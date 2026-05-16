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

// ---------------------------------------------------------------------------
// replaceInventory: 把整份资产覆盖写入权威表 (gold + 全部 item / weapon / armor)
// 用途: SaveMigrate / SaveCloud 把"老存档 blob"上传到服务端时, 同步把里面的
//       _gold / _items / _weapons / _armors 提取出来灌进 character.gold 与
//       inventory 表, 保证下一次 inventory.snapshot 不会因为权威表为空而把客
//       户端的 $gameParty._gold reconcile 成 0.
//
// 修复历史: 老玩家"上传本地存档到云端" → 只写 savefile_cloud blob, 没写
//          character.gold / inventory → 下次进游戏 Scene_Map.start 拉
//          inventory.snapshot 拿到空快照 → reconcileLocal 把 $gameParty._gold
//          清零、_items 清空 → 30s 后 SaveCloud auto-mirror 把清零状态推回云端
//          覆盖原始 blob, 钻石和金币永久丢失.
//
// 设计: 单事务原子覆盖. 不做差量 (老存档可能在 _items 里有 0 条 entry, 直接代表
//       "没有任何物品", 不能 OR 合并保留权威表里的旧物品).
// 边界:
//   - gold 超出 GOLD_CAP / 负数 → clamp
//   - 单条 item count 超出 ITEM_CAP / 负数 → clamp; 0 / 负 → 跳过, 不入表
//   - kind 不在 'item'/'weapon'/'armor' → 跳过
//   - dataId 非正整数 → 跳过
// ---------------------------------------------------------------------------
export interface ReplaceInventoryInput {
  gold: number;
  items: { kind: ItemKind; dataId: number; count: number }[];
}

export interface ReplaceInventoryResult {
  gold: number;
  itemCount: number;
}

export function replaceInventory(
  characterId: number,
  input: ReplaceInventoryInput,
  reason?: string,
): ReplaceInventoryResult {
  if (!Number.isFinite(input.gold)) throw new AppError('BAD_INPUT', 'gold NaN');
  if (!Array.isArray(input.items)) throw new AppError('BAD_INPUT', 'items must be array');
  return repo.tx((db) => {
    let gold = Math.floor(input.gold);
    if (gold < 0) gold = 0;
    if (gold > GOLD_CAP) gold = GOLD_CAP;
    repo.setGold(db, characterId, gold);
    repo.clearInventory(db, characterId);
    let written = 0;
    for (const it of input.items) {
      if (!it) continue;
      if (it.kind !== 'item' && it.kind !== 'weapon' && it.kind !== 'armor') continue;
      if (!Number.isInteger(it.dataId) || it.dataId <= 0) continue;
      let count = Math.floor(Number(it.count) || 0);
      if (count <= 0) continue;
      if (count > ITEM_CAP) count = ITEM_CAP;
      repo.upsertInventory(db, characterId, it.kind, it.dataId, count);
      written++;
    }
    log.info({ characterId, gold, itemCount: written, reason }, 'inventory replaced');
    return { gold, itemCount: written };
  });
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
