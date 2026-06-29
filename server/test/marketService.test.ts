// 寄售行 marketService 行为测试（TDD）。
// 隔离临时 DB：在任何会触发 config 求值的导入之前设置 DB_PATH，再用动态 import 拉起被测模块。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB_FILE = path.join(os.tmpdir(), `xsg-market-test-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;
process.env.LOG_LEVEL = 'error';

type MarketSvc = typeof import('../src/domain/market/marketService.js');
type PlayerRepo = typeof import('../src/domain/player/playerRepo.js');
type InvRepo = typeof import('../src/domain/inventory/inventoryRepo.js');
type Sqlite = typeof import('../src/db/sqlite.js');
type Cfg = typeof import('../src/config.js');

let market: MarketSvc;
let playerRepo: PlayerRepo;
let invRepo: InvRepo;
let sqlite: Sqlite;
let config: Cfg['config'];

const GOLD_CAP = 999_999_999;

beforeAll(async () => {
  const migrate = await import('../src/db/migrate.js');
  migrate.runMigrations();
  market = await import('../src/domain/market/marketService.js');
  playerRepo = await import('../src/domain/player/playerRepo.js');
  invRepo = await import('../src/domain/inventory/inventoryRepo.js');
  sqlite = await import('../src/db/sqlite.js');
  config = (await import('../src/config.js')).config;
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
    username: `u${seq}_${Math.random().toString(36).slice(2, 8)}`,
    passwordHash: 'x',
  });
  const pid = playerRepo.createCharacter({ accountId, name: `c${seq}` });
  invRepo.tx((db) => {
    if (opts.gold) invRepo.applyGoldDelta(db, pid, opts.gold);
    for (const it of opts.items ?? []) invRepo.applyItemDelta(db, pid, it.kind, it.dataId, it.count);
  });
  return pid;
}

