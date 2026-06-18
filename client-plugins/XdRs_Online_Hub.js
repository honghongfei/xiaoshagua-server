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
  function miniBtn(color) {
    return 'background:' + color + ';color:#fff;border:0;border-radius:3px;padding:1px 8px;font-size:11px;cursor:pointer';
  }

  // ---------- 入口 FAB ----------
  function buildFab() {
    fab = document.createElement('button');
    fab.id = 'xsg-online-hub-fab';
    fab.textContent = '联机中心';
    Object.assign(fab.style, {
      position: 'absolute', right: '14px', top: '14px',
      padding: '8px 16px', fontSize: '15px', fontWeight: 'bold',
      background: 'linear-gradient(135deg, #3a82ff 0%, #2c9c4a 100%)',
      color: '#fff', border: '0', borderRadius: '8px', cursor: 'pointer',
      zIndex: String(Z.fab), boxShadow: '0 4px 14px rgba(0,0,0,0.5)',
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
    { key: 'pet', label: '宠物', run: () => openModule(() => G.Pet && G.Pet.open && G.Pet.open()) },
    { key: 'save', label: '存档迁移', run: () => openModule(() => G.SaveMigrate && G.SaveMigrate.open && G.SaveMigrate.open()) },
    { key: 'rename', label: '改名', run: () => doRename() },
    { key: 'logout', label: '退出联机', run: () => doLogout() },
    { key: 'help', label: '帮助', run: () => showHelp() },
  ];

  function buildPopover() {
    popover = document.createElement('div');
    popover.id = 'xsg-online-hub-popover';
    Object.assign(popover.style, {
      position: 'absolute', right: '14px', top: '56px', width: '300px',
      background: 'rgba(20,20,28,0.96)', color: '#eee', borderRadius: '10px',
      border: '1px solid #333', padding: '10px', zIndex: String(Z.popover),
      boxShadow: '0 8px 24px rgba(0,0,0,0.6)', fontFamily: 'sans-serif', display: 'none',
    });
    const grid = TILES.map((t) =>
      '<button data-tile="' + t.key + '" style="background:#262833;color:#eee;border:1px solid #3a3d4a;border-radius:8px;padding:14px 4px;font-size:13px;cursor:pointer;transition:background 80ms">' + t.label + '</button>'
    ).join('');
    popover.innerHTML = [
      '<div style="display:flex;align-items:center;margin-bottom:8px">',
      '  <span style="flex:1;font-weight:bold;letter-spacing:1px">联机中心</span>',
      '  <button data-act="close" style="background:#444;color:#fff;border:0;border-radius:3px;padding:2px 8px;cursor:pointer">×</button>',
      '</div>',
      '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">' + grid + '</div>',
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
    popover.querySelectorAll('button[data-tile]').forEach((b) => {
      b.addEventListener('mouseenter', () => { b.style.background = '#3a82ff'; });
      b.addEventListener('mouseleave', () => { b.style.background = '#262833'; });
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
    flash('联机中心 v' + (G.version || '?') + ' · 快捷键：F好友 P宠物 回车聊天 右键点玩家交互');
  }

  // ---------- 在线玩家面板 ----------
  function buildOnlinePanel() {
    onlinePanel = document.createElement('div');
    onlinePanel.id = 'xsg-online-hub-players';
    Object.assign(onlinePanel.style, {
      position: 'absolute', right: '14px', top: '56px', width: '320px', maxHeight: '60%',
      background: 'rgba(20,20,28,0.95)', color: '#eee', borderRadius: '8px', border: '1px solid #333',
      zIndex: String(Z.onlinePanel), boxShadow: '0 4px 14px rgba(0,0,0,0.6)',
      fontFamily: 'sans-serif', fontSize: '12px', display: 'none', flexDirection: 'column',
    });
    onlinePanel.innerHTML = [
      '<div style="padding:6px 10px;border-bottom:1px solid #333;display:flex;align-items:center;gap:6px">',
      '  <span style="font-weight:bold;flex:1">在线玩家</span>',
      '  <button data-act="refresh" style="background:#333;color:#fff;border:0;border-radius:3px;padding:2px 8px;cursor:pointer">刷新</button>',
      '  <button data-act="close" style="background:#444;color:#fff;border:0;border-radius:3px;padding:2px 8px;cursor:pointer">×</button>',
      '</div>',
      '<div data-body style="overflow-y:auto;padding:6px 10px;line-height:1.6"></div>',
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
    onlineBody.innerHTML = '<div style="color:#888;padding:6px 0">加载中…</div>';
    Net.request('player.listOnline', {}, 6000)
      .then((data) => renderOnline((data && data.players) || []))
      .catch((err) => { onlineBody.innerHTML = '<div style="color:#ff7070;padding:6px 0">加载失败: ' + escapeHtml(err && err.message || '?') + '</div>'; });
  }

  function renderOnline(list) {
    if (!onlineBody) return;
    const myPid = Core.session && Core.session.character ? Core.session.character.pid : null;
    const others = list.filter((p) => p && p.pid !== myPid);
    if (!others.length) {
      onlineBody.innerHTML = '<div style="color:#888;padding:6px 0">当前没有其他在线玩家</div>';
      return;
    }
    onlineBody.innerHTML = others.map((p) => {
      const nm = escapeHtml(p.name || ('#' + p.pid));
      return '<div style="display:flex;align-items:center;justify-content:space-between;padding:3px 0;border-bottom:1px solid #2c2d33">'
        + '<span><span style="color:#5dd55d">●</span> ' + nm + ' <span style="color:#888">#' + p.pid + ' @map' + p.mapId + '</span></span>'
        + '<span style="display:flex;gap:4px">'
        + '<button data-pid="' + p.pid + '" data-nm="' + nm + '" data-op="whisper" style="' + miniBtn('#3a82ff') + '">私聊</button>'
        + '<button data-pid="' + p.pid + '" data-op="friend" style="' + miniBtn('#2c9c4a') + '">加好友</button>'
        + '<button data-pid="' + p.pid + '" data-op="trade" style="' + miniBtn('#a0790f') + '">邀交易</button>'
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

  const _Scene_Map_start = Scene_Map.prototype.start;
  Scene_Map.prototype.start = function () {
    _Scene_Map_start.call(this);
    if (Core.isOnline()) showFab();
  };
  const _Scene_Map_terminate = Scene_Map.prototype.terminate;
  Scene_Map.prototype.terminate = function () {
    hideAll();
    _Scene_Map_terminate.call(this);
  };
  Net.on('__disconnect__', hideAll);

  // ESC 关闭当前浮层
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    if (popoverOpen()) { closePopover(); return; }
    if (onlinePanel && onlinePanel.style.display !== 'none') { closeOnlinePanel(); }
  });

  Util.log('info', 'Hub (联机中心) loaded');
})();
