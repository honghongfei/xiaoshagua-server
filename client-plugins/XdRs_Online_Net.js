//=============================================================================
// XdRs_Online_Net.js
//=============================================================================
/*:
 * @target MZ
 * @plugindesc 联机-网络层 | socket.io-client 封装 + Promise ack + 重连
 * @author xsg-online
 *
 * @param serverUrl
 * @text 服务器地址
 * @desc 形如 ws://127.0.0.1:3000 或 wss://your.domain.cn
 * @type string
 * @default ws://127.0.0.1:3000
 *
 * @param reconnectDelayMs
 * @text 重连间隔(ms)
 * @type number
 * @min 500
 * @default 3000
 *
 * @param ackTimeoutMs
 * @text ack 超时(ms)
 * @type number
 * @min 1000
 * @default 8000
 *
 * @help
 * 依赖：vendor/socket.io.min.js（已经由 plugins.js 前置加载）。
 * 暴露 XdRsOnline.Net 接口：
 *   Net.connect()    -> Promise
 *   Net.disconnect()
 *   Net.isConnected()
 *   Net.emit(event, payload)
 *   Net.request(event, payload, timeoutMs?) -> Promise<data>
 *   Net.on(event, fn) -> off函数
 *   Net.off(event, fn)
 *
 * 特殊事件：'__connect__'、'__disconnect__'(reason)
 */
(() => {
  'use strict';
  const G = (window.XdRsOnline = window.XdRsOnline || {});
  const Util = G.Util;
  if (!Util) { console.error('[XSG-Online] Net: Util missing, did you load XdRs_Online_Util first?'); return; }

  const params = PluginManager.parameters('XdRs_Online_Net');
  const cfg = {
    url: String(params.serverUrl || 'ws://127.0.0.1:3000'),
    reconnectMs: Number(params.reconnectDelayMs || 3000),
    ackTimeoutMs: Number(params.ackTimeoutMs || 8000),
  };

  const Net = (G.Net = G.Net || {});
  Net.config = cfg;

  let socket = null;
  const listeners = new Map();
  let connectDeferred = null;

  Net.isConnected = function () {
    return !!(socket && socket.connected);
  };

  Net.connect = function (url) {
    if (Net.isConnected()) return Promise.resolve();
    if (typeof window.io !== 'function') {
      return Promise.reject(new Error('socket.io vendor not loaded'));
    }
    if (connectDeferred) return connectDeferred.promise;

    connectDeferred = Util.deferred();
    const useUrl = url || cfg.url;

    socket = window.io(useUrl, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: cfg.reconnectMs,
      reconnectionDelayMax: cfg.reconnectMs * 4,
      timeout: cfg.ackTimeoutMs,
      forceNew: true,
    });

    socket.on('connect', () => {
      Util.log('info', 'connected', socket.id);
      _fanout('__connect__');
      if (connectDeferred) { connectDeferred.resolve(); connectDeferred = null; }
    });

    socket.on('disconnect', (reason) => {
      Util.log('warn', 'disconnected:', reason);
      _fanout('__disconnect__', reason);
    });

    socket.on('connect_error', (err) => {
      Util.log('warn', 'connect_error:', (err && err.message) || err);
      if (connectDeferred) { connectDeferred.reject(err); connectDeferred = null; }
    });

    socket.onAny((event, ...args) => _fanout(event, ...args));

    return connectDeferred.promise;
  };

  Net.disconnect = function () {
    if (socket) {
      try { socket.disconnect(); } catch (e) { /* ignore */ }
      socket = null;
    }
  };

  Net.on = function (event, handler) {
    let s = listeners.get(event);
    if (!s) { s = new Set(); listeners.set(event, s); }
    s.add(handler);
    return () => Net.off(event, handler);
  };

  Net.off = function (event, handler) {
    const s = listeners.get(event);
    if (s) s.delete(handler);
  };

  Net.emit = function (event, payload) {
    if (!Net.isConnected()) {
      Util.log('warn', 'emit skipped (not connected):', event);
      return;
    }
    socket.emit(event, payload);
  };

  Net.request = function (event, payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!Net.isConnected()) return reject(_err('NOT_CONNECTED', 'not connected'));
      const t = setTimeout(() => reject(_err('ACK_TIMEOUT', 'ack timeout: ' + event)), timeoutMs || cfg.ackTimeoutMs);
      socket.emit(event, payload, (resp) => {
        clearTimeout(t);
        if (!resp || typeof resp !== 'object') return reject(_err('BAD_ACK', 'bad ack shape'));
        if (resp.ok) return resolve(resp.data);
        const e = resp.error || { code: 'UNKNOWN', message: 'unknown error' };
        reject(_err(e.code, e.message));
      });
    });
  };

  function _fanout(event, ...args) {
    const s = listeners.get(event);
    if (!s) return;
    for (const fn of s) {
      try { fn(...args); } catch (e) { Util.log('error', 'listener error for', event, e); }
    }
  }

  function _err(code, message) {
    const e = new Error(message || code);
    e.code = code;
    return e;
  }
})();
