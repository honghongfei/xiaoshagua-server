//=============================================================================
// XdRs_AfkGather.js
//=============================================================================
/*:
 * @target MZ
 * @plugindesc 在线挂机采集：联机+地图时失焦也继续 update，让本体宝宝挂后台自动采集
 * @author xsg-online
 * @help 仅当「已联机 + 当前 Scene_Map + 开关开(默认开)」时放行失焦 update。
 *   插件命令 ToggleAfkGather 可开关；$gameSystem.afkGatherEnabled() 读状态。
 *   其余场景(菜单/战斗/标题)维持原生失焦冻结。
 *
 * @command ToggleAfkGather
 * @text 开关挂机采集
 * @desc 切换在线挂机采集开关（默认开）。
 *
 * @param afkFpsDivider
 * @type number
 * @min 1
 * @default 1
 * @text 失焦降帧分频(1=满帧)
 * @desc 失焦挂机时每 N 帧渲染一次（仅省渲染，不省逻辑）。1=满帧。
 */
(() => {
  'use strict';
  const pluginName = 'XdRs_AfkGather';

  Game_System.prototype.afkGatherEnabled = function () {
    return this._afkGather !== false; // 默认开
  };
  Game_System.prototype.setAfkGather = function (on) {
    this._afkGather = !!on;
  };

  const _isActive = SceneManager.isGameActive;
  SceneManager.isGameActive = function () {
    const N = window.XdRsOnline && window.XdRsOnline.Net;
    if (N && N.isConnected && N.isConnected()
        && this._scene instanceof Scene_Map
        && $gameSystem && $gameSystem.afkGatherEnabled && $gameSystem.afkGatherEnabled()) {
      return true; // 在线 + 地图 + 开关开 → 失焦也 update
    }
    return _isActive.call(this);
  };

  PluginManager.registerCommand(pluginName, 'ToggleAfkGather', () => {
    $gameSystem.setAfkGather(!$gameSystem.afkGatherEnabled());
  });
})();
