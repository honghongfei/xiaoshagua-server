//=============================================================================
// XdRs_Online_PlayerSync.js
//=============================================================================
/*:
 * @target MZ
 * @plugindesc 联机-位置同步 | 本机上报 + 他人精灵 + 引擎插值
 * @author xsg-online
 *
 * @param moveReportHz
 * @text 移动上报频率(Hz)
 * @type number
 * @min 1
 * @max 20
 * @default 5
 *
 * @help
 * 进入 Scene_Map 触发 player.enterMap 并接收 others 快照。
 * 之后接收 world.delta 增量，维护 Sprite_OtherPlayer 实例。
 * 本机以 5Hz 节流上报 player.move（仅在格子或方向变化时）。
 */
(() => {
  'use strict';
  const G = window.XdRsOnline;
  if (!G || !G.Net || !G.Core) {
    console.error('[XSG-Online] PlayerSync: depends on Util + Net + Core');
    return;
  }
  const Util = G.Util;
  const Net = G.Net;
  const Core = G.Core;

  const params = PluginManager.parameters('XdRs_Online_PlayerSync');
  const reportHz = Math.max(1, Math.min(20, Number(params.moveReportHz || 5)));
  const reportIntervalMs = Math.round(1000 / reportHz);

  const Sync = (G.PlayerSync = G.PlayerSync || {});
  Sync.others = new Map();

  // ---------- Sprite_OtherPlayer (lazy) ----------
  function ensureOtherPlayerClass() {
    if (window.Sprite_OtherPlayer) return;

    function Sprite_OtherPlayer() { this.initialize(...arguments); }
    Sprite_OtherPlayer.prototype = Object.create(Sprite_Character.prototype);
    Sprite_OtherPlayer.prototype.constructor = Sprite_OtherPlayer;

    Sprite_OtherPlayer.prototype.initialize = function (view) {
      const ghost = new Game_Character();
      // 三步闭环 - 渲染兜底:
      //   1. server 给的 charSet 优先
      //   2. server 没给 (老数据 / null) -> 用本地玩家自己的角色图作 fallback
      //   3. 本地玩家也没有 -> 用 RMMZ 默认的 Actor1
      let charSet = view.charSet;
      let charIndex = view.charIndex;
      if (!charSet) {
        const leader = $gameParty && $gameParty.leader && $gameParty.leader();
        if (leader && typeof leader.characterName === 'function') {
          charSet = leader.characterName();
          if (charIndex == null) charIndex = leader.characterIndex();
        }
      }
      if (!charSet) charSet = 'Actor1';
      if (charIndex == null) charIndex = 0;
      ghost.setImage(charSet, charIndex);
      ghost.setPosition(view.x, view.y);
      ghost.setDirection(view.d || 2);
      Sprite_Character.prototype.initialize.call(this, ghost);
      this._pid = view.pid;
      this._name = view.name || '';
      this._nameSprite = this._makeNameSprite();
      this.addChild(this._nameSprite);
    };

    Sprite_OtherPlayer.prototype._makeNameSprite = function () {
      const bmp = new Bitmap(140, 24);
      bmp.fontSize = 16;
      bmp.outlineColor = 'rgba(0,0,0,0.8)';
      bmp.outlineWidth = 4;
      bmp.textColor = '#ffe070';
      bmp.drawText(this._name, 0, 0, 140, 24, 'center');
      const s = new Sprite(bmp);
      s.anchor.x = 0.5;
      s.anchor.y = 1;
      s.y = -48;
      return s;
    };

    Sprite_OtherPlayer.prototype.applyRemoteMove = function (x, y, d) {
      const ch = this._character;
      if (!ch) return;
      if (d) ch.setDirection(d);
      ch._x = x;
      ch._y = y;
    };

    Sprite_OtherPlayer.prototype.update = function () {
      if (this._character) this._character.update();
      Sprite_Character.prototype.update.call(this);
    };

    window.Sprite_OtherPlayer = Sprite_OtherPlayer;
  }

  // ---------- Scene_Map lifecycle ----------
  const _Scene_Map_start = Scene_Map.prototype.start;
  Scene_Map.prototype.start = function () {
    _Scene_Map_start.call(this);
    if (!Core.isOnline()) return;
    enterCurrentMap();
  };

  const _Scene_Map_terminate = Scene_Map.prototype.terminate;
  Scene_Map.prototype.terminate = function () {
    clearAllOthers();
    _Scene_Map_terminate.call(this);
  };

  // ---------- Player movement -> throttled report ----------
  let lastReport = 0;
  let lastSent = { x: -1, y: -1, d: -1 };

  const _Game_Player_update = Game_Player.prototype.update;
  Game_Player.prototype.update = function (sceneActive) {
    _Game_Player_update.call(this, sceneActive);
    if (!Core.isOnline()) return;
    const now = Util.now();
    if (now - lastReport < reportIntervalMs) return;
    const x = this._x | 0;
    const y = this._y | 0;
    const d = this.direction();
    if (x === lastSent.x && y === lastSent.y && d === lastSent.d) return;
    lastSent = { x, y, d };
    lastReport = now;
    Net.emit('player.move', { x, y, d, ts: now });
  };

  // ---------- enterMap + sprite management ----------
  Sync.enterCurrentMap = enterCurrentMap;
  function enterCurrentMap() {
    ensureOtherPlayerClass();
    const mapId = $gameMap.mapId();
    const x = $gamePlayer.x | 0;
    const y = $gamePlayer.y | 0;
    const d = $gamePlayer.direction();
    // 把本地角色图 + index 带上去, 服端 markOnline + DB 写回, 别的客户端也能看到本人的真实贴图
    let charSet = null;
    let charIndex = 0;
    const leader = $gameParty && $gameParty.leader && $gameParty.leader();
    if (leader && typeof leader.characterName === 'function') {
      charSet = leader.characterName() || null;
      charIndex = typeof leader.characterIndex === 'function' ? (leader.characterIndex() | 0) : 0;
    }
    const payload = { mapId, x, y, d };
    if (charSet) {
      payload.charSet = charSet;
      payload.charIndex = charIndex;
    }
    Net.request('player.enterMap', payload)
      .then((snap) => {
        Util.log('info', 'enterMap ok others=' + ((snap && snap.others) ? snap.others.length : 0));
        clearAllOthers();
        if (snap && snap.others) snap.others.forEach(addOther);
        lastSent = { x, y, d };
      })
      .catch((err) => {
        Util.log('warn', 'enterMap failed:', err && err.message);
      });
  }

  function currentSpriteset() {
    return SceneManager._scene && SceneManager._scene._spriteset;
  }

  function addOther(view) {
    if (!view || view.pid == null) return;
    // 不要把自己的 ghost 也加到 others, 不然画面上会和 $gamePlayer 叠一份
    const myPid = Core.session && Core.session.character ? Core.session.character.pid : null;
    if (myPid != null && view.pid === myPid) return;
    ensureOtherPlayerClass();
    const ss = currentSpriteset();
    if (!ss) return;
    if (Sync.others.has(view.pid)) removeOther(view.pid);
    const sp = new window.Sprite_OtherPlayer(view);
    Sync.others.set(view.pid, sp);
    if (ss._characterSprites) ss._characterSprites.push(sp);
    if (ss._tilemap) ss._tilemap.addChild(sp);
  }

  function removeOther(pid) {
    const sp = Sync.others.get(pid);
    if (!sp) return;
    Sync.others.delete(pid);
    const ss = currentSpriteset();
    if (ss && ss._characterSprites) {
      const idx = ss._characterSprites.indexOf(sp);
      if (idx >= 0) ss._characterSprites.splice(idx, 1);
    }
    if (sp.parent) sp.parent.removeChild(sp);
  }

  function clearAllOthers() {
    for (const pid of Array.from(Sync.others.keys())) removeOther(pid);
  }

  // ---------- Server -> client events ----------
  Net.on('world.delta', (payload) => {
    if (!payload) return;
    if (payload.leave) payload.leave.forEach(removeOther);
    if (payload.enter) payload.enter.forEach(addOther);
    if (payload.move) {
      payload.move.forEach((m) => {
        const sp = Sync.others.get(m.pid);
        if (sp) sp.applyRemoteMove(m.x, m.y, m.d);
      });
    }
  });

  Net.on('sys.error', (e) => {
    Util.log('warn', 'sys.error from server:', e && e.code, e && e.msg);
  });

  Net.on('__disconnect__', () => {
    clearAllOthers();
  });
})();
