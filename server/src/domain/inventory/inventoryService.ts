import { log } from '../../log.js';
import { AppError } from '../../util/errors.js';
import * as repo from './inventoryRepo.js';

export type ItemKind = repo.ItemKind;

const GOLD_CAP = 9_999_999;
const ITEM_CAP = 9_999;

export interface InventorySnapshot {
  gold: number;
  items: { kind: ItemKind; dataId: number; count: number }[];
}

export function snapshot(characterId: number): InventorySnapshot {
  return {
    gold: repo.getGold(characterId),
    items: repo.listInventory(characterId).map((r) => ({
      kind: r.kind,
      dataId: r.data_id,
      count: r.count,
    })),
  };
}

export interface DeltaResult {
  appliedDelta: number;
  newTotal: number;
}

export function gainGold(characterId: number, amount: number, reason?: string): DeltaResult {
  if (!Number.isFinite(amount)) throw new AppError('BAD_INPUT', 'amount NaN');
  return repo.tx((db) => {
    const before = repo.getGold(characterId);
    let target = before + amount;
    if (target > GOLD_CAP) target = GOLD_CAP;
    if (target < 0) target = 0;
    const applied = repo.applyGoldDelta(db, characterId, target - before);
    if (applied !== amount) {
      log.debug({ characterId, amount, applied, reason }, 'gold delta clamped');
    }
    return { appliedDelta: applied, newTotal: before + applied };
  });
}

export function gainItem(
  characterId: number,
  kind: ItemKind,
  dataId: number,
  amount: number,
  reason?: string,
): DeltaResult {
  if (!Number.isFinite(amount)) throw new AppError('BAD_INPUT', 'amount NaN');
  return repo.tx((db) => {
    const cur = repo.listInventory(characterId).find((r) => r.kind === kind && r.data_id === dataId);
    const before = cur ? cur.count : 0;
    let target = before + amount;
    if (target > ITEM_CAP) target = ITEM_CAP;
    if (target < 0) target = 0;
    const applied = repo.applyItemDelta(db, characterId, kind, dataId, target - before);
    if (applied !== amount) {
      log.debug({ characterId, kind, dataId, amount, applied, reason }, 'item delta clamped');
    }
    return { appliedDelta: applied, newTotal: before + applied };
  });
}

export function useItem(
  characterId: number,
  kind: ItemKind,
  dataId: number,
  count = 1,
): DeltaResult {
  if (count <= 0) throw new AppError('BAD_INPUT', 'count must be >0');
  return repo.tx((db) => {
    const cur = repo.listInventory(characterId).find((r) => r.kind === kind && r.data_id === dataId);
    const before = cur ? cur.count : 0;
    if (before < count) throw new AppError('NOT_ENOUGH', `need ${count}, have ${before}`);
    const applied = repo.applyItemDelta(db, characterId, kind, dataId, -count);
    return { appliedDelta: applied, newTotal: before + applied };
  });
}
