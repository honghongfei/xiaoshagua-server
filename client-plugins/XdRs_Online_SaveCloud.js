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

  function decompress(b64) {
    try {
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return arr;
    } catch (e) {
      return null;
    }
  }

  // ---------- Hook saveGame ----------
  const _DM_saveGame = DataManager.saveGame;
  DataManager.saveGame = function (savefileId) {
    if (!Core.isOnline()) return _DM_saveGame.call(this, savefileId);
    try {
      const contents = JsonEx.stringify(this.makeSaveContents());
      const meta = {
        savefileId,
        mapId: $gameMap ? $gameMap.mapId() : null,
        partyName: $gameParty && $gameParty.leader() ? $gameParty.leader().name() : '',
        playtime: $gameSystem && $gameSystem.playtimeText ? $gameSystem.playtimeText() : '',
      };
      Net.request('save.upload', { contents, meta }, 12000)
        .then((res) => Util.log('info', 'cloud save uploaded ts=' + res.ts))
        .catch((err) => Util.log('warn', 'cloud save failed:', err && err.message));
      return Promise.resolve(true);
    } catch (e) {
      Util.log('error', 'cloud save threw:', e);
      return Promise.resolve(false);
    }
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

  // 自动保存：玩家在地图上每 5 分钟自动云存一次（防止意外退出丢进度）
  let lastAutoSave = 0;
  const AUTO_SAVE_INTERVAL = 5 * 60 * 1000;
  const _Scene_Map_update_save = Scene_Map.prototype.update;
  Scene_Map.prototype.update = function (sceneActive) {
    _Scene_Map_update_save.call(this, sceneActive);
    if (!Core.isOnline()) return;
    const now = Date.now();
    if (now - lastAutoSave < AUTO_SAVE_INTERVAL) return;
    if ($gameMap && $gameMap.isEventRunning && $gameMap.isEventRunning()) return;
    if ($gameMessage && $gameMessage.isBusy && $gameMessage.isBusy()) return;
    lastAutoSave = now;
    try {
      DataManager.saveGame(1);
      Util.log('info', 'periodic cloud save');
    } catch (e) { Util.log('warn', 'periodic save failed:', e); }
  };
})();
