//=============================================================================
// XdRs_Online_Time.js
//=============================================================================
/*:
 * @target MZ
 * @plugindesc 联机-服务端权威时间 | serverNow / 真实时钟格 / 每日重置闸门
 * @author xsg-online
 *
 * @param syncIntervalSec
 * @text 同步间隔(秒)
 * @type number
 * @min 10
 * @default 60
 *
 * @param reacquireSec
 * @text 强制重采间隔(秒)
 * @desc 即使 RTT 偏大, 超过此时长也接受新样本以纠正时钟漂移
 * @type number
 * @min 30
 * @default 300
 *
 * @help
 * 依赖 XdRs_Online_Util / XdRs_Online_Net (须在本插件之前加载)。
 *
 * 暴露 XdRsOnline.Time:
 *   Time.serverNow()        -> 服务端权威 epoch(ms); 未同步时回退本地 Date.now()
 *   Time.isSynced()         -> 是否已与服务端对过时
 *   Time.clockGrid()        -> 1..24, 现实小时对应的时钟格 (午夜0点=24)
 *   Time.consumeDailyReset()-> bool, 每真实自然日仅首次返回 true (持久化到存档)
 *   Time.status()           -> 调试信息
 *
 * 设计:
 *   - 连上服务端后立即同步, 之后每 syncIntervalSec 同步一次。
 *   - 用半-RTT 校正: offset = t_server - (t0+t1)/2, 取最小 RTT 样本最准。
 *   - clockGrid / consumeDailyReset 用 new Date(serverNow()) 的本地时区取小时/日,
 *     全 UTC+8 玩家一致; 服务端只下发 epoch, 时区中立。
 *   - 时钟显示与每日重置由公共事件 322 调用本插件函数驱动 (方案乙-1: 彻底真实时间)。
 */
(() => {
  'use strict';
  const G = (window.XdRsOnline = window.XdRsOnline || {});
  const Util = G.Util;
  if (!Util) { console.error('[XSG-Online] Time: Util missing, load XdRs_Online_Util first'); return; }
  const Net = G.Net;
  if (!Net) { console.error('[XSG-Online] Time: Net missing, load XdRs_Online_Net first'); return; }
  const LOG = Util.log;

  const params = PluginManager.parameters('XdRs_Online_Time');
  const SYNC_INTERVAL_MS = Math.max(10, Number(params.syncIntervalSec || 60)) * 1000;
  const REACQUIRE_MS = Math.max(30, Number(params.reacquireSec || 300)) * 1000;

  const Time = (G.Time = G.Time || {});

  let offsetMs = 0;       // serverNow = Date.now() + offsetMs
  let synced = false;
  let bestRtt = Infinity; // 当前采用样本的 RTT, 越小越准
  let lastAcceptTs = 0;   // 本地时间戳: 上次接受样本
  let lastSyncOkTs = 0;
  let inFlight = false;
  let timer = null;

  Time.serverNow = function () {
    return Date.now() + offsetMs;
  };

  Time.isSynced = function () {
    return synced;
  };

  // 现实小时 -> 时钟格: time-N 图与 VAR[2] 一致, 午夜(0点)映射到 24:00 格(触发"全新一天")
  Time.clockGrid = function () {
    const h = new Date(this.serverNow()).getHours(); // 0..23
    return h === 0 ? 24 : h;
  };

  // 服务端权威自然日编号(本地时区), 例 20260619
  function serverDayNum() {
    const d = new Date(Time.serverNow());
    return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  }

  // 每真实自然日仅首次返回 true; 未同步时不触发(防改本地钟提前刷新)。
  Time.consumeDailyReset = function () {
    try {
      if (!synced) return false;
      if (typeof $gameSystem === 'undefined' || !$gameSystem) return false;
      const today = serverDayNum();
      if ($gameSystem._xdrsLastDailyResetDay === today) return false;
      $gameSystem._xdrsLastDailyResetDay = today;
      return true;
    } catch (e) {
      LOG('warn', 'Time.consumeDailyReset error:', e && e.message);
      return false;
    }
  };

  // 每真实日分 periodsPerDay 段, 每段首次返回 true(key 区分用途, 持久化到存档)。
  // 例: consumePeriod('acquire',4) -> 每 6 小时一次(0/6/12/18 点各刷一次);
  //     玩家任意时刻登录, 当前时段未刷过则补刷一次。未同步不触发。
  Time.consumePeriod = function (key, periodsPerDay) {
    try {
      if (!synced) return false;
      if (typeof $gameSystem === 'undefined' || !$gameSystem) return false;
      const n = Math.max(1, Number(periodsPerDay) || 1);
      const d = new Date(this.serverNow());
      const dayNum = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
      const period = Math.floor(d.getHours() / (24 / n));
      const token = dayNum * 100 + period;
      if (!$gameSystem._xdrsPeriodTokens) $gameSystem._xdrsPeriodTokens = {};
      if ($gameSystem._xdrsPeriodTokens[key] === token) return false;
      $gameSystem._xdrsPeriodTokens[key] = token;
      return true;
    } catch (e) {
      LOG('warn', 'Time.consumePeriod error:', e && e.message);
      return false;
    }
  };

  Time.status = function () {
    return {
      synced,
      offsetMs,
      bestRtt: bestRtt === Infinity ? null : bestRtt,
      serverNow: this.serverNow(),
      serverTime: new Date(this.serverNow()).toLocaleString(),
      clockGrid: this.clockGrid(),
      lastSyncSecAgo: lastSyncOkTs ? Math.floor((Date.now() - lastSyncOkTs) / 1000) : null,
      lastDailyResetDay: (typeof $gameSystem !== 'undefined' && $gameSystem) ? $gameSystem._xdrsLastDailyResetDay : undefined,
    };
  };

  function syncOnce() {
    if (inFlight || !Net.isConnected()) return;
    inFlight = true;
    const t0 = Date.now();
    Net.request('time.sync', {})
      .then((data) => {
        const t1 = Date.now();
        const tServer = data && Number(data.t);
        if (!tServer || !isFinite(tServer)) { LOG('warn', 'time.sync bad payload'); return; }
        const rtt = t1 - t0;
        const candidate = tServer - (t0 + t1) / 2;
        const stale = (Date.now() - lastAcceptTs) > REACQUIRE_MS;
        if (!synced || rtt <= bestRtt || stale) {
          offsetMs = candidate;
          bestRtt = rtt;
          synced = true;
          lastAcceptTs = Date.now();
          LOG('debug', 'time sync accepted offset=' + Math.round(offsetMs) + 'ms rtt=' + rtt + 'ms');
        }
        lastSyncOkTs = Date.now();
      })
      .catch((err) => { LOG('warn', 'time.sync failed:', (err && err.message) || err); })
      .finally(() => { inFlight = false; });
  }
  Time.syncNow = syncOnce;

  function startLoop() {
    syncOnce();
    if (timer) clearInterval(timer);
    timer = setInterval(syncOnce, SYNC_INTERVAL_MS);
  }
  function stopLoop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  Net.on('__connect__', startLoop);
  Net.on('__disconnect__', stopLoop);
  // 装载时若已连接(理论上少见), 立即起步
  if (Net.isConnected()) startLoop();

  LOG('info', 'Time plugin loaded (server-authoritative clock, plan-乙1)');
})();
