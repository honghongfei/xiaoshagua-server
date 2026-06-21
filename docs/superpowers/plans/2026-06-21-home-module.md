# 家园模块 实现计划

> **面向 AI 代理的工作者：** 用 executing-plans 逐任务实现。完整设计见 `../specs/2026-06-21-home-module-design.md`，本计划只列可执行步骤与验证。
> **范围**：本计划覆盖 **H-A 服务端核心 + H-B 数据管线 + H-D 老存档迁移 + 收尾**（均可独立 typecheck/vitest 跑通），以及 **H-C 客户端组（高风险，目标行为 + 挂点，落地时对照 800+ 行活文件 `XdRs_Online_Trade.js`/`Hub`/`Friend` 定稿，建议单独细化成子计划）**。
> **已锁定决策（用户确认）**：可见性由房主设（private/friends/public）；家具来源 A+B+C，家具拥有复用现有 `inventory`；升级沿用原版"换底图"（开关 582~611 + parallax 装修图 + 升级动画 119），零新美术；分期 A→D→B→C，本计划落 期1（搬上线+房型服务端权威+槽位）+ 期2 家具 DIY。

**目标：** 把原版单机家园（房型升级 + 装修地图 + 家具道具）搬成**每人一间的私有实例化家园**：房型/风格/家具布局/花园解锁服务端权威持久化；房主可设可见性；家具可自由 DIY 摆放；好友可串门、实时同步。
**架构：** 新增 `domain/home`（`homeRepo` + `homeService`）；家园 = 确定性虚拟地图 `HOME_VBASE + ownerPid`，玩家走动复用现有 `worldService`/`world.delta`；家具拥有复用 `inventory`，新增 `home_furniture` 布局表，摆放/收回单事务原子；客户端新增 `XdRs_Online_Home.js` 渲染现成装修图 + 家具叠加层 + 编辑态 + 访客同步；数据管线从 `MapInfos.json`/`Items.json` 抽房型→地图映射与家具白名单。
**技术栈：** TypeScript + socket.io + better-sqlite3 + zod + vitest（服务端）；RMMZ/NW.js（客户端）。

## 文件结构

服务端（`xiaoshagua-server/server/src/`）：
- 新增 `db/migrations/004_home.sql`：`home` / `home_furniture` / `home_furniture_catalog` 三表 + 索引。
- 新增 `domain/home/homeRepo.ts`：三表 CRUD + 家具白名单加载（类比 `marketRepo`）。
- 新增 `domain/home/homeService.ts`：enter（可见性校验）、setVisibility/setStyle、upgrade、家具 place/move/remove、实例化与房型→地图解析（类比 `marketService`/`dungeonService`）。
- 改 `util/schema.ts`：`HomeEnter / HomePidOnly / HomeVisibility / HomeStyle / HomeFurniturePlace / HomeFurnitureMove / HomeIdOnly`。
- 改 `config.ts`：家园常量。
- 改 `gateway/router.ts`：9 个 `home.*` handler（范式同既有 handler）。
- 新增 `scripts/extract-home.ts`：扫 `MapInfos.json` 生成房型→地图映射草表；扫 `Items.json` 生成家具白名单。
- 新增 `server/data/home-map-table.json`、`server/data/home-furniture-catalog.json`：构建产物。
- 新增 `test/homeService.test.ts`。

客户端（`xiaoshagua/js/plugins/`，镜像 `client-plugins/`）：
- 新增 `XdRs_Online_Home.js`：进家流程 + 现成装修图渲染（按服务端房型设开关）+ 家具 DIY 叠加层 + 访客同步 + 双态（联机/单机）。
- 改 `plugins.js`：注册 `XdRs_Online_Home`（Market 之后、Hub 之前）。
- 改 `XdRs_Online_Hub.js`：宫格加「我的家园」；`XdRs_Online_Friend.js`：加「去TA家」。
- 数据：给 `Items.json` 的 `⭐家具-*` 补 notetag `<HomeFurniture>`（非代码）。

## 统一类型 & wire 协议

```ts
// home 行
interface HomeRow {
  owner_id: number; building: 'coconut' | 'skygarden'; tier: number;
  style: string; visibility: 'private' | 'friends' | 'public';
  furniture_slots: number; garden_unlocked: 0 | 1; bonus_json: string | null;
  created_at: number; updated_at: number;
}
// 已摆家具
interface FurnitureRow {
  id: number; owner_id: number; furniture_id: number;
  x: number; y: number; dir: number; layer: number; created_at: number;
}
// wire: server → client 进家返回
interface HomeEnterResult {
  ownerPid: number; virtualMapId: number; baseMapId: number;
  building: string; tier: number; style: string;
  gardenUnlocked: boolean; visibility: string; canEdit: boolean;
  furniture: { id: number; furnitureId: number; x: number; y: number; dir: number; layer: number }[];
  spawn: { x: number; y: number; d: number };
}
// wire: server → client 推送
// 'home.furniture.evt' { op:'place'|'move'|'remove', item:{id,furnitureId,x,y,dir,layer} }
// 'home.update.evt'    { tier?, style?, gardenUnlocked?, visibility? }
```