function itemCount(pid: number, kind: SeedItem['kind'], dataId: number): number {
  const row = invRepo.listInventory(pid).find((r) => r.kind === kind && r.data_id === dataId);
  return row ? row.count : 0;
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

describe('marketService.createListing (上架 + escrow)', () => {
  it('escrows the items and occupies a slot', () => {
    const seller = mkChar({ items: [{ kind: 'item', dataId: 7, count: 5 }] });
    const { listingId } = market.createListing(seller, 'item', 7, 3, 100);
    expect(listingId).toBeGreaterThan(0);
    expect(itemCount(seller, 'item', 7)).toBe(2); // 5 - 3 escrowed
    const mine = market.getMine(seller);
    expect(mine.usedSlots).toBe(1);
    expect(mine.listings.find((l) => l.id === listingId)?.count).toBe(3);
  });

  it('rejects NO_SLOT when active listings reach slot cap', () => {
    const seller = mkChar({ items: [{ kind: 'item', dataId: 1, count: 9 }] });
    market.createListing(seller, 'item', 1, 1, 10); // slot 1
    market.createListing(seller, 'item', 1, 1, 10); // slot 2 (default 2)
    expectCode(() => market.createListing(seller, 'item', 1, 1, 10), 'NO_SLOT');
  });

  it('rejects NOT_ENOUGH_ITEM when listing more than owned', () => {
    const seller = mkChar({ items: [{ kind: 'item', dataId: 2, count: 1 }] });
    expectCode(() => market.createListing(seller, 'item', 2, 2, 10), 'NOT_ENOUGH_ITEM');
  });

  it('rejects BAD_INPUT on non-positive price / count', () => {
    const seller = mkChar({ items: [{ kind: 'item', dataId: 3, count: 5 }] });
    expectCode(() => market.createListing(seller, 'item', 3, 0, 10), 'BAD_INPUT');
    expectCode(() => market.createListing(seller, 'item', 3, 1, 0), 'BAD_INPUT');
    expectCode(() => market.createListing(seller, 'item', 3, 1, GOLD_CAP + 1), 'BAD_INPUT');
  });
});

describe('marketService.cancelListing (下架退物)', () => {
  it('returns remaining escrowed items to the seller', () => {
    const seller = mkChar({ items: [{ kind: 'weapon', dataId: 4, count: 4 }] });
    const { listingId } = market.createListing(seller, 'weapon', 4, 4, 50);
    expect(itemCount(seller, 'weapon', 4)).toBe(0);
    const r = market.cancelListing(seller, listingId);
    expect(r.returned).toBe(4);
    expect(itemCount(seller, 'weapon', 4)).toBe(4);
    expect(market.getMine(seller).usedSlots).toBe(0);
  });

  it('rejects FORBIDDEN for a non-owner', () => {
    const seller = mkChar({ items: [{ kind: 'item', dataId: 5, count: 1 }] });
    const other = mkChar();
    const { listingId } = market.createListing(seller, 'item', 5, 1, 10);
    expectCode(() => market.cancelListing(other, listingId), 'FORBIDDEN');
  });

  it('rejects BAD_STATE when listing is not active', () => {
    const seller = mkChar({ items: [{ kind: 'item', dataId: 6, count: 1 }] });
    const { listingId } = market.createListing(seller, 'item', 6, 1, 10);
    market.cancelListing(seller, listingId);
    expectCode(() => market.cancelListing(seller, listingId), 'BAD_STATE');
  });
});

describe('marketService.buyListing (拆分购买 + 原子结算)', () => {
  it('full buy transfers items, pays seller full proceeds (fee=0), marks sold', () => {
    const seller = mkChar({ items: [{ kind: 'item', dataId: 10, count: 10 }] });
    const buyer = mkChar({ gold: 1000 });
    const { listingId } = market.createListing(seller, 'item', 10, 10, 10); // unit 10, total 100
    const res = market.buyListing(buyer, listingId, 10);
    expect(res.sold).toBe(true);
    expect(res.remaining).toBe(0);
    expect(res.cost).toBe(100);
    expect(res.fee).toBe(0); // 手续费已取消
    expect(res.proceeds).toBe(100);
    expect(invRepo.getGold(buyer)).toBe(900); // 1000 - 100
    expect(invRepo.getGold(seller)).toBe(100); // 全款到账，无销毁
    expect(itemCount(buyer, 'item', 10)).toBe(10);
  });

  it('partial buy decrements remaining and keeps listing active', () => {
    const seller = mkChar({ items: [{ kind: 'item', dataId: 11, count: 10 }] });
    const buyer = mkChar({ gold: 1000 });
    const { listingId } = market.createListing(seller, 'item', 11, 10, 10);
    const r1 = market.buyListing(buyer, listingId, 4);
    expect(r1.sold).toBe(false);
    expect(r1.remaining).toBe(6);
    expect(r1.cost).toBe(40);
    expect(itemCount(buyer, 'item', 11)).toBe(4);
    const r2 = market.buyListing(buyer, listingId, 6);
    expect(r2.sold).toBe(true);
    expect(r2.remaining).toBe(0);
    expect(itemCount(buyer, 'item', 11)).toBe(10);
  });

  it('rejects CANNOT_BUY_OWN', () => {
    const seller = mkChar({ gold: 1000, items: [{ kind: 'item', dataId: 12, count: 2 }] });
    const { listingId } = market.createListing(seller, 'item', 12, 2, 10);
    expectCode(() => market.buyListing(seller, listingId, 1), 'CANNOT_BUY_OWN');
  });

  it('rejects NOT_ENOUGH_GOLD', () => {
    const seller = mkChar({ items: [{ kind: 'item', dataId: 13, count: 1 }] });
    const buyer = mkChar({ gold: 5 });
    const { listingId } = market.createListing(seller, 'item', 13, 1, 10);
    expectCode(() => market.buyListing(buyer, listingId, 1), 'NOT_ENOUGH_GOLD');
  });

  it('rejects BAD_QTY when qty exceeds remaining', () => {
    const seller = mkChar({ items: [{ kind: 'item', dataId: 14, count: 2 }] });
    const buyer = mkChar({ gold: 1000 });
    const { listingId } = market.createListing(seller, 'item', 14, 2, 10);
    expectCode(() => market.buyListing(buyer, listingId, 3), 'BAD_QTY');
  });

  it('rejects LISTING_GONE on a sold-out listing', () => {
    const seller = mkChar({ items: [{ kind: 'item', dataId: 15, count: 1 }] });
    const buyer = mkChar({ gold: 1000 });
    const { listingId } = market.createListing(seller, 'item', 15, 1, 10);
    market.buyListing(buyer, listingId, 1);
    expectCode(() => market.buyListing(buyer, listingId, 1), 'LISTING_GONE');
  });

  it('applies fee bps when configured (cost 99 -> fee 19, proceeds 80)', () => {
    const prevFee = config.marketFeeBps;
    (config as { marketFeeBps: number }).marketFeeBps = 2000; // 显式开启 20% 验证费率算法
    try {
      const seller = mkChar({ items: [{ kind: 'item', dataId: 16, count: 11 }] });
      const buyer = mkChar({ gold: 1000 });
      const { listingId } = market.createListing(seller, 'item', 16, 11, 9); // unit 9
      const res = market.buyListing(buyer, listingId, 11); // cost 99
      expect(res.cost).toBe(99);
      expect(res.fee).toBe(19); // floor(99 * 0.2) = 19
      expect(res.proceeds).toBe(80);
    } finally {
      (config as { marketFeeBps: number }).marketFeeBps = prevFee;
    }
  });

  it('clamps seller gold at GOLD_CAP, burning the overflow', () => {
    const seller = mkChar({ gold: GOLD_CAP - 10, items: [{ kind: 'item', dataId: 17, count: 10 }] });
    const buyer = mkChar({ gold: 1000 });
    const { listingId } = market.createListing(seller, 'item', 17, 10, 10); // proceeds 100 (fee=0)
    market.buyListing(buyer, listingId, 10);
    expect(invRepo.getGold(seller)).toBe(GOLD_CAP); // capped; overflow burned
  });

  it('rejects ITEM_FULL when buyer would exceed the item stack cap', () => {
    const seller = mkChar({ items: [{ kind: 'item', dataId: 18, count: 1 }] });
    const buyer = mkChar({ gold: 1000, items: [{ kind: 'item', dataId: 18, count: 9999 }] });
    const { listingId } = market.createListing(seller, 'item', 18, 1, 10);
    expectCode(() => market.buyListing(buyer, listingId, 1), 'ITEM_FULL');
    // listing untouched, buyer gold unchanged
    expect(invRepo.getGold(buyer)).toBe(1000);
  });
});

describe('marketService.unlockSlot (开格销毁)', () => {
  it('unlocks sequentially, burning the slot price', () => {
    const start = config.marketSlotPrices[0]; // 第3格 = 1万
    const pid = mkChar({ gold: start + 5 });
    const r = market.unlockSlot(pid);
    expect(r.slots).toBe(3);
    expect(r.spent).toBe(start);
    expect(invRepo.getGold(pid)).toBe(5); // burned
  });

  it('rejects NOT_ENOUGH_GOLD', () => {
    const pid = mkChar({ gold: 1 });
    expectCode(() => market.unlockSlot(pid), 'NOT_ENOUGH_GOLD');
  });

  it('rejects SLOT_MAXED at 10 slots', () => {
    // 解锁到 10 需要全部 8 段价；给足金币
    const total = config.marketSlotPrices.reduce((a, b) => a + b, 0);
    const pid = mkChar({ gold: total });
    for (let i = 0; i < config.marketSlotPrices.length; i += 1) market.unlockSlot(pid);
    expect(market.getMine(pid).slots).toBe(10);
    expectCode(() => market.unlockSlot(pid), 'SLOT_MAXED');
  });
});

describe('marketService notifications (离线邮箱)', () => {
  it('enqueues market_sold for seller and market_bought for buyer on a sale', () => {
    const seller = mkChar({ items: [{ kind: 'item', dataId: 20, count: 1 }] });
    const buyer = mkChar({ gold: 1000 });
    const { listingId } = market.createListing(seller, 'item', 20, 1, 50);
    market.buyListing(buyer, listingId, 1);
    const sellerNotes = market.listNotifications(seller).items;
    const buyerNotes = market.listNotifications(buyer).items;
    expect(sellerNotes.some((n) => n.type === 'market_sold')).toBe(true);
    expect(buyerNotes.some((n) => n.type === 'market_bought')).toBe(true);
  });

  it('ack marks notifications read so they are not re-served', () => {
    const seller = mkChar({ items: [{ kind: 'item', dataId: 21, count: 1 }] });
    const buyer = mkChar({ gold: 1000 });
    const { listingId } = market.createListing(seller, 'item', 21, 1, 50);
    market.buyListing(buyer, listingId, 1);
    const before = market.listNotifications(seller).items;
    expect(before.length).toBeGreaterThan(0);
    market.ackNotifications(seller, before.map((n) => n.id));
    expect(market.listNotifications(seller).items.length).toBe(0);
  });
});

describe('marketService.browse / getMine', () => {
  it('browse shows active listings with seller name and flags own listings', () => {
    const seller = mkChar({ items: [{ kind: 'armor', dataId: 30, count: 2 }] });
    const { listingId } = market.createListing(seller, 'armor', 30, 2, 77);
    const res = market.browse({ viewerPid: seller, kind: 'armor' });
    const row = res.listings.find((l) => l.id === listingId);
    expect(row).toBeTruthy();
    expect(typeof row!.sellerName).toBe('string');
    expect(row!.unitPrice).toBe(77);
    expect(row!.mine).toBe(true);
  });

  it('getMine reports slots, usedSlots and next slot price', () => {
    const pid = mkChar({ gold: 0, items: [{ kind: 'item', dataId: 31, count: 1 }] });
    market.createListing(pid, 'item', 31, 1, 10);
    const mine = market.getMine(pid);
    expect(mine.slots).toBe(2);
    expect(mine.maxSlots).toBe(10);
    expect(mine.usedSlots).toBe(1);
    expect(mine.nextSlotPrice).toBe(config.marketSlotPrices[0]);
  });
});
