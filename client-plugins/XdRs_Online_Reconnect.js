//=============================================================================
// XdRs_Online_Reconnect.js
//=============================================================================
/*:
 * @target MZ
 * @plugindesc 联机-断线重连 | localStorage token + socket 重连后自动重新鉴权
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
 * 登录/注册成功后保存 token。下次启动时自动 auth.resume。
 *
 * 断线恢复时会先等 socket.io 重新连上，再循环 auth.resume，成功后重新 enterMap。
 * 这样可以避免“socket connected 但服务端新 socket 未鉴权”的假在线状态。
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
  const AUTH_RETRY_BASE_MS = 1000;
  const AUTH_RETRY_MAX_MS = 30000;
  const SESSION_REFRESH_MS = 10 * 60 * 1000;

  let serverAuthed = false;
  let reauthTimer = null;
  let reauthInFlight = false;
  let reauthAttempt = 0;
  let reauthSeq = 0;
  let refreshTimer = null;

  Re.saveToken = function (token) {
    try { localStorage.setItem(cfg.key, token || ''); } catch (e) { /* ignore */ }
  };

  Re.loadToken = function () {
    try { return localStorage.getItem(cfg.key) || ''; } catch (e) { return ''; }
  };

  Re.clearToken = function () {
    try { localStorage.removeItem(cfg.key); } catch (e) { /* ignore */ }
  };

  Re.isServerAuthed = function () {
    return serverAuthed;
  };

  function setServerAuthed(value) {
    serverAuthed = !!value;
  }

  const _setSession = Core.setSession;
  Core.setSession = function (session) {
    _setSession.call(this, session);
    if (session && session.token) {
      Re.saveToken(session.token);
      setServerAuthed(Net.isConnected());
      startSessionRefresh();
    }
  };

  const _clearSession = Core.clearSession;
  Core.clearSession = function () {
    stopSessionRefresh();
    cancelReauth();
    setServerAuthed(false);
    Re.clearToken();
    _clearSession.call(this);
  };

  const _isOnline = Core.isOnline;
  Core.isOnline = function () {
    return _isOnline.call(this) && Re.isServerAuthed();
  };

  Re.tryResume = function () {
    const token = Re.loadToken();
    if (!token) return Promise.resolve(false);
    return Net.connect()
      .then(() => requestResume(token, 10000))
      .then((resp) => {
        Core.setSession({ token: (resp && resp.token) || token, character: resp && resp.character });
        Util.log('info', 'auto-resume ok pid=' + (resp && resp.character && resp.character.pid));
        return true;
      })
      .catch((err) => {
        Util.log('warn', 'auto-resume failed:', err && err.code, err && err.message);
        if (isPermanentAuthError(err)) Re.clearToken();
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
      Util.log('info', 'auto-resume succeeded, session ready; click online/M to enter game');
    });
  };

  let isFirstConnect = true;
  Net.on('__connect__', () => {
    if (isFirstConnect) { isFirstConnect = false; return; }
    setServerAuthed(false);
    scheduleReauth('socket reconnect', 0, true);
  });

  Net.on('__disconnect__', () => {
    setServerAuthed(false);
    cancelReauth();
  });

  Net.on('__auth_lost__', (event) => {
    Util.log('warn', 'server auth lost after request:', event);
    setServerAuthed(false);
    scheduleReauth('NO_AUTH ' + (event || ''), 0, true);
  });

  function authPayload(token) {
    return { token, clientVer: G.version };
  }

  function requestResume(token, timeoutMs) {
    const payload = authPayload(token);
    if (typeof Net.requestRetry === 'function') {
      return Net.requestRetry('auth.resume', payload, { timeout: timeoutMs || 10000, retries: 2, retryDelay: 800, reconnectWaitMs: 15000 });
    }
    return Net.request('auth.resume', payload, timeoutMs || 10000);
  }

  function isPermanentAuthError(err) {
    const code = err && err.code;
    return code === 'TOKEN_INVALID' || code === 'TOKEN_EXPIRED' || code === 'CHAR_GONE';
  }

  function retryDelay() {
    const pow = Math.min(5, reauthAttempt);
    return Math.min(AUTH_RETRY_MAX_MS, AUTH_RETRY_BASE_MS * Math.pow(2, pow)) + Math.floor(Math.random() * 500);
  }

  function cancelReauth() {
    if (reauthTimer) {
      clearTimeout(reauthTimer);
      reauthTimer = null;
    }
    reauthSeq += 1;
    reauthInFlight = false;
  }

  function scheduleReauth(reason, delayMs, reenterMap) {
    if (!Core.session) return;
    if (!Re.loadToken()) return;
    if (!Net.isConnected()) return;
    if (reauthTimer) clearTimeout(reauthTimer);
    const seq = reauthSeq;
    reauthTimer = setTimeout(() => {
      reauthTimer = null;
      if (seq !== reauthSeq) return;
      if (reauthInFlight) {
        scheduleReauth(reason, 500, reenterMap);
        return;
      }
      runReauth(reason, reenterMap !== false, seq);
    }, Math.max(0, delayMs || 0));
  }

  function runReauth(reason, reenterMap, seq) {
    if (seq == null) seq = reauthSeq;
    if (reauthInFlight) return;
    if (!Core.session || !Net.isConnected()) return;
    const token = Re.loadToken();
    if (!token) return;

    reauthInFlight = true;
    Util.log('info', 're-auth attempt #' + (reauthAttempt + 1) + ' (' + reason + ')');
    requestResume(token, 10000)
      .then((resp) => {
        if (seq !== reauthSeq) return;
        reauthAttempt = 0;
        if (resp && resp.character) Core.setSession({ token: resp.token || token, character: resp.character });
        setServerAuthed(true);
        Util.log('info', 're-auth ok pid=' + (resp && resp.character && resp.character.pid));
        if (reenterMap) reenterCurrentMap();
      })
      .catch((err) => {
        if (seq !== reauthSeq) return;
        if (isPermanentAuthError(err)) {
          Util.log('warn', 'session expired, login required:', err && err.code, err && err.message);
          notifySessionExpired();
          Core.clearSession();
          return;
        }
        if (reenterMap || !serverAuthed) setServerAuthed(false);
        reauthAttempt += 1;
        Util.log('warn', 're-auth failed, will retry:', err && err.code, err && err.message);
        scheduleReauth('retry ' + reason, retryDelay(), reenterMap || !serverAuthed);
      })
      .finally(() => {
        if (seq === reauthSeq) reauthInFlight = false;
      });
  }

  function reenterCurrentMap() {
    const G2 = window.XdRsOnline;
    if (G2 && G2.PlayerSync && typeof G2.PlayerSync.enterCurrentMap === 'function' && SceneManager._scene instanceof Scene_Map) {
      G2.PlayerSync.enterCurrentMap();
    }
  }

  function startSessionRefresh() {
    stopSessionRefresh();
    if (!Core.session || !Re.loadToken()) return;
    refreshTimer = setInterval(() => {
      if (!Core.session || !Net.isConnected()) return;
      runReauth('session refresh', !serverAuthed, reauthSeq);
    }, SESSION_REFRESH_MS);
  }

  function stopSessionRefresh() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  function notifySessionExpired() {
    const msg = 'Online session expired. Please login again.';
    if (typeof $gameTemp !== 'undefined' && $gameTemp && typeof $gameTemp.addWorldMessage === 'function') {
      try { $gameTemp.addWorldMessage('\\c[10][System]\\c[0] ' + msg, true); return; } catch (e) { /* ignore */ }
    }
    Util.log('warn', msg);
  }
})();
