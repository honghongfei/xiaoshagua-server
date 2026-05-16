//=============================================================================
// XdRs_Online_Inventory.js
//=============================================================================
/*:
 * @target MZ
 * @plugindesc 联机-资产 | gainGold / gainItem 拦截走服务器，乐观本地应用
 * @author xsg-online
 *
 * @param strictMode
 * @text 严格模式（资产分歧时弹窗）
 * @type boolean
 * @default false
 *
 * @help
 * 拦截 Game_Party.gainGold / gainItem / loseItem，转 RPC 给服务器。
 * 服务器返回 deltaApplied 后用此修正本地（如果服务端裁剪了量，本地也跟着裁剪）。
 *
 * 进 Scene_Map 时拉一次 inventory.snapshot 校准。
 */
(() => {
  'use strict';
  const G = window.XdRsOnline;
  if (!G || !G.Net || !G.Core) {
    console.error('[XSG-Online] Inventory: deps missing');
    return;
  }
  const Util = G.Util;
  const Net = G.Net;
  const Core = G.Core;
  const params = PluginManager.parameters('XdRs_Online_Inventory');
  const strict = String(params.strictMode || 'false') === 'true';

  const Inv = (G.Inv = G.Inv || {});
  Inv.snapshot = null;

  // ---------- Helpers ----------
  function itemKind(item) {
    if (!item) return null;
    if (DataManager.isItem(item)) return 'item';
    if (DataManager.isWeapon(item)) return 'weapon';
    if (DataManager.isArmor(item)) return 'armor';
    return null;
  }

  // H5 修：服端返回 appliedDelta + newTotal 后，把本地校准到 newTotal (不止 strict)
  function adjustLocalAfterRpc(kind, dataIdOrZero, requestedDelta, res, label) {
    if (!res) return;
    const applied = typeof res.appliedDelta === 'number' ? res.appliedDelta : requestedDelta;
    const newTotal = typeof res.newTotal === 'number' ? res.newTotal : null;
    if (kind === 'gold') {
      if (newTotal != null && typeof $gameParty._gold === 'number') {
        const before = $gameParty._gold;
        if (before !== newTotal) {
          withSuppressSync(() => { $gameParty._gold = newTotal | 0; });
          Util.log('debug', 'gold corrected local ' + before + ' -> ' + newTotal + ' (req=' + requestedDelta + ' applied=' + applied + ')');
        }
      }
    } else {
      const bucket = kind === 'item' ? $gameParty._items : kind === 'weapon' ? $gameParty._weapons : $gameParty._armors;
      if (bucket && newTotal != null) {
        withSuppressSync(() => { bucket[dataIdOrZero] = newTotal | 0; });
      }
    }
    if (strict && applied !== requestedDelta) {
      Util.log('warn', label + ' server clamped: req=' + requestedDelta + ' applied=' + applied);
      if (typeof $gameMessage !== 'undefined') {
        $gameMessage.add('服务端裁剪了 ' + label + '：申请 ' + requestedDelta + '，实得 ' + applied);
      }
    }
  }

  // H5 修：RPC 失败的本地回滚 (因为我们是 _gainGold 先调本地的 optimistic 模式)
  function rollbackLocalGold(amount) {
    if (typeof $gameParty._gold !== 'number') return;
    withSuppressSync(() => { $gameParty._gold = Math.max(0, ($gameParty._gold | 0) - (amount | 0)); });
  }
  function rollbackLocalItem(kind, dataId, amount) {
    const bucket = kind === 'item' ? $gameParty._items : kind === 'weapon' ? $gameParty._weapons : $gameParty._armors;
    if (!bucket) return;
    withSuppressSync(() => { bucket[dataId] = Math.max(0, (bucket[dataId] | 0) - (amount | 0)); });
  }

  // ---------- Hook gainGold (H5 + M1 + M2 修) ----------
  const _gainGold = Game_Party.prototype.gainGold;
  Game_Party.prototype.gainGold = function (amount) {
    _gainGold.call(this, amount);
    if (suppressSync) return;
    if (!Core.isOnline() || amount === 0) return;
    const requested = amount | 0;
    Net.request('inventory.gainGold', { amount: requested, reason: requested >= 0 ? 'gainGold' : 'loseGold' }, 6000)
      .then((res) => adjustLocalAfterRpc('gold', 0, requested, res, '金币'))
      .catch((err) => {
        Util.log('warn', 'gainGold sync failed, rollback:', err && err.message);
        rollbackLocalGold(requested);
        // 同时再去 reconcile, 防止部分写入
        Net.request('inventory.snapshot', {}, 4000).then((snap) => reconcileLocal(snap)).catch(() => {});
      });
  };

  // ---------- Hook gainItem (H5 + M1 + M2 修) ----------
  // M2: gainItem 也接管负数 (loseItem 在 RMMZ 里调 gainItem(-n))
  const _gainItem = Game_Party.prototype.gainItem;
  Game_Party.prototype.gainItem = function (item, amount, includeEquip) {
    _gainItem.call(this, item, amount, includeEquip);
    if (suppressSync) return;
    if (!Core.isOnline() || !item || amount === 0) return;
    const kind = itemKind(item);
    if (!kind) return;
    const requested = amount | 0;
    Net.request('inventory.gainItem', {
      kind,
      dataId: item.id,
      amount: requested,
      reason: requested >= 0 ? 'gainItem' : 'loseItem',
    }, 6000)
      .then((res) => adjustLocalAfterRpc(kind, item.id, requested, res, item.name || kind))
      .catch((err) => {
        Util.log('warn', 'gainItem sync failed, rollback:', err && err.message);
        rollbackLocalItem(kind, item.id, requested);
        Net.request('inventory.snapshot', {}, 4000).then((snap) => reconcileLocal(snap)).catch(() => {});
      });
  };

  // ---------- snapshot on enter map (+ reconcile local with server) ----------
  // 三步闭环:
  //   发起端 client : Scene_Map.start 一次性拉 inventory.snapshot
  //   服端    server: domain/inventory 直接读 character_inventory 表回这一份
  //   表现端 client : reconcileLocal 把 server 的 gold / item 数量直接覆盖到 $gameParty
  //                   (server 是资产单一可信源, 本地差异一律以 server 为准)
  // 兜底:
  //   snap 空 / 字段缺失 直接 return, 不会让 $gameParty._gold 变 NaN
  //   item.kind 不是 item/weapon/armor 跳过, 不会去碰未知 bucket
  //   reconcile 走 suppressSync, 防止把 $gameParty._gold = N 又被 gainGold hook 反弹回 server
  // 并发自检:
  //   多人各自的 inventory.snapshot 取各自 pid, 不共享, reconcile 只动本机 $gameParty
  let suppressSync = false;
  function withSuppressSync(fn) {
    suppressSync = true;
    try { fn(); } finally { suppressSync = false; }
  }
  function reconcileLocal(snap, opts) {
    if (!snap) return;
    const fullReplace = !!(opts && opts.fullReplace);
    // 防御: 服务端权威表为空 (gold=0 + 0 件物品), 但本地内存里资产非空时,
    // 不做覆盖. 这种情况通常是迁移流程不完整 (老存档 blob 上传了, 但 gold/inventory
    // 表没同步), 让 reconcile 静默清零会直接抹掉玩家的钻石和金币.
    // 修复历史详见: server/src/domain/inventory/inventoryService.ts replaceInventory 注释.
    // 例外: fullReplace=true 时跳过保护. 调用方 (例如交易完成后的 reconcile) 已经
    //       明确知道服务端是权威源, 即使快照"看起来"是空 也应该执行覆盖. 否则交易
    //       把全部物品给了对方, 服务端 inventory 那条 row 被 DELETE → snap.items 不
    //       含该 dataId → 老的"按 snap 写入"逻辑不会清掉本地残留 bucket → 玩家下次
    //       开交易时会看到 "持有:1" 的鬼物品, 提交时服务端找不到行直接拒绝
    //       NOT_ENOUGH_ITEM: need 1 of item#8.
    if (!fullReplace) {
      const snapEmpty = (snap.gold | 0) === 0 && (!Array.isArray(snap.items) || snap.items.length === 0);
      if (snapEmpty) {
        const localGold = ($gameParty && $gameParty._gold) | 0;
        const localItemCount = $gameParty
          ? Object.keys($gameParty._items || {}).length +
            Object.keys($gameParty._weapons || {}).length +
            Object.keys($gameParty._armors || {}).length
          : 0;
        if (localGold > 0 || localItemCount > 0) {
          Util.log(
            'warn',
            'inventory snapshot suspicious empty (server gold=0, items=0) but local has gold=' +
              localGold + ' items=' + localItemCount + ', skip reconcile to protect assets'
          );
          return;
        }
      }
    }
    withSuppressSync(() => {
      if (typeof snap.gold === 'number' && typeof $gameParty._gold === 'number' && $gameParty._gold !== snap.gold) {
        Util.log('info', 'reconcile gold local=' + $gameParty._gold + ' server=' + snap.gold);
        $gameParty._gold = snap.gold | 0;
      }
      if (!Array.isArray(snap.items)) return;
      const buckets = { item: $gameParty._items, weapon: $gameParty._weapons, armor: $gameParty._armors };
      // fullReplace 时先建立 server 持有的 (kind, dataId) 集合; 本地有但服务端没有
      // 的条目要被设成 0, 否则交易掉光的物品会作为 "鬼条目" 留在本地.
      // 注意: 仅在 fullReplace=true 时才做"清扫", 默认行为保持向后兼容.
      if (fullReplace) {
        const serverHas = {
          item: new Set(),
          weapon: new Set(),
          armor: new Set(),
        };
        for (const it of snap.items) {
          if (!it) continue;
          if (serverHas[it.kind]) serverHas[it.kind].add(it.dataId);
        }
        for (const kind of Object.keys(buckets)) {
          const bucket = buckets[kind];
          if (!bucket) continue;
          for (const idStr of Object.keys(bucket)) {
            const id = Number(idStr);
            if (!serverHas[kind].has(id)) {
              if ((bucket[idStr] | 0) !== 0) {
                Util.log('debug', 'reconcile drop ghost ' + kind + '#' + id + ' local=' + bucket[idStr]);
                bucket[idStr] = 0;
              }
            }
          }
        }
      }
      for (const it of snap.items) {
        const bucket = buckets[it.kind];
        if (!bucket || it.dataId == null) continue;
        bucket[it.dataId] = it.count | 0;
      }
    });
  }
  Inv.reconcileLocal = reconcileLocal;

  const _Scene_Map_start = Scene_Map.prototype.start;
  Scene_Map.prototype.start = function () {
    _Scene_Map_start.call(this);
    if (!Core.isOnline()) return;
    Net.request('inventory.snapshot', {}, 6000)
      .then((snap) => {
        Inv.snapshot = snap;
        const itemsLen = Array.isArray(snap && snap.items) ? snap.items.length : 0; // M5 修：防御异常 payload
        Util.log('debug', 'inventory snapshot: gold=' + (snap && snap.gold) + ' items=' + itemsLen);
        reconcileLocal(snap);
      })
      .catch((err) => Util.log('warn', 'inventory snapshot failed:', err && err.message));
  };

  // ---------- Listen to push events (M3 修) ----------
  // 服端某些路径会主动推 inventory.delta (例如交易完成)
  // 之前只 log 不应用, 现在应用到 $gameParty 并保护 suppressSync 不反弹
  Net.on('inventory.delta', (d) => {
    if (!d) return;
    if (typeof d.gold === 'number' && typeof $gameParty._gold === 'number') {
      withSuppressSync(() => { $gameParty._gold = Math.max(0, ($gameParty._gold | 0) + (d.gold | 0)); });
      Util.log('debug', 'apply server gold delta:', d.gold);
    }
    if (Array.isArray(d.items)) {
      for (const it of d.items) {
        if (!it || !it.kind) continue;
        const bucket = it.kind === 'item' ? $gameParty._items : it.kind === 'weapon' ? $gameParty._weapons : it.kind === 'armor' ? $gameParty._armors : null;
        if (!bucket) continue;
        if (typeof it.newCount === 'number') {
          withSuppressSync(() => { bucket[it.dataId] = Math.max(0, it.newCount | 0); });
        } else if (typeof it.deltaCount === 'number') {
          withSuppressSync(() => { bucket[it.dataId] = Math.max(0, (bucket[it.dataId] | 0) + (it.deltaCount | 0)); });
        }
      }
    }
  });
})();
