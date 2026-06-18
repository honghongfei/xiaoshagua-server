//=============================================================================
// XdRs_Online_Gather.js
//=============================================================================
/*:
 * @target MZ
 * @plugindesc 联机-地上物云端共享 | 服务端权威：资源存在/刷新由服务端驱动，全服一致；采集发货走本地权威库存
 * @author xsg-online
 *
 * @help
 * 依赖 XdRs_Online_Net/Core + XdRs_GatherAsync + XdRs_Arder_* + XdRs_Online_Inventory。
 * 在服务端管理的地图(enterMap 返回 gatherManaged=true)：
 *   - 资源「在不在」完全由服务端活跃集驱动：活跃→把该资源事件的消耗开关置 OFF(显示)，
 *     非活跃→置 ON(空页隐藏)。覆盖本地存档状态，全服看到同一份。
 *   - 服务端 respawn(每点被采后 30 分钟) 广播 gather.delta.spawn → 全员同时重现。
 *   - 采集到点：发 gather.claim 通知服务端 despawn+广播+排程 respawn；发货仍走本地
 *     (XdRs_Online_Inventory 已转服务端权威库存)，不在此处重复发货。
 * 体力(var5)门控保持本体设计：page0 需体力≥1，体力 0 看不到资源(个人门控)。
 * 非管理地图：完全不介入，保持单机/TimeOffline 本地行为。
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
  const switchCache = new Map(); // eventId -> consume switchId (per current map)

  function tileKey(x, y) {
    return x + ',' + y;
  }
  function clearAll() {
    managed = false;
    activeByTile.clear();
    switchCache.clear();
  }

  // 资源事件的「消耗开关」= 空页(无角色图)且条件含 switch1 的那一页的 switch1Id
  function consumeSwitchOf(ev) {
    if (!ev || typeof ev.event !== 'function') return 0;
    if (switchCache.has(ev.eventId())) return switchCache.get(ev.eventId());
    let sw = 0;
    const data = ev.event();
    const pages = (data && data.pages) || [];
    for (const pg of pages) {
      const c = pg.conditions || {};
      const img = pg.image || {};
      if (c.switch1Valid && !img.characterName) {
        sw = c.switch1Id;
        break;
      }
    }
    switchCache.set(ev.eventId(), sw);
    return sw;
  }

  function resourceEventsOnMap() {
    if (typeof $gameMap === 'undefined' || !$gameMap) return [];
    return $gameMap.events().filter((e) => e && typeof e.event === 'function' && e.event() && /<Resource>/.test(e.event().note));
  }

  // 按服务端活跃集设置所有资源事件的消耗开关：活跃→OFF(显示)，非活跃→ON(隐藏)
  function applyServerState() {
    if (!managed || typeof $gameSwitches === 'undefined' || !$gameSwitches) return;
    for (const ev of resourceEventsOnMap()) {
      const sw = consumeSwitchOf(ev);
      if (!sw) continue;
      const active = activeByTile.has(tileKey(ev.x, ev.y));
      const desired = !active; // true=消耗/隐藏
      if ($gameSwitches.value(sw) !== desired) $gameSwitches.setValue(sw, desired);
    }
    if (typeof $gameMap.requestRefresh === 'function') $gameMap.requestRefresh();
  }

  function setTileSwitch(x, y, show) {
    for (const ev of resourceEventsOnMap()) {
      if (ev.x !== x || ev.y !== y) continue;
      const sw = consumeSwitchOf(ev);
      if (sw && $gameSwitches.value(sw) === show) $gameSwitches.setValue(sw, !show);
    }
  }

  function tileOfRid(rid) {
    for (const [k, v] of activeByTile) {
      if (v === rid) {
        const p = k.split(',');
        return { x: Number(p[0]), y: Number(p[1]) };
      }
    }
    return null;
  }

  // 进图快照(由 PlayerSync 的 enterMap/reconcile ack 注入)
  Gather.onEnterSnapshot = function (snap) {
    activeByTile.clear();
    switchCache.clear();
    managed = !!(snap && snap.gatherManaged);
    if (managed && snap && Array.isArray(snap.resources)) {
      for (const r of snap.resources) activeByTile.set(tileKey(r.x, r.y), r.rid);
    }
    if (managed) applyServerState();
  };

  Gather.isManagedMap = function () {
    return managed && typeof SceneManager !== 'undefined' && SceneManager._scene instanceof Scene_Map;
  };

  // GatherAsync 采集完成回调：通知服务端 despawn，但发货交回本地(走 Online_Inventory 权威库存)
  Gather.onResourceComplete = function (event) {
    if (managed && event) {
      const rid = activeByTile.get(tileKey(event.x, event.y));
      if (rid) {
        activeByTile.delete(tileKey(event.x, event.y));
        Net.emit('gather.claim', { rid }); // fire-and-forget：服务端 despawn+广播+排程 respawn
      }
    }
    return false; // 本地结算：发物(Online_Inventory 权威) + 扣体力 + 翻消耗开关
  };

  // 服务端增量：活跃集变化 → 驱动开关
  Net.on('gather.delta', (payload) => {
    if (!payload || !managed) return;
    let changed = false;
    if (Array.isArray(payload.spawn)) {
      for (const s of payload.spawn) {
        activeByTile.set(tileKey(s.x, s.y), s.rid);
        setTileSwitch(s.x, s.y, true); // 显示
        changed = true;
      }
    }
    if (Array.isArray(payload.claimed)) {
      for (const c of payload.claimed) {
        const t = tileOfRid(c.rid);
        if (t) {
          activeByTile.delete(tileKey(t.x, t.y));
          setTileSwitch(t.x, t.y, false); // 隐藏
          changed = true;
        }
      }
    }
    if (changed && $gameMap && typeof $gameMap.requestRefresh === 'function') $gameMap.requestRefresh();
  });

  Net.on('__disconnect__', clearAll);

  // 禁用本体「采集点刷新系统」CommonEvent 325(并行, 每 25200 帧=7 分钟翻 701-2979 OFF)在联机管理图的本地刷新
  // —— 资源刷新交服务端权威, 避免本地 7 分钟刷新绕过 / 与服务端冲突
  if (typeof Game_CommonEvent !== 'undefined') {
    const _CE_isActive = Game_CommonEvent.prototype.isActive;
    Game_CommonEvent.prototype.isActive = function () {
      if (this._commonEventId === 325 && Gather.isManagedMap()) return false;
      return _CE_isActive.call(this);
    };
  }
})();

