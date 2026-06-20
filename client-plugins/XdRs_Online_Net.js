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
 * @default 25000
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
    ackTimeoutMs: Number(params.ackTimeoutMs || 25000),
  };

  const Net = (G.Net = G.Net || {});
  Net.config = cfg;

  let socket = null;
  const listeners = new Map();
  const pending = new Set(); // 在途 request: { settle(fn,arg), timer }
  let connectDeferred = null;
  let manualDisconnect = false;

  // 断线/换 socket 时立即 reject 所有在途 request, 否则它们要挂到各自 ackTimeout 才失败.
  function _rejectAllPending(code, message) {
    if (pending.size === 0) return;
    const arr = Array.from(pending);
    pending.clear();
    for (const entry of arr) {
      try { entry.fail(_err(code, message)); } catch (e) { /* ignore */ }
    }
  }

  Net.isConnected = function () {
    return !!(socket && socket.connected);
  };

  Net.connect = function (url) {
    if (Net.isConnected()) return Promise.resolve();
    if (typeof window.io !== 'function') {
      return Promise.reject(new Error('socket.io vendor not loaded'));
    }
    if (connectDeferred) return connectDeferred.promise;
    manualDisconnect = false;

    // 清理可能残留的旧 socket(已断开但未释放): 不清会留下旧的 onAny / connect 监听器,
    // 新 socket forceNew 再叠一层 -> 事件 fanout 翻倍 + 孤儿连接在后台偷偷重连.
    if (socket) {
      try { socket.removeAllListeners(); } catch (e) { /* ignore */ }
      try { socket.disconnect(); } catch (e) { /* ignore */ }
      socket = null;
      _rejectAllPending('NET_RESET', 'socket replaced before reconnect');
    }

    connectDeferred = Util.deferred();
    const useUrl = url || cfg.url;

    socket = window.io(useUrl, {
      transports: ['polling', 'websocket'],
      upgrade: true,
      tryAllTransports: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: cfg.reconnectMs,
      reconnectionDelayMax: cfg.reconnectMs * 4,
      randomizationFactor: 0.5,
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
      _rejectAllPending('NET_DISCONNECTED', 'disconnected: ' + reason);
      _fanout('__disconnect__', reason);
      if (!manualDisconnect && reason === 'io server disconnect' && socket) {
        setTimeout(() => {
          if (socket && !socket.connected) {
            try { socket.connect(); } catch (e) { /* retry on next timer */ }
          }
        }, cfg.reconnectMs);
      }
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
      manualDisconnect = true;
      try { socket.disconnect(); } catch (e) { /* ignore */ }
      socket = null;
    }
    _rejectAllPending('CLIENT_DISCONNECT', 'client disconnected');
    if (connectDeferred) {
      connectDeferred.reject(_err('CLIENT_DISCONNECT', 'client disconnected'));
      connectDeferred = null;
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
      const entry = { settled: false };
      const finish = (fn, arg) => {
        if (entry.settled) return;
        entry.settled = true;
        clearTimeout(entry.timer);
        pending.delete(entry);
        fn(arg);
      };
      entry.fail = (err) => finish(reject, err);
      entry.timer = setTimeout(() => finish(reject, _err('ACK_TIMEOUT', 'ack timeout: ' + event)), timeoutMs || cfg.ackTimeoutMs);
      pending.add(entry);
      socket.emit(event, payload, (resp) => {
        if (!resp || typeof resp !== 'object') return finish(reject, _err('BAD_ACK', 'bad ack shape'));
        if (resp.ok) return finish(resolve, resp.data);
        const e = resp.error || { code: 'UNKNOWN', message: 'unknown error' };
        if (e.code === 'NO_AUTH') _fanout('__auth_lost__', event);
        finish(reject, _err(e.code, e.message));
      });
    });
  };

  // 网络类错误(可安全重试): 连接/心跳/ack 层面的失败, 非业务拒绝(NO_AUTH/SAVE_STALE 等不重试)
  function _isRetriable(err) {
    const code = err && err.code;
    return code === 'NET_DISCONNECTED' || code === 'ACK_TIMEOUT' ||
      code === 'NOT_CONNECTED' || code === 'NET_RESET' || code === 'BAD_ACK';
  }

  // 等待连接就绪(配合 socket.io 自动重连): 已连接立即 resolve, 否则等 __connect__ 或超时
  Net.waitConnected = function (timeoutMs) {
    if (Net.isConnected()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let done = false;
      let off = null;
      const t = setTimeout(() => {
        if (done) return; done = true; if (off) off();
        reject(_err('CONNECT_TIMEOUT', 'wait connected timeout'));
      }, timeoutMs || 15000);
      off = Net.on('__connect__', () => {
        if (done) return; done = true; clearTimeout(t); off();
        resolve();
      });
    });
  };

  // 幂等请求自动重试: 网络类失败时(丢包/抖动断连)等待重连后重发, 业务错误立即抛出.
  // 仅用于幂等操作(save.download / auth.login / auth.resume / *.snapshot 等), 切勿用于 buy/use 等非幂等.
  // opts: { timeout, retries=2, retryDelay=800, reconnectWaitMs=15000 }
  Net.requestRetry = function (event, payload, opts) {
    opts = opts || {};
    const retries = opts.retries != null ? opts.retries : 2;
    const timeout = opts.timeout;
    const retryDelay = opts.retryDelay != null ? opts.retryDelay : 800;
    const reconnectWaitMs = opts.reconnectWaitMs != null ? opts.reconnectWaitMs : 15000;
    let attempt = 0;
    const run = () => Net.request(event, payload, timeout).catch((err) => {
      if (attempt >= retries || !_isRetriable(err)) throw err;
      attempt++;
      Util.log('warn', 'request retry ' + attempt + '/' + retries + ' for ' + event + ' (' + (err && err.code) + ')');
      const wait = Net.isConnected() ? Promise.resolve() : Net.waitConnected(reconnectWaitMs);
      return wait.then(() => new Promise((r) => setTimeout(r, retryDelay))).then(run);
    });
    return run();
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