---

## H-A · 服务端核心

### A1 · 迁移 `004_home.sql`
**文件：** 新增 `server/src/db/migrations/004_home.sql`
**步骤：**
```sql
CREATE TABLE IF NOT EXISTS home (
  owner_id        INTEGER PRIMARY KEY REFERENCES character(id) ON DELETE CASCADE,
  building        TEXT    NOT NULL DEFAULT 'coconut' CHECK(building IN ('coconut','skygarden')),
  tier            INTEGER NOT NULL DEFAULT 0,
  style           TEXT    NOT NULL DEFAULT 'base',
  visibility      TEXT    NOT NULL DEFAULT 'private' CHECK(visibility IN ('private','friends','public')),
  furniture_slots INTEGER NOT NULL DEFAULT 20,
  garden_unlocked INTEGER NOT NULL DEFAULT 0,
  bonus_json      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS home_furniture (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id      INTEGER NOT NULL REFERENCES character(id) ON DELETE CASCADE,
  furniture_id  INTEGER NOT NULL,
  x             INTEGER NOT NULL CHECK(x >= 0 AND x <= 999),
  y             INTEGER NOT NULL CHECK(y >= 0 AND y <= 999),
  dir           INTEGER NOT NULL DEFAULT 2 CHECK(dir IN (2,4,6,8)),
  layer         INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_home_furniture_owner ON home_furniture(owner_id);

CREATE TABLE IF NOT EXISTS home_furniture_catalog (
  furniture_id  INTEGER PRIMARY KEY,
  layer         INTEGER NOT NULL DEFAULT 1,
  w             INTEGER NOT NULL DEFAULT 1,
  h             INTEGER NOT NULL DEFAULT 1
);
```
**验证：** `npm run migrate` 应用 `004_home.sql`，`_migration` 表出现该行（再次跑为 skipped）。
**提交：** `feat(server): 004_home.sql (home/home_furniture/catalog)`

### A2 · `homeRepo.ts`
**文件：** 新增 `server/src/domain/home/homeRepo.ts`
**步骤：**
```ts
import { openDb, withTx, type DB } from '../../db/sqlite.js';

export interface HomeRow {
  owner_id: number; building: 'coconut' | 'skygarden'; tier: number;
  style: string; visibility: 'private' | 'friends' | 'public';
  furniture_slots: number; garden_unlocked: 0 | 1; bonus_json: string | null;
  created_at: number; updated_at: number;
}
export interface FurnitureRow {
  id: number; owner_id: number; furniture_id: number;
  x: number; y: number; dir: number; layer: number; created_at: number;
}

export function tx<T>(fn: (db: DB) => T): T { return withTx(openDb(), fn); }

export function ensureHome(ownerId: number, now: number): void {
  openDb().prepare(
    `INSERT OR IGNORE INTO home
       (owner_id, building, tier, style, visibility, furniture_slots, garden_unlocked, bonus_json, created_at, updated_at)
     VALUES (?, 'coconut', 0, 'base', 'private', 20, 0, NULL, ?, ?)`
  ).run(ownerId, now, now);
}

export function getHome(ownerId: number): HomeRow | undefined {
  return openDb().prepare('SELECT * FROM home WHERE owner_id = ?').get(ownerId) as HomeRow | undefined;
}

export function updateTier(db: DB, ownerId: number, tier: number, slots: number, garden: 0 | 1, now: number): void {
  db.prepare('UPDATE home SET tier=?, furniture_slots=?, garden_unlocked=?, updated_at=? WHERE owner_id=?')
    .run(tier, slots, garden, now, ownerId);
}
export function setVisibility(db: DB, ownerId: number, visibility: string, now: number): number {
  return db.prepare('UPDATE home SET visibility=?, updated_at=? WHERE owner_id=?').run(visibility, now, ownerId).changes;
}
export function setStyle(db: DB, ownerId: number, style: string, now: number): number {
  return db.prepare('UPDATE home SET style=?, updated_at=? WHERE owner_id=?').run(style, now, ownerId).changes;
}

export function listFurniture(ownerId: number): FurnitureRow[] {
  return openDb().prepare('SELECT * FROM home_furniture WHERE owner_id=? ORDER BY layer, id').all(ownerId) as FurnitureRow[];
}
export function countFurniture(ownerId: number): number {
  const r = openDb().prepare('SELECT COUNT(*) AS n FROM home_furniture WHERE owner_id=?').get(ownerId) as { n: number };
  return r.n;
}
export function cellOccupied(ownerId: number, x: number, y: number, layer: number): boolean {
  const r = openDb().prepare('SELECT 1 FROM home_furniture WHERE owner_id=? AND x=? AND y=? AND layer=? LIMIT 1')
    .get(ownerId, x, y, layer);
  return !!r;
}
export function getFurnitureById(id: number): FurnitureRow | undefined {
  return openDb().prepare('SELECT * FROM home_furniture WHERE id=?').get(id) as FurnitureRow | undefined;
}
export function insertFurniture(db: DB, ownerId: number, furnitureId: number, x: number, y: number, dir: number, layer: number, now: number): number {
  const info = db.prepare(
    'INSERT INTO home_furniture (owner_id, furniture_id, x, y, dir, layer, created_at) VALUES (?,?,?,?,?,?,?)'
  ).run(ownerId, furnitureId, x, y, dir, layer, now);
  return Number(info.lastInsertRowid);
}
export function moveFurniture(db: DB, id: number, ownerId: number, x: number, y: number, dir: number): number {
  return db.prepare('UPDATE home_furniture SET x=?, y=?, dir=? WHERE id=? AND owner_id=?').run(x, y, dir, id, ownerId).changes;
}
export function deleteFurniture(db: DB, id: number, ownerId: number): number {
  return db.prepare('DELETE FROM home_furniture WHERE id=? AND owner_id=?').run(id, ownerId).changes;
}

// 家具白名单：从 home_furniture_catalog 一次性载入内存 Set（启动时 loadCatalog 调一次）
let catalog: Set<number> = new Set();
export function loadCatalog(): void {
  const rows = openDb().prepare('SELECT furniture_id FROM home_furniture_catalog').all() as { furniture_id: number }[];
  catalog = new Set(rows.map((r) => r.furniture_id));
}
export function isFurniture(furnitureId: number): boolean { return catalog.has(furnitureId); }
export function catalogSize(): number { return catalog.size; }
```
**验证：** `npm run typecheck`。
**提交：** `feat(server): homeRepo (home/furniture CRUD + catalog whitelist)`

