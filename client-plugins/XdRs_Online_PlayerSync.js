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

    Sprite_OtherPlayer.prototype.initialize = function (view, opts) {
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
      this._noName = !!(opts && opts.withName === false);
      if (!this._noName) {
        this._nameSprite = this._makeNameSprite();
        this.addChild(this._nameSprite);
      }
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
  let lastSentFol = '';

  // 采集本机可见的 Game_Follower(本体宝宝), 口径对齐玩家 _x|0/_y|0/direction
  function collectFollowers() {
    const out = [];
    const data = $gamePlayer && $gamePlayer._followers && $gamePlayer._followers._data;
    if (!data) return out;
    for (const f of data) {
      if (!f || !f.isVisible || !f.isVisible()) continue;
      out.push({
        x: f._x | 0,
        y: f._y | 0,
        d: f.direction(),
        charSet: (f.characterName && f.characterName()) || null,
        charIndex: (f.characterIndex && (f.characterIndex() | 0)) || 0,
      });
    }
    return out;
  }
  function followersSig(fs) {
    return fs.map((f) => f.x + ',' + f.y + ',' + f.d + ',' + f.charSet + ',' + f.charIndex).join('|');
  }

  const _Game_Player_update = Game_Player.prototype.update;
  Game_Player.prototype.update = function (sceneActive) {
    _Game_Player_update.call(this, sceneActive);
    if (!Core.isOnline()) return;
    const now = Util.now();
    if (now - lastReport < reportIntervalMs) return;
    const x = this._x | 0;
    const y = this._y | 0;
    const d = this.direction();
    const followers = collectFollowers();
    const folSig = followersSig(followers);
    if (x === lastSent.x && y === lastSent.y && d === lastSent.d && folSig === lastSentFol) return;
    lastSent = { x, y, d };
    lastSentFol = folSig;
    lastReport = now;
    const payload = { x, y, d, ts: now };
    if (followers.length) payload.followers = followers;
    Net.emit('player.move', payload);
  };

  // ---------- enterMap + sprite management ----------
  Sync.enterCurrentMap = enterCurrentMap;
  function enterCurrentMap() {
    ensureOtherPlayerClass();
    // H2 修：副本中要上报服端分配的 virtualMapId, 让 worldService 按实例路由广播
    // 不在副本时, 用 RMMZ 真实 $gameMap.mapId()
    const G2 = window.XdRsOnline;
    let mapId = $gameMap.mapId();
    if (G2.Dungeon && G2.Dungeon.current && typeof G2.Dungeon.current.virtualMapId === 'number') {
      mapId = G2.Dungeon.current.virtualMapId;
    } else if (G2.Home && G2.Home.current && typeof G2.Home.current.virtualMapId === 'number') {
      mapId = G2.Home.current.virtualMapId;
    }
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
    const fol = collectFollowers();
    if (fol.length) payload.followers = fol;
    Net.request('player.enterMap', payload)
      .then((snap) => {
        Util.log('info', 'enterMap ok mapId=' + mapId + ' others=' + ((snap && snap.others) ? snap.others.length : 0));
        clearAllOthers();
        if (window.XdRsOnline.Gather) window.XdRsOnline.Gather.onEnterSnapshot(snap);
        if (snap && snap.others) snap.others.forEach(addOther);
        lastSent = { x, y, d };
        startReconcileLoops();
      })
      .catch((err) => {
        Util.log('warn', 'enterMap failed:', err && err.message);
      });
  }

  function currentSpriteset() {
    return SceneManager._scene && SceneManager._scene._spriteset;
  }

  // ---------- 远端宝宝(Follower) 精灵: 复用 Sprite_OtherPlayer(无名字) ----------
  function createFollowerSprite(fv, ss) {
    const fsp = new window.Sprite_OtherPlayer(fv, { withName: false });
    if (ss && ss._characterSprites) ss._characterSprites.push(fsp);
    if (ss && ss._tilemap) ss._tilemap.addChild(fsp);
    return fsp;
  }
  function removeFollowerSprites(sp, ss) {
    if (!sp || !sp._followers) return;
    for (const fsp of sp._followers) {
      if (ss && ss._characterSprites) {
        const i = ss._characterSprites.indexOf(fsp);
        if (i >= 0) ss._characterSprites.splice(i, 1);
      }
      if (fsp.parent) fsp.parent.removeChild(fsp);
      if (typeof fsp.destroy === 'function') fsp.destroy();
    }
    sp._followers = null;
  }
  function syncOtherFollowers(sp, fols, ss) {
    if (!sp._followers) sp._followers = [];
    if (sp._followers.length !== fols.length) {
      removeFollowerSprites(sp, ss);
      sp._followers = fols.map((fv) => createFollowerSprite(fv, ss));
      return;
    }
    fols.forEach((fv, i) => {
      const fsp = sp._followers[i];
      const ch = fsp && fsp._character;
      if (ch && fv.charSet && (ch.characterName() !== fv.charSet || ch.characterIndex() !== (fv.charIndex || 0))) {
        ch.setImage(fv.charSet, fv.charIndex || 0);
      }
      if (fsp) fsp.applyRemoteMove(fv.x, fv.y, fv.d);
    });
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
    sp._lastSeenAt = Util.now();
    Sync.others.set(view.pid, sp);
    if (ss._characterSprites) ss._characterSprites.push(sp);
    if (ss._tilemap) ss._tilemap.addChild(sp);
    sp._followers = Array.isArray(view.followers) ? view.followers.map((fv) => createFollowerSprite(fv, ss)) : [];
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
    removeFollowerSprites(sp, ss);
    if (sp.parent) sp.parent.removeChild(sp);
    destroyOtherSprite(sp);
  }

  // 销毁离场玩家 sprite. 只 removeChild 不 destroy 会让独占的名字 Bitmap(每人一张 140x24)
  // 持续泄漏(玩家进进出出越攒越多)。
  //  - 名字 Bitmap 是本插件 new 出来的独占纹理 -> 必须显式 Bitmap.destroy() 释放 baseTexture + canvas。
  //  - 角色贴图来自 ImageManager 共享缓存 -> 绝不能销毁其 baseTexture。RMMZ Sprite.prototype.destroy
  //    固定用 {children:true, texture:true}(忽略入参), PIXI 默认 baseTexture:false, 只销毁本 sprite
  //    自己的 Texture 包装, 不动共享 baseTexture, 因此 sp.destroy() 对共享贴图是安全的。
  function destroyOtherSprite(sp) {
    if (!sp) return;
    try {
      if (sp._nameSprite) {
        const nb = sp._nameSprite.bitmap;
        if (sp._nameSprite.parent) sp._nameSprite.parent.removeChild(sp._nameSprite);
        sp._nameSprite.bitmap = null;
        if (nb && typeof nb.destroy === 'function') nb.destroy();
        sp._nameSprite = null;
      }
    } catch (e) { Util.log('warn', 'destroy name sprite failed: ' + (e && e.message)); }
    try {
      if (typeof sp.destroy === 'function') sp.destroy();
    } catch (e) { Util.log('warn', 'destroy other sprite failed: ' + (e && e.message)); }
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
        if (sp) {
          sp.applyRemoteMove(m.x, m.y, m.d);
          if (Array.isArray(m.followers)) syncOtherFollowers(sp, m.followers, currentSpriteset());
          sp._lastSeenAt = Util.now();
        }
      });
    }
  });

  Net.on('sys.error', (e) => {
    Util.log('warn', 'sys.error from server:', e && e.code, e && e.msg);
  });

  Net.on('__disconnect__', () => {
    clearAllOthers();
  });

  // ----------------------------------------------------------------
  // M14 客户端兜底：定期 reconcile，防止服务端漏发 leave
  // ----------------------------------------------------------------
  // 即使 server 端有 bug 漏发 world.delta { leave: [...] }, 客户端也能在 30s 内
  // 通过重拉一次 player.enterMap snapshot 自动校准本地 others 列表。
  // 同时给"超过 90s 完全没动过"的 ghost 自动半透明 + 90s 后移除, 表示"可能离线"。
  // ----------------------------------------------------------------
  const RECONCILE_INTERVAL_MS = 30_000;
  const STALE_FADE_MS = 60_000;   // 超过 60s 没动 → 半透明
  const STALE_DROP_MS = 120_000;  // 超过 120s 没动 → 直接移除
  let _reconcileTimer = null;
  let _staleTimer = null;

  function reconcileOthersFromSnapshot() {
    if (!Core.isOnline()) return;
    if (!(SceneManager._scene instanceof Scene_Map)) return;
    // 30s 一次轻量校准: 直接 request 一次 player.enterMap（服务端把它当 no-op）,
    // 然后用返回的 snapshot.others 与本地 Sync.others 做差集 (新增 + 删除), 不全删全建免闪烁。
    const G2 = window.XdRsOnline;
    let mapId = $gameMap.mapId();
    if (G2 && G2.Dungeon && G2.Dungeon.current && typeof G2.Dungeon.current.virtualMapId === 'number') {
      mapId = G2.Dungeon.current.virtualMapId;
    } else if (G2 && G2.Home && G2.Home.current && typeof G2.Home.current.virtualMapId === 'number') {
      mapId = G2.Home.current.virtualMapId;
    }
    const x = $gamePlayer.x | 0;
    const y = $gamePlayer.y | 0;
    const d = $gamePlayer.direction();
    Net.request('player.enterMap', { mapId, x, y, d }, 5000)
      .then((snap) => {
        if (window.XdRsOnline.Gather) window.XdRsOnline.Gather.onEnterSnapshot(snap);
        const remoteIds = new Set();
        if (snap && snap.others) snap.others.forEach((v) => remoteIds.add(v.pid));
        // 1. 本地多余的 (服务端 snapshot 没有) → 移除
        for (const pid of Array.from(Sync.others.keys())) {
          if (!remoteIds.has(pid)) removeOther(pid);
        }
        // 2. 服务端有的本地没有 → 新增
        if (snap && snap.others) {
          for (const v of snap.others) {
            if (!Sync.others.has(v.pid)) addOther(v);
          }
        }
      })
      .catch((err) => Util.log('warn', 'reconcile failed:', err && err.message));
  }

  function pruneStaleOthers() {
    const now = Util.now();
    for (const [pid, sp] of Array.from(Sync.others.entries())) {
      if (!sp || sp._lastSeenAt == null) continue;
      const idle = now - sp._lastSeenAt;
      if (idle >= STALE_DROP_MS) {
        Util.log('debug', 'prune stale other pid=' + pid + ' idle=' + idle + 'ms');
        removeOther(pid);
      } else if (idle >= STALE_FADE_MS) {
        // 半透明提示「可能掉线」
        sp.opacity = 128;
      } else {
        sp.opacity = 255;
      }
    }
  }

  function startReconcileLoops() {
    stopReconcileLoops();
    _reconcileTimer = setInterval(reconcileOthersFromSnapshot, RECONCILE_INTERVAL_MS);
    _staleTimer = setInterval(pruneStaleOthers, 5_000);
  }
  function stopReconcileLoops() {
    if (_reconcileTimer) { clearInterval(_reconcileTimer); _reconcileTimer = null; }
    if (_staleTimer) { clearInterval(_staleTimer); _staleTimer = null; }
  }

  // 进入 Scene_Map 时启动；离开时停止；断线时停止
  const _Scene_Map_start_loops = Scene_Map.prototype.start;
  Scene_Map.prototype.start = function () {
    _Scene_Map_start_loops.call(this);
    if (Core.isOnline()) startReconcileLoops();
  };
  const _Scene_Map_terminate_loops = Scene_Map.prototype.terminate;
  Scene_Map.prototype.terminate = function () {
    stopReconcileLoops();
    _Scene_Map_terminate_loops.call(this);
  };
  Net.on('__disconnect__', () => {
    stopReconcileLoops();
  });

  // ======================================================================
  // 点击其他玩家 -> 弹互动菜单 (私聊 / 邀请交易 / 加好友 / 拉黑)
  // 三步闭环
  //   发起端 client: Scene_Map 监听 TouchInput.isTriggered, 命中其他玩家 sprite 弹 DOM 菜单
  //   服端    server: chat.send / trade.invite / friend.add / social.block 都有 null check
  //   表现端 client: 选定操作后 Net.request, 失败用 alert 提示
  // 兜底
  //   pid 不存在 / sprite 已被删 -> 命中失败直接 return
  //   命名空间没注入 (Trade/Chat/Friend 没装) -> 菜单条目自动隐藏
  //   高频点击 -> 250ms 节流
  // ======================================================================
  let _interactMenuRoot = null;
  let _lastInteractTriggerMs = 0;

  function pidUnderTouch(touchX, touchY) {
    if (!Sync.others || Sync.others.size === 0) return null;
    const ss = currentSpriteset();
    if (!ss) return null;
    for (const [pid, sp] of Sync.others.entries()) {
      if (!sp || !sp.visible) continue;
      // 角色 sprite 默认 anchor.x=0.5 anchor.y=1 (脚底)
      const w = (sp.patternWidth ? sp.patternWidth() : 48) | 0;
      const h = (sp.patternHeight ? sp.patternHeight() : 48) | 0;
      const left = sp.x - w / 2;
      const top = sp.y - h;
      if (touchX >= left && touchX <= left + w && touchY >= top && touchY <= top + h) {
        return { pid, sp };
      }
    }
    return null;
  }

  function ensureInteractMenu() {
    if (_interactMenuRoot) return _interactMenuRoot;
    const root = document.createElement('div');
    root.id = 'xsg-online-interact';
    root.className = 'xsg-win';
    Object.assign(root.style, {
      position: 'absolute',
      display: 'none',
      padding: '4px',
      minWidth: '128px',
      zIndex: '9100',
      fontSize: '13px',
    });
    document.body.appendChild(root);
    document.addEventListener('mousedown', (e) => {
      if (_interactMenuRoot && _interactMenuRoot.style.display !== 'none' && !_interactMenuRoot.contains(e.target)) {
        _interactMenuRoot.style.display = 'none';
      }
    });
    _interactMenuRoot = root;
    return root;
  }

  function openInteractMenu(pid, sp, screenX, screenY) {
    const root = ensureInteractMenu();
    const G = window.XdRsOnline;
    const name = sp._name || ('#' + pid);
    const items = [];
    items.push({ key: 'header', label: name + '  (pid=' + pid + ')', disabled: true });
    if (G.Chat) items.push({ key: 'whisper', label: '私聊 (/w)', action: () => doWhisper(pid, name) });
    if (G.Trade && typeof G.Trade.inviteTo === 'function') items.push({ key: 'trade', label: '邀请交易', action: () => G.Trade.inviteTo(pid) });
    items.push({ key: 'friend', label: '加好友', action: () => doFriend(pid, name) });
    items.push({ key: 'block', label: '拉黑', action: () => doBlock(pid, name) });
    items.push({ key: 'cancel', label: '取消', action: () => { root.style.display = 'none'; } });

    root.innerHTML = '';
    items.forEach((it) => {
      const btn = document.createElement('div');
      btn.textContent = it.label;
      Object.assign(btn.style, {
        padding: '6px 14px',
        borderRadius: '6px',
        cursor: it.disabled ? 'default' : 'pointer',
        color: it.disabled ? '#8a5a12' : '#3f3315',
        fontWeight: it.disabled ? 'bold' : 'normal',
        userSelect: 'none',
      });
      if (!it.disabled) {
        btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(255,255,255,0.35)'; });
        btn.addEventListener('mouseleave', () => { btn.style.background = ''; });
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          root.style.display = 'none';
          try { it.action(); } catch (e) { console.error('[XSG-Online] interact action error', e); }
        });
      }
      root.appendChild(btn);
    });

    // 右键事件给的是 viewport client 坐标, 菜单 position:absolute 直接用 (NW.js \u6e38\u620f\u7a97\u6ca1\u6709\u6eda\u52a8)
    root.style.left = Math.round(screenX + 8) + 'px';
    root.style.top = Math.round(screenY - 8) + 'px';
    root.style.display = 'block';
  }

  function doWhisper(pid, name) {
    const G = window.XdRsOnline;
    if (G.Chat && typeof G.Chat.startWhisper === 'function') {
      G.Chat.startWhisper(pid, name);
    } else {
      // fallback (Chat \u63d2\u4ef6\u672a\u88c5)
      const text = window.prompt('\u79c1\u804a ' + name + ':', '');
      if (text) Net.request('chat.send', { channel: 'whisper', targetPid: pid, text }).catch((err) => alert(err && err.message || '\u53d1\u9001\u5931\u8d25'));
    }
  }

  function doFriend(pid, name) {
    // 服端是 social.add { pid, kind: 'friend' | 'block' }, 不是 friend.add
    Net.request('social.add', { pid, kind: 'friend' }, 5000)
      .then(() => {
        flashSys('已向 ' + name + ' 发送好友请求');
        const G = window.XdRsOnline;
        if (G.Friend && typeof G.Friend.refresh === 'function') G.Friend.refresh();
      })
      .catch((err) => flashSys('加好友失败: ' + (err && err.message || '?')));
  }

  function doBlock(pid, name) {
    if (!window.confirm('拉黑 ' + name + '？拉黑后将看不到他的聊天')) return;
    Net.request('social.add', { pid, kind: 'block' }, 5000)
      .then(() => {
        flashSys('已拉黑 ' + name);
        const G = window.XdRsOnline;
        if (G.Friend && typeof G.Friend.refresh === 'function') G.Friend.refresh();
      })
      .catch((err) => flashSys('拉黑失败: ' + (err && err.message || '?')));
  }

  function flashSys(text) {
    if (typeof $gameTemp !== 'undefined' && $gameTemp && typeof $gameTemp.addWorldMessage === 'function') {
      $gameTemp.addWorldMessage('\\c[10][系统]\\c[0] ' + text, true);
    } else {
      console.log('[XSG-Online] ' + text);
    }
  }

  // 右键 = 玩家交互；左键留给 RMMZ 原生（移动 / 选 NPC）
  // 用 contextmenu DOM 事件，不动 TouchInput 的 _cancelled (避免顶掉 Scene_Map 主菜单)
  function bindContextMenu() {
    if (window._xsgInteractBound) return;
    window._xsgInteractBound = true;
    document.addEventListener('contextmenu', (e) => {
      if (!Core.isOnline()) return;
      if (!(SceneManager._scene instanceof Scene_Map)) return;
      // RMMZ canvas 在 body 下，用 Graphics.pageToCanvasX/Y 转坐标
      const canvasX = typeof Graphics.pageToCanvasX === 'function' ? Graphics.pageToCanvasX(e.pageX) : e.pageX;
      const canvasY = typeof Graphics.pageToCanvasY === 'function' ? Graphics.pageToCanvasY(e.pageY) : e.pageY;
      const hit = pidUnderTouch(canvasX, canvasY);
      if (!hit) return;
      // 阻止浏览器原生右键菜单
      e.preventDefault();
      const now = Util.now();
      if (now - _lastInteractTriggerMs < 250) return;
      _lastInteractTriggerMs = now;
      openInteractMenu(hit.pid, hit.sp, e.clientX, e.clientY);
    });
  }
  bindContextMenu();
})();
