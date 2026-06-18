import { config } from '../../config.js';
import type { DB } from '../../db/sqlite.js';
import { log } from '../../log.js';
import { AppError } from '../../util/errors.js';
import * as invRepo from '../inventory/inventoryRepo.js';
import type { ItemKind } from '../inventory/inventoryRepo.js';
import { findCharacterById } from '../player/playerRepo.js';
import * as repo from './marketRepo.js';

// 与 inventoryService 对齐的资产上限（那边是私有 const，这里复制一份避免引入 argon2 依赖链）。
const GOLD_CAP = 999_999_999;
const ITEM_CAP = 9_999;
const KINDS: ItemKind[] = ['item', 'weapon', 'armor'];

export interface ClientListing {
  id: number;
  sellerId: number;
  sellerName?: string;
  kind: ItemKind;
  dataId: number;
  origCount: number;
  count: number;
  unitPrice: number;
  createdAt: number;
  mine: boolean;
}

function nameOf(pid: number): string {
  const c = findCharacterById(pid);
  return c ? c.name : `#${pid}`;
}

function creditClamped(db: DB, pid: number, amount: number): number {
  if (amount <= 0) return 0;
  const before = invRepo.getGold(pid);
  let target = before + amount;
  if (target > GOLD_CAP) target = GOLD_CAP;
  return invRepo.applyGoldDelta(db, pid, target - before);
}

// ---------------- 上架 ----------------

export function createListing(
  sellerPid: number,
  kind: ItemKind,
  dataId: number,
  count: number,
  unitPrice: number,
): { listingId: number } {
  if (!KINDS.includes(kind)) throw new AppError('BAD_INPUT', 'bad kind');
  if (!Number.isInteger(dataId) || dataId <= 0) throw new AppError('BAD_INPUT', 'bad dataId');
  if (!Number.isInteger(count) || count < 1 || count > config.marketMaxStack) {
    throw new AppError('BAD_INPUT', `count must be 1..${config.marketMaxStack}`);
  }
  if (!Number.isInteger(unitPrice) || unitPrice < 1 || unitPrice > config.marketMaxUnitPrice) {
    throw new AppError('BAD_INPUT', `unitPrice must be 1..${config.marketMaxUnitPrice}`);
  }
  return invRepo.tx((db) => {
    repo.ensureSlotRow(db, sellerPid, config.marketDefaultSlots);
    const slots = repo.getSlots(sellerPid, config.marketDefaultSlots);
    const used = repo.countActiveListings(sellerPid);
    if (used >= slots) throw new AppError('NO_SLOT', `no free slot (${used}/${slots})`);
    const have = invRepo.listInventory(sellerPid).find((r) => r.kind === kind && r.data_id === dataId);
    if (!have || have.count < count) {
      throw new AppError('NOT_ENOUGH_ITEM', `need ${count}, have ${have ? have.count : 0}`);
    }
    invRepo.applyItemDelta(db, sellerPid, kind, dataId, -count);
    const listingId = repo.insertListing(db, { sellerId: sellerPid, kind, dataId, count, unitPrice });
    log.info({ sellerPid, listingId, kind, dataId, count, unitPrice }, 'market listing created');
    return { listingId };
  });
}

// ---------------- 下架 ----------------

export function cancelListing(sellerPid: number, listingId: number): { ok: true; returned: number } {
  return invRepo.tx((db) => {
    const row = repo.getListingById(listingId);
    if (!row || row.seller_id !== sellerPid) throw new AppError('FORBIDDEN', 'not your listing');
    if (row.status !== 'active') throw new AppError('BAD_STATE', `listing is ${row.status}`);
    const remaining = row.count;
    const n = repo.cancelListing(db, listingId);
    if (n !== 1) throw new AppError('LISTING_GONE', 'listing changed concurrently');
    if (remaining > 0) invRepo.applyItemDelta(db, sellerPid, row.kind, row.data_id, remaining);
    log.info({ sellerPid, listingId, returned: remaining }, 'market listing cancelled');
    return { ok: true, returned: remaining };
  });
}

// ---------------- 购买（拆分 + 原子结算）----------------

export interface BuyResult {
  ok: true;
  kind: ItemKind;
  dataId: number;
  qty: number;
  cost: number;
  fee: number;
  proceeds: number;
  remaining: number;
  sellerId: number;
  sold: boolean;
}

