//=============================================================================
// XdRs_Online_SaveCloud.js  v3 - 云端为主, 本地为离线备用
//=============================================================================
/*:
 * @target MZ
 * @plugindesc 联机-云存档 | 云端为主, 本地仅作离线备份, 多槽位都映射到同一份云档
 * @author xsg-online
 *
 * @help
 * 设计哲学
 * ----------------------------------------------------------------------------
 *  联机时: 玩家操作的本质是"我的角色当前进度", 与具体哪个本地槽无关.
 *  - saveGame(N): 上传到云端唯一一份云档, 同时把当前内容写到本地槽 N 作为离线备份
 *  - loadGame(N): 优先读云端最新; 云端失败/为空时降级读本地槽 N
 *  - savefileExists(N): 云端有就所有槽都返回 true (反正读哪个都是同一份);
 *                       云端无则按本地实际情况
 *  - 离线时: 完全走 RMMZ 原版逻辑, 本地存档独立, 互不影响
 *
 * 修复点
 *  v1 把 saveGame 完全劫持, 联机时玩家点本地槽看似成功但本地文件没更新
 *      → 关网/换机器读档失效
 *  v3 改成"双写云端+本地", 云端是权威源, 本地是离线兜底
 *
 * 数据流
 * ----------------------------------------------------------------------------
 *  玩家点存档槽 3:
 *    1. saveGame(3) 触发
 *    2. 联机时: 先走原版 _DM_saveGame 把数据写到本地 file3.rmmzsave + 更新 globalInfo
 *       (这样原生存档界面立刻刷新缩略图、时长等)
 *    3. 然后异步把同一份 contents 上传到云端 (角色级 1 份云档)
 *    4. 离线时: 直接走原版, 跳过云端步骤
 *
 *  玩家点读档槽 3:
 *    1. loadGame(3) 触发
 *    2. 联机时: 先 save.download 拿云端 → 应用; 失败 / 云端无 → 降级读本地槽 3
 *    3. 离线时: 直接走原版本地读取
 *
 * 与 SaveMigrate 关系
 * ----------------------------------------------------------------------------
 *  SaveMigrate 是显式 UI 工具 (玩家手动点"上传/下载"), 用于初次迁移老存档.
 *  SaveCloud 是透明同步 (玩家在原生菜单里存读, 自动走云端).
 *  两者共享同一份云端槽位, 互相兼容.
 */
