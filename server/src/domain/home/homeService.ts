import type { Server } from 'socket.io';
import { config } from '../../config.js';
import { log } from '../../log.js';
import { AppError } from '../../util/errors.js';
import * as invRepo from '../inventory/inventoryRepo.js';
import { isFriend, isBlocked } from '../social/socialService.js';
import { resolveBaseMap, spawnFor, stylesForTier } from './homeMaps.js';
import * as repo from './homeRepo.js';

let io: Server | null = null;

export function attachHomeIo(s: Server): void {
  io = s;
  repo.loadCatalog();
}

export function homeVirtualMapId(ownerPid: number): number {
  return config.homeVirtualBase + ownerPid;
}

function roomOf(virtualMapId: number): string {
  return `map:${virtualMapId}`;
}

export interface HomeFurnitureView {
  id: number;
  furnitureId: number;
  x: number;
  y: number;
  dir: number;
  layer: number;
}

export interface HomeEnterResult {
  ownerPid: number;
  virtualMapId: number;
  baseMapId: number;
  building: string;
  tier: number;
  style: string;
  gardenUnlocked: boolean;
  visibility: string;
  canEdit: boolean;
  furniture: HomeFurnitureView[];
  spawn: { x: number; y: number; d: number };
}

function furnitureView(rows: repo.FurnitureRow[]): HomeFurnitureView[] {
  return rows.map((r) => ({
    id: r.id,
    furnitureId: r.furniture_id,
    x: r.x,
    y: r.y,
    dir: r.dir,
    layer: r.layer,
  }));
}

export function enter(selfPid: number, ownerPid?: number): HomeEnterResult {
  const target = ownerPid ?? selfPid;
  repo.ensureHome(target, Date.now());
  const home = repo.getHome(target);
  if (!home) throw new AppError('INTERNAL', 'home row missing', 500);
  if (target !== selfPid) {
    if (isBlocked(target, selfPid)) throw new AppError('BLOCKED', 'you are blocked by the owner');
    if (home.visibility === 'private') throw new AppError('FORBIDDEN', 'home is private');
    if (home.visibility === 'friends' && !isFriend(target, selfPid)) {
      throw new AppError('NOT_FRIEND', 'friends only');
    }
  }
  return {
    ownerPid: target,
    virtualMapId: homeVirtualMapId(target),
    baseMapId: resolveBaseMap(home.building, home.tier, home.style),
    building: home.building,
    tier: home.tier,
    style: home.style,
    gardenUnlocked: home.garden_unlocked === 1,
    visibility: home.visibility,
    canEdit: target === selfPid,
    furniture: furnitureView(repo.listFurniture(target)),
    spawn: spawnFor(home.building),
  };
}

export function setVisibility(
  pid: number,
  visibility: 'private' | 'friends' | 'public',
): { visibility: string } {
  repo.ensureHome(pid, Date.now());
  repo.tx((db) => repo.setVisibility(db, pid, visibility, Date.now()));
  broadcast(pid, 'home.update.evt', { visibility });
  return { visibility };
}

export function setStyle(pid: number, style: string): { style: string } {
  const home = mustHome(pid);
  if (!stylesForTier(home.building, home.tier).includes(style)) {
    throw new AppError('BAD_STYLE', 'style not unlocked for current tier');
  }
  repo.tx((db) => repo.setStyle(db, pid, style, Date.now()));
  broadcast(pid, 'home.update.evt', { style });
  return { style };
}

