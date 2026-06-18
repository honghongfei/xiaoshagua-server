//=============================================================================
// XdRs_Online_Gather.js
//=============================================================================
/*:
 * @target MZ
 * @plugindesc 联机-地上物云端共享 | 资源服务端权威：采集走认领、防双采，被采点联机隐藏
 * @author xsg-online
 *
 * @help
 * 依赖 XdRs_Online_Net/Core + XdRs_GatherAsync + XdRs_Arder_*（放它们之后加载）。
 * 仅在服务端管理的地图(enterMap 返回 gatherManaged=true)接管：
 *   - 宝宝/玩家采集到点 → 发 gather.claim → 服务端仲裁防双采 + 服务端库存发货（不本地造物）
 *   - 他人采走该资源点 → 本地按 _erased 隐藏，宝宝不再 seek
 *   - 服务端重生(每点被采后 30 分钟) → 该点重新出现
 * 非管理地图：完全保持单机本地采集行为，不介入。
 */
(() => {
  'use strict';
  const G = window.XdRsOnline;
  if (!G || !G.Net) {
    console.error('[XSG-Online] Gather: needs Net');
    return;
  }
  const Net = G.Net;

  const Gather = (G.Gather = G.Gather || {});
  let managed = false;
  const activeByTile = new Map(); // "x,y" -> rid

  function tileKey(x, y) {
    return x + ',' + y;
  }
  function clearAll() {
    managed = false;
    activeByTile.clear();
  }

  // 进图快照(由 PlayerSync 的 enterMap / reconcile ack 回调注入)
  Gather.onEnterSnapshot = function (snap) {
    activeByTile.clear();
    managed = !!(snap && snap.gatherManaged);
    if (managed && snap && Array.isArray(snap.resources)) {
      for (const r of snap.resources) {
        activeByTile.set(tileKey(r.x, r.y), r.rid);
        showResourceAt(r.x, r.y);
      }
    }
  };

  // 某事件(资源)对应的服务端 rid（仅 managed 地图 + 当前活跃）
  Gather.ridAtEvent = function (event) {
    if (!managed || !event) return 0;
    return activeByTile.get(tileKey(event.x, event.y)) || 0;
  };

  // GatherAsync 采集完成回调：始终返回 false = 交回本地结算。
  // 关键：本游戏 $gameParty.gainItem 已被 XdRs_Online_Inventory 拦截转服务端权威库存(乐观本地应用)，
  // 所以本地采集本身就是「服务端权威发物 + 防刷」；本地 executeEventPage 还负责扣体力 + 翻消耗页。
  // ③ 服务端 gather 域不接管发货(否则与库存拦截重复发物/丢体力)，留作未来「跨玩家显示/刷新」增强。
  Gather.onResourceComplete = function () {
    return false;
  };

  // 服务端增量
  Net.on('gather.delta', (payload) => {
    if (!payload || !managed) return;
    if (Array.isArray(payload.spawn)) {
      for (const s of payload.spawn) {
        activeByTile.set(tileKey(s.x, s.y), s.rid);
        showResourceAt(s.x, s.y);
      }
    }
    if (Array.isArray(payload.claimed)) {
      for (const c of payload.claimed) {
        const tile = tileOfRid(c.rid);
        if (tile) {
          eraseResourceAt(tile.x, tile.y);
          activeByTile.delete(tileKey(tile.x, tile.y));
        }
      }
    }
  });

  Net.on('__disconnect__', clearAll);

  function tileOfRid(rid) {
    for (const [k, v] of activeByTile) {
      if (v === rid) {
        const parts = k.split(',');
        return { x: Number(parts[0]), y: Number(parts[1]) };
      }
    }
    return null;
  }

  // ---------- 可见性：_erased 翻转 + refresh（不依赖具体开关 ID）----------
  function resourceEventsAt(x, y) {
    if (typeof $gameMap === 'undefined' || !$gameMap) return [];
    return $gameMap.eventsXy(x, y).filter(
      (e) => e && typeof e._origIsResource === 'function' && e._origIsResource(),
    );
  }
  function eraseResourceAt(x, y) {
    for (const ev of resourceEventsAt(x, y)) {
      if (!ev._erased) {
        ev._erased = true;
        if (typeof ev.refresh === 'function') ev.refresh();
      }
    }
  }
  function showResourceAt(x, y) {
    for (const ev of resourceEventsAt(x, y)) {
      if (ev._erased) {
        ev._erased = false;
        if (typeof ev.refresh === 'function') ev.refresh();
      }
    }
  }

  function flash(text) {
    if (typeof $gameTemp !== 'undefined' && $gameTemp && typeof $gameTemp.addWorldMessage === 'function') {
      $gameTemp.addWorldMessage('\\c[10][采集]\\c[0] ' + text, true);
    }
  }

  // 宝宝(Game_Follower)不应 seek 已被采(_erased)的资源；保留原判定到 _origIsResource
  if (typeof Game_Event !== 'undefined') {
    const _isResource = Game_Event.prototype.isResource;
    Game_Event.prototype._origIsResource = function () {
      return _isResource ? _isResource.call(this) : false;
    };
    Game_Event.prototype.isResource = function () {
      if (this._erased) return false;
      return _isResource ? _isResource.call(this) : false;
    };
  }
})();