### A3 · `homeService.ts`（实例化 + 进家 + 可见性/风格/升级）
**文件：** 新增 `server/src/domain/home/homeService.ts`
**步骤：**
```ts
import type { Server } from 'socket.io';
import { config } from '../../config.js';
import { log } from '../../log.js';
import { AppError } from '../../util/errors.js';
import * as invRepo from '../inventory/inventoryRepo.js';
import { getOnlineByPid } from '../player/playerService.js';
import { isFriend, isBlocked } from '../social/socialService.js';
import { resolveBaseMap, spawnFor } from './homeMaps.js';
import * as repo from './homeRepo.js';

let io: Server | null = null;
export function attachHomeIo(s: Server): void { io = s; repo.loadCatalog(); }

export function homeVirtualMapId(ownerPid: number): number { return config.homeVirtualBase + ownerPid; }
function roomOf(virtualMapId: number): string { return `map:${virtualMapId}`; }

export interface HomeEnterResult {
  ownerPid: number; virtualMapId: number; baseMapId: number;
  building: string; tier: number; style: string;
  gardenUnlocked: boolean; visibility: string; canEdit: boolean;
  furniture: { id: number; furnitureId: number; x: number; y: number; dir: number; layer: number }[];
  spawn: { x: number; y: number; d: number };
}

function furnitureView(rows: repo.FurnitureRow[]) {
  return rows.map((r) => ({ id: r.id, furnitureId: r.furniture_id, x: r.x, y: r.y, dir: r.dir, layer: r.layer }));
}

export function enter(selfPid: number, ownerPid?: number): HomeEnterResult {
  const target = ownerPid ?? selfPid;
  repo.ensureHome(target, Date.now());
  const home = repo.getHome(target);
  if (!home) throw new AppError('INTERNAL', 'home row missing', 500);
  if (target !== selfPid) {
    if (isBlocked(target, selfPid)) throw new AppError('BLOCKED', 'you are blocked by owner');
    if (home.visibility === 'private') throw new AppError('FORBIDDEN', 'home is private');
    if (home.visibility === 'friends' && !isFriend(target, selfPid)) throw new AppError('NOT_FRIEND', 'friends only');
  }
  const baseMapId = resolveBaseMap(home.building, home.tier, home.style);
  const spawn = spawnFor(home.building);
  return {
    ownerPid: target,
    virtualMapId: homeVirtualMapId(target),
    baseMapId,
    building: home.building,
    tier: home.tier,
    style: home.style,
    gardenUnlocked: home.garden_unlocked === 1,
    visibility: home.visibility,
    canEdit: target === selfPid,
    furniture: furnitureView(repo.listFurniture(target)),
    spawn,
  };
}

export function setVisibility(pid: number, visibility: 'private' | 'friends' | 'public'): { visibility: string } {
  repo.ensureHome(pid, Date.now());
  repo.tx((db) => repo.setVisibility(db, pid, visibility, Date.now()));
  broadcast(pid, 'home.update.evt', { visibility });
  return { visibility };
}

export function setStyle(pid: number, style: string): { style: string } {
  const home = mustHome(pid);
  if (!stylesForTier(home.building, home.tier).includes(style)) throw new AppError('BAD_STYLE', 'style not unlocked');
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
    const voucherId = voucherItemFor(nextTier);
    const inv = invRepo.listInventory(pid);
    const hasVoucher = voucherId > 0 && (inv.find((r) => r.kind === 'item' && r.data_id === voucherId)?.count ?? 0) >= 1;
    if (hasVoucher) {
      invRepo.applyItemDelta(db, pid, 'item', voucherId, -1);
    } else {
      const price = config.homeUpgradePrices[nextTier - 1];
      if (price == null) throw new AppError('NO_VOUCHER', 'need a house voucher');
      if (invRepo.getGold(pid) < price) throw new AppError('NOT_ENOUGH_GOLD', `need ${price}`);
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

export function placeFurniture(pid: number, furnitureId: number, x: number, y: number, dir: number, layer: number): { id: number } {
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
    if ((row.x !== x || row.y !== y || row.layer !== row.layer) && repo.cellOccupied(pid, x, y, row.layer) && !(row.x === x && row.y === y)) {
      throw new AppError('CELL_OCCUPIED', 'cell occupied');
    }
    const n = repo.moveFurniture(db, id, pid, x, y, dir);
    if (n !== 1) throw new AppError('NOT_FOUND', 'furniture gone');
    broadcast(pid, 'home.furniture.evt', { op: 'move', item: { id, furnitureId: row.furniture_id, x, y, dir, layer: row.layer } });
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
    broadcast(pid, 'home.furniture.evt', { op: 'remove', item: { id, furnitureId: row.furniture_id, x: row.x, y: row.y, dir: row.dir, layer: row.layer } });
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
function voucherItemFor(tier: number): number {
  return config.homeVoucherItemIds[tier - 1] ?? 0; // 0 = 无对应券，走金币兜底
}
function stylesForTier(building: string, tier: number): string[] {
  return ['base']; // 占位：实际由 homeMaps 提供该 (building,tier) 的合法风格集合，见 B1
}
```
> 注：`stylesForTier` 的真实实现依赖 B1 产出的映射表。A3 落地时把它改为 `import { stylesForTier } from './homeMaps.js'`，删除此处占位函数。本步骤先以 `['base']` 让 typecheck 通过，B1 完成后替换（见 B1 验证）。
**验证：** `npm run typecheck`（`homeMaps.ts` 由 B1 创建；若先做 A3，可临时桩 `resolveBaseMap/spawnFor/stylesForTier` 返回定值，B1 再替换）。
**提交：** `feat(server): homeService (enter/visibility/style/upgrade/furniture)`

