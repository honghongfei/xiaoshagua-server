//=============================================================================
// XdRs_Online_Core.js
//=============================================================================
/*:
 * @target MZ
 * @plugindesc 联机-核心 | 生命周期、会话、共享状态
 * @author xsg-online
 *
 * @param logLevel
 * @text 客户端日志级别
 * @type select
 * @option debug
 * @option info
 * @option warn
 * @option error
 * @default info
 *
 * @help
 * 联机入口。在 Scene_Boot.start 之后初始化命名空间，维护当前会话：
 *   - Core.session = { token, character }
 *   - Core.isOnline() = 同时具备 session 与已连接 socket
 *
 * 不会自动连接服务端，由 Login 插件在用户点击时再 Net.connect()。
 */
(() => {
  'use strict';
  const G = (window.XdRsOnline = window.XdRsOnline || {});
  const Util = G.Util;
  const Net = G.Net;
  if (!Util || !Net) {
    console.error('[XSG-Online] Core: depends on Util + Net, check plugin order');
    return;
  }

  const params = PluginManager.parameters('XdRs_Online_Core');
  Util.minLogLevel = Util.LOG_LEVELS[params.logLevel] != null
    ? Util.LOG_LEVELS[params.logLevel]
    : Util.LOG_LEVELS.info;

  const Core = (G.Core = G.Core || {});
  Core.enabled = true;
  Core.session = null;

  Core.setSession = function (session) {
    Core.session = session;
    Util.log('info', 'session set pid=' + (session && session.character && session.character.pid));
  };

  Core.clearSession = function () {
    Core.session = null;
    Net.disconnect();
    Util.log('info', 'session cleared');
  };

  Core.isOnline = function () {
    return !!(Core.session && Net.isConnected());
  };

  const _Scene_Boot_start = Scene_Boot.prototype.start;
  Scene_Boot.prototype.start = function () {
    _Scene_Boot_start.call(this);
    Util.log('info', 'XSG-Online client v' + (G.version || '?') + ' ready, server=' + Net.config.url);
  };
})();
