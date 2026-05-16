//=============================================================================
// XdRs_Online_SaveCloud.js
//=============================================================================
/*:
 * @target MZ
 * @plugindesc 联机-云存档 | 联机模式下 DataManager.saveGame/loadGame 走服务端
 * @author xsg-online
 *
 * @help
 * 联机会话期间：
 *   - saveGame(any) 把 RMMZ saveContents 上传到服务端（按角色 1 份云档）
 *   - loadGame(any) 从服务端拉取
 *   - 离线模式下回退原生本地存档行为
 *
 * 注意：v1 单云档（每角色 1 份），UI 中不同存档槽会被映射成同一份云档。
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

  // ---------- Hook saveGame (H3 修：返回值与服端 ack 真正一致) ----------
  // M14b 修: 保存前必须先调 $gameSystem.onBeforeSave(),
  //   原因: RMMZ 的 _bgmOnSave / _bgsOnSave 初始为 null, 只有 onBeforeSave 里
  //   AudioManager.saveBgm() 才会写成合法 audio object. 旧版直接 makeSaveContents
  //   会把 null 序列化进存档, 下次读这份云档时 onAfterLoad 把 null 传给 playBgm 炸.
  const _DM_saveGame = DataManager.saveGame;
  DataManager.saveGame = function (savefileId) {
    if (!Core.isOnline()) return _DM_saveGame.call(this, savefileId);
    let contents;
    let meta;
    try {
      // 与 RMMZ 原生 Scene_Save.executeSave 行为对齐
      if ($gameSystem) {
        try { $gameSystem.setSavefileId(savefileId); } catch (e) { /* ignore */ }
        try { $gameSystem.onBeforeSave(); } catch (e) { Util.log('warn', 'onBeforeSave threw:', e && e.message); }
      }
      contents = JsonEx.stringify(this.makeSaveContents());
      meta = {
        savefileId,
        mapId: $gameMap ? $gameMap.mapId() : null,
        partyName: $gameParty && $gameParty.leader() ? $gameParty.leader().name() : '',
        playtime: $gameSystem && $gameSystem.playtimeText ? $gameSystem.playtimeText() : '',
      };
    } catch (e) {
      Util.log('error', 'cloud save serialize threw:', e);
      return Promise.resolve(false);
    }
    return Net.request('save.upload', { contents, meta }, 12000)
      .then((res) => {
        Util.log('info', 'cloud save uploaded ts=' + res.ts);
        return true;
      })
      .catch((err) => {
        Util.log('warn', 'cloud save failed:', err && err.message);
        return false;
      });
  };

  // ---------- Hook loadGame ----------
  const _DM_loadGame = DataManager.loadGame;
  DataManager.loadGame = function (savefileId) {
    if (!Core.isOnline()) return _DM_loadGame.call(this, savefileId);
    return Net.request('save.download', {}, 12000).then((res) => {
      if (!res.found || !res.blob) return false;
      try {
        const contents = JsonEx.parse(res.blob.contents);
        this.createGameObjects();
        this.extractSaveContents(contents);
        this.correctDataErrors();
        return true;
      } catch (e) {
        Util.log('error', 'cloud load parse failed:', e);
        return false;
      }
    }).catch((err) => {
      Util.log('warn', 'cloud load failed:', err && err.message);
      return false;
    });
  };

  // ---------- save exists / makeSavefileInfo ----------
  const _DM_savefileExists = DataManager.savefileExists;
  DataManager.savefileExists = function (savefileId) {
    if (!Core.isOnline()) return _DM_savefileExists.call(this, savefileId);
    return !!Cloud._lastExists;
  };

  Cloud.refreshExists = function () {
    if (!Core.isOnline()) return Promise.resolve(false);
    return Net.request('save.exists', {}, 6000).then((r) => {
      Cloud._lastExists = !!r.exists;
      return Cloud._lastExists;
    }).catch(() => false);
  };

  // Probe existence after login so menu shows correctly
  const _Scene_Title_create = Scene_Title.prototype.create;
  Scene_Title.prototype.create = function () {
    _Scene_Title_create.call(this);
    Cloud.refreshExists();
  };

  // 联机模式下，玩家完成 Scene_MakeActor（创角）后自动上传一份初始云存档
  // 这样玩家不需要去主动按「保存」，第一份云存档就有了，下次开机能恢复
  if (typeof Scene_MakeActor !== 'undefined' && Scene_MakeActor.prototype && Scene_MakeActor.prototype.commandNewGame) {
    const _Scene_MakeActor_commandNewGame = Scene_MakeActor.prototype.commandNewGame;
    Scene_MakeActor.prototype.commandNewGame = function () {
      _Scene_MakeActor_commandNewGame.call(this);
      if (Core.isOnline()) {
        // 等 Scene_Map 起来再存一次，保证 $gameMap 数据全
        setTimeout(() => {
          if (SceneManager._scene instanceof Scene_Map) {
            try {
              DataManager.saveGame(1);
              Util.log('info', 'initial cloud save after Scene_MakeActor');
            } catch (e) { Util.log('warn', 'initial save failed:', e); }
          }
        }, 2000);
      }
    };
  }

  // 自动云存档策略：尽量频繁、但别打断玩家
  //   - 30s 一次的轮询保存（地图空闲时）
  //   - 每次进入新地图触发一次
  //   - 浏览器关闭 / 重启前最后一次同步存（NW.js beforeunload）
  let lastAutoSave = 0;
  const AUTO_SAVE_INTERVAL = 30 * 1000;

  function trySave(reason) {
    if (!Core.isOnline()) return;
    if (!$gameSystem) return;
    if ($gameMap && $gameMap.isEventRunning && $gameMap.isEventRunning()) return;
    if ($gameMessage && $gameMessage.isBusy && $gameMessage.isBusy()) return;
    try {
      DataManager.saveGame(1);
      lastAutoSave = Date.now();
      Util.log('debug', 'cloud save (' + reason + ')');
    } catch (e) { Util.log('warn', 'cloud save failed (' + reason + '):', e); }
  }

  const _Scene_Map_update_save = Scene_Map.prototype.update;
  Scene_Map.prototype.update = function (sceneActive) {
    _Scene_Map_update_save.call(this, sceneActive);
    if (!Core.isOnline()) return;
    const now = Date.now();
    if (now - lastAutoSave < AUTO_SAVE_INTERVAL) return;
    trySave('interval');
  };

  // 每次进新 Map 触发一次
  const _Scene_Map_onMapLoaded_save = Scene_Map.prototype.onMapLoaded;
  Scene_Map.prototype.onMapLoaded = function () {
    _Scene_Map_onMapLoaded_save.call(this);
    if (Core.isOnline()) {
      // delay 一拍，让 $gameMap 完成 setup
      setTimeout(() => trySave('mapEnter'), 500);
    }
  };

  // H4 修：关窗 / 关进程前最后一次同步存
  //   1. 优先用 navigator.sendBeacon (浏览器保证 unload 时把请求送出去)
  //   2. 服端新增 POST /save (token 鉴权) 接收 beacon
  //   3. 兜底：sendBeacon 不可用 / 太大时降级到 socket emit
  window.addEventListener('beforeunload', () => {
    if (!Core.isOnline()) return;
    if (!Core.session || !Core.session.token) return;
    try {
      const contents = JsonEx.stringify(DataManager.makeSaveContents());
      const payload = JSON.stringify({
        token: Core.session.token,
        contents,
        meta: { savefileId: 1, reason: 'beforeunload', mapId: $gameMap ? $gameMap.mapId() : null },
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
        Net.emit('save.upload', { contents, meta: { savefileId: 1, reason: 'beforeunload-fallback', mapId: $gameMap ? $gameMap.mapId() : null } });
      }
      Util.log('info', 'cloud save on beforeunload (beacon=' + sent + ')');
    } catch (e) { /* ignore */ }
  });
})();