### A4 · `schema.ts` 追加
**文件：** 改 `server/src/util/schema.ts`
**步骤：**
```ts
export const HomeEnter = z.object({ ownerPid: z.number().int().positive().optional() });
export const HomePidOnly = z.object({ ownerPid: z.number().int().positive() });
export const HomeVisibility = z.object({ visibility: z.enum(['private', 'friends', 'public']) });
export const HomeStyle = z.object({ style: z.string().min(1).max(32) });
export const HomeFurniturePlace = z.object({
  furnitureId: z.number().int().positive(),
  x: z.number().int().min(0).max(999),
  y: z.number().int().min(0).max(999),
  dir: z.number().int().refine((v) => v === 2 || v === 4 || v === 6 || v === 8, { message: 'd must be 2/4/6/8' }),
  layer: z.number().int().min(0).max(3).default(1),
});
export const HomeFurnitureMove = z.object({
  id: z.number().int().positive(),
  x: z.number().int().min(0).max(999),
  y: z.number().int().min(0).max(999),
  dir: z.number().int().refine((v) => v === 2 || v === 4 || v === 6 || v === 8, { message: 'd must be 2/4/6/8' }),
});
export const HomeIdOnly = z.object({ id: z.number().int().positive() });
```
**验证：** `npm run typecheck`。
**提交：** `feat(server): home zod schemas`

### A5 · `config.ts` 追加
**文件：** 改 `server/src/config.ts`（在 config 对象内，沿用 `num()` 风格；数组直接字面量）
**步骤：**
```ts
  homeVirtualBase: num(process.env.HOME_VBASE, 20_000_000),
  homeMaxTier: num(process.env.HOME_MAX_TIER, 17),
  homeBaseFurnSlots: num(process.env.HOME_BASE_SLOTS, 20),
  homeFurnSlotPerTier: num(process.env.HOME_SLOT_PER_TIER, 4),
  homeGardenTier: num(process.env.HOME_GARDEN_TIER, 4),
  homeMaxFurniture: num(process.env.HOME_MAX_FURNITURE, 300),
  // 升级金币兜底价（index = 目标 tier-1），无房型券时用；扣的金币销毁。长度需覆盖到 homeMaxTier。
  homeUpgradePrices: [
    5_000, 20_000, 80_000, 300_000, 1_000_000, 3_000_000, 8_000_000, 20_000_000,
    50_000_000, 100_000_000, 200_000_000, 300_000_000, 400_000_000, 500_000_000, 700_000_000, 900_000_000, 999_000_000,
  ] as number[],
  // 房型券物品 id（index = 目标 tier-1）；缺省/0 = 该等级无券、仅金币升级。实现时按实际 Items.json 券 id 填，先全 0。
  homeVoucherItemIds: [] as number[],
```
**验证：** `npm run typecheck`。
**提交：** `feat(server): home config constants`

