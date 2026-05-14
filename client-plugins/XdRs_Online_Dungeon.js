//=============================================================================
// XdRs_Online_Dungeon.js
//=============================================================================
/*:
 * @target MZ
 * @plugindesc 联机-副本 | regionId 触发副本进入 + 实例隔离 + 离开返回
 * @author xsg-online
 *
 * @param triggerRegionId
 * @text 进入副本的 regionId
 * @type number
 * @default 20
 *
 * @param defaultDungeonId
 * @text 该 region 默认对应副本 ID
 * @type string
 * @default test_cave
 *
 * @param exitRegionId
 * @text 副本内退出 regionId
 * @type number
 * @default 21
 *
 * @help
 * 玩家踩到指定 regionId 时调 `dungeon.enter`，服务端返回 virtualMapId；
 * 客户端转场到 baseMapId（资源是 baseMap 的），但服务端按 instance 路由广播。
 *
 * v1：副本内只有自己（partyIds 默认空）；后续可在好友面板做组队邀请。
 */
(() => {
  'use strict';
  const G = window.XdRsOnline;
  if (!G || !G.Net || !G.Core) {
    console.error('[XSG-Online] Dungeon: deps missing');
    return;
  }
  const Util = G.Util;
  const Net = G.Net;
  const Core = G.Core;
  const params = PluginManager.parameters('XdRs_Online_Dungeon');
  const cfg = {
    triggerRegion: Number(params.triggerRegionId || 20),
    dungeonId: String(params.defaultDungeonId || 'test_cave'),
    exitRegion: Number(params.exitRegionId || 21),
  };

  const Dungeon = (G.Dungeon = G.Dungeon || {});
  Dungeon.current = null; // {instanceId, virtualMapId, baseMapId, spawn, party}

  function checkStep() {
    if (!Core.isOnline() || !$gamePlayer) return;
    const rid = $gameMap.regionId($gamePlayer.x, $gamePlayer.y);
    if (rid === cfg.triggerRegion && !Dungeon.current) {
      enterCurrent();
    } else if (rid === cfg.exitRegion && Dungeon.current) {
      leaveCurrent();
    }
  }

  function enterCurrent() {
    Util.log('info', 'request dungeon enter:', cfg.dungeonId);
    Net.request('dungeon.enter', { dungeonId: cfg.dungeonId, partyIds: [] })
      .then((res) => {
        Dungeon.current = res;
        // Transfer to base map; server-side instance id is in Dungeon.current
        $gamePlayer.reserveTransfer(res.baseMapId, res.spawn.x, res.spawn.y, res.spawn.d, 0);
        Util.log('info', 'dungeon enter ok inst=' + res.instanceId);
      })
      .catch((err) => {
        Util.log('warn', 'dungeon.enter failed:', err && err.message);
      });
  }

  function leaveCurrent() {
    Net.request('dungeon.leave', {}).finally(() => {
      Dungeon.current = null;
    });
  }

  // Hook Game_Player update to check region after movement
  const _Game_Player_update = Game_Player.prototype.update;
  Game_Player.prototype.update = function (sceneActive) {
    _Game_Player_update.call(this, sceneActive);
    if (this.isMoving()) return;
    if (!this._xsgLastRegion) this._xsgLastRegion = -1;
    const rid = $gameMap && $gamePlayer ? $gameMap.regionId(this.x, this.y) : -1;
    if (rid !== this._xsgLastRegion) {
      this._xsgLastRegion = rid;
      checkStep();
    }
  };

  Net.on('dungeon.peerLeft.evt', (e) => {
    Util.log('info', 'dungeon peer left:', e && e.pid);
  });

  Net.on('dungeon.leave.evt', () => {
    Dungeon.current = null;
  });
})();
