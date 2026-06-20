//=============================================================================
// XdRs_Online_Hub.js
//=============================================================================
/*:
 * @target MZ
 * @plugindesc 联机-联机中心 | 游戏内统一入口(单按钮)聚合好友/在线玩家/聊天/宠物/存档/改名等
 * @author xsg-online
 *
 * @help
 * 解决"联机功能全靠记热键、入口分散重叠、看不见"的问题:
 * 在地图里(已联机)右上角放一个「联机中心」按钮, 点开是一个宫格菜单, 集中所有模块入口。
 *  - 复用各模块已有的 open()/close(), 不重写它们; 打开新面板前先关其它(面板互斥)。
 *  - 新增「在线玩家」面板: 列出全服在线玩家, 一键 私聊/加好友/邀交易(远距离也能加好友)。
 *  - 热键(F好友 / P宠物 / 回车聊天 / 右键玩家)照常作为快捷方式保留。
 * 必须放在其它 XdRs_Online_* 插件之后加载。
 */
(() => {
  'use strict';
  const G = window.XdRsOnline;
  if (!G || !G.Net || !G.Core) {
    console.error('[XSG-Online] Hub: deps missing');
    return;
  }
  const Util = G.Util;
  const Net = G.Net;
  const Core = G.Core;

  const Hub = (G.Hub = G.Hub || {});
  const Z = { fab: 9000, onlinePanel: 9560, popover: 9600 };

  let fab = null;
  let badgeEl = null;
  let popover = null;
  let onlinePanel = null;
  let onlineBody = null;
  let unreadChat = 0;

  // ---------- 公共工具 ----------
  function flash(text) {
    if (typeof $gameTemp !== 'undefined' && $gameTemp && typeof $gameTemp.addWorldMessage === 'function') {
      $gameTemp.addWorldMessage('\\c[10][系统]\\c[0] ' + text, true);
    } else {
      console.log('[XSG-Online] ' + text);
    }
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function onErr(err) {
    flash((err && err.code ? err.code + ': ' : '') + (err && err.message || '操作失败'));
  }
  // 截断 DOM 弹层上的指针/键盘事件, 防穿透到 RMMZ canvas 触发寻路
  function stopBubble(el) {
    ['mousedown', 'mouseup', 'click', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'wheel', 'contextmenu'].forEach((evt) => {
      el.addEventListener(evt, (e) => { e.stopPropagation(); }, evt === 'touchstart' || evt === 'touchend' || evt === 'wheel' ? { passive: false } : undefined);
    });
    el.addEventListener('keydown', (e) => e.stopPropagation());
  }
  // ---------- 入口 FAB ----------
  function buildFab() {
    fab = document.createElement('button');
    fab.id = 'xsg-online-hub-fab';
    fab.textContent = '联机中心';
    Object.assign(fab.style, {
      position: 'absolute', left: '310px', top: '14px',
      padding: '8px 16px', fontSize: '15px', fontWeight: 'bold',
      background: 'linear-gradient(180deg, #ffc861 0%, #f09a32 100%)',
      color: '#5a3410', border: '2px solid #c96a1e', borderRadius: '9px', cursor: 'pointer',
      zIndex: String(Z.fab), boxShadow: '0 3px 8px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.5)',
      letterSpacing: '1px', transition: 'transform 80ms ease-out', display: 'none',
    });
    badgeEl = document.createElement('span');
    Object.assign(badgeEl.style, {
      position: 'absolute', top: '-6px', right: '-6px', minWidth: '18px', height: '18px',
      lineHeight: '18px', padding: '0 4px', borderRadius: '9px', background: '#e0413f',
      color: '#fff', fontSize: '11px', textAlign: 'center', boxSizing: 'border-box', display: 'none',
    });
    fab.appendChild(badgeEl);
    stopBubble(fab);
    fab.addEventListener('click', (e) => { e.stopPropagation(); if (e.preventDefault) e.preventDefault(); togglePopover(); });
    fab.addEventListener('mouseenter', () => { fab.style.transform = 'scale(1.05)'; });
    fab.addEventListener('mouseleave', () => { fab.style.transform = 'scale(1)'; });
    document.body.appendChild(fab);
  }

  function showFab() {
    if (!fab) buildFab();
    fab.style.display = 'block';
  }
  function hideFab() {
    if (fab) fab.style.display = 'none';
  }
  function updateBadge() {
    if (!badgeEl) return;
    if (unreadChat > 0) {
      badgeEl.textContent = unreadChat > 99 ? '99+' : String(unreadChat);
      badgeEl.style.display = 'block';
    } else {
      badgeEl.style.display = 'none';
    }
  }

  // ---------- 宫格 popover ----------
  const TILES = [
    { key: 'friend', label: '好友', run: () => openModule(() => G.Friend && G.Friend.open && G.Friend.open()) },
    { key: 'players', label: '在线玩家', run: () => openOnlinePanel() },
    { key: 'market', label: '寄售行', run: () => openModule(() => G.Market && G.Market.open && G.Market.open()) },
    { key: 'chat', label: '聊天', run: () => openChat() },
    { key: 'save', label: '存档迁移', run: () => openModule(() => G.SaveMigrate && G.SaveMigrate.open && G.SaveMigrate.open()) },
    { key: 'rename', label: '改名', run: () => doRename() },
    { key: 'update', label: '检查更新', run: () => openModule(() => G.Update && G.Update.openPanel && G.Update.openPanel()) },
    { key: 'logout', label: '退出联机', run: () => doLogout() },
    { key: 'help', label: '帮助', run: () => showHelp() },
  ];

  function buildPopover() {
    popover = document.createElement('div');
    popover.id = 'xsg-online-hub-popover';
    popover.className = 'xsg-win';
    Object.assign(popover.style, {
      position: 'absolute', right: '14px', top: '56px', width: '300px',
      zIndex: String(Z.popover), display: 'none',
    });
    const grid = TILES.map((t) =>
      '<button class="xsg-btn" data-tile="' + t.key + '" style="padding:14px 4px;font-size:13px">' + t.label + '</button>'
    ).join('');
    popover.innerHTML = [
      '<div class="xsg-titlebar">',
      '  <span class="xsg-title">联机中心</span>',
      '  <button class="xsg-btn-close" data-act="close">×</button>',
      '</div>',
      '<div class="xsg-body" style="min-height:0;display:grid;grid-template-columns:repeat(3,1fr);gap:8px">' + grid + '</div>',
    ].join('');
    document.body.appendChild(popover);
    stopBubble(popover);
    popover.querySelector('button[data-act=close]').addEventListener('click', closePopover);
    popover.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-tile]');
      if (!b) return;
      const tile = TILES.find((t) => t.key === b.dataset.tile);
      if (tile) tile.run();
    });
  }

  function openPopover() {
    if (!popover) buildPopover();
    popover.style.display = 'block';
    unreadChat = 0;
    updateBadge();
  }
  function closePopover() {
    if (popover) popover.style.display = 'none';
  }
  function popoverOpen() {
    return !!(popover && popover.style.display !== 'none');
  }
  function togglePopover() {
    if (popoverOpen()) closePopover();
    else openPopover();
  }
  Hub.openPopover = openPopover;
  Hub.closePopover = closePopover;

  // ---------- 面板互斥 ----------
  function closeAllPanels() {
    if (G.Friend && typeof G.Friend.close === 'function') { try { G.Friend.close(); } catch (e) { /* ignore */ } }
    if (G.Pet && typeof G.Pet.close === 'function') { try { G.Pet.close(); } catch (e) { /* ignore */ } }
    if (G.Chat && typeof G.Chat.close === 'function') { try { G.Chat.close(); } catch (e) { /* ignore */ } }
    if (G.SaveMigrate && typeof G.SaveMigrate.close === 'function') { try { G.SaveMigrate.close(); } catch (e) { /* ignore */ } }
    if (G.Market && typeof G.Market.close === 'function') { try { G.Market.close(); } catch (e) { /* ignore */ } }
    closeOnlinePanel();
  }
  function openModule(opener) {
    closeAllPanels();
    closePopover();
    try { opener(); } catch (e) { Util.log('warn', 'hub open module failed:', e && e.message); }
  }

  // ---------- 各 tile 动作 ----------
  function openChat() {
    closePopover();
    if (G.Chat && typeof G.Chat.open === 'function') {
      closeAllPanels();
      G.Chat.open();
    } else {
      flash('聊天：直接按回车输入消息');
    }
  }

  function doRename() {
    closePopover();
    if (!Core.session || !Core.session.character) { flash('未登录'); return; }
    const cur = Core.session.character.name || '';
    const input = window.prompt('输入新角色名（1~12 位）:', cur);
    if (input == null) return;
    const name = String(input).trim();
    if (!name) { flash('名字不能为空'); return; }
    Net.request('character.rename', { name }, 6000)
      .then((r) => {
        const nn = (r && r.name) || name;
        if (Core.session && Core.session.character) Core.session.character.name = nn;
        flash('已改名为：' + nn);
      })
      .catch(onErr);
  }

  function doLogout() {
    closePopover();
    closeAllPanels();
    hideAll();
    Core.clearSession();
    flash('已退出联机');
  }

  function showHelp() {
    closePopover();
    flash('联机中心 v' + (G.version || '?') + ' · 快捷键：F好友 回车聊天 右键点玩家交互');
  }

  // ---------- 在线玩家面板 ----------
  function buildOnlinePanel() {
    onlinePanel = document.createElement('div');
    onlinePanel.id = 'xsg-online-hub-players';
    onlinePanel.className = 'xsg-win';
    Object.assign(onlinePanel.style, {
      position: 'absolute', right: '14px', top: '56px', width: '320px', maxHeight: '60%',
      zIndex: String(Z.onlinePanel), display: 'none', fontSize: '12px',
    });
    onlinePanel.innerHTML = [
      '<div class="xsg-titlebar">',
      '  <span class="xsg-title">在线玩家</span>',
      '  <button class="xsg-btn" data-act="refresh">刷新</button>',
      '  <button class="xsg-btn-close" data-act="close">×</button>',
      '</div>',
      '<div class="xsg-body" data-body></div>',
    ].join('');
    document.body.appendChild(onlinePanel);
    onlineBody = onlinePanel.querySelector('[data-body]');
    stopBubble(onlinePanel);
    onlinePanel.querySelector('button[data-act=close]').addEventListener('click', closeOnlinePanel);
    onlinePanel.querySelector('button[data-act=refresh]').addEventListener('click', fetchOnline);
    onlineBody.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-pid]');
      if (!b) return;
      const pid = Number(b.dataset.pid);
      const op = b.dataset.op;
      if (op === 'whisper') {
        if (G.Chat && typeof G.Chat.startWhisper === 'function') G.Chat.startWhisper(pid, b.dataset.nm);
      } else if (op === 'friend') {
        Net.request('social.add', { pid, kind: 'friend' }, 5000).then(() => flash('已发送好友请求 #' + pid)).catch(onErr);
      } else if (op === 'trade') {
        if (G.Trade && typeof G.Trade.inviteTo === 'function') { closeOnlinePanel(); G.Trade.inviteTo(pid); }
        else flash('交易插件未就绪');
      }
    });
  }

  function openOnlinePanel() {
    closeAllPanels();
    closePopover();
    if (!onlinePanel) buildOnlinePanel();
    onlinePanel.style.display = 'flex';
    fetchOnline();
  }
  function closeOnlinePanel() {
    if (onlinePanel) onlinePanel.style.display = 'none';
  }

  function fetchOnline() {
    if (!Core.isOnline() || !onlineBody) return;
    onlineBody.innerHTML = '<div class="xsg-muted" style="padding:6px 0">加载中…</div>';
    Net.request('player.listOnline', {}, 6000)
      .then((data) => renderOnline((data && data.players) || []))
      .catch((err) => { onlineBody.innerHTML = '<div style="color:#ff7070;padding:6px 0">加载失败: ' + escapeHtml(err && err.message || '?') + '</div>'; });
  }

  function renderOnline(list) {
    if (!onlineBody) return;
    const myPid = Core.session && Core.session.character ? Core.session.character.pid : null;
    const others = list.filter((p) => p && p.pid !== myPid);
    if (!others.length) {
      onlineBody.innerHTML = '<div class="xsg-muted" style="padding:6px 0">当前没有其他在线玩家</div>';
      return;
    }
    onlineBody.innerHTML = others.map((p) => {
      const nm = escapeHtml(p.name || ('#' + p.pid));
      return '<div class="xsg-row" style="justify-content:space-between">'
        + '<span><span style="color:#2c8a2c">●</span> ' + nm + ' <span class="xsg-muted">#' + p.pid + ' @map' + p.mapId + '</span></span>'
        + '<span style="display:flex;gap:4px">'
        + '<button class="xsg-btn-primary" data-pid="' + p.pid + '" data-nm="' + nm + '" data-op="whisper" style="font-size:11px;padding:1px 8px">私聊</button>'
        + '<button class="xsg-btn" data-pid="' + p.pid + '" data-op="friend" style="font-size:11px;padding:1px 8px">加好友</button>'
        + '<button class="xsg-btn-warn" data-pid="' + p.pid + '" data-op="trade" style="font-size:11px;padding:1px 8px">邀交易</button>'
        + '</span></div>';
    }).join('');
  }

  // ---------- 未读聊天徽标 ----------
  Net.on('chat.evt', (msg) => {
    if (!msg) return;
    const myPid = Core.session && Core.session.character ? Core.session.character.pid : null;
    if (myPid != null && msg.fromPid === myPid) return; // 自己发的不计未读
    if (!popoverOpen()) { unreadChat++; updateBadge(); }
  });

  // ---------- 生命周期 ----------
  function hideAll() {
    closePopover();
    closeOnlinePanel();
    hideFab();
  }
  function inMapScene() {
    return typeof Scene_Map !== 'undefined' && SceneManager._scene instanceof Scene_Map;
  }
  function refreshVisibility() {
    if (inMapScene() && Core.isOnline()) showFab();
    else hideAll();
  }
  Hub.refreshVisibility = refreshVisibility;

  const _Scene_Map_start = Scene_Map.prototype.start;
  Scene_Map.prototype.start = function () {
    _Scene_Map_start.call(this);
    refreshVisibility();
  };
  const _Scene_Map_terminate = Scene_Map.prototype.terminate;
  Scene_Map.prototype.terminate = function () {
    hideAll();
    _Scene_Map_terminate.call(this);
  };
  Net.on('__disconnect__', hideAll);
  Net.on('__connect__', () => {
    setTimeout(refreshVisibility, 500);
    setTimeout(refreshVisibility, 2500);
  });
  setInterval(refreshVisibility, 1000);

  // ESC 关闭当前浮层
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    if (popoverOpen()) { closePopover(); return; }
    if (onlinePanel && onlinePanel.style.display !== 'none') { closeOnlinePanel(); }
  });

  Util.log('info', 'Hub (联机中心) loaded');
})();