### A6 · router 接线（9 事件）
**文件：** 改 `server/src/gateway/router.ts`
**步骤：**
- import：
```ts
import {
  attachHomeIo, enter as homeEnter, setVisibility as homeSetVisibility,
  setStyle as homeSetStyle, upgrade as homeUpgrade,
  placeFurniture, moveFurniture, removeFurniture,
} from '../domain/home/homeService.js';
import { HomeEnter, HomePidOnly, HomeVisibility, HomeStyle, HomeFurniturePlace, HomeFurnitureMove, HomeIdOnly } from '../util/schema.js';
```
- `installRouter` 顶部（`attachTradeIo(io)` 旁）加：`attachHomeIo(io);`
- 在 `io.on('connection')` 内追加 handler（范式同既有 market/trade handler）：
```ts
    socket.on('home.enter', (raw, ack) => {
      const cb = safeAck(ack);
      try {
        if (!takeToken(socket)) throw new AppError('RATE_LIMIT', 'too many requests');
        const s = requireAuth(socket);
        const input = parse(HomeEnter, raw);
        cb?.(okAck(homeEnter(s.pid, input.ownerPid)));
      } catch (err) { sendError(socket, cb, err); }
    });

    socket.on('home.setVisibility', (raw, ack) => {
      const cb = safeAck(ack);
      try {
        if (!takeToken(socket)) throw new AppError('RATE_LIMIT', 'too many requests');
        const s = requireAuth(socket);
        const input = parse(HomeVisibility, raw);
        cb?.(okAck(homeSetVisibility(s.pid, input.visibility)));
      } catch (err) { sendError(socket, cb, err); }
    });

    socket.on('home.setStyle', (raw, ack) => {
      const cb = safeAck(ack);
      try {
        if (!takeToken(socket)) throw new AppError('RATE_LIMIT', 'too many requests');
        const s = requireAuth(socket);
        const input = parse(HomeStyle, raw);
        cb?.(okAck(homeSetStyle(s.pid, input.style)));
      } catch (err) { sendError(socket, cb, err); }
    });

    socket.on('home.upgrade', (_raw, ack) => {
      const cb = safeAck(ack);
      try {
        if (!takeToken(socket)) throw new AppError('RATE_LIMIT', 'too many requests');
        const s = requireAuth(socket);
        cb?.(okAck(homeUpgrade(s.pid)));
      } catch (err) { sendError(socket, cb, err); }
    });

    socket.on('home.furniture.place', (raw, ack) => {
      const cb = safeAck(ack);
      try {
        if (!takeToken(socket)) throw new AppError('RATE_LIMIT', 'too many requests');
        const s = requireAuth(socket);
        const i = parse(HomeFurniturePlace, raw);
        cb?.(okAck(placeFurniture(s.pid, i.furnitureId, i.x, i.y, i.dir, i.layer)));
      } catch (err) { sendError(socket, cb, err); }
    });

    socket.on('home.furniture.move', (raw, ack) => {
      const cb = safeAck(ack);
      try {
        if (!takeToken(socket)) throw new AppError('RATE_LIMIT', 'too many requests');
        const s = requireAuth(socket);
        const i = parse(HomeFurnitureMove, raw);
        cb?.(okAck(moveFurniture(s.pid, i.id, i.x, i.y, i.dir)));
      } catch (err) { sendError(socket, cb, err); }
    });

    socket.on('home.furniture.remove', (raw, ack) => {
      const cb = safeAck(ack);
      try {
        if (!takeToken(socket)) throw new AppError('RATE_LIMIT', 'too many requests');
        const s = requireAuth(socket);
        const i = parse(HomeIdOnly, raw);
        cb?.(okAck(removeFurniture(s.pid, i.id)));
      } catch (err) { sendError(socket, cb, err); }
    });

    socket.on('home.furniture.snapshot', (raw, ack) => {
      const cb = safeAck(ack);
      try {
        const s = requireAuth(socket);
        const input = parse(HomePidOnly, raw);
        // 复用 enter 的可见性校验拿布局；只回 furniture（轻量兜底）
        const r = homeEnter(s.pid, input.ownerPid);
        cb?.(okAck({ furniture: r.furniture }));
      } catch (err) { sendError(socket, cb, err); }
    });
```
> `home.leave` 不需要专设：玩家离开家园 = 走既有 `player.enterMap` 去别的图 / `disconnect`，`worldService` 自动把其移出该 virtualMapId 房间。
**验证：** `npm run typecheck`。
**提交：** `feat(server): wire home.* socket handlers`