(() => {
  'use strict';
  const G = window.XdRsOnline;
  if (!G || !G.Net || !G.Core) {
    console.error('[XSG-Online] SaveCloud: deps missing');
    return;
  }
  const Util = G.Util;
  const Net = G.Net;
  const Core = G.Core;

  const Cloud = (G.SaveCloud = G.SaveCloud || {});
  Cloud._lastExists = null;          // 云端是否有云档 (探测后缓存)
  Cloud._lastUploadTs = 0;
  const MIN_UPLOAD_INTERVAL_MS = 3_000; // 防抖

  // ============================================================
  // Helper: 把 makeSaveContents 与 onBeforeSave 对齐
  // ============================================================
  function buildContentsForUpload(reason) {
    // 与 RMMZ 原生 Scene_Save.executeSave 行为对齐
    // 保证 _bgmOnSave / _bgsOnSave / _framesOnSave 是合法值, 否则下次读档会炸
    // 但自动后台镜像不能让 _saveCount 跟着 30s 心跳暴涨, 所以只补必要字段
    if ($gameSystem) {
      try {
        $gameSystem._framesOnSave = Graphics.frameCount;
        $gameSystem._bgmOnSave = AudioManager.saveBgm();
        $gameSystem._bgsOnSave = AudioManager.saveBgs();
      } catch (e) { Util.log('warn', 'sync audio fields failed:', e && e.message); }
    }
    return JsonEx.stringify(DataManager.makeSaveContents());
  }

  function uploadCloud(savefileId, reason) {
    if (!Core.isOnline()) return Promise.resolve(false);
    if (!$gameSystem) return Promise.resolve(false);
    const now = Date.now();
    if (now - Cloud._lastUploadTs < MIN_UPLOAD_INTERVAL_MS && reason !== 'manual') {
      Util.log('debug', 'cloud upload debounced (' + reason + ')');
      return Promise.resolve(false);
    }
    Cloud._lastUploadTs = now;

    let contents, meta;
    try {
      contents = buildContentsForUpload(reason);
      meta = {
        savefileId: savefileId || 1,
        reason: reason || 'manual',
        mapId: $gameMap ? $gameMap.mapId() : null,
        partyName: $gameParty && $gameParty.leader && $gameParty.leader() ? $gameParty.leader().name() : '',
        playtime: $gameSystem.playtimeText ? $gameSystem.playtimeText() : '',
        uploadedAt: now,
      };
    } catch (e) {
      Util.log('error', 'cloud upload serialize threw:', e);
      return Promise.resolve(false);
    }

    return Net.request('save.upload', { contents, meta }, 12000)
      .then((res) => {
        Util.log('info', 'cloud uploaded ts=' + (res && res.ts) + ' (' + reason + ')');
        Cloud._lastExists = true;
        return true;
      })
      .catch((err) => {
        Util.log('warn', 'cloud upload failed (' + reason + '):', err && err.message);
        return false;
      });
  }
  Cloud.upload = uploadCloud;

  // ============================================================
  // 1. saveGame: 联机时本地+云端双写, 离线时只本地
  // ============================================================
  // 玩家点 Scene_Save 任一槽 → onBeforeSave 已经被 RMMZ 调过 (写好了 _bgmOnSave 等),
  //   原版 saveGame 写本地文件 file{N}.rmmzsave + globalInfo[N]
  // 我们在原版完成后追加一次云端上传 (不阻塞返回值)
  // 自动云存档 (interval / mapEnter / beforeunload) 走单独的 uploadCloud, 不动本地
  const _DM_saveGame = DataManager.saveGame;
  DataManager.saveGame = function (savefileId) {
    const ret = _DM_saveGame.call(this, savefileId);
    if (Core.isOnline() && ret && typeof ret.then === 'function') {
      ret.then(() => uploadCloud(savefileId, 'manual')).catch(() => {});
    }
    return ret;
  };

  // ============================================================
  // 2. loadGame: 联机时优先云端, 失败降级本地
  // ============================================================
  const _DM_loadGame = DataManager.loadGame;
  DataManager.loadGame = function (savefileId) {
    if (!Core.isOnline()) return _DM_loadGame.call(this, savefileId);
    return Net.request('save.download', {}, 12000)
      .then((res) => {
        if (!res || !res.found || !res.blob) {
          Util.log('info', 'cloud has no save, fallback to local slot ' + savefileId);
          return _DM_loadGame.call(this, savefileId);
        }
        try {
          const contents = JsonEx.parse(res.blob.contents);
          this.createGameObjects();
          this.extractSaveContents(contents);
          this.correctDataErrors();
          Util.log('info', 'cloud loaded (slot=' + savefileId + ', cloud-ts=' + res.blob.ts + ')');
          return 0;
        } catch (e) {
          Util.log('error', 'cloud load parse failed, fallback to local:', e);
          return _DM_loadGame.call(this, savefileId);
        }
      })
      .catch((err) => {
        Util.log('warn', 'cloud load network failed, fallback to local:', err && err.message);
        return _DM_loadGame.call(this, savefileId);
      });
  };

  // ============================================================
  // 3. savefileExists: 云端有 → 所有槽 true; 云端无 → 走原版本地判断
  // ============================================================
  const _DM_savefileExists = DataManager.savefileExists;
  DataManager.savefileExists = function (savefileId) {
    // 离线模式 / 云端确认无: 让玩家看到真实的本地槽情况
    if (!Core.isOnline()) return _DM_savefileExists.call(this, savefileId);
    if (Cloud._lastExists === false) return _DM_savefileExists.call(this, savefileId);
    if (Cloud._lastExists === true) return true;
    // 还没探测过, 暂时也按本地判断 (refreshExists 会异步刷新)
    return _DM_savefileExists.call(this, savefileId);
  };

  // 探测云端存档存在性 (登录后/进标题界面)
  Cloud.refreshExists = function () {
    if (!Core.isOnline()) {
      Cloud._lastExists = null;
      return Promise.resolve(false);
    }
    return Net.request('save.exists', {}, 6000).then((r) => {
      Cloud._lastExists = !!(r && r.exists);
      return Cloud._lastExists;
    }).catch(() => {
      Cloud._lastExists = null;
      return false;
    });
  };

  // 进入标题界面时, 探测一下云端 (让 Scene_Load 列表显示对)
  const _Scene_Title_create = Scene_Title.prototype.create;
  Scene_Title.prototype.create = function () {
    _Scene_Title_create.call(this);
    Cloud.refreshExists();
  };

  // ============================================================
  // 4. 创角后立即云端备份 (老逻辑保留)
  // ============================================================
  if (typeof Scene_MakeActor !== 'undefined' && Scene_MakeActor.prototype && Scene_MakeActor.prototype.commandNewGame) {
    const _Scene_MakeActor_commandNewGame = Scene_MakeActor.prototype.commandNewGame;
    Scene_MakeActor.prototype.commandNewGame = function () {
      _Scene_MakeActor_commandNewGame.call(this);
      if (Core.isOnline()) {
        setTimeout(() => {
          if (SceneManager._scene instanceof Scene_Map) {
            uploadCloud(1, 'makeActor');
            Util.log('info', 'initial cloud save after Scene_MakeActor');
          }
        }, 2000);
      }
    };
  }

  // ============================================================
  // 5. 自动云端镜像 (interval + mapEnter + beforeunload)
  // ============================================================
  let lastAutoSave = 0;
  const AUTO_SAVE_INTERVAL = 30 * 1000;

  function tryAutoSave(reason) {
    if (!Core.isOnline()) return;
    if (!$gameSystem) return;
    if ($gameMap && $gameMap.isEventRunning && $gameMap.isEventRunning()) return;
    if ($gameMessage && $gameMessage.isBusy && $gameMessage.isBusy()) return;
    lastAutoSave = Date.now();
    uploadCloud($gameSystem.savefileId() || 1, reason);
  }

  const _Scene_Map_update_save = Scene_Map.prototype.update;
  Scene_Map.prototype.update = function (sceneActive) {
    _Scene_Map_update_save.call(this, sceneActive);
    if (!Core.isOnline()) return;
    const now = Date.now();
    if (now - lastAutoSave < AUTO_SAVE_INTERVAL) return;
    tryAutoSave('interval');
  };

  const _Scene_Map_onMapLoaded_save = Scene_Map.prototype.onMapLoaded;
  Scene_Map.prototype.onMapLoaded = function () {
    _Scene_Map_onMapLoaded_save.call(this);
    if (Core.isOnline()) setTimeout(() => tryAutoSave('mapEnter'), 500);
  };

  // 关窗/重启前最后一次同步推
  window.addEventListener('beforeunload', () => {
    if (!Core.isOnline()) return;
    if (!Core.session || !Core.session.token) return;
    if (!$gameSystem) return;
    try {
      const contents = buildContentsForUpload('beforeunload');
      const payload = JSON.stringify({
        token: Core.session.token,
        contents,
        meta: {
          savefileId: $gameSystem.savefileId() || 1,
          reason: 'beforeunload',
          mapId: $gameMap ? $gameMap.mapId() : null,
        },
      });
      const wsUrl = Net.config.url;
      const httpUrl = wsUrl.replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:') + '/save';
      let sent = false;
      if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        try {
          const blob = new Blob([payload], { type: 'application/json' });
          sent = navigator.sendBeacon(httpUrl, blob);
        } catch (e) { /* ignore */ }
      }
      if (!sent) {
        Net.emit('save.upload', { contents, meta: { savefileId: 1, reason: 'beforeunload-fallback' } });
      }
      Util.log('info', 'cloud save on beforeunload (beacon=' + sent + ')');
    } catch (e) { /* ignore */ }
  });

  Util.log('info', 'SaveCloud v3 loaded (云端为主, 本地为离线备用)');
})();
