//=============================================================================
// XdRs_Online_Reconnect.js
//=============================================================================
/*:
 * @target MZ
 * @plugindesc 联机-断线重连 | localStorage 保存 token，开机自动 resume
 * @author xsg-online
 *
 * @param storageKey
 * @text localStorage key
 * @type string
 * @default xsg.token
 *
 * @param autoResumeOnBoot
 * @text 开机自动尝试 resume
 * @type boolean
 * @default true
 *
 * @help
 * 登录/注册成功后把 token 写入 localStorage；下次启动 Scene_Title 前
 * 自动尝试 auth.resume，成功则跳过登录界面直接进 Scene_Map。
 *
 * 失败（token 过期 / 角色被删）则清除本地 token 并走正常登录流程。
 */
(() => {
  'use strict';
  const G = window.XdRsOnline;
  if (!G || !G.Net || !G.Core) {
    console.error('[XSG-Online] Reconnect: deps missing');
    return;
  }
  const Util = G.Util;
  const Net = G.Net;
  const Core = G.Core;
  const params = PluginManager.parameters('XdRs_Online_Reconnect');
  const cfg = {
    key: String(params.storageKey || 'xsg.token'),
    autoResume: String(params.autoResumeOnBoot || 'true') === 'true',
  };

  const Re = (G.Reconnect = G.Reconnect || {});

  Re.saveToken = function (token) {
    try { localStorage.setItem(cfg.key, token || ''); } catch (e) { /* ignore */ }
  };

  Re.loadToken = function () {
    try { return localStorage.getItem(cfg.key) || ''; } catch (e) { return ''; }
  };

  Re.clearToken = function () {
    try { localStorage.removeItem(cfg.key); } catch (e) { /* ignore */ }
  };

  // ---------- Hook Core.setSession to persist ----------
  const _setSession = Core.setSession;
  Core.setSession = function (session) {
    _setSession.call(this, session);
    if (session && session.token) Re.saveToken(session.token);
  };

  const _clearSession = Core.clearSession;
  Core.clearSession = function () {
    Re.clearToken();
    _clearSession.call(this);
  };

  // ---------- Auto resume on Scene_Title ----------
  Re.tryResume = function () {
    const token = Re.loadToken();
    if (!token) return Promise.resolve(false);
    return Net.connect().then(() => Net.request('auth.resume', { token })).then((resp) => {
      Core.setSession({ token: resp.token, character: resp.character });
      Util.log('info', 'auto-resume ok pid=' + resp.character.pid);
      return true;
    }).catch((err) => {
      Util.log('warn', 'auto-resume failed:', err && err.code, err && err.message);
      Re.clearToken();
      return false;
    });
  };

  const _Scene_Title_create = Scene_Title.prototype.create;
  Scene_Title.prototype.create = function () {
    _Scene_Title_create.call(this);
    if (!cfg.autoResume) return;
    if (Re._tried) return;
    Re._tried = true;
    Re.tryResume().then((ok) => {
      if (!ok) return;
      const ch = Core.session.character;
      const sys = (typeof $dataSystem !== 'undefined' && $dataSystem) ? $dataSystem : null;
      const fbMap = (sys && sys.startMapId) || 1;
      const fbX = (sys && sys.startX != null) ? sys.startX : 8;
      const fbY = (sys && sys.startY != null) ? sys.startY : 6;
      DataManager.setupNewGame();
      $gameParty.setupStartingMembers();
      $gamePlayer.reserveTransfer(
        ch.mapId || fbMap,
        ch.x != null ? ch.x : fbX,
        ch.y != null ? ch.y : fbY,
        ch.d || 2,
        0,
      );
      SceneManager.goto(Scene_Map);
    });
  };
})();
