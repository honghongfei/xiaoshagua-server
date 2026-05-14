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

  // 「联机」是附加层：玩家走原生「新游戏 / 继续」进游戏，进 Scene_Map 后再点联机按钮启用同步。
  // 这里不做 setupNewGame、不做 reserveTransfer、不替原生剧情拍板。
  // commandXsgOnline 在 Scene_Title 上仅显示提示，引导用户先进游戏。
  Scene_Title.prototype.commandXsgOnline = function () {
    const scene = this;
    if (this._commandWindow) this._commandWindow.close();
    alert('请先用「新游戏 / 继续」进入游戏，然后在地图里按 M 键或点屏幕右上的「联机」按钮启用联机同步。');
    if (scene._commandWindow) {
      scene._commandWindow.open();
      scene._commandWindow.activate();
    }
  };

  // 在 Scene_Map 里点「联机」/ 按 M：弹登录窗 → 拿到 session → PlayerSync 自动接管同步
  function activateOnlineOnMap() {
    if (Core.isOnline()) {
      alert('当前已登录联机：' + (Core.session.character.name || ('#' + Core.session.character.pid)) +
            '\n要退出可按 F12 控制台运行 XdRsOnline.Core.clearSession()');
      return;
    }
    if (Core.session && Core.session.character) {
      // Reconnect 已 resume：只需要 Net.connect，PlayerSync 会触发 enterMap
      Net.connect().then(() => {
        // 触发一次 enterMap，让服务端知道你在哪
        if (G.PlayerSync && typeof G.PlayerSync.enterCurrentMap === 'function') {
          G.PlayerSync.enterCurrentMap();
        }
        flash('联机已激活：' + Core.session.character.name);
      }).catch((err) => alert('联机失败：' + (err && err.message)));
      return;
    }
    LoginOverlay.open((ok) => {
      if (!ok) return;
      if (G.PlayerSync && typeof G.PlayerSync.enterCurrentMap === 'function') {
        G.PlayerSync.enterCurrentMap();
      }
      flash('联机已激活：' + Core.session.character.name);
    });
  }

  function flash(text) {
    if (typeof $gameTemp !== 'undefined' && $gameTemp && typeof $gameTemp.addWorldMessage === 'function') {
      $gameTemp.addWorldMessage('\\c[10][系统]\\c[0] ' + text, true);
    } else {
      console.log('[XSG-Online] ' + text);
    }
  }

  // ---- 「联机」按钮在 Scene_Title 和 Scene_Map 上都显示 ----
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
  const _Scene_Map_start_login = Scene_Map.prototype.start;
  Scene_Map.prototype.start = function () {
    _Scene_Map_start_login.call(this);
    OnlineEntry.show();
  };
  const _Scene_Map_terminate_login = Scene_Map.prototype.terminate;
  Scene_Map.prototype.terminate = function () {
    OnlineEntry.hide();
    if (_Scene_Map_terminate_login) _Scene_Map_terminate_login.call(this);
  };

  const OnlineEntry = {};
  let entryBtn = null;
  let keyBound = false;

  OnlineEntry.show = function () {
    if (!entryBtn) buildEntryButton();
    entryBtn.style.display = 'block';
    if (!keyBound) bindKey();
  };
  OnlineEntry.hide = function () {
    if (entryBtn) entryBtn.style.display = 'none';
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
      const inTitle = SceneManager._scene instanceof Scene_Title;
      const inMap = SceneManager._scene instanceof Scene_Map;
      if (!inTitle && !inMap) return;
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
    } else if (SceneManager._scene instanceof Scene_Map) {
      activateOnlineOnMap();
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