### A7 · 服务端单测 `homeService.test.ts`
**文件：** 新增 `server/test/homeService.test.ts`（参考 `marketService.test.ts` 的 DB 初始化与造数据方式）
**步骤：**
```ts
import { describe, it, expect, beforeEach } from 'vitest';
// 按 marketService.test 的方式初始化内存/临时 DB + 跑 runMigrations + 造 character + 给家具道具入库
// 关键断言：
// 1. enter 自己家：ensureHome 建行，canEdit=true
// 2. enter 私密家被他人：抛 FORBIDDEN；friends 档非好友抛 NOT_FRIEND
// 3. place：背包家具 -1 + listFurniture 多一行；非家具 NOT_FURNITURE；不持有 NOT_OWNED；满槽 SLOT_FULL；占格 CELL_OCCUPIED
// 4. remove：删行 + 背包 +1；非房主 FORBIDDEN
// 5. 守恒：place 后 remove，背包该家具数量回到初值
// 6. upgrade：有券扣券 tier++；无券有金币扣金币 tier++；满级 TIER_MAXED
describe('homeService', () => {
  beforeEach(() => { /* migrate + seed */ });
  it('place then remove conserves inventory', () => {
    // const before = ownedCount(pid, fid);
    // const { id } = placeFurniture(pid, fid, 5, 5, 2, 1);
    // expect(ownedCount(pid, fid)).toBe(before - 1);
    // removeFurniture(pid, id);
    // expect(ownedCount(pid, fid)).toBe(before);
  });
});
```
> 实现时把注释展开为真实用例（参照 `marketService.test.ts` 的 seed helper：建 character、`invRepo` 入库家具道具、把 `home_furniture_catalog` 插入该家具 id）。**至少覆盖上面 6 条断言。**
**验证：** `cd xiaoshagua-server/server && npm test`（新用例通过，无回归）。
**提交：** `test(server): home enter/visibility/place/remove/upgrade`

---

## H-B · 数据管线（房型→地图映射 + 家具白名单）

### B1 · `extract-home.ts` + `homeMaps.ts`
**文件：** 新增 `server/scripts/extract-home.ts`、新增 `server/src/domain/home/homeMaps.ts`、产出 `server/data/home-map-table.json`
**步骤：**
- `extract-home.ts`：读 `../../xiaoshagua/data/MapInfos.json`，对每条 `name` 匹配正则 `^(椰树大厦|空中花园).*（家）(\d+)(\S*)$`（楼栋 → building、数字 → tier、后缀 → style），输出：
```ts
// home-map-table.json 形如
// { "coconut": { "0": { "base": 61 }, "2": { "米黄": 42, ... } }, "skygarden": { ... } }
```
  楼栋映射：椰树大厦→`coconut`，空中花园→`skygarden`；`0毛坯`→tier 0、style `base`。无法解析的家图记到日志供人工补。
- `homeMaps.ts`：加载该 JSON，导出 `resolveBaseMap(building, tier, style)`（缺风格回退该 tier 第一个；缺 tier 回退 0）、`spawnFor(building)`（每楼栋的进门落点，常量配置：如 coconut `{x:8,y:9,d:2}`）、`stylesForTier(building, tier)`（返回该 tier 已配置的风格名数组）。
```ts
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const TABLE = join(here, '../../../data/home-map-table.json');
type Table = Record<string, Record<string, Record<string, number>>>;
let t: Table = {};
try { if (existsSync(TABLE)) t = JSON.parse(readFileSync(TABLE, 'utf8')) as Table; } catch { t = {}; }
const SPAWN: Record<string, { x: number; y: number; d: number }> = {
  coconut: { x: 8, y: 9, d: 2 }, skygarden: { x: 8, y: 9, d: 2 },
};
export function resolveBaseMap(building: string, tier: number, style: string): number {
  const b = t[building] ?? {};
  const byStyle = b[String(tier)] ?? b['0'] ?? {};
  return byStyle[style] ?? Object.values(byStyle)[0] ?? 61; // 61 = 空中花园 0 毛坯兜底
}
export function spawnFor(building: string): { x: number; y: number; d: number } {
  return SPAWN[building] ?? SPAWN.coconut;
}
export function stylesForTier(building: string, tier: number): string[] {
  return Object.keys((t[building] ?? {})[String(tier)] ?? { base: 0 });
}
```
> A3 落地后把 `homeService` 里的占位 `stylesForTier` 删除，改 `import { resolveBaseMap, spawnFor, stylesForTier } from './homeMaps.js'`。
**验证：** `tsx scripts/extract-home.ts` 跑通，`home-map-table.json` 含 coconut+skygarden、每楼栋有 tier 0 与若干风格；人工抽查 3 个映射对得上 `MapInfos.json`（**这一步是设计 §10 标注的已知缺口的填补，需人工校对**）。
**提交：** `feat(server): extract home map table + homeMaps resolver`

