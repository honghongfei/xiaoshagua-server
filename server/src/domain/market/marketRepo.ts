import { openDb, type DB } from '../../db/sqlite.js';
import type { ItemKind } from '../inventory/inventoryRepo.js';

export type ListingStatus = 'active' | 'sold' | 'cancelled';

export interface ListingRow {
  id: number;
  seller_id: number;
  kind: ItemKind;
  data_id: number;
  orig_count: number;
  count: number;
  unit_price: number;
  status: ListingStatus;
  created_at: number;
  updated_at: number;
  sold_at: number | null;
}

export interface ListingWithSeller extends ListingRow {
  seller_name: string;
}

export interface NotificationRow {
  id: number;
  character_id: number;
  type: string;
  payload_json: string;
  created_at: number;
  read_at: number | null;
}

// ---------------- slots ----------------

export function getSlots(characterId: number, defaultSlots: number): number {
  const db = openDb();
  const row = db
    .prepare<[number], { slots: number }>('SELECT slots FROM market_slot WHERE character_id = ?')
    .get(characterId);
  return row ? row.slots : defaultSlots;
}

export function ensureSlotRow(db: DB, characterId: number, defaultSlots: number): void {
  db.prepare(
    'INSERT OR IGNORE INTO market_slot (character_id, slots, updated_at) VALUES (?, ?, ?)',
  ).run(characterId, defaultSlots, Date.now());
}

export function setSlots(db: DB, characterId: number, slots: number): void {
  db.prepare('UPDATE market_slot SET slots = ?, updated_at = ? WHERE character_id = ?').run(
    slots,
    Date.now(),
    characterId,
  );
}

// ---------------- listings ----------------

export function countActiveListings(sellerId: number): number {
  const db = openDb();
  const row = db
    .prepare<[number], { n: number }>(
      "SELECT COUNT(*) AS n FROM market_listing WHERE seller_id = ? AND status = 'active'",
    )
    .get(sellerId);
  return row ? row.n : 0;
}

export function getListingById(id: number): ListingRow | undefined {
  const db = openDb();
  return db.prepare<[number], ListingRow>('SELECT * FROM market_listing WHERE id = ?').get(id);
}

export function insertListing(
  db: DB,
  input: {
    sellerId: number;
    kind: ItemKind;
    dataId: number;
    count: number;
    unitPrice: number;
  },
): number {
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO market_listing
       (seller_id, kind, data_id, orig_count, count, unit_price, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    )
    .run(input.sellerId, input.kind, input.dataId, input.count, input.count, input.unitPrice, now, now);
  return Number(info.lastInsertRowid);
}

// 原子下架：仅当 active 才置 cancelled，返回受影响行数（并发兜底）。
export function cancelListing(db: DB, id: number): number {
  const info = db
    .prepare(
      "UPDATE market_listing SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'active'",
    )
    .run(Date.now(), id);
  return info.changes;
}

// 原子拆分扣减：count 足够才成交；扣到 0 自动 sold。返回受影响行数。
export function decrementForBuy(db: DB, id: number, qty: number): number {
  const now = Date.now();
  const info = db
    .prepare(
      `UPDATE market_listing
       SET count = count - ?,
           status = CASE WHEN count - ? = 0 THEN 'sold' ELSE 'active' END,
           sold_at = CASE WHEN count - ? = 0 THEN ? ELSE sold_at END,
           updated_at = ?
       WHERE id = ? AND status = 'active' AND count >= ?`,
    )
    .run(qty, qty, qty, now, now, id, qty);
  return info.changes;
}

export function listMine(sellerId: number): ListingRow[] {
  const db = openDb();
  return db
    .prepare<[number], ListingRow>(
      "SELECT * FROM market_listing WHERE seller_id = ? AND status = 'active' ORDER BY created_at DESC",
    )
    .all(sellerId);
}

export interface BrowseOpts {
  kind?: ItemKind;
  q?: string;
  limit: number;
  offset: number;
}

export function browseActive(opts: BrowseOpts): { rows: ListingWithSeller[]; total: number } {
  const db = openDb();
  const where: string[] = ["l.status = 'active'", 'l.count > 0'];
  const params: unknown[] = [];
  if (opts.kind) {
    where.push('l.kind = ?');
    params.push(opts.kind);
  }
  if (opts.q && opts.q.length > 0) {
    const safe = opts.q.replace(/[\\%_]/g, (c) => '\\' + c);
    where.push("c.name LIKE ? ESCAPE '\\'");
    params.push('%' + safe + '%');
  }
  const whereSql = where.join(' AND ');
  const totalRow = db
    .prepare<unknown[], { n: number }>(
      `SELECT COUNT(*) AS n FROM market_listing l JOIN character c ON c.id = l.seller_id WHERE ${whereSql}`,
    )
    .get(...params);
  const rows = db
    .prepare<unknown[], ListingWithSeller>(
      `SELECT l.*, c.name AS seller_name
       FROM market_listing l JOIN character c ON c.id = l.seller_id
       WHERE ${whereSql}
       ORDER BY l.created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, opts.limit, opts.offset);
  return { rows, total: totalRow ? totalRow.n : 0 };
}

// ---------------- market_log ----------------

export function insertLog(
  db: DB,
  input: {
    listingId: number;
    sellerId: number;
    buyerId: number;
    kind: ItemKind;
    dataId: number;
    qty: number;
    unitPrice: number;
    cost: number;
    fee: number;
    proceeds: number;
  },
): void {
  db.prepare(
    `INSERT INTO market_log
     (ts, listing_id, seller_id, buyer_id, kind, data_id, qty, unit_price, cost, fee, proceeds)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    Date.now(),
    input.listingId,
    input.sellerId,
    input.buyerId,
    input.kind,
    input.dataId,
    input.qty,
    input.unitPrice,
    input.cost,
    input.fee,
    input.proceeds,
  );
}

// ---------------- notifications ----------------

export function insertNotification(
  db: DB,
  characterId: number,
  type: string,
  payload: unknown,
): number {
  const info = db
    .prepare(
      'INSERT INTO notification (character_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)',
    )
    .run(characterId, type, JSON.stringify(payload ?? {}), Date.now());
  return Number(info.lastInsertRowid);
}

export function listUnread(characterId: number): NotificationRow[] {
  const db = openDb();
  return db
    .prepare<[number], NotificationRow>(
      'SELECT * FROM notification WHERE character_id = ? AND read_at IS NULL ORDER BY created_at ASC',
    )
    .all(characterId);
}

export function markRead(db: DB, characterId: number, ids: number[]): number {
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => '?').join(',');
  const info = db
    .prepare(
      `UPDATE notification SET read_at = ? WHERE character_id = ? AND read_at IS NULL AND id IN (${placeholders})`,
    )
    .run(Date.now(), characterId, ...ids);
  return info.changes;
}

export function markAllRead(db: DB, characterId: number): number {
  const info = db
    .prepare('UPDATE notification SET read_at = ? WHERE character_id = ? AND read_at IS NULL')
    .run(Date.now(), characterId);
  return info.changes;
}
