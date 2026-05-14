//=============================================================================
// XdRs_Online_Util.js
//=============================================================================
/*:
 * @target MZ
 * @plugindesc 联机-工具 | 全局命名空间、日志、节流、工具函数
 * @author xsg-online
 *
 * @help
 * 提供 window.XdRsOnline 命名空间和基础工具。
 * 无参数。后续所有 XdRs_Online_* 插件依赖本文件。
 */
(() => {
  'use strict';
  const G = (window.XdRsOnline = window.XdRsOnline || {});
  const Util = (G.Util = G.Util || {});
  const PREFIX = '[XSG-Online]';

  Util.LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
  Util.minLogLevel = Util.LOG_LEVELS.info;

  Util.log = function (level, ...args) {
    const lv = Util.LOG_LEVELS[level] != null ? Util.LOG_LEVELS[level] : Util.LOG_LEVELS.info;
    if (lv < Util.minLogLevel) return;
    const fn =
      level === 'error' ? console.error :
      level === 'warn' ? console.warn :
      console.log;
    fn(PREFIX, ...args);
  };

  Util.now = function () { return Date.now(); };

  Util.lerp = function (a, b, t) { return a + (b - a) * t; };

  Util.clamp = function (v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  };

  Util.throttle = function (fn, intervalMs) {
    let last = 0;
    let timer = null;
    let lastArgs = null;
    let lastThis = null;
    return function (...args) {
      const now = Date.now();
      const elapsed = now - last;
      lastArgs = args;
      lastThis = this;
      if (elapsed >= intervalMs) {
        last = now;
        fn.apply(lastThis, lastArgs);
      } else if (!timer) {
        timer = setTimeout(() => {
          last = Date.now();
          timer = null;
          fn.apply(lastThis, lastArgs);
        }, intervalMs - elapsed);
      }
    };
  };

  Util.deferred = function () {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };

  Util.showError = function (text) {
    if (typeof $gameMessage !== 'undefined' && $gameMessage && SceneManager && SceneManager._scene) {
      try { $gameMessage.add(text); return; } catch (e) { /* fall through */ }
    }
    if (typeof alert === 'function') alert(text);
  };

  G.version = '0.1.0';
})();
