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
 * @param gatherRefreshIntervalSec
 * @text 采集点刷新间隔(秒)
 * @desc 进入地图时若距上次刷新超过此时长则立即翻开关。默认 420 = 7 分钟, 与 CommonEvent 325 一致。
 * @type number
 * @min 30
 * @default 420
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
 *     - 旧: _lifeCount++ 每帧 +1, 60 秒 (3600 帧) 长一阶段, 关游戏=暂停
 *     - 新: 按 wall-clock 计时, 关游戏 1 小时回来植物长 1 小时, 上限 8 小时
 *
 *  2. 采集点不再要求"7 分钟连续在地图上"
 *     - 旧: 并行 CommonEvent 325 跑 41×wait(600 帧)≈7 分钟才翻开关
 *     - 新: 进 Scene_Map 时若距上次刷新已经过去 7 分钟, 立即翻开关
 *     - 旧的 CommonEvent 325 仍在跑, 双保险, setSwitch 幂等无副作用
 *
 * 工作机制
 * ----------------------------------------------------------------------------
 *  Game_Botany.update():
 *    - 替换原版的"每帧 _lifeCount++"
 *    - 用 _lastUpdateTs (随存档保存) 计算与上次 update 的 wall-clock 差值
 *    - 累积到 _lifeCountMs >= 60000 时调用一次原版 addLife()
 *    - delta 上限是 maxOfflineGrowSec, 防止改本地时钟速生
 *    - delta < 0 (倒拨时钟) 取 0
 *
 *  Scene_Map.start (gather refresh):
 *    - 检查 $gameSystem._lastGatherRefreshTs (随存档保存)
 *    - 若间隔 >= gatherRefreshIntervalSec, setSwitch(701..2979 + 4003..4090, true)
 *    - 立即更新时间戳避免连续切图刷过头
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
    gatherRefreshIntervalMs: Math.max(30, Number(params.gatherRefreshIntervalSec || 420)) * 1000,
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

  const ONE_STAGE_MS = 60 * 1000;  // 原版 3600 帧 / 60fps = 60 秒 = 1 阶段

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

      // 完全替换 update: 用 wall-clock 替代 _lifeCount++ per frame
      // 原版会 3600 帧 → addLife(), 等价于 60000ms → addLife()
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

        if (typeof this._lifeCountMs !== 'number') this._lifeCountMs = 0;
        this._lifeCountMs += delta;

        // 多阶段补偿 (离线 8 小时一次性长 8 阶段)
        while (this._lifeCountMs >= ONE_STAGE_MS && this._life < this._maxLife) {
          this._lifeCountMs -= ONE_STAGE_MS;
          this.addLife();
        }
        // 已经成熟时把 lifeCountMs 清零, 避免数值爆炸
        if (this._life >= this._maxLife) this._lifeCountMs = 0;
      };

      LOG('info', 'botany wall-clock compensation enabled, max=' + CFG.maxOfflineGrowMs / 1000 + 's');
    }
  }

  // ============================================================
  // 2. 采集点 wall-clock 刷新
  // ============================================================
  if (CFG.gatherEnabled) {
    const _Scene_Map_start = Scene_Map.prototype.start;
    Scene_Map.prototype.start = function () {
      _Scene_Map_start.call(this);
      try {
        applyGatherRefresh();
      } catch (e) {
        LOG('warn', 'gather refresh failed:', e && e.message);
      }
    };

    function applyGatherRefresh() {
      if (!$gameSystem || !$gameSwitches) return;

      const now = Date.now();
      const last = $gameSystem._lastGatherRefreshTs;

      // 老存档第一次进图: 仅初始化时间戳, 不立刻刷
      if (typeof last !== 'number') {
        $gameSystem._lastGatherRefreshTs = now;
        LOG('debug', 'first map enter, init gather refresh timestamp');
        return;
      }

      const elapsed = now - last;
      if (elapsed < CFG.gatherRefreshIntervalMs) {
        LOG('debug', 'gather refresh skipped, elapsed=' + Math.floor(elapsed / 1000) + 's < ' + Math.floor(CFG.gatherRefreshIntervalMs / 1000) + 's');
        return;
      }

      // 翻两段开关
      let count = 0;
      for (let id = CFG.range1Start; id <= CFG.range1End; id++) {
        $gameSwitches.setValue(id, true);
        count++;
      }
      for (let id = CFG.range2Start; id <= CFG.range2End; id++) {
        $gameSwitches.setValue(id, true);
        count++;
      }
      $gameSystem._lastGatherRefreshTs = now;
      LOG('info', 'gather refresh fired (offline ' + Math.floor(elapsed / 1000) + 's, switches flipped=' + count + ')');
    }
  }

  // ============================================================
  // 3. 暴露调试钩子 (玩家可以 F12 控制台用)
  // ============================================================
  window.XdRsTimeOffline = {
    cfg: CFG,
    forceRefreshGather() {
      if (!$gameSystem) return false;
      $gameSystem._lastGatherRefreshTs = 0;
      if (SceneManager._scene && SceneManager._scene.constructor === Scene_Map) {
        try { Scene_Map.prototype.start.call(SceneManager._scene); } catch (e) {}
      }
      return true;
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
  };

  LOG('info', 'plugin loaded; botany=' + CFG.botanyEnabled + ' gather=' + CFG.gatherEnabled);
})();
