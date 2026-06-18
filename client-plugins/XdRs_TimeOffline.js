//=============================================================================
// XdRs_TimeOffline.js  v1.0
//=============================================================================
/*:
 * @target MZ
 * @plugindesc 离线时间补偿 - 植物按 wall-clock 生长 + 采集点按 wall-clock 刷新
 * @author xsg-online
 *
 * @param maxOfflineGrowSec
 * @text 单次最长离线补偿(秒)
 * @desc 关游戏多久回来也只补偿这么多秒的植物生长。默认 8 小时 = 28800。
 * @type number
 * @min 0
 * @default 28800
 *
 * @param botanyLifeSec
 * @text 前台游玩时每个 life 对应秒数
 * @desc 前台正常游玩时, 植物每长 1 life 需要多少真实秒。默认 60 = 1 分钟,
 *       与单机原版完全一致。改大数会让前台游玩时植物长得更慢。
 * @type number
 * @min 1
 * @default 60
 *
 * @param offlineMaxLife
 * @text 离线 maxOfflineGrowSec 最多补几个 life
 * @desc 关游戏达到 maxOfflineGrowSec 上限时, 最多给植物加多少 life。
 *       默认 100 让 8 小时离线刚好把最长 (100-life) 植物补到成熟。
 *       注意: 这个上限是按"离线压缩比"算的, 数字越小压缩越狠 (离线长得越慢)。
 * @type number
 * @min 1
 * @default 100
 *
 * @param foregroundDeltaMs
 * @text 区分前台 / 离线的单次 delta 阈值(毫秒)
 * @desc 单次 update() 的 wall-delta 中, 前 N 毫秒按前台速率, 之后按离线压缩速率。
 *       默认 100 ms (覆盖 60fps 正常 16.6ms + 卡顿余量)。除非了解原理, 不建议改。
 * @type number
 * @min 50
 * @default 100
 *
 * @param gatherRefreshIntervalSec
 * @text 采集点刷新间隔(秒)
 * @desc 在线/离线累计 wall-clock 超过此时长就翻一次开关。默认 3600 = 1 小时。
 * @type number
 * @min 60
 * @default 3600
 *
 * @param gatherSwitchRange1Start
 * @text 第一段开关 ID 起
 * @type number
 * @min 1
 * @default 701
 *
 * @param gatherSwitchRange1End
 * @text 第一段开关 ID 止
 * @type number
 * @min 1
 * @default 2979
 *
 * @param gatherSwitchRange2Start
 * @text 第二段开关 ID 起
 * @type number
 * @min 1
 * @default 4003
 *
 * @param gatherSwitchRange2End
 * @text 第二段开关 ID 止
 * @type number
 * @min 1
 * @default 4090
 *
 * @param botanyEnabled
 * @text 启用植物离线补偿
 * @type boolean
 * @default true
 *
 * @param gatherEnabled
 * @text 启用采集点 wall-clock 刷新
 * @type boolean
 * @default true
 *
 * @param logLevel
 * @text 日志级别
 * @type select
 * @option off
 * @option info
 * @option debug
 * @default info
 *
 * @help
 * ============================================================================
 * 这个插件干什么的
 * ============================================================================
 * 解决两个 UX 痛点 (与单机/联机均无关, 纯本地体验优化):
 *
 *  1. 植物生长不再依赖"游戏窗口在前台运行"
 *     - 前台游玩: 与原版完全一致, 1 life = 60s wall-clock, 牡丹/古代小麦
 *       100 life = 100 分钟成熟。在线挂着不亏。
 *     - 后台 / 关游戏: 把"最多 maxOfflineGrowSec 秒离线时间"压缩成
 *       "最多 offlineMaxLife 个 life", 默认 8 小时 → 100 life,
 *       离线一次睡眠就能从种到收最长那株。压缩比 = 28800/(100*60) = 4.8。
 *     - 区分依据: 单次 update() 的 wall-delta. 60fps 时每帧只有 16.6ms,
 *       小于 foregroundDeltaMs (默认 100ms), 整段算前台 → 跟原版一样。
 *       浏览器把 tab 降到 1Hz 时每次 1000ms, 前 100ms 算前台 + 后 900ms 算离线。
 *       关游戏后第一次 update 的 delta 是关机时长, 几乎全部算离线。
 *
 *  2. 采集点不再要求"7 分钟连续在地图上"
 *     - 旧: 并行 CommonEvent 325 跑 41×wait(600 帧)≈7 分钟才翻开关
 *           而且必须保持游戏在前台、地图在 update, 离线/最小化都不算
 *     - 新: 三路并行触发, 任一满足就刷:
 *            (a) Scene_Map.start 时若 wall-clock 距上次刷新 ≥ 间隔, 立即刷
 *            (b) 在地图上每 60 秒轮询一次, AFK 挂机也能触发
 *            (c) 旧 CommonEvent 325 保留, 双保险
 *     - 间隔默认 1 小时 (gatherRefreshIntervalSec=3600), 比原版 7 分钟更保守
 *     - 翻开关方向: 与 CommonEvent 325 严格对齐, params[2]=1 => setValue(id, false),
 *       让消耗过的资源点 conditions 不再满足, 翻回有资源的页
 *     - 开关是全局的, 翻一次 = 全地图所有 *采集点* 同时回到有页面状态
 *
 * 工作机制
 * ----------------------------------------------------------------------------
 *  Game_Botany.update():
 *    - 替换原版的"每帧 _lifeCount++"
 *    - 用 _lastUpdateTs (随存档保存) 计算与上次 update 的 wall-clock 差值
 *    - 单次 delta 拆 前台 (≤ foregroundDeltaMs) + 离线 两段
 *    - 前台部分按 1 ms = 1 ms 计入; 离线部分按 OFFLINE_RATIO (默认 4.8) 压缩
 *    - 累积到 _lifeCountMs >= ONE_STAGE_MS 时调用一次 addLife()
 *    - delta 上限是 maxOfflineGrowSec, 防止改本地时钟速生
 *    - delta < 0 (倒拨时钟) 取 0
 *
 *  Scene_Map.start + 每 60 秒地图轮询 (gather refresh):
 *    - 检查 $gameSystem._lastGatherRefreshTs (随存档保存)
 *    - 若间隔 >= gatherRefreshIntervalSec, setSwitch(701..2979, false) +
 *      setSwitch(4003..4090, false), 与 CommonEvent 325 行为完全一致
 *    - 立即更新时间戳避免连续切图刷过头
 *    - 60 秒轮询确保 AFK 玩家不离开地图也能在 wall-clock 到点时刷
 *
 * 兼容性
 * ----------------------------------------------------------------------------
 *  - 老存档无 _lastUpdateTs / _lastGatherRefreshTs → 当作 now 处理, 不补偿、不刷新
 *    (即首次启动行为完全等同原版)
 *  - 与 SaveCloud / SaveMigrate 完全兼容: 新字段挂在 Game_Botany 实例和 $gameSystem 上,
 *    随 RMMZ 默认 saveContents 序列化
 *  - 与 SFCYtimecore 签到逻辑完全独立, 不重叠不冲突
 *  - 与并行 CommonEvent 325 同时存在, 无害
 *
 * 回滚
 * ----------------------------------------------------------------------------
 *  plugins.js 把 status 改 false 即关闭, 玩家存档里的新字段无副作用 (RMMZ 静默忽略)
 */
