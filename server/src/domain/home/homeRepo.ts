import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb, withTx, type DB } from '../../db/sqlite.js';

export interface HomeRow {
  owner_id: number;
  building: 'coconut' | 'skygarden';
  tier: number;
  style: string;
  visibility: 'private' | 'friends' | 'public';
  furniture_slots: number;
  garden_unlocked: 0 | 1;
  bonus_json: string | null;
  created_at: number;
  updated_at: number;
}

export interface FurnitureRow {
  id: number;
  owner_id: number;
  furniture_id: number;
  x: number;
  y: number;
  dir: number;
  layer: number;
  created_at: number;
}

export function tx<T>(fn: (db: DB) => T): T {
  return withTx(openDb(), fn);
}

export function ensureHome(
  ownerId: number,
  building: string,
  tier: number,
  style: string,
  slots: number,
  garden: 0 | 1,
  now: number,
): void {
  openDb()
    .prepare(
      `INSERT OR IGNORE INTO home
         (owner_id, building, tier, style, visibility, furniture_slots, garden_unlocked, bonus_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'private', ?, ?, NULL, ?, ?)`,
    )
    .run(ownerId, building, tier, style, slots, garden, now, now);
}

export function getHome(ownerId: number): HomeRow | undefined {
  return openDb()
    .prepare<[number], HomeRow>('SELECT * FROM home WHERE owner_id = ?')
    .get(ownerId);
}

export function updateTier(
  db: DB,
  ownerId: number,
  building: string,
  tier: number,
  slots: number,
  garden: 0 | 1,
  now: number,
): void {
  db.prepare(
    'UPDATE home SET building = ?, tier = ?, furniture_slots = ?, garden_unlocked = ?, updated_at = ? WHERE owner_id = ?',
  ).run(building, tier, slots, garden, now, ownerId);
}

export function setVisibility(db: DB, ownerId: number, visibility: string, now: number): number {
  return db
    .prepare('UPDATE home SET visibility = ?, updated_at = ? WHERE owner_id = ?')
    .run(visibility, now, ownerId).changes;
}

export function setStyle(db: DB, ownerId: number, style: string, now: number): number {
  return db
    .prepare('UPDATE home SET style = ?, updated_at = ? WHERE owner_id = ?')
    .run(style, now, ownerId).changes;
}

export function listFurniture(ownerId: number): FurnitureRow[] {
  return openDb()
    .prepare<[number], FurnitureRow>('SELECT * FROM home_furniture WHERE owner_id = ? ORDER BY layer, id')
    .all(ownerId);
}

export function countFurniture(ownerId: number): number {
  const r = openDb()
    .prepare<[number], { n: number }>('SELECT COUNT(*) AS n FROM home_furniture WHERE owner_id = ?')
    .get(ownerId);
  return r ? r.n : 0;
}

export function cellOccupied(ownerId: number, x: number, y: number, layer: number): boolean {
  const r = openDb()
    .prepare<[number, number, number, number], { one: number }>(
      'SELECT 1 AS one FROM home_furniture WHERE owner_id = ? AND x = ? AND y = ? AND layer = ? LIMIT 1',
    )
    .get(ownerId, x, y, layer);
  return !!r;
}

export function getFurnitureById(id: number): FurnitureRow | undefined {
  return openDb()
    .prepare<[number], FurnitureRow>('SELECT * FROM home_furniture WHERE id = ?')
    .get(id);
}

export function insertFurniture(
  db: DB,
  ownerId: number,
  furnitureId: number,
  x: number,
  y: number,
  dir: number,
  layer: number,
  now: number,
): number {
  const info = db
    .prepare(
      'INSERT INTO home_furniture (owner_id, furniture_id, x, y, dir, layer, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(ownerId, furnitureId, x, y, dir, layer, now);
  return Number(info.lastInsertRowid);
}

export function moveFurniture(db: DB, id: number, ownerId: number, x: number, y: number, dir: number): number {
  return db
    .prepare('UPDATE home_furniture SET x = ?, y = ?, dir = ? WHERE id = ? AND owner_id = ?')
    .run(x, y, dir, id, ownerId).changes;
}

export function deleteFurniture(db: DB, id: number, ownerId: number): number {
  return db.prepare('DELETE FROM home_furniture WHERE id = ? AND owner_id = ?').run(id, ownerId).changes;
}

// 家具白名单：启动时 loadCatalog() 从 home-furniture-catalog.json 载入内存 Set
// （与 gather-spawn-table.json 同惯例：生成文件强制提交进 git，随部署上服务器，无需在服务器跑 extract）。
let catalog: Set<number> = new Set();
const CATALOG_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../../data/home-furniture-catalog.json');

export function loadCatalog(): void {
  try {
    if (existsSync(CATALOG_PATH)) {
      const arr = JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) as { furniture_id: number }[];
      catalog = new Set(arr.map((r) => r.furniture_id));
      return;
    }
  } catch {
    /* 缺文件 / 解析失败 → 空白名单（摆放一律 NOT_FURNITURE，安全降级） */
  }
  catalog = new Set();
}

// 测试用：直接注入白名单（不依赖文件/DB）。
export function setCatalogForTest(ids: number[]): void {
  catalog = new Set(ids);
}

export function isFurniture(furnitureId: number): boolean {
  return catalog.has(furnitureId);
}

export function catalogSize(): number {
  return catalog.size;
}
