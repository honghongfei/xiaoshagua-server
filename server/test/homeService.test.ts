// 家园 homeService 行为测试（TDD）。隔离临时 DB：导入前设置 DB_PATH，再动态 import 被测模块。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB_FILE = path.join(os.tmpdir(), `xsg-home-test-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;
process.env.LOG_LEVEL = 'error';

type HomeSvc = typeof import('../src/domain/home/homeService.js');
type HomeRepo = typeof import('../src/domain/home/homeRepo.js');
type Social = typeof import('../src/domain/social/socialService.js');
type PlayerRepo = typeof import('../src/domain/player/playerRepo.js');
type InvRepo = typeof import('../src/domain/inventory/inventoryRepo.js');
type Sqlite = typeof import('../src/db/sqlite.js');

let home: HomeSvc;
let homeRepo: HomeRepo;
let social: Social;
let playerRepo: PlayerRepo;
let invRepo: InvRepo;
let sqlite: Sqlite;

beforeAll(async () => {
  const migrate = await import('../src/db/migrate.js');
  migrate.runMigrations();
  home = await import('../src/domain/home/homeService.js');
  homeRepo = await import('../src/domain/home/homeRepo.js');
  social = await import('../src/domain/social/socialService.js');
  playerRepo = await import('../src/domain/player/playerRepo.js');
  invRepo = await import('../src/domain/inventory/inventoryRepo.js');
  sqlite = await import('../src/db/sqlite.js');
});

afterAll(() => {
  try {
    sqlite?.closeDb();
  } catch {
    /* ignore */
  }
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(DB_FILE + suffix);
    } catch {
      /* ignore */
    }
  }
});

let seq = 0;
interface SeedItem {
  kind: 'item' | 'weapon' | 'armor';
  dataId: number;
  count: number;
}
function mkChar(opts: { gold?: number; items?: SeedItem[] } = {}): number {
  seq += 1;
  const accountId = playerRepo.createAccount({
    username: `h${seq}_${Math.random().toString(36).slice(2, 8)}`,
    passwordHash: 'x',
  });
  const pid = playerRepo.createCharacter({ accountId, name: `h${seq}` });
  invRepo.tx((db) => {
    if (opts.gold) invRepo.applyGoldDelta(db, pid, opts.gold);
    for (const it of opts.items ?? []) invRepo.applyItemDelta(db, pid, it.kind, it.dataId, it.count);
  });
  return pid;
}
function itemCount(pid: number, dataId: number): number {
  const row = invRepo.listInventory(pid).find((r) => r.kind === 'item' && r.data_id === dataId);
  return row ? row.count : 0;
}
function seedFurniture(fid: number): void {
  sqlite
    .openDb()
    .prepare('INSERT OR REPLACE INTO home_furniture_catalog (furniture_id, layer, w, h) VALUES (?, 1, 1, 1)')
    .run(fid);
  homeRepo.loadCatalog();
}
function setSlots(pid: number, n: number): void {
  home.enter(pid); // ensure home row exists
  sqlite.openDb().prepare('UPDATE home SET furniture_slots = ? WHERE owner_id = ?').run(n, pid);
}
function expectCode(fn: () => unknown, code: string): void {
  let got: string | undefined;
  try {
    fn();
  } catch (e: any) {
    got = e?.code;
  }
  expect(got).toBe(code);
}

describe('homeService.enter (可见性)', () => {
  it('owner enters own home with canEdit', () => {
    const pid = mkChar();
    const r = home.enter(pid);
    expect(r.ownerPid).toBe(pid);
    expect(r.canEdit).toBe(true);
    expect(r.virtualMapId).toBeGreaterThan(20_000_000);
  });

  it('rejects FORBIDDEN entering a private home', () => {
    const owner = mkChar();
    const visitor = mkChar();
    home.enter(owner); // default visibility = private
    expectCode(() => home.enter(visitor, owner), 'FORBIDDEN');
  });

  it('friends visibility: friend may enter, non-friend NOT_FRIEND', () => {
    const owner = mkChar();
    const friend = mkChar();
    const stranger = mkChar();
    home.setVisibility(owner, 'friends');
    social.addFriend(owner, friend);
    const r = home.enter(friend, owner);
    expect(r.ownerPid).toBe(owner);
    expect(r.canEdit).toBe(false);
    expectCode(() => home.enter(stranger, owner), 'NOT_FRIEND');
  });
});

