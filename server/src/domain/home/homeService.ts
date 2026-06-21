import type { Server } from 'socket.io';
import { config } from '../../config.js';
import { log } from '../../log.js';
import { AppError } from '../../util/errors.js';
import * as invRepo from '../inventory/inventoryRepo.js';
import { findCharacterById } from '../player/playerRepo.js';
import { isFriend, isBlocked } from '../social/socialService.js';
import { resolveBaseMap, spawnFor, stylesForTier, buildingForTier } from './homeMaps.js';
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

function slotsForTier(tier: number): number {
  return config.homeBaseFurnSlots + tier * config.homeFurnSlotPerTier;
}

function gardenForTier(tier: number): 0 | 1 {
  return tier >= config.homeGardenTier ? 1 : 0;
}

// 新家起始档位由 config.homeStartTier 决定（默认 0 毛坯；可后期调 1 直接住椰树大厦）。
function ensureOwnHome(pid: number): void {
  const tier = config.homeStartTier;
  repo.ensureHome(pid, buildingForTier(tier), tier, 'base', slotsForTier(tier), gardenForTier(tier), Date.now());
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

// 访客可见性校验：home 缺行按 private 处理（访客拒；房主进自家有 ensureOwnHome 兜底）。
function assertCanView(home: repo.HomeRow | undefined, selfPid: number, ownerPid: number): void {
  if (ownerPid === selfPid) return;
  if (isBlocked(ownerPid, selfPid)) throw new AppError('BLOCKED', 'you are blocked by the owner');
  const visibility = home?.visibility ?? 'private';
  if (visibility === 'private') throw new AppError('FORBIDDEN', 'home is private');
  if (visibility === 'friends' && !isFriend(ownerPid, selfPid)) throw new AppError('NOT_FRIEND', 'friends only');
}

export function enter(selfPid: number, ownerPid?: number): HomeEnterResult {
  const target = ownerPid ?? selfPid;
  if (!findCharacterById(target)) throw new AppError('NOT_FOUND', 'character not found');
  if (target === selfPid) ensureOwnHome(target);
  const home = repo.getHome(target);
  assertCanView(home, selfPid, target);
  if (!home) throw new AppError('INTERNAL', 'home row missing', 500);
  const building = buildingForTier(home.tier);
  return {
    ownerPid: target,
    virtualMapId: homeVirtualMapId(target),
    baseMapId: resolveBaseMap(home.tier, home.style),
    building,
    tier: home.tier,
    style: home.style,
    gardenUnlocked: home.garden_unlocked === 1,
    visibility: home.visibility,
    canEdit: target === selfPid,
    furniture: furnitureView(repo.listFurniture(target)),
    spawn: spawnFor(building),
  };
}

// 只读快照：不 ensureHome（避免访客刷出空行），用于访客补拉布局兜底。
export function furnitureSnapshot(selfPid: number, ownerPid: number): { furniture: HomeFurnitureView[] } {
  if (!findCharacterById(ownerPid)) throw new AppError('NOT_FOUND', 'character not found');
  const home = repo.getHome(ownerPid);
  assertCanView(home, selfPid, ownerPid);
  return { furniture: furnitureView(repo.listFurniture(ownerPid)) };
}

export function setVisibility(
  pid: number,
  visibility: 'private' | 'friends' | 'public',
): { visibility: string } {
  ensureOwnHome(pid);
  repo.tx((db) => repo.setVisibility(db, pid, visibility, Date.now()));
  broadcast(pid, 'home.update.evt', { visibility });
  return { visibility };
}

export function setStyle(pid: number, style: string): { style: string } {
  const home = mustHome(pid);
  if (!stylesForTier(home.tier).includes(style)) {
    throw new AppError('BAD_STYLE', 'style not unlocked for current tier');
  }
  repo.tx((db) => repo.setStyle(db, pid, style, Date.now()));
  broadcast(pid, 'home.update.evt', { style });
  return { style };
}

export function upgrade(pid: number): {
  tier: number;
  building: string;
  furnitureSlots: number;
  gardenUnlocked: boolean;
} {
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
    const building = buildingForTier(nextTier); // 跨 6→7 自动从椰树大厦切空中花园
    const slots = slotsForTier(nextTier);
    const garden: 0 | 1 = nextTier >= config.homeGardenTier ? 1 : home.garden_unlocked;
    repo.updateTier(db, pid, building, nextTier, slots, garden, Date.now());
    return { tier: nextTier, building, furnitureSlots: slots, gardenUnlocked: garden === 1 };
  });
  broadcast(pid, 'home.update.evt', {
    tier: result.tier,
    building: result.building,
    gardenUnlocked: result.gardenUnlocked,
  });
  log.info({ pid, tier: result.tier, building: result.building }, 'home upgraded');
  return result;
}

// 老存档迁移：把客户端从本地开关反推的房型 tier/style 灌入服务端。
// 护栏：仅当服务端仍是初始档(tier <= homeStartTier)时才迁移，杜绝覆盖线上已升级进度；
//       只升不降、tier 夹取到 [0, homeMaxTier]、style 非法则取该档首个风格。幂等。
export function migrate(
  pid: number,
  tier: number,
  style: string,
): { tier: number; building: string; style: string; migrated: boolean } {
  ensureOwnHome(pid);
  const result = repo.tx((db) => {
    const home = repo.getHome(pid);
    if (!home) throw new AppError('INTERNAL', 'home missing', 500);
    let t = Math.floor(Number(tier));
    if (!Number.isFinite(t) || t < 0) t = 0;
    if (t > config.homeMaxTier) t = config.homeMaxTier;
    if (home.tier > config.homeStartTier || t <= home.tier) {
      // 服务端已有进度，或本地不比服务端高 → no-op
      return { tier: home.tier, building: buildingForTier(home.tier), style: home.style, migrated: false };
    }
    const building = buildingForTier(t);
    const garden: 0 | 1 = t >= config.homeGardenTier ? 1 : home.garden_unlocked;
    repo.updateTier(db, pid, building, t, slotsForTier(t), garden, Date.now());
    const styles = stylesForTier(t);
    const s = typeof style === 'string' && styles.includes(style) ? style : styles[0] ?? 'base';
    repo.setStyle(db, pid, s, Date.now());
    return { tier: t, building, style: s, migrated: true };
  });
  if (result.migrated) {
    broadcast(pid, 'home.update.evt', { tier: result.tier, building: result.building, style: result.style });
    log.info({ pid, tier: result.tier, style: result.style }, 'home migrated from local save');
  }
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
    ensureOwnHome(pid);
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
  ensureOwnHome(pid);
  const h = repo.getHome(pid);
  if (!h) throw new AppError('INTERNAL', 'home missing', 500);
  return h;
}

function broadcast(ownerPid: number, evt: string, payload: unknown): void {
  if (!io) return;
  io.to(roomOf(homeVirtualMapId(ownerPid))).emit(evt, payload);
}
