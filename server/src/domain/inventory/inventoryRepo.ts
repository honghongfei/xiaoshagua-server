import { openDb, withTx, type DB } from '../../db/sqlite.js';

export type ItemKind = 'item' | 'weapon' | 'armor';

export interface InventoryRow {
  character_id: number;
  kind: ItemKind;
  data_id: number;
  count: number;
}

export function listInventory(characterId: number): InventoryRow[] {
  const db = openDb();
  return db
    .prepare<[number], InventoryRow>(
      'SELECT character_id, kind, data_id, count FROM inventory WHERE character_id = ? ORDER BY kind, data_id',
    )
    .all(characterId);
}

export function getGold(characterId: number): number {
  const db = openDb();
  const row = db
    .prepare<[number], { gold: number }>('SELECT gold FROM character WHERE id = ?')
    .get(characterId);
  return row ? row.gold : 0;
}

export function applyGoldDelta(db: DB, characterId: number, delta: number): number {
  const cur = db
    .prepare<[number], { gold: number }>('SELECT gold FROM character WHERE id = ?')
    .get(characterId);
  const before = cur ? cur.gold : 0;
  const after = Math.max(0, before + delta);
  db.prepare('UPDATE character SET gold = ?, updated_at = ? WHERE id = ?').run(after, Date.now(), characterId);
  return after - before;
}

export function applyItemDelta(
  db: DB,
  characterId: number,
  kind: ItemKind,
  dataId: number,
  delta: number,
): number {
  const cur = db
    .prepare<[number, string, number], { count: number }>(
      'SELECT count FROM inventory WHERE character_id = ? AND kind = ? AND data_id = ?',
    )
    .get(characterId, kind, dataId);
  const before = cur ? cur.count : 0;
  const after = Math.max(0, before + delta);
  if (after === 0) {
    db.prepare(
      'DELETE FROM inventory WHERE character_id = ? AND kind = ? AND data_id = ?',
    ).run(characterId, kind, dataId);
  } else if (cur) {
    db.prepare(
      'UPDATE inventory SET count = ? WHERE character_id = ? AND kind = ? AND data_id = ?',
    ).run(after, characterId, kind, dataId);
  } else {
    db.prepare(
      'INSERT INTO inventory (character_id, kind, data_id, count) VALUES (?, ?, ?, ?)',
    ).run(characterId, kind, dataId, after);
  }
  return after - before;
}

export function tx<T>(fn: (db: DB) => T): T {
  const db = openDb();
  return withTx(db, fn);
}

// 全量覆盖 helper (用于 inventoryService.replaceInventory).
// 调用方必须自己包 tx, 这两个函数只接收 db.
export function setGold(db: DB, characterId: number, gold: number): void {
  db.prepare('UPDATE character SET gold = ?, updated_at = ? WHERE id = ?').run(
    gold,
    Date.now(),
    characterId,
  );
}

export function clearInventory(db: DB, characterId: number): void {
  db.prepare('DELETE FROM inventory WHERE character_id = ?').run(characterId);
}

export function upsertInventory(
  db: DB,
  characterId: number,
  kind: ItemKind,
  dataId: number,
  count: number,
): void {
  // 在 clearInventory 之后调用, 所以这里直接 INSERT 即可, 但保留 ON CONFLICT
  // 以便支持单点 patch 用法.
  db.prepare(
    `INSERT INTO inventory (character_id, kind, data_id, count) VALUES (?, ?, ?, ?)
     ON CONFLICT(character_id, kind, data_id) DO UPDATE SET count = excluded.count`,
  ).run(characterId, kind, dataId, count);
}