export function upgrade(pid: number): { tier: number; furnitureSlots: number; gardenUnlocked: boolean } {
  const result = repo.tx((db) => {
    const home = repo.getHome(pid);
    if (!home) throw new AppError('INTERNAL', 'home missing', 500);
    if (home.tier >= config.homeMaxTier) throw new AppError('TIER_MAXED', 'already at max tier');
    const nextTier = home.tier + 1;
    const voucherId = config.homeVoucherItemIds[nextTier - 1] ?? 0;
    const ownedVoucher =
      voucherId > 0
        ? invRepo.listInventory(pid).find((r) => r.kind === 'item' && r.data_id === voucherId)?.count ?? 0
        : 0;
    if (ownedVoucher >= 1) {
      invRepo.applyItemDelta(db, pid, 'item', voucherId, -1);
    } else {
      const price = config.homeUpgradePrices[nextTier - 1];
      if (price == null) throw new AppError('NO_VOUCHER', 'need a house voucher for this tier');
      if (invRepo.getGold(pid) < price) throw new AppError('NOT_ENOUGH_GOLD', `need ${price} gold`);
      invRepo.applyGoldDelta(db, pid, -price);
    }
    const slots = config.homeBaseFurnSlots + nextTier * config.homeFurnSlotPerTier;
    const garden: 0 | 1 = nextTier >= config.homeGardenTier ? 1 : home.garden_unlocked;
    repo.updateTier(db, pid, nextTier, slots, garden, Date.now());
    return { tier: nextTier, furnitureSlots: slots, gardenUnlocked: garden === 1 };
  });
  broadcast(pid, 'home.update.evt', { tier: result.tier, gardenUnlocked: result.gardenUnlocked });
  log.info({ pid, tier: result.tier }, 'home upgraded');
  return result;
}

export function placeFurniture(
  pid: number,
  furnitureId: number,
  x: number,
  y: number,
  dir: number,
  layer: number = 1,
): { id: number } {
  return repo.tx((db) => {
    if (!repo.isFurniture(furnitureId)) throw new AppError('NOT_FURNITURE', 'not a placeable furniture');
    const home = repo.getHome(pid);
    if (!home) throw new AppError('INTERNAL', 'home missing', 500);
    const cap = Math.min(home.furniture_slots, config.homeMaxFurniture);
    if (repo.countFurniture(pid) >= cap) throw new AppError('SLOT_FULL', `furniture cap ${cap}`);
    const owned = invRepo.listInventory(pid).find((r) => r.kind === 'item' && r.data_id === furnitureId)?.count ?? 0;
    if (owned < 1) throw new AppError('NOT_OWNED', 'you do not own this furniture');
    if (repo.cellOccupied(pid, x, y, layer)) throw new AppError('CELL_OCCUPIED', 'cell occupied');
    invRepo.applyItemDelta(db, pid, 'item', furnitureId, -1);
    const id = repo.insertFurniture(db, pid, furnitureId, x, y, dir, layer, Date.now());
    broadcast(pid, 'home.furniture.evt', { op: 'place', item: { id, furnitureId, x, y, dir, layer } });
    return { id };
  });
}

export function moveFurniture(pid: number, id: number, x: number, y: number, dir: number): { ok: true } {
  repo.tx((db) => {
    const row = repo.getFurnitureById(id);
    if (!row || row.owner_id !== pid) throw new AppError('FORBIDDEN', 'not your furniture');
    if ((row.x !== x || row.y !== y) && repo.cellOccupied(pid, x, y, row.layer)) {
      throw new AppError('CELL_OCCUPIED', 'cell occupied');
    }
    const n = repo.moveFurniture(db, id, pid, x, y, dir);
    if (n !== 1) throw new AppError('NOT_FOUND', 'furniture gone');
    broadcast(pid, 'home.furniture.evt', {
      op: 'move',
      item: { id, furnitureId: row.furniture_id, x, y, dir, layer: row.layer },
    });
  });
  return { ok: true };
}

export function removeFurniture(pid: number, id: number): { ok: true; furnitureId: number } {
  return repo.tx((db) => {
    const row = repo.getFurnitureById(id);
    if (!row || row.owner_id !== pid) throw new AppError('FORBIDDEN', 'not your furniture');
    const n = repo.deleteFurniture(db, id, pid);
    if (n !== 1) throw new AppError('NOT_FOUND', 'furniture gone');
    invRepo.applyItemDelta(db, pid, 'item', row.furniture_id, +1);
    broadcast(pid, 'home.furniture.evt', {
      op: 'remove',
      item: { id, furnitureId: row.furniture_id, x: row.x, y: row.y, dir: row.dir, layer: row.layer },
    });
    return { ok: true, furnitureId: row.furniture_id };
  });
}

function mustHome(pid: number): repo.HomeRow {
  repo.ensureHome(pid, Date.now());
  const h = repo.getHome(pid);
  if (!h) throw new AppError('INTERNAL', 'home missing', 500);
  return h;
}

function broadcast(ownerPid: number, evt: string, payload: unknown): void {
  if (!io) return;
  io.to(roomOf(homeVirtualMapId(ownerPid))).emit(evt, payload);
}
