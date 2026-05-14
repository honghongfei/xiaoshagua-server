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
    if (!Core.isOnline() || amount === 0) return;
    Net.request('inventory.gainGold', { amount: amount | 0, reason: 'gainGold' }, 6000)
      .then((res) => applyServerDelta(res.appliedDelta, amount | 0, '金币'))
      .catch((err) => Util.log('warn', 'gainGold sync failed:', err && err.message));
  };

  // ---------- Hook gainItem ----------
  const _gainItem = Game_Party.prototype.gainItem;
  Game_Party.prototype.gainItem = function (item, amount, includeEquip) {
    _gainItem.call(this, item, amount, includeEquip);
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

  // ---------- snapshot on enter map ----------
  const _Scene_Map_start = Scene_Map.prototype.start;
  Scene_Map.prototype.start = function () {
    _Scene_Map_start.call(this);
    if (!Core.isOnline()) return;
    Net.request('inventory.snapshot', {}, 6000)
      .then((snap) => {
        Inv.snapshot = snap;
        Util.log('debug', 'inventory snapshot: gold=' + snap.gold + ' items=' + snap.items.length);
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
