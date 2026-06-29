// petService.regress（退化回蛋「换形态」）行为测试。
// 隔离临时 DB：在任何会触发 config 求值的导入之前设置 DB_PATH，再用动态 import 拉起被测模块。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB_FILE = path.join(os.tmpdir(), `xsg-pet-test-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;
process.env.LOG_LEVEL = 'error';

type PetSvc = typeof import('../src/domain/pet/petService.js');
type PetRepo = typeof import('../src/domain/pet/petRepo.js');
type PlayerRepo = typeof import('../src/domain/player/playerRepo.js');
type InvRepo = typeof import('../src/domain/inventory/inventoryRepo.js');
type Sqlite = typeof import('../src/db/sqlite.js');
type Cfg = typeof import('../src/config.js');

let pet: PetSvc;
let petRepo: PetRepo;
let playerRepo: PlayerRepo;
let invRepo: InvRepo;
let sqlite: Sqlite;
let config: Cfg['config'];

beforeAll(async () => {
  const migrate = await import('../src/db/migrate.js');
  migrate.runMigrations();
  pet = await import('../src/domain/pet/petService.js');
  petRepo = await import('../src/domain/pet/petRepo.js');
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
function mkChar(gold = 0): number {
  seq += 1;
  const accountId = playerRepo.createAccount({
    username: `pu${seq}_${Math.random().toString(36).slice(2, 8)}`,
    passwordHash: 'x',
  });
  const pid = playerRepo.createCharacter({ accountId, name: `pc${seq}` });
  if (gold) invRepo.tx((db) => invRepo.applyGoldDelta(db, pid, gold));
  return pid;
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

describe('petService.regress (退化回蛋换形态)', () => {
  it('rejects BAD_STATE when pet is already at egg stage (stage 0)', () => {
    const cid = mkChar(config.petRegressFeeGold);
    const p = pet.adopt(cid, 1, '小蛋');
    expect(p.stage).toBe(0);
    expectCode(() => pet.regress(p.id, cid), 'BAD_STATE');
  });

  it('reverts stage to 0, keeps level/exp, and burns the fee', () => {
    const fee = config.petRegressFeeGold;
    const cid = mkChar(fee + 123);
    const p = pet.adopt(cid, 2, '阿宝');
    // 直接拉到 stage 2 / level 30 / exp 40 模拟已进化
    petRepo.updatePet(p.id, { stage: 2, level: 30, exp: 40 });

    const res = pet.regress(p.id, cid);
    expect(res.pet.stage).toBe(0); // 回蛋
    expect(res.pet.level).toBe(30); // 等级保留
    expect(res.pet.exp).toBe(40); // 经验保留
    expect(res.delta.regressed).toBe(true);
    expect(invRepo.getGold(cid)).toBe(123); // 扣掉并销毁手续费
  });

  it('rejects NOT_ENOUGH_GOLD and leaves the pet unchanged', () => {
    const fee = config.petRegressFeeGold;
    const cid = mkChar(fee - 1);
    const p = pet.adopt(cid, 3, '穷蛋');
    petRepo.updatePet(p.id, { stage: 1, level: 12 });

    expectCode(() => pet.regress(p.id, cid), 'NOT_ENOUGH_GOLD');
    const after = petRepo.findPet(p.id);
    expect(after?.stage).toBe(1); // 未变
    expect(after?.level).toBe(12);
    expect(invRepo.getGold(cid)).toBe(fee - 1); // 未扣
  });
});