export function buyListing(buyerPid: number, listingId: number, qty: number): BuyResult {
  if (!Number.isInteger(qty) || qty < 1) throw new AppError('BAD_QTY', 'qty must be >=1');
  return invRepo.tx((db) => {
    const row = repo.getListingById(listingId);
    if (!row || row.status !== 'active' || row.count <= 0) {
      throw new AppError('LISTING_GONE', 'listing not available');
    }
    if (row.seller_id === buyerPid) throw new AppError('CANNOT_BUY_OWN', 'cannot buy your own listing');
    if (qty > row.count) throw new AppError('BAD_QTY', `only ${row.count} left`);
    const cost = row.unit_price * qty;
    const buyerGold = invRepo.getGold(buyerPid);
    if (buyerGold < cost) throw new AppError('NOT_ENOUGH_GOLD', `need ${cost}, have ${buyerGold}`);
    const buyerHas = invRepo.listInventory(buyerPid).find((r) => r.kind === row.kind && r.data_id === row.data_id);
    if ((buyerHas ? buyerHas.count : 0) + qty > ITEM_CAP) {
      throw new AppError('ITEM_FULL', `would exceed item cap ${ITEM_CAP}`);
    }
    const fee = Math.floor((cost * config.marketFeeBps) / 10000);
    const proceeds = cost - fee;

    const n = repo.decrementForBuy(db, listingId, qty);
    if (n !== 1) throw new AppError('LISTING_GONE', 'listing changed concurrently');

    invRepo.applyGoldDelta(db, buyerPid, -cost); // 买家全额付
    creditClamped(db, row.seller_id, proceeds); // 卖家得 80%，超 GOLD_CAP 销毁
    invRepo.applyItemDelta(db, buyerPid, row.kind, row.data_id, qty); // 物品给买家
    // 剩下的 fee 金币不入任何账户 = 销毁（sink）

    const remaining = row.count - qty;
    const sold = remaining === 0;

    repo.insertLog(db, {
      listingId,
      sellerId: row.seller_id,
      buyerId: buyerPid,
      kind: row.kind,
      dataId: row.data_id,
      qty,
      unitPrice: row.unit_price,
      cost,
      fee,
      proceeds,
    });

    const buyerName = nameOf(buyerPid);
    const sellerName = nameOf(row.seller_id);
    repo.insertNotification(db, row.seller_id, 'market_sold', {
      listingId,
      kind: row.kind,
      dataId: row.data_id,
      qty,
      unitPrice: row.unit_price,
      cost,
      fee,
      proceeds,
      remaining,
      buyerId: buyerPid,
      buyerName,
    });
    repo.insertNotification(db, buyerPid, 'market_bought', {
      listingId,
      kind: row.kind,
      dataId: row.data_id,
      qty,
      unitPrice: row.unit_price,
      cost,
      sellerId: row.seller_id,
      sellerName,
    });

    log.info(
      { buyerPid, sellerPid: row.seller_id, listingId, qty, cost, fee, proceeds, remaining },
      'market purchase committed',
    );
    return { ok: true, kind: row.kind, dataId: row.data_id, qty, cost, fee, proceeds, remaining, sellerId: row.seller_id, sold };
  });
}

// ---------------- 开格 ----------------

export function unlockSlot(pid: number): { slots: number; spent: number } {
  return invRepo.tx((db) => {
    repo.ensureSlotRow(db, pid, config.marketDefaultSlots);
    const slots = repo.getSlots(pid, config.marketDefaultSlots);
    if (slots >= config.marketMaxSlots) throw new AppError('SLOT_MAXED', `already at max ${config.marketMaxSlots}`);
    const idx = slots - config.marketDefaultSlots;
    const price = config.marketSlotPrices[idx];
    if (price == null) throw new AppError('SLOT_MAXED', 'no further slot');
    const gold = invRepo.getGold(pid);
    if (gold < price) throw new AppError('NOT_ENOUGH_GOLD', `need ${price}, have ${gold}`);
    invRepo.applyGoldDelta(db, pid, -price); // 销毁
    repo.setSlots(db, pid, slots + 1);
    log.info({ pid, slots: slots + 1, spent: price }, 'market slot unlocked');
    return { slots: slots + 1, spent: price };
  });
}

// ---------------- 查询 ----------------

function toClientListing(viewerPid: number, r: repo.ListingRow | repo.ListingWithSeller): ClientListing {
  const out: ClientListing = {
    id: r.id,
    sellerId: r.seller_id,
    kind: r.kind,
    dataId: r.data_id,
    origCount: r.orig_count,
    count: r.count,
    unitPrice: r.unit_price,
    createdAt: r.created_at,
    mine: r.seller_id === viewerPid,
  };
  if ('seller_name' in r) out.sellerName = r.seller_name;
  return out;
}

export interface MineResult {
  slots: number;
  maxSlots: number;
  usedSlots: number;
  nextSlotIndex: number | null;
  nextSlotPrice: number | null;
  gold: number;
  listings: ClientListing[];
}

export function getMine(pid: number): MineResult {
  const slots = repo.getSlots(pid, config.marketDefaultSlots);
  const used = repo.countActiveListings(pid);
  const canUnlock = slots < config.marketMaxSlots;
  const nextSlotPrice = canUnlock ? config.marketSlotPrices[slots - config.marketDefaultSlots] ?? null : null;
  return {
    slots,
    maxSlots: config.marketMaxSlots,
    usedSlots: used,
    nextSlotIndex: canUnlock ? slots + 1 : null,
    nextSlotPrice,
    gold: invRepo.getGold(pid),
    listings: repo.listMine(pid).map((r) => toClientListing(pid, r)),
  };
}

export interface BrowseOpts {
  viewerPid: number;
  kind?: ItemKind;
  q?: string;
  offset?: number;
  limit?: number;
}

export function browse(opts: BrowseOpts): { listings: ClientListing[]; total: number } {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), config.marketBrowsePageMax);
  const offset = Math.max(opts.offset ?? 0, 0);
  const { rows, total } = repo.browseActive({ kind: opts.kind, q: opts.q, limit, offset });
  return { listings: rows.map((r) => toClientListing(opts.viewerPid, r)), total };
}

// ---------------- 通知 ----------------

export interface NotificationItem {
  id: number;
  type: string;
  payload: unknown;
  createdAt: number;
}

export function listNotifications(pid: number): { items: NotificationItem[] } {
  const items = repo.listUnread(pid).map((n) => ({
    id: n.id,
    type: n.type,
    payload: safeParse(n.payload_json),
    createdAt: n.created_at,
  }));
  return { items };
}

export function ackNotifications(pid: number, ids: number[]): { ok: true; count: number } {
  const clean = (ids ?? []).filter((x) => Number.isInteger(x) && x > 0);
  const count = clean.length === 0 ? 0 : invRepo.tx((db) => repo.markRead(db, pid, clean));
  return { ok: true, count };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
