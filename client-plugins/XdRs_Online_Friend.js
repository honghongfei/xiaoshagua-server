//=============================================================================
// XdRs_Online_Friend.js
//=============================================================================
/*:
 * @target MZ
 * @plugindesc 联机-好友/黑名单 | DOM 面板 + 加好友/拉黑/私聊跳转
 * @author xsg-online
 *
 * @param toggleKey
 * @text 打开面板热键
 * @type string
 * @default F
 *
 * @help
 * 按 F 打开好友面板。点击好友名可一键私聊。
 */
(() => {
  'use strict';
  const G = window.XdRsOnline;
  if (!G || !G.Net || !G.Core) {
    console.error('[XSG-Online] Friend: deps missing');
    return;
  }
  const Util = G.Util;
  const Net = G.Net;
  const Core = G.Core;
  const params = PluginManager.parameters('XdRs_Online_Friend');
  const cfg = { toggleKey: String(params.toggleKey || 'F') };

  const Friend = (G.Friend = G.Friend || {});
  Friend.cache = { friends: [], blocks: [] };

  let panel = null;
  let body = null;
  let searchInput = null;
  let resultsEl = null;
  let opened = false;

  function build() {
    panel = document.createElement('div');
    panel.id = 'xsg-online-friend';
    panel.className = 'xsg-win';
    Object.assign(panel.style, {
      position: 'absolute',
      right: '10px', top: '10px',
      width: '260px', maxHeight: '60%',
      fontSize: '12px',
      display: 'none',
      zIndex: '9000',
    });
    panel.innerHTML = [
      '<div class="xsg-titlebar">',
      '  <span class="xsg-title">好友 / 黑名单</span>',
      '  <button data-act="refresh" class="xsg-btn">刷新</button>',
      '  <button data-act="close"   class="xsg-btn-close">×</button>',
      '</div>',
      '<div style="display:flex;gap:6px;padding:0 8px 6px">',
      '  <input data-search class="xsg-input" placeholder="搜名字 或 输入pid 加好友" maxlength="16" style="flex:1" />',
      '  <button data-act="search" class="xsg-btn-primary">搜</button>',
      '</div>',
      '<div data-results style="padding:0 10px"></div>',
      '<div class="xsg-body" data-body style="min-height:120px"></div>',
    ].join('');
    document.body.appendChild(panel);
    body = panel.querySelector('[data-body]');
    searchInput = panel.querySelector('input[data-search]');
    resultsEl = panel.querySelector('[data-results]');

    panel.querySelector('button[data-act=close]').addEventListener('click', () => Friend.close());
    panel.querySelector('button[data-act=refresh]').addEventListener('click', () => Friend.refresh());
    panel.querySelector('button[data-act=search]').addEventListener('click', () => doSearch());
    searchInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); doSearch(); }
    });
    resultsEl.addEventListener('click', (e) => {
      const a = e.target.closest('button[data-pid]');
      if (!a) return;
      addFriendByPid(Number(a.dataset.pid));
    });
    panel.addEventListener('keydown', (e) => e.stopPropagation());

    body.addEventListener('click', (e) => {
      const a = e.target.closest('button[data-pid]');
      if (!a) return;
      const pid = Number(a.dataset.pid);
      const op = a.dataset.op;
      if (op === 'whisper') {
        if (G.Chat && typeof G.Chat.startWhisper === 'function') {
          G.Chat.startWhisper(pid);
        } else {
          const text = window.prompt('\u79c1\u804a #' + pid + ':', '');
          if (text) Net.request('chat.send', { channel: 'whisper', targetPid: pid, text }).catch(showErr);
        }
      } else if (op === 'remove-friend') {
        Net.request('social.remove', { pid, kind: 'friend' }).then(Friend.refresh).catch(showErr);
      } else if (op === 'unblock') {
        Net.request('social.remove', { pid, kind: 'block' }).then(Friend.refresh).catch(showErr);
      }
    });
  }

  function showErr(err) {
    const msg = (err && err.code ? err.code + ': ' : '') + (err && err.message || '失败');
    if (G.Chat && G.Chat.open) {
      G.Chat.open();
    }
    if (typeof alert === 'function') alert(msg);
  }

  function addFriendByPid(pid) {
    if (!pid || Number.isNaN(pid)) return;
    Net.request('social.add', { pid, kind: 'friend' }).then(() => {
      if (resultsEl) resultsEl.innerHTML = '<div class="xsg-gold" style="padding:4px 0">已发送好友请求 #' + pid + '</div>';
      Friend.refresh();
    }).catch(showErr);
  }

  // 搜名字(远距离/离线也能加) 或 直接输 pid 加好友
  function doSearch() {
    if (!searchInput) return;
    const q = (searchInput.value || '').trim();
    if (!q) return;
    if (/^\d+$/.test(q)) { addFriendByPid(Number(q)); return; }
    resultsEl.innerHTML = '<div class="xsg-muted" style="padding:4px 0">搜索中…</div>';
    Net.request('social.search', { name: q }, 6000).then((data) => {
      const list = (data && data.results) || [];
      if (!list.length) {
        resultsEl.innerHTML = '<div class="xsg-muted" style="padding:4px 0">没找到叫“' + escape(q) + '”的玩家</div>';
        return;
      }
      resultsEl.innerHTML = '<div class="xsg-gold" style="padding:2px 0">搜索结果 (' + list.length + ')</div>' + list.map((e) => {
        const dot = e.online ? '<span style="color:#2c8a2c">●</span>' : '<span style="color:#888">●</span>';
        return '<div style="display:flex;align-items:center;justify-content:space-between;padding:1px 0">'
          + '<span>' + dot + ' ' + escape(e.name) + ' <span class="xsg-muted">#' + e.pid + '</span></span>'
          + '<button data-pid="' + e.pid + '" class="xsg-btn-primary" style="font-size:11px;padding:1px 8px">加好友</button>'
          + '</div>';
      }).join('');
    }).catch(showErr);
  }

  Friend.refresh = function () {
    if (!Core.isOnline()) return;
    return Net.request('social.list', {}).then((data) => {
      Friend.cache = data;
      render();
    }).catch((err) => { Util.log('warn', 'social.list failed', err && err.message); });
  };

  function render() {
    if (!body) return;
    const fs = Friend.cache.friends || [];
    const bs = Friend.cache.blocks || [];
    const renderEntry = (e, kind) => {
      const dot = e.online ? '<span style="color:#2c8a2c">●</span>' : '<span style="color:#888">●</span>';
      const map = e.online && e.mapId != null ? ` <span class="xsg-muted">@map${e.mapId}</span>` : '';
      const buttons = kind === 'friend'
        ? `<button data-pid="${e.pid}" data-op="whisper" class="xsg-btn-primary" style="font-size:11px;padding:1px 6px">私聊</button>
           <button data-pid="${e.pid}" data-op="remove-friend" class="xsg-btn-danger" style="font-size:11px;padding:1px 6px;margin-left:4px">删</button>`
        : `<button data-pid="${e.pid}" data-op="unblock" class="xsg-btn" style="font-size:11px;padding:1px 6px">解除</button>`;
      return `<div style="display:flex;align-items:center;justify-content:space-between;padding:2px 0">
        <span>${dot} ${escape(e.name)} <span class="xsg-muted">#${e.pid}</span>${map}</span>
        <span>${buttons}</span>
      </div>`;
    };
    body.innerHTML =
      '<div class="xsg-gold" style="margin-top:2px">好友 (' + fs.length + ')</div>' +
      (fs.length ? fs.map(e => renderEntry(e, 'friend')).join('') : '<div class="xsg-muted">空</div>') +
      '<div style="font-weight:bold;color:#b5402a;margin-top:8px">黑名单 (' + bs.length + ')</div>' +
      (bs.length ? bs.map(e => renderEntry(e, 'block')).join('') : '<div class="xsg-muted">空</div>');
  }

  function escape(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  Friend.open = function () {
    if (!panel) build();
    panel.style.display = 'flex';
    opened = true;
    Friend.refresh();
  };

  Friend.close = function () {
    if (panel) panel.style.display = 'none';
    opened = false;
  };

  Friend.toggle = function () { opened ? Friend.close() : Friend.open(); };

  document.addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    if (!Core.isOnline()) return;
    if (!(SceneManager._scene instanceof Scene_Map)) return;
    if (e.key && e.key.toUpperCase() === cfg.toggleKey.toUpperCase()) {
      e.preventDefault();
      Friend.toggle();
    }
  });
})();
