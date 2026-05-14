//=============================================================================
// XdRs_Online_Login.js  (v0.2.0)
//=============================================================================
/*:
 * @target MZ
 * @plugindesc 联机-登录 | Scene_Title 浮动入口 + 原生 Scene_OnlineMenu(已登录三选一) + DOM 登录覆盖层
 * @author xsg-online
 *
 * @param titleCommandText
 * @text 入口按钮文字
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
 * 修复点 (v0.2.0)
 * ---------------------------------------------------------------
 * 旧版三选一菜单用 DOM 覆盖层在 capture 阶段调 stopImmediatePropagation，
 * 阻断了事件传到子按钮，导致按钮看似存在却"点不动"。
 * 现在已登录三选一菜单改为原生 RMMZ：
 *   Scene_OnlineMenu (Scene_MenuBase) + Window_OnlineMenuCommand (Window_Command)
 * 走 RMMZ 自己的输入层，与 XdRs_Arder_Scene 的 sprite hit-test 完全没有交集。
 *
 * 三步闭环
 *   发起端 client : Window_OnlineMenuCommand 命令选择 (Enter/上下/Esc)
 *   服端    server: domain/storage 的 save.exists / save.download
 *                   未找到角色直接 return code SAVE.NOT_FOUND, 不会全服报错
 *   表现端 client : DataManager.extractSaveContents + SceneManager.goto(Scene_Map)
 *                   parse 失败或下载 reject 都被 catch, 不会让 client 崩
 *
 * 兜底
 *   res / blob 任何一处空: 直接 return + 提示, 转 startFreshNewGame()
 *   JsonEx.parse 抛错: catch + 提示 + 留在菜单
 *   Net.connect reject: catch + 提示 + 留在菜单
 *
 * 多人并发自检
 *   该 UI 全部在 client 单机 DOM/Scene 上, 不和其他玩家共享状态.
 *   服端 save.download 是单角色读 (按 Core.session.character.pid),
 *   并发请求各取各的存档行, 不会互相覆盖.
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

  // ======================================================================
  // 公共工具
  // ======================================================================
  function flash(text) {
    if (typeof $gameTemp !== 'undefined' && $gameTemp && typeof $gameTemp.addWorldMessage === 'function') {
      $gameTemp.addWorldMessage('\\c[10][系统]\\c[0] ' + text, true);
    } else {
      console.log('[XSG-Online] ' + text);
    }
  }

  function startFreshNewGame() {
    DataManager.setupNewGame();
    if (typeof Scene_MakeActor !== 'undefined') {
      SceneManager.push(Scene_MakeActor);
    } else {
      SceneManager.goto(Scene_Map);
    }
  }

  function applyCloudSave(blob) {
    if (!blob || !blob.contents) return false;
    const contents = JsonEx.parse(blob.contents);
    if (!contents) return false;
    DataManager.createGameObjects();
    DataManager.extractSaveContents(contents);
    DataManager.correctDataErrors();
    return true;
  }

  function downloadAndEnter(onError) {
    Net.request('save.download', {}, 12000).then((res) => {
      if (!res || !res.found || !res.blob) {
        startFreshNewGame();
        return;
      }
      try {
        const ok = applyCloudSave(res.blob);
        if (!ok) {
          if (typeof onError === 'function') onError('云存档结构为空');
          return;
        }
        SceneManager.goto(Scene_Map);
      } catch (e) {
        console.error('[XSG-Online] cloud save parse failed', e);
        if (typeof onError === 'function') onError((e && e.message) || '云存档解析失败');
      }
    }).catch((err) => {
      if (typeof onError === 'function') onError((err && err.message) || '下载失败');
    });
  }

  function afterLogin() {
    flash('登录成功：' + (Core.session.character.name || ('#' + Core.session.character.pid)));
    Net.request('save.exists', {}, 6000).then((r) => {
      if (r && r.exists) {
        downloadAndEnter((msg) => {
          alert('下载存档失败：' + msg + '\n将以新游戏开始');
          startFreshNewGame();
        });
      } else {
        startFreshNewGame();
      }
    }).catch((err) => {
      alert('查询云存档失败：' + ((err && err.message) || '未知错误') + '\n将以新游戏开始');
      startFreshNewGame();
    });
  }

  // ======================================================================
  // Window_OnlineMenuCommand - 三选一命令窗口
  // ======================================================================
  function Window_OnlineMenuCommand() { this.initialize(...arguments); }
  Window_OnlineMenuCommand.prototype = Object.create(Window_Command.prototype);
  Window_OnlineMenuCommand.prototype.constructor = Window_OnlineMenuCommand;

  Window_OnlineMenuCommand.prototype.initialize = function (rect) {
    Window_Command.prototype.initialize.call(this, rect);
  };

  Window_OnlineMenuCommand.prototype.makeCommandList = function () {
    this.addCommand('进入游戏（云存档继续）', 'enter');
    this.addCommand('退出联机', 'logout');
    this.addCommand('取消',     'cancel');
  };

  Window_OnlineMenuCommand.prototype.itemHeight = function () {
    return 48;
  };

  // ======================================================================
  // Scene_OnlineMenu - 已登录态三选一菜单 (原生 RMMZ 实现)
  // ======================================================================
  function Scene_OnlineMenu() { this.initialize(...arguments); }
  Scene_OnlineMenu.prototype = Object.create(Scene_MenuBase.prototype);
  Scene_OnlineMenu.prototype.constructor = Scene_OnlineMenu;

  Scene_OnlineMenu.prototype.initialize = function () {
    Scene_MenuBase.prototype.initialize.call(this);
  };

  Scene_OnlineMenu.prototype.create = function () {
    Scene_MenuBase.prototype.create.call(this);
    OnlineEntry.hide();
    this.createHelpWindow();
    this.createCommandWindow();
  };

  Scene_OnlineMenu.prototype.helpWindowRect = function () {
    const ww = Graphics.boxWidth;
    const wh = this.calcWindowHeight(2, false);
    return new Rectangle(0, 0, ww, wh);
  };

  Scene_OnlineMenu.prototype.createHelpWindow = function () {
    const rect = this.helpWindowRect();
    this._helpWindow = new Window_Help(rect);
    this.refreshHelp();
    this.addWindow(this._helpWindow);
  };

  Scene_OnlineMenu.prototype.refreshHelp = function (extra) {
    if (!this._helpWindow) return;
    const ch = Core.session && Core.session.character;
    const name = ch ? (ch.name || ('#' + ch.pid)) : '(未知角色)';
    const tip = extra || '↑↓ 选择   Enter 确认   Esc 取消';
    this._helpWindow.setText('已登录：' + name + '\n' + tip);
  };

  Scene_OnlineMenu.prototype.commandWindowRect = function () {
    const ww = 480;
    const wh = this.calcWindowHeight(3, true);
    const wx = Math.floor((Graphics.boxWidth - ww) / 2);
    const wy = Math.floor((Graphics.boxHeight - wh) / 2);
    return new Rectangle(wx, wy, ww, wh);
  };

  Scene_OnlineMenu.prototype.createCommandWindow = function () {
    const rect = this.commandWindowRect();
    this._commandWindow = new Window_OnlineMenuCommand(rect);
    this._commandWindow.setHandler('enter',  this.commandEnter.bind(this));
    this._commandWindow.setHandler('logout', this.commandLogout.bind(this));
    this._commandWindow.setHandler('cancel', this.commandCancel.bind(this));
    this.addWindow(this._commandWindow);
  };

  Scene_OnlineMenu.prototype.commandEnter = function () {
    if (!Core.session || !Core.session.character) {
      this.refreshHelp('未登录，操作取消');
      this._commandWindow.activate();
      return;
    }
    this._commandWindow.deactivate();
    this.refreshHelp('正在连接服务器…');
    Net.connect().then(() => {
      this.refreshHelp('正在下载云存档…');
      downloadAndEnter((msg) => {
        this.refreshHelp('下载失败：' + msg + '   按 Esc 返回标题');
        this._commandWindow.activate();
      });
    }).catch((err) => {
      this.refreshHelp('连接失败：' + ((err && err.message) || '未知错误'));
      this._commandWindow.activate();
    });
  };

  Scene_OnlineMenu.prototype.commandLogout = function () {
    Core.clearSession();
    flash('已退出联机');
    SceneManager.goto(Scene_Title);
  };

  Scene_OnlineMenu.prototype.commandCancel = function () {
    this.popScene();
  };

  // ======================================================================
  // Scene_Title hook (兼容原生 RMMZ，XdRs_Arder_Scene 项目下不会触发但保留兜底)
  // ======================================================================
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

  Scene_Title.prototype.commandXsgOnline = function () {
    if (this._commandWindow && typeof this._commandWindow.close === 'function') this._commandWindow.close();
    if (Core.isOnline() || (Core.session && Core.session.character)) {
      SceneManager.push(Scene_OnlineMenu);
      return;
    }
    LoginOverlay.open((ok) => {
      if (!ok) {
        if (this._commandWindow && typeof this._commandWindow.open === 'function') {
          this._commandWindow.open();
          this._commandWindow.activate();
        }
        return;
      }
      afterLogin();
    });
  };

  // ======================================================================
  // OnlineEntry - Scene_Title 上的 DOM 浮动入口按钮
  // 用 bubble 阶段事件 + stopPropagation, 防止穿透到 canvas
  // ======================================================================
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
  OnlineEntry._refreshTimer = null;

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
      entryBtn.textContent = '已联机 [' + name + ']';
      entryBtn.style.background = 'linear-gradient(135deg, #a05050 0%, #d04040 100%)';
    } else if (Core.session && Core.session.character) {
      entryBtn.textContent = '重连 [' + (Core.session.character.name || '?') + ']';
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
      transition: 'transform 80ms ease-out',
    });
    entryBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.preventDefault) e.preventDefault();
      trigger();
    });
    entryBtn.addEventListener('mousedown',   (e) => { e.stopPropagation(); if (e.preventDefault) e.preventDefault(); });
    entryBtn.addEventListener('mouseup',     (e) => { e.stopPropagation(); if (e.preventDefault) e.preventDefault(); });
    entryBtn.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
    entryBtn.addEventListener('pointerup',   (e) => { e.stopPropagation(); });
    entryBtn.addEventListener('touchstart',  (e) => { e.stopPropagation(); }, { passive: false });
    entryBtn.addEventListener('touchend',    (e) => { e.stopPropagation(); if (e.preventDefault) e.preventDefault(); trigger(); }, { passive: false });
    entryBtn.addEventListener('mouseenter',  () => { entryBtn.style.transform = 'scale(1.05)'; });
    entryBtn.addEventListener('mouseleave',  () => { entryBtn.style.transform = 'scale(1)'; });
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
    if (SceneManager._scene instanceof Scene_Title && typeof SceneManager._scene.commandXsgOnline === 'function') {
      SceneManager._scene.commandXsgOnline();
    }
  }

  // ======================================================================
  // LoginOverlay - DOM 登录覆盖层 (账号 / 密码输入框)
  // RMMZ 无原生文本输入 widget, 此处 DOM 是合理选择.
  // 关键修复: 全部用 bubble 阶段, 按钮 click 内 stopPropagation,
  // overlay 空白处再额外 stopPropagation, 子按钮事件不会被父覆盖层吃掉.
  // ======================================================================
  const LoginOverlay = {};
  let loginRoot = null;
  let onDone = null;

  LoginOverlay.open = function (cb) {
    onDone = cb;
    if (!loginRoot) buildLoginRoot();
    loginRoot.style.display = 'flex';
    setStatus('');
    setBusy(false);
    setTimeout(() => {
      const u = loginRoot.querySelector('input[name=u]');
      if (u) u.focus();
    }, 60);
  };

  LoginOverlay.close = function (success) {
    if (loginRoot) loginRoot.style.display = 'none';
    const cb = onDone; onDone = null;
    if (cb) cb(!!success);
  };

  function buildLoginRoot() {
    loginRoot = document.createElement('div');
    loginRoot.id = 'xsg-online-login';
    Object.assign(loginRoot.style, {
      position: 'absolute',
      left: '0', top: '0', right: '0', bottom: '0',
      background: 'rgba(0,0,0,0.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: '9999',
      fontFamily: 'sans-serif', color: '#fff',
    });
    loginRoot.innerHTML = [
      '<div data-modal style="background:#1f1f24;padding:22px 26px;border-radius:10px;min-width:300px;box-shadow:0 6px 32px rgba(0,0,0,.5)">',
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
    document.body.appendChild(loginRoot);

    ['mousedown', 'mouseup', 'click', 'pointerdown', 'pointerup'].forEach((evt) => {
      loginRoot.addEventListener(evt, (e) => {
        if (e.target === loginRoot) {
          e.stopPropagation();
          if (e.preventDefault) e.preventDefault();
        }
      });
    });

    loginRoot.querySelectorAll('button[data-act]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const act = btn.dataset.act;
        if (act === 'cancel') { LoginOverlay.close(false); return; }
        const u = loginRoot.querySelector('input[name=u]').value.trim();
        const p = loginRoot.querySelector('input[name=p]').value;
        if (!u || !p) { setStatus('账号、密码必填'); return; }
        doSubmit(act, u, p);
      });
      btn.addEventListener('mousedown', (e) => { e.stopPropagation(); });
      btn.addEventListener('mouseup',   (e) => { e.stopPropagation(); });
    });

    loginRoot.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const btn = loginRoot.querySelector('button[data-act=login]');
        if (btn && !btn.disabled) btn.click();
      } else if (e.key === 'Escape') {
        LoginOverlay.close(false);
      }
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
        if (Util && Util.log) Util.log('warn', 'login/register failed:', msg);
      });
  }

  function setStatus(s) {
    if (!loginRoot) return;
    const el = loginRoot.querySelector('[data-status]');
    if (el) el.textContent = s;
  }

  function setBusy(b) {
    if (!loginRoot) return;
    loginRoot.querySelectorAll('button').forEach((btn) => {
      btn.disabled = b;
      btn.style.opacity = b ? '0.5' : '1';
      btn.style.cursor = b ? 'default' : 'pointer';
    });
    loginRoot.querySelectorAll('input').forEach((inp) => { inp.disabled = b; });
  }
})();
