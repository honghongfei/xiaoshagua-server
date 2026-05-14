//=============================================================================
// XdRs_Online_Login.js
//=============================================================================
/*:
 * @target MZ
 * @plugindesc 联机-登录 | 标题菜单追加「联机」入口 + DOM 登录窗
 * @author xsg-online
 *
 * @param titleCommandText
 * @text 标题菜单按钮文字
 * @type string
 * @default 联机
 *
 * @param defaultMapId
 * @text 角色无位置时的默认地图 ID
 * @type number
 * @min 1
 * @default 1
 *
 * @param defaultSpawnX
 * @text 默认出生 X
 * @type number
 * @default 8
 *
 * @param defaultSpawnY
 * @text 默认出生 Y
 * @type number
 * @default 6
 *
 * @help
 * 在 Scene_Title 菜单追加「联机」按钮。点击后弹出 DOM 覆盖层登录/注册。
 * 成功后调用 DataManager.setupNewGame 并传送到角色的存档地图。
 */
(() => {
  'use strict';
  const G = window.XdRsOnline;
  if (!G || !G.Net || !G.Core) {
    console.error('[XSG-Online] Login: depends on Util + Net + Core, check plugin order');
    return;
  }
  const Util = G.Util;
  const Net = G.Net;
  const Core = G.Core;

  const params = PluginManager.parameters('XdRs_Online_Login');
  const cfg = {
    text: String(params.titleCommandText || '联机'),
    defaultMapId: Number(params.defaultMapId || 1),
    spawnX: Number(params.defaultSpawnX || 8),
    spawnY: Number(params.defaultSpawnY || 6),
  };

  // ---- Title menu hook（标准 RMMZ 用，兼容回退）----
  if (typeof Window_TitleCommand !== 'undefined' && Window_TitleCommand.prototype) {
    const _Window_TitleCommand_makeCommandList = Window_TitleCommand.prototype.makeCommandList;
    Window_TitleCommand.prototype.makeCommandList = function () {
      _Window_TitleCommand_makeCommandList.call(this);
      this.addCommand(cfg.text, 'xsgOnline');
    };
    const _Scene_Title_createCommandWindow = Scene_Title.prototype.createCommandWindow;
    if (_Scene_Title_createCommandWindow) {
      Scene_Title.prototype.createCommandWindow = function () {
        _Scene_Title_createCommandWindow.call(this);
        if (this._commandWindow) this._commandWindow.setHandler('xsgOnline', this.commandXsgOnline.bind(this));
      };
    }
  }

  function getSpawnFromGame() {
    const sys = (typeof $dataSystem !== 'undefined' && $dataSystem) ? $dataSystem : null;
    return {
      mapId: (sys && sys.startMapId) || cfg.defaultMapId,
      x: (sys && sys.startX != null) ? sys.startX : cfg.spawnX,
      y: (sys && sys.startY != null) ? sys.startY : cfg.spawnY,
    };
  }

  // 方案 1：联机即「云存档替代单人」
  // - Title 上一个「联机」按钮 = 入口
  // - 已有云存档：下载 → 应用 → 跳 Scene_Map（位置/任务/开关全恢复）
  // - 无云存档：登录后走原生「新游戏」流程 → Scene_MakeActor → 进游戏后第一次保存自动上传云端
  // - 已在线时按钮变「退出联机」，点了清 session
  function flash(text) {
    if (typeof $gameTemp !== 'undefined' && $gameTemp && typeof $gameTemp.addWorldMessage === 'function') {
      $gameTemp.addWorldMessage('\\c[10][系统]\\c[0] ' + text, true);
    } else {
      console.log('[XSG-Online] ' + text);
    }
  }

  function downloadAndEnter() {
    return Net.request('save.download', {}, 12000).then((res) => {
      if (!res || !res.found || !res.blob) return false;
      try {
        const contents = JsonEx.parse(res.blob.contents);
        DataManager.createGameObjects();
        DataManager.extractSaveContents(contents);
        DataManager.correctDataErrors();
        if (G.PlayerSync && typeof G.PlayerSync.enterCurrentMap === 'function') {
          // 进了 Scene_Map.start 自然会调一次 enterMap
        }
        SceneManager.goto(Scene_Map);
        return true;
      } catch (e) {
        console.error('[XSG-Online] cloud save parse failed', e);
        return false;
      }
    });
  }

  function startFreshNewGame() {
    // 走游戏自定义的「新游戏」流程：到 Scene_MakeActor 创角，结束后进 Scene_Map
    DataManager.setupNewGame();
    if (typeof Scene_MakeActor !== 'undefined') {
      SceneManager.push(Scene_MakeActor);
    } else {
      SceneManager.goto(Scene_Map);
    }
  }

  function afterLogin() {
    flash('登录成功：' + (Core.session.character.name || ('#' + Core.session.character.pid)));
    Net.request('save.exists', {}, 6000).then((r) => {
      if (r && r.exists) {
        downloadAndEnter().then((ok) => {
          if (!ok) startFreshNewGame();
        });
      } else {
        startFreshNewGame();
      }
    }).catch(() => startFreshNewGame());
  }

  Scene_Title.prototype.commandXsgOnline = function () {
    const scene = this;
    if (this._commandWindow) this._commandWindow.close();
    // 已经 session 在手（或在线）→ 弹三选一菜单
    if ((Core.isOnline()) || (Core.session && Core.session.character)) {
      OnlineMenu.open(Core.session.character, (action) => {
        if (action === 'enter') {
          // 走「进入游戏」流程：保证 net 连通后再下云存档
          Net.connect().then(afterLogin).catch((err) => alert('连服失败：' + (err && err.message)));
        } else if (action === 'logout') {
          Core.clearSession();
          flash('已退出联机');
          if (scene._commandWindow) { scene._commandWindow.open(); scene._commandWindow.activate(); }
        } else {
          if (scene._commandWindow) { scene._commandWindow.open(); scene._commandWindow.activate(); }
        }
      });
      return;
    }
    LoginOverlay.open((ok) => {
      if (!ok) {
        if (scene._commandWindow) { scene._commandWindow.open(); scene._commandWindow.activate(); }
        return;
      }
      afterLogin();
    });
  };

  // ===== \u300c\u8054\u673a\u72b6\u6001\u300d\u4e09\u9009\u4e00\u83dc\u5355 =====
  const OnlineMenu = {};
  let menuRoot = null;
  let menuCb = null;
  OnlineMenu.open = function (character, cb) {
    if (!menuRoot) buildMenu();
    menuCb = cb;
    menuRoot.querySelector('[data-name]').textContent = character.name || ('#' + character.pid);
    menuRoot.style.display = 'flex';
  };
  OnlineMenu.close = function (action) {
    if (menuRoot) menuRoot.style.display = 'none';
    const cb = menuCb; menuCb = null;
    if (cb) cb(action);
  };
  function buildMenu() {
    menuRoot = document.createElement('div');
    Object.assign(menuRoot.style, {
      position: 'absolute', left: '0', top: '0', right: '0', bottom: '0',
      background: 'rgba(0,0,0,0.55)',
      display: 'none', alignItems: 'center', justifyContent: 'center', zIndex: '9999',
      fontFamily: 'sans-serif', color: '#fff',
    });
    menuRoot.innerHTML = [
      '<div style="background:#1f1f24;padding:22px 26px;border-radius:10px;min-width:300px;box-shadow:0 6px 32px rgba(0,0,0,.6)">',
      '  <div style="font-size:16px;margin-bottom:14px;text-align:center">已登录：<b data-name></b></div>',
      '  <button data-act="enter"  style="display:block;width:100%;padding:10px;margin-bottom:8px;background:#2c9c4a;color:#fff;border:0;border-radius:6px;font-size:15px;cursor:pointer">进入游戏（云存档继续）</button>',
      '  <button data-act="logout" style="display:block;width:100%;padding:10px;margin-bottom:8px;background:#a05050;color:#fff;border:0;border-radius:6px;font-size:15px;cursor:pointer">退出联机</button>',
      '  <button data-act="cancel" style="display:block;width:100%;padding:8px;background:#555;color:#fff;border:0;border-radius:6px;font-size:13px;cursor:pointer">取消</button>',
      '</div>',
    ].join('');
    document.body.appendChild(menuRoot);
    // 阻断所有底层 canvas 事件
    const allEvents = ['mousedown', 'mouseup', 'click', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'wheel'];
    allEvents.forEach((evt) => {
      menuRoot.addEventListener(evt, (e) => {
        e.stopPropagation();
        e.stopImmediatePropagation();
      }, true);
    });
    // 给每个按钮都加直接处理（不依赖事件委托）
    menuRoot.querySelectorAll('button[data-act]').forEach((btn) => {
      const act = btn.dataset.act;
      allEvents.forEach((evt) => {
        btn.addEventListener(evt, (e) => {
          e.stopPropagation();
          e.stopImmediatePropagation();
          if (e.preventDefault) e.preventDefault();
          if (evt === 'click' || evt === 'touchend') {
            OnlineMenu.close(act);
          }
        }, true);
      });
    });
  }

  // ---- 「联机」按钮在 Scene_Title 显示。Scene_Map 上不再显示。----
  const _Scene_Title_start = Scene_Title.prototype.start;
  Scene_Title.prototype.start = function () {
    _Scene_Title_start.call(this);
    OnlineEntry.show();
  };
  const _Scene_Title_terminate = Scene_Title.prototype.terminate;
  Scene_Title.prototype.terminate = function () {
    OnlineEntry.hide();
    if (_Scene_Title_terminate) _Scene_Title_terminate.call(this);
  };

  const OnlineEntry = {};
  let entryBtn = null;
  let keyBound = false;

  OnlineEntry.show = function () {
    if (!entryBtn) buildEntryButton();
    entryBtn.style.display = 'block';
    if (!keyBound) bindKey();
    OnlineEntry.refresh();
    if (!OnlineEntry._refreshTimer) {
      OnlineEntry._refreshTimer = setInterval(OnlineEntry.refresh, 2000);
    }
  };
  OnlineEntry.hide = function () {
    if (entryBtn) entryBtn.style.display = 'none';
    if (OnlineEntry._refreshTimer) {
      clearInterval(OnlineEntry._refreshTimer);
      OnlineEntry._refreshTimer = null;
    }
  };
  OnlineEntry.refresh = function () {
    if (!entryBtn) return;
    if (Core.isOnline()) {
      const name = Core.session.character.name || ('#' + Core.session.character.pid);
      entryBtn.textContent = '退出联机 [' + name + ']';
      entryBtn.style.background = 'linear-gradient(135deg, #a05050 0%, #d04040 100%)';
    } else if (Core.session && Core.session.character) {
      entryBtn.textContent = '重连联机 [' + (Core.session.character.name || '?') + ']';
      entryBtn.style.background = 'linear-gradient(135deg, #c08030 0%, #d4a040 100%)';
    } else {
      entryBtn.textContent = cfg.text + '（M）';
      entryBtn.style.background = 'linear-gradient(135deg, #3a82ff 0%, #2c9c4a 100%)';
    }
  };

  function buildEntryButton() {
    entryBtn = document.createElement('button');
    entryBtn.id = 'xsg-online-entry';
    entryBtn.textContent = cfg.text + '（M）';
    Object.assign(entryBtn.style, {
      position: 'absolute',
      right: '14px', top: '14px',
      padding: '10px 20px',
      fontSize: '18px', fontWeight: 'bold',
      background: 'linear-gradient(135deg, #3a82ff 0%, #2c9c4a 100%)',
      color: '#fff', border: '0', borderRadius: '8px',
      cursor: 'pointer', zIndex: '9000',
      boxShadow: '0 4px 14px rgba(0,0,0,0.5)',
      letterSpacing: '2px',
    });
    // 阻断所有指针事件向下穿透到 RMMZ canvas（不然点完会被画布同位置原菜单收走）
    ['mousedown', 'mouseup', 'click', 'pointerdown', 'pointerup', 'touchstart', 'touchend'].forEach((evt) => {
      entryBtn.addEventListener(evt, (e) => {
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (e.preventDefault) e.preventDefault();
        if (evt === 'click' || evt === 'touchend') trigger();
      }, true);
    });
    entryBtn.addEventListener('mouseenter', () => { entryBtn.style.transform = 'scale(1.05)'; });
    entryBtn.addEventListener('mouseleave', () => { entryBtn.style.transform = 'scale(1)'; });
    document.body.appendChild(entryBtn);
  }

  function bindKey() {
    keyBound = true;
    document.addEventListener('keydown', (e) => {
      if (!(SceneManager._scene instanceof Scene_Title)) return;
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      if (e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        trigger();
      }
    });
  }

  function trigger() {
    if (SceneManager._scene instanceof Scene_Title) {
      SceneManager._scene.commandXsgOnline();
    }
  }

  // ---- DOM login overlay ----
  const LoginOverlay = {};
  let root = null;
  let onDone = null;

  LoginOverlay.open = function (cb) {
    onDone = cb;
    if (!root) build();
    root.style.display = 'flex';
    setStatus('');
    setBusy(false);
    setTimeout(() => {
      const u = root.querySelector('input[name=u]');
      if (u) u.focus();
    }, 60);
  };

  LoginOverlay.close = function (success) {
    if (root) root.style.display = 'none';
    const cb = onDone; onDone = null;
    if (cb) cb(!!success);
  };

  function build() {
    root = document.createElement('div');
    root.id = 'xsg-online-login';
    Object.assign(root.style, {
      position: 'absolute',
      left: '0', top: '0', right: '0', bottom: '0',
      background: 'rgba(0,0,0,0.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: '9999',
      fontFamily: 'sans-serif', color: '#fff',
    });
    root.innerHTML = [
      '<div style="background:#1f1f24;padding:22px 26px;border-radius:10px;min-width:300px;box-shadow:0 6px 32px rgba(0,0,0,.5)">',
      '  <div style="font-size:18px;margin-bottom:14px;text-align:center;letter-spacing:2px">小傻瓜·联机服</div>',
      '  <div style="margin-bottom:8px"><input name="u" placeholder="账号 (3~16位)" autocomplete="off" style="width:100%;padding:8px;border-radius:4px;border:1px solid #333;background:#111;color:#fff;box-sizing:border-box"/></div>',
      '  <div style="margin-bottom:8px"><input name="p" type="password" placeholder="密码 (6~64位)" autocomplete="off" style="width:100%;padding:8px;border-radius:4px;border:1px solid #333;background:#111;color:#fff;box-sizing:border-box"/></div>',
      '  <div style="display:flex;gap:8px;margin-top:6px">',
      '    <button data-act="login"    style="flex:1;padding:8px;border-radius:4px;border:0;background:#3a82ff;color:#fff;cursor:pointer">登录</button>',
      '    <button data-act="register" style="flex:1;padding:8px;border-radius:4px;border:0;background:#2c9c4a;color:#fff;cursor:pointer">注册</button>',
      '    <button data-act="cancel"   style="flex:0 0 60px;padding:8px;border-radius:4px;border:0;background:#555;color:#fff;cursor:pointer">取消</button>',
      '  </div>',
      '  <div data-status style="margin-top:10px;font-size:12px;color:#ffb84d;min-height:16px;text-align:center"></div>',
      '</div>',
    ].join('');
    document.body.appendChild(root);

    root.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const btn = root.querySelector('button[data-act=login]');
        if (btn && !btn.disabled) btn.click();
      } else if (e.key === 'Escape') {
        LoginOverlay.close(false);
      }
    });

    root.addEventListener('click', (e) => {
      const t = e.target;
      if (!t || !t.dataset || !t.dataset.act) return;
      const act = t.dataset.act;
      if (act === 'cancel') { LoginOverlay.close(false); return; }
      const u = root.querySelector('input[name=u]').value.trim();
      const p = root.querySelector('input[name=p]').value;
      if (!u || !p) { setStatus('账号、密码必填'); return; }
      doSubmit(act, u, p);
    });
  }

  function doSubmit(act, u, p) {
    setBusy(true);
    setStatus('正在连接服务器…');
    Net.connect()
      .then(() => {
        setStatus(act === 'login' ? '登录中…' : '注册中…');
        return Net.request('auth.' + act, { username: u, password: p, clientVer: G.version });
      })
      .then((resp) => {
        Core.setSession({ token: resp.token, character: resp.character });
        LoginOverlay.close(true);
      })
      .catch((err) => {
        const msg = err && err.code
          ? '[' + err.code + '] ' + (err.message || '')
          : (err && err.message) || '未知错误';
        setStatus(msg);
        setBusy(false);
        Util.log('warn', 'login/register failed:', msg);
      });
  }

  function setStatus(s) {
    if (!root) return;
    const el = root.querySelector('[data-status]');
    if (el) el.textContent = s;
  }

  function setBusy(b) {
    if (!root) return;
    root.querySelectorAll('button').forEach((btn) => {
      btn.disabled = b;
      btn.style.opacity = b ? '0.5' : '1';
      btn.style.cursor = b ? 'default' : 'pointer';
    });
    root.querySelectorAll('input').forEach((inp) => { inp.disabled = b; });
  }
})();
