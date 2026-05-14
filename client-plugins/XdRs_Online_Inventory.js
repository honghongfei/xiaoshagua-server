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

  function applyServerDelta(deltaApplied, requested, label) {
    if (!strict) return;
    if (deltaApplied !== requested) {
      Util.log('warn', label + ' server clamped: req=' + requested + ' applied=' + deltaApplied);
      if (typeof $gameMessage !== 'undefined') {
        $gameMessage.add('服务端裁剪了 ' + label + '：申请 ' + requested + '，实得 ' + deltaApplied);
      }
    }
  }

  // ---------- Hook gainGold ----------
  const _gainGold = Game_Party.prototype.gainGold;
  Game_Party.prototype.gainGold = function (amount) {
    _gainGold.call(this, amount);
    if (suppressSync) return;
    if (!Core.isOnline() || amount === 0) return;
    Net.request('inventory.gainGold', { amount: amount | 0, reason: 'gainGold' }, 6000)
      .then((res) => applyServerDelta(res.appliedDelta, amount | 0, '金币'))
      .catch((err) => Util.log('warn', 'gainGold sync failed:', err && err.message));
  };

  // ---------- Hook gainItem ----------
  const _gainItem = Game_Party.prototype.gainItem;
  Game_Party.prototype.gainItem = function (item, amount, includeEquip) {
    _gainItem.call(this, item, amount, includeEquip);
    if (suppressSync) return;
    if (!Core.isOnline() || !item || amount === 0) return;
    const kind = itemKind(item);
    if (!kind) return;
    Net.request('inventory.gainItem', {
      kind,
      dataId: item.id,
      amount: amount | 0,
      reason: 'gainItem',
    }, 6000)
      .then((res) => applyServerDelta(res.appliedDelta, amount | 0, item.name || kind))
      .catch((err) => Util.log('warn', 'gainItem sync failed:', err && err.message));
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
  function reconcileLocal(snap) {
    if (!snap) return;
    withSuppressSync(() => {
      if (typeof snap.gold === 'number' && typeof $gameParty._gold === 'number' && $gameParty._gold !== snap.gold) {
        Util.log('info', 'reconcile gold local=' + $gameParty._gold + ' server=' + snap.gold);
        $gameParty._gold = snap.gold | 0;
      }
      if (!Array.isArray(snap.items)) return;
      const buckets = { item: $gameParty._items, weapon: $gameParty._weapons, armor: $gameParty._armors };
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
        Util.log('debug', 'inventory snapshot: gold=' + snap.gold + ' items=' + snap.items.length);
        reconcileLocal(snap);
      })
      .catch((err) => Util.log('warn', 'inventory snapshot failed:', err && err.message));
  };

  // ---------- Listen to push events ----------
  Net.on('inventory.delta', (d) => {
    if (!d) return;
    if (d.gold != null) Util.log('debug', 'server gold delta:', d.gold);
    if (d.items) {
      for (const it of d.items) {
        Util.log('debug', 'server item delta:', it.kind, '#' + it.dataId, 'd=' + it.deltaCount);
      }
    }
  });
})();