### B2 · 家具白名单 + notetag
**文件：** 扩展 `server/scripts/extract-home.ts`、产出 `server/data/home-furniture-catalog.json`、改 `xiaoshagua/data/Items.json`（数据）
**步骤：**
- 给 `Items.json` 中所有 `⭐家具-*` 物品的 `note` 追加 `<HomeFurniture>`（可选 `<FurnitureLayer:1>`）。
- `extract-home.ts` 增：扫 `Items.json`，`note` 含 `<HomeFurniture>`（或名称前缀 `⭐家具-` 兜底）的 item → `{ furniture_id:id, layer:解析<FurnitureLayer:n>默认1, w:1, h:1 }`，写 `home-furniture-catalog.json`。
- 新增迁移或启动加载：把 `home-furniture-catalog.json` 灌入 `home_furniture_catalog` 表（提供 `scripts/seed-furniture-catalog.ts`：读 JSON → `INSERT OR REPLACE`）。`homeService.attachHomeIo` 已调 `repo.loadCatalog()` 从表载入内存。
**验证：** `tsx scripts/extract-home.ts` 产出 catalog JSON 含全部 `⭐家具-*`（条数 ≈ Items.json 中家具数）；`tsx scripts/seed-furniture-catalog.ts` 后 `SELECT COUNT(*) FROM home_furniture_catalog` > 0；重启服务 `repo.catalogSize()` > 0。
**提交：** `feat(server): home furniture catalog whitelist (extract + seed + Items notetag)`

---

## H-C · 客户端 `XdRs_Online_Home.js`（高风险，目标行为 + 挂点）

> 设计 §7。本组**实现时对照活文件** `XdRs_Online_Trade.js`（DOM 浮层 + 事件拦截范式）、`XdRs_Online_Hub.js`（宫格入口）、`XdRs_Online_PlayerSync.js`（enterMap 流程）定稿。建议本组单独细化为子计划。下为目标行为与挂点。

### C1 · 进家流程 + 现成装修图渲染
**文件：** 新增 `xiaoshagua/js/plugins/XdRs_Online_Home.js`
**目标行为：**
- `XdRsOnline.Home.enterHome(ownerPid?)`：`Net.request('home.enter',{ownerPid})` → 拿 `HomeEnterResult`。
- 按 `building/tier/style` 把房型开关 582~611 单选置位（仅渲染；映射表与服务端 `homeMaps` 同源，客户端内置一份等价表或随 enter 下发开关号）。**推荐**：服务端 enter 额外下发 `renderSwitchId`（由 homeMaps 给出该 (building,tier,style) 对应开关号），客户端直接 `$gameSwitches.setValue(renderSwitchId, true)` + 关同组，免维护两份表。
- `$gamePlayer.reserveTransfer(baseMapId, spawn.x, spawn.y, spawn.d)` 进装修图；进图后调既有 `PlayerSync` 的 `player.enterMap(virtualMapId, spawn)` 接入 world 房间（拿同房玩家走动）。
**挂点：** `Scene_Map`/`PlayerSync` 现有 enterMap 流程；开关置位用 `$gameSwitches`。
**验证：** `node --check XdRs_Online_Home.js`；运行期进自己家落到对应装修图。
**提交：** `feat(client): home enter + render existing decor by server tier`

### C2 · 家具 DIY 叠加层（编辑态）
**文件：** 改 `XdRs_Online_Home.js`
**目标行为：**
- 在 `Spriteset_Map` 之上挂家具容器，按 `furniture[]` 逐件画（家具图标 `iconIndex` 或专用图集，按 `layer` 排序、`x*tileW,y*tileH` 定位）。
- 编辑态（`canEdit`）：从背包家具列表（`$gameParty` 中 `<HomeFurniture>` 物品）选一件 → 选格 → `Net.request('home.furniture.place',{furnitureId,x,y,dir,layer})` → 成功后本地加 sprite + reconcile 背包；点已摆家具拖动→`home.furniture.move`、收回→`home.furniture.remove`（背包+1）。
- 乐观更新 + ack 校正；失败回滚本地。
**挂点：** Trade 的 DOM 浮层 + 事件拦截（防穿透 RMMZ 寻路）；背包读取复用 Trade/Market 的 `listOwnedItems()` 思路。
**验证：** `node --check`；运行期摆/移/收家具，背包数量随之变化。
**提交：** `feat(client): furniture DIY overlay + edit mode`

### C3 · 访客同步 + 双态
**文件：** 改 `XdRs_Online_Home.js`
**目标行为：**
- `Net.on('home.furniture.evt', ...)`：op=place/move/remove → 增改删对应 sprite（访客实时看到房主装修）。
- `Net.on('home.update.evt', ...)`：tier/style 变 → 重置房型开关 + 重载 baseMapId；visibility 变 → 更新面板。
- 双态：联机态房型开关只读（仅由 enter/update 驱动）；单机离线态保持原版开关逻辑不变（用 `Net.isConnected()` 判定）。
**挂点：** Net 事件总线；`$gameSwitches`。
**验证：** 两客户端：A 摆家具，B（在 A 家）实时看到。
**提交：** `feat(client): visitor live sync + online/offline dual-mode`