(() => {
  'use strict';
  const PLUGIN = 'XdRs_TimeOffline';
  const params = PluginManager.parameters(PLUGIN);
  const CFG = {
    maxOfflineGrowMs: Math.max(0, Number(params.maxOfflineGrowSec || 28800)) * 1000,
    botanyLifeMs: Math.max(1, Number(params.botanyLifeSec || 60)) * 1000,
    offlineMaxLife: Math.max(1, Number(params.offlineMaxLife || 100)),
    foregroundDeltaMs: Math.max(50, Number(params.foregroundDeltaMs || 100)),
    gatherRefreshIntervalMs: Math.max(60, Number(params.gatherRefreshIntervalSec || 3600)) * 1000,
    range1Start: Math.max(1, Number(params.gatherSwitchRange1Start || 701)),
    range1End:   Math.max(1, Number(params.gatherSwitchRange1End   || 2979)),
    range2Start: Math.max(1, Number(params.gatherSwitchRange2Start || 4003)),
    range2End:   Math.max(1, Number(params.gatherSwitchRange2End   || 4090)),
    botanyEnabled: params.botanyEnabled !== 'false',
    gatherEnabled: params.gatherEnabled !== 'false',
    logLevel: String(params.logLevel || 'info').toLowerCase(),
  };

  // 简易日志
  const LOG = (level, ...args) => {
    if (CFG.logLevel === 'off') return;
    if (CFG.logLevel === 'info' && level === 'debug') return;
    const prefix = '[TimeOffline]';
    const fn = level === 'warn' ? console.warn : (level === 'error' ? console.error : console.log);
    fn(prefix, ...args);
  };

  // 前台速率: 1 life = 60s wall-clock (与 RMMZ 原版 3600 帧 / 60fps 完全一致).
  // 离线压缩: 把 maxOfflineGrowMs 这段时间最多压缩到 offlineMaxLife 个 life.
  //          maxOffline=28800s, offlineMaxLife=100 → 离线每 288s 长 1 life.
  // 区分前台 / 离线的依据: 单次 update() 的 wall-delta.
  //   60fps 正常游玩 delta ~16.6ms → 全部按前台速率
  //   后台 throttled / 关游戏 → delta 很大, 前 foregroundDeltaMs 算前台,
  //   剩下算离线 (按比例换成毫秒后再加进 _lifeCountMs).
  const ONE_STAGE_MS = CFG.botanyLifeMs;
  const OFFLINE_RATIO = CFG.maxOfflineGrowMs / (CFG.offlineMaxLife * ONE_STAGE_MS);
  // OFFLINE_RATIO 默认 = 28800000 / (100 * 60000) = 4.8
  // 即"1ms 真实离线时间" 在内部记账成 "1/4.8 ms 前台时间", 这样 wall 8h 离线
  // → 内部累积 28800000/4.8 = 6_000_000ms = 100 life × 60_000ms, 正好 100 阶段.

  // ============================================================
  // 1. 植物 wall-clock 生长
  // ============================================================
  if (CFG.botanyEnabled) {
    if (typeof Game_Botany === 'undefined') {
      LOG('warn', 'Game_Botany undefined, botany compensation disabled (load order issue?)');
    } else {
      const _setup = Game_Botany.prototype.setup;
      Game_Botany.prototype.setup = function () {
        _setup.call(this);
        this._lastUpdateTs = Date.now();
        this._lifeCountMs = 0;
      };

      // 完全替换 update: 用 wall-clock 替代 _lifeCount++ per frame.
      //
      // 双速率: 单次 wall-delta 拆成两段
      //   - 前 foregroundDeltaMs (默认 100ms) 按前台速率 1ms = 1ms 计入
      //   - 之后的部分按离线压缩比例 OFFLINE_RATIO 计入 (1ms wall = 1/4.8 ms 内部)
      //
      // 60fps 正常前台: 每帧 delta ~16.6ms < 100ms, 行为完全等同原版.
      // 后台 throttled (1Hz): delta ~1000ms, 前 100ms 算前台, 后 900ms 压缩为 ~187ms,
      //   总计入 ~287ms, 等价于 ~ 0.287 倍前台速率, 比原版后台几乎不动好得多.
      // 关游戏 8h 重开: delta ~28_800_000ms (会被 maxOfflineGrowMs clamp), 前 100ms
      //   走前台 (无意义级别), 后 28_799_900ms 压缩为 28_799_900/4.8 = 5_999_979ms,
      //   再加上 100ms 前台 = 5_999_979 + 100 ≈ 6_000_000ms = 100 个 life × 60_000ms,
      //   正好 100 个阶段.
      Game_Botany.prototype.update = function () {
        // 已成熟, 不再生长, 但仍要刷新时间戳避免下次 update 算出巨大 delta
        if (this._life >= this._maxLife) {
          this._lastUpdateTs = Date.now();
          return;
        }

        const now = Date.now();
        // 老存档兼容: 字段缺失时初始化为 now, 本帧 delta = 0
        const lastTs = (typeof this._lastUpdateTs === 'number') ? this._lastUpdateTs : now;
        // 上限 + 倒拨保护
        const rawDelta = now - lastTs;
        const delta = Math.max(0, Math.min(rawDelta, CFG.maxOfflineGrowMs));
        this._lastUpdateTs = now;

        // 拆成 前台 + 离线 两段, 按各自速率换成内部毫秒
        const fgMs = Math.min(delta, CFG.foregroundDeltaMs);
        const bgMs = delta - fgMs;
        const internalMs = fgMs + bgMs / OFFLINE_RATIO;

        if (typeof this._lifeCountMs !== 'number') this._lifeCountMs = 0;
        this._lifeCountMs += internalMs;

        // 多阶段消费
        while (this._lifeCountMs >= ONE_STAGE_MS && this._life < this._maxLife) {
          this._lifeCountMs -= ONE_STAGE_MS;
          this.addLife();
        }
        // 已经成熟时把 lifeCountMs 清零, 避免数值爆炸
        if (this._life >= this._maxLife) this._lifeCountMs = 0;
      };

      LOG('info',
        'botany dual-rate enabled: foreground 1life=' + (ONE_STAGE_MS / 1000) + 's, ' +
        'offline ' + (CFG.maxOfflineGrowMs / 1000) + 's→' + CFG.offlineMaxLife + ' life ' +
        '(ratio=' + OFFLINE_RATIO.toFixed(3) + ')'
      );
    }
  }

  // ============================================================
  // 2. 采集点 wall-clock 刷新
  // ============================================================
  // 翻开关方向: 与 CommonEvent 325 的 [start,end,1] 完全一致 (1 = OFF)。
  // 资源事件页 1 的 conditions 多数是 "switch701 = true → 空页", 把开关置 OFF
  // 让 conditions 不再满足, 玩家会再次看到资源点.
  if (CFG.gatherEnabled) {
    const POLL_INTERVAL_MS = 60_000; // 地图上 60s 轮询一次, AFK 挂机也能触发

    let pollTimer = null;

    function applyGatherRefresh(reason) {
      if (!$gameSystem || !$gameSwitches) return false;

      // 联机管理图：资源存在/刷新由服务端权威驱动(XdRs_Online_Gather)，禁用本地每角色刷新
      const XG = window.XdRsOnline;
      if (XG && XG.Gather && typeof XG.Gather.isManagedMap === 'function' && XG.Gather.isManagedMap()) {
        LOG('debug', 'gather refresh skipped (server-managed map): ' + reason);
        return false;
      }

      const now = Date.now();
      const last = $gameSystem._lastGatherRefreshTs;

      // 老存档第一次 / 全新角色: 仅初始化时间戳, 不立刻刷
      if (typeof last !== 'number') {
        $gameSystem._lastGatherRefreshTs = now;
        LOG('debug', 'init gather refresh timestamp (' + reason + ')');
        return false;
      }

      const elapsed = now - last;
      if (elapsed < CFG.gatherRefreshIntervalMs) {
        LOG('debug', 'gather refresh skipped (' + reason + '), elapsed=' +
            Math.floor(elapsed / 1000) + 's < ' +
            Math.floor(CFG.gatherRefreshIntervalMs / 1000) + 's');
        return false;
      }

      // 翻两段开关, 与 CommonEvent 325 完全一致 (置 OFF)
      let count = 0;
      for (let id = CFG.range1Start; id <= CFG.range1End; id++) {
        $gameSwitches.setValue(id, false);
        count++;
      }
      for (let id = CFG.range2Start; id <= CFG.range2End; id++) {
        $gameSwitches.setValue(id, false);
        count++;
      }
      $gameSystem._lastGatherRefreshTs = now;
      // 全图事件刷新, 让正在显示的事件立即采用新页
      if ($gameMap && typeof $gameMap.requestRefresh === 'function') {
        $gameMap.requestRefresh();
      }
      LOG('info', 'gather refresh fired (' + reason + ', offline ' +
          Math.floor(elapsed / 1000) + 's, switches=' + count + ')');
      return true;
    }

    // (a) 进入 Scene_Map 立即检查 (覆盖"刚开游戏"+"切图")
    const _Scene_Map_start = Scene_Map.prototype.start;
    Scene_Map.prototype.start = function () {
      _Scene_Map_start.call(this);
      try { applyGatherRefresh('mapStart'); } catch (e) { LOG('warn', 'refresh failed:', e && e.message); }
      // (b) 启动 60s 轮询, 覆盖 AFK / 后台挂机
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(() => {
        try { applyGatherRefresh('poll'); } catch (e) { LOG('warn', 'poll refresh failed:', e && e.message); }
      }, POLL_INTERVAL_MS);
    };

    // 离开 Scene_Map 停掉轮询
    const _Scene_Map_terminate = Scene_Map.prototype.terminate;
    Scene_Map.prototype.terminate = function () {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      _Scene_Map_terminate.call(this);
    };

    // 暴露给调试钩子用
    Game_System.prototype._applyGatherRefreshNow = function () {
      return applyGatherRefresh('debug');
    };
  }

  // ============================================================
  // 3. 暴露调试钩子 (玩家可以 F12 控制台用)
  // ============================================================
  window.XdRsTimeOffline = {
    cfg: CFG,
    forceRefreshGather() {
      if (!$gameSystem) return false;
      $gameSystem._lastGatherRefreshTs = 0;
      if (typeof $gameSystem._applyGatherRefreshNow === 'function') {
        return $gameSystem._applyGatherRefreshNow();
      }
      return false;
    },
    botanyStatus() {
      if (!$gameSystem || !$gameSystem._botanys) return [];
      const now = Date.now();
      return $gameSystem._botanys.filter(b => b).map(b => ({
        id: b.id(),
        mapId: b.mapId(),
        item: b.data() && b.data().name,
        life: b._life + '/' + b._maxLife,
        stage: b.stage(),
        lifeCountMs: b._lifeCountMs || 0,
        idleSec: b._lastUpdateTs ? Math.floor((now - b._lastUpdateTs) / 1000) : null,
      }));
    },
    gatherStatus() {
      if (!$gameSystem) return null;
      const now = Date.now();
      const last = $gameSystem._lastGatherRefreshTs;
      if (typeof last !== 'number') return { lastRefreshTs: null, idleSec: null, intervalSec: CFG.gatherRefreshIntervalMs / 1000 };
      return {
        lastRefreshTs: last,
        lastRefreshAt: new Date(last).toLocaleString(),
        idleSec: Math.floor((now - last) / 1000),
        intervalSec: CFG.gatherRefreshIntervalMs / 1000,
        nextRefreshIn: Math.max(0, Math.floor((CFG.gatherRefreshIntervalMs - (now - last)) / 1000)),
      };
    },
  };

  LOG('info', 'plugin loaded; botany=' + CFG.botanyEnabled + ' gather=' + CFG.gatherEnabled);
})();
