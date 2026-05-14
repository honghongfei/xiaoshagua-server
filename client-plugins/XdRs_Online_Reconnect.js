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

  // 仅恢复会话（token + character），不会替你按「联机」也不跳 Scene_Map。
  // 这样你还能选「新游戏」走完原本的角色创建流程；
  // 真要进游戏，按 M 或点右上「联机」即可，登录窗会识别已有 session 自动跳过密码。
  const _Scene_Title_create = Scene_Title.prototype.create;
  Scene_Title.prototype.create = function () {
    _Scene_Title_create.call(this);
    if (!cfg.autoResume) return;
    if (Re._tried) return;
    Re._tried = true;
    Re.tryResume().then((ok) => {
      if (!ok) return;
      Util.log('info', 'auto-resume succeeded, session ready; click 联机/M to enter game');
    });
  };

  // ---------- 重连后自动 re-auth + re-enterMap (防 socket 短暂断后 NO_AUTH) ----------
  // 三步闭环
  //   发起端 client: socket.io 收到 '__connect__' 二次/N 次连接事件
  //   服端    server: 老 socket-to-pid 已随上一个 socket 释放, 新 socket 必须重走 auth.resume
  //   表现端 client: re-enter 当前 map 让 server.online_tracker 重新挂上, 表现层无感知
  // 兜底
  //   没 token / 没 session : 直接 return, 当成纯新连
  //   auth.resume reject    : Util.log warn, 但不 clearToken (因为可能仅是 server 短暂超时)
  //   player.enterMap reject: Util.log warn, 表现是过几秒位置不同步, 下次 Scene_Map.start 自然再修
  let isFirstConnect = true;
  Net.on('__connect__', () => {
    if (isFirstConnect) { isFirstConnect = false; return; }
    if (!Re || typeof Re.loadToken !== 'function') return;
    const token = Re.loadToken();
    if (!token) return;
    if (!Core.session) return;
    Util.log('info', 'socket reconnected, auto re-auth…');
    Net.request('auth.resume', { token }, 6000)
      .then((resp) => {
        if (resp && resp.character) Core.setSession({ token: resp.token || token, character: resp.character });
        Util.log('info', 're-auth ok pid=' + (resp && resp.character && resp.character.pid));
        const G2 = window.XdRsOnline;
        if (G2 && G2.PlayerSync && typeof G2.PlayerSync.enterCurrentMap === 'function' && SceneManager._scene instanceof Scene_Map) {
          G2.PlayerSync.enterCurrentMap();
        }
      })
      .catch((err) => {
        Util.log('warn', 're-auth failed:', err && err.code, err && err.message);
      });
  });
})();