### C4 · 入口 + 注册 + 镜像
**文件：** 改 `xiaoshagua/js/plugins.js`、`XdRs_Online_Hub.js`、`XdRs_Online_Friend.js`；镜像 `XdRs_Online_Home.js` 到 `client-plugins/`
**目标行为：** Hub 宫格加「我的家园」→ `Home.enterHome()`；好友/在线列表加「去TA家」→ `Home.enterHome(targetPid)`；`plugins.js` 在 Market 之后、Hub 之前注册 `XdRs_Online_Home`。
**验证：** `node --check` 改动文件；`plugins.js` JSON 合法；`fc` 镜像一致。
**提交：** `chore(client): register + entries + mirror XdRs_Online_Home`

---

## H-D · 老存档房型迁移

### D1 · 首次进家迁移本地开关 → 服务端
**文件：** 改 `XdRs_Online_Home.js`（客户端侧一次性迁移）
**目标行为：**
- 玩家首次联机进家时，若服务端 `home.tier===0 && style==='base'`（默认未迁移）且本地开关 582~611 有置位 → 客户端反推 `(building,tier,style)` → 调一个迁移 RPC（可复用 `home.setStyle` + 新增 `home.migrate {building,tier,style}` 或在 `home.enter` 带 `migrateFrom`）把本地房型灌服务端一次。
- 之后以服务端为准。
> 服务端如需 `home.migrate`：在 A3/A6 增一个受限 handler（仅本人、仅当服务端仍是默认值时允许，防覆盖）。本任务落地时定接口形态。
**验证：** 用一个本地已升级房型的存档联机进家 → 服务端 `home` 行 tier/style 被正确灌入，再次进家从服务端读出一致。
**提交：** `feat(home): one-time migrate local house tier to server`

---

## 收尾

### E1 · 全量校验
**步骤：** 服务端 `npm run typecheck && npm test && npm run build && npm run migrate`；客户端改动文件 `node --check`；`plugins.js` JSON 合法；全部改动文件 ReadLints；`client-plugins` 镜像 `fc` 一致。修掉一切错误。
**提交：** `chore: typecheck/test/lint/build pass for home module`

---

## 验证（上线前汇总，对应设计 §11/§13）

- 服务端：`npm run typecheck`=0；`npm test` 全绿（含 homeService：enter 可见性三档、place/remove 守恒、SLOT_FULL/CELL_OCCUPIED/NOT_OWNED/NOT_FURNITURE、upgrade 券/金币/满级）；`npm run build`=0；`npm run migrate` 应用 004。
- 数据管线：`tsx scripts/extract-home.ts` 产出合法 `home-map-table.json` + `home-furniture-catalog.json`（人工抽查 3 个房型映射、家具条数对得上）。
- 客户端：`node --check` 全过；镜像一致。
- 运行期实测：进自己家落对应装修图；好友进我家（friends 档）可见装修+家具+彼此走动，陌生人被拒；切 private 好友再进被拒；升级换图 + 槽位增 + 4 级花园；A 摆家具 B 实时看到；**防作弊：改客户端开关 582~611 不改变服务端房型真值**（重连后被服务端值覆盖）。

## 计划自检

- **规格覆盖**：设计 §4→A1/A2；§5→A5；§6.1 实例化→A3(homeVirtualMapId)；§6.2 事件→A6（9 handler，含 snapshot；leave 复用 world）；§6.3 enter→A3；§6.4 upgrade→A3；§6.5 家具→A3(place/move/remove)；§6.6 可见性/风格→A3；§6.7 白名单→B2；§7 客户端→C1~C4；§10 房型→地图映射缺口→B1（脚本+人工校对）；老存档迁移→D1；§11 测试→A7+汇总。
- **占位符**：服务端 A1/A2/A4/A5/A6 + 数据管线 B1/B2 为完整代码；**A3 的 `stylesForTier` 临时桩**（B1 后替换，已显式标注）；**A7 用例骨架**（注释列出 6 条必覆盖断言，实现时展开，参照 marketService.test seed 范式）；**H-C 客户端**为目标行为+挂点（800+ 行活文件，落地对照定稿，已在组首显式标注）——三者均为"实现时确认/展开"项，非遗漏。
- **类型一致**：`HomeRow`/`FurnitureRow` 定义(A2)贯穿 A3/A7；`HomeEnterResult` 定义(A3)与 router 返回(A6)、客户端消费(C1)一致；`resolveBaseMap/spawnFor/stylesForTier` 定义(B1)与调用(A3)一致；wire `home.furniture.evt {op,item}` / `home.update.evt` 在 A3(broadcast)与 C3(订阅)一致；`placeFurniture(pid,furnitureId,x,y,dir,layer)` 定义(A3)与调用(A6)一致。
- **风险**：H-C 为最高风险（RMMZ DIY 叠加层 + 双态开关）；建议 H-A/H-B/H-D 先落地并单测通过，H-C 单独细化子计划。B1 的房型→地图映射需人工校对（设计已标为已知缺口）。
- **顺序建议**：A1→A2→A5→A4→B1→A3（B1 后去桩）→A6→B2→A7→（H-A/B 全绿）→C1→C2→C3→C4→D1→E1。
```