describe('homeService furniture (place/move/remove)', () => {
  it('place decrements inventory and adds a furniture row', () => {
    const fid = 5001;
    seedFurniture(fid);
    const pid = mkChar({ items: [{ kind: 'item', dataId: fid, count: 2 }] });
    const { id } = home.placeFurniture(pid, fid, 4, 5, 2, 1);
    expect(id).toBeGreaterThan(0);
    expect(itemCount(pid, fid)).toBe(1);
    expect(home.enter(pid).furniture.length).toBe(1);
  });

  it('rejects NOT_FURNITURE for a non-catalog item', () => {
    const pid = mkChar({ items: [{ kind: 'item', dataId: 9999, count: 1 }] });
    expectCode(() => home.placeFurniture(pid, 9999, 1, 1, 2, 1), 'NOT_FURNITURE');
  });

  it('rejects NOT_OWNED when the furniture is not in inventory', () => {
    const fid = 5002;
    seedFurniture(fid);
    const pid = mkChar();
    expectCode(() => home.placeFurniture(pid, fid, 1, 1, 2, 1), 'NOT_OWNED');
  });

  it('rejects CELL_OCCUPIED on the same cell+layer', () => {
    const fid = 5003;
    seedFurniture(fid);
    const pid = mkChar({ items: [{ kind: 'item', dataId: fid, count: 2 }] });
    home.placeFurniture(pid, fid, 3, 3, 2, 1);
    expectCode(() => home.placeFurniture(pid, fid, 3, 3, 2, 1), 'CELL_OCCUPIED');
  });

  it('rejects SLOT_FULL at the furniture cap', () => {
    const fid = 5004;
    seedFurniture(fid);
    const pid = mkChar({ items: [{ kind: 'item', dataId: fid, count: 5 }] });
    setSlots(pid, 1);
    home.placeFurniture(pid, fid, 1, 1, 2, 1);
    expectCode(() => home.placeFurniture(pid, fid, 2, 2, 2, 1), 'SLOT_FULL');
  });

  it('remove returns the furniture to inventory (conservation)', () => {
    const fid = 5005;
    seedFurniture(fid);
    const pid = mkChar({ items: [{ kind: 'item', dataId: fid, count: 3 }] });
    const before = itemCount(pid, fid);
    const { id } = home.placeFurniture(pid, fid, 6, 6, 2, 1);
    expect(itemCount(pid, fid)).toBe(before - 1);
    home.removeFurniture(pid, id);
    expect(itemCount(pid, fid)).toBe(before);
  });

  it('rejects FORBIDDEN moving someone else furniture', () => {
    const fid = 5006;
    seedFurniture(fid);
    const owner = mkChar({ items: [{ kind: 'item', dataId: fid, count: 1 }] });
    const other = mkChar();
    const { id } = home.placeFurniture(owner, fid, 7, 7, 2, 1);
    expectCode(() => home.moveFurniture(other, id, 8, 8, 2), 'FORBIDDEN');
  });
});

describe('homeService.upgrade', () => {
  it('upgrades tier via gold fallback and raises furniture slots', () => {
    const pid = mkChar({ gold: 10_000 });
    home.enter(pid);
    const r = home.upgrade(pid);
    expect(r.tier).toBe(1);
    expect(r.furnitureSlots).toBe(20 + 1 * 4);
    expect(invRepo.getGold(pid)).toBe(10_000 - 5_000); // 第1级兜底价 5000，金币销毁
  });

  it('rejects NOT_ENOUGH_GOLD when broke and no voucher', () => {
    const pid = mkChar({ gold: 0 });
    home.enter(pid);
    expectCode(() => home.upgrade(pid), 'NOT_ENOUGH_GOLD');
  });
});

describe('homeService hardening (N1/N2)', () => {
  it('enter rejects NOT_FOUND for a non-existent owner', () => {
    const me = mkChar();
    expectCode(() => home.enter(me, 999_999), 'NOT_FOUND');
  });

  it('furnitureSnapshot respects visibility (private FORBIDDEN, public visible)', () => {
    const fid = 5101;
    seedFurniture(fid);
    const owner = mkChar({ items: [{ kind: 'item', dataId: fid, count: 1 }] });
    const visitor = mkChar();
    home.placeFurniture(owner, fid, 2, 2, 2, 1); // ensures owner home (default private)
    expectCode(() => home.furnitureSnapshot(visitor, owner), 'FORBIDDEN');
    home.setVisibility(owner, 'public');
    expect(home.furnitureSnapshot(visitor, owner).furniture.length).toBe(1);
  });

  it('furnitureSnapshot rejects NOT_FOUND for a non-existent owner', () => {
    const me = mkChar();
    expectCode(() => home.furnitureSnapshot(me, 999_999), 'NOT_FOUND');
  });
});
