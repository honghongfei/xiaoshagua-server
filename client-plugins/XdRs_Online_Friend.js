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
  let opened = false;

  function build() {
    panel = document.createElement('div');
    panel.id = 'xsg-online-friend';
    Object.assign(panel.style, {
      position: 'absolute',
      right: '10px', top: '10px',
      width: '260px', maxHeight: '60%',
      background: 'rgba(20,20,28,0.88)', color: '#eee',
      borderRadius: '6px', fontFamily: 'sans-serif', fontSize: '12px',
      display: 'none', flexDirection: 'column',
      zIndex: '9000', boxShadow: '0 4px 14px rgba(0,0,0,0.6)',
    });
    panel.innerHTML = [
      '<div style="padding:6px 10px;border-bottom:1px solid #333;display:flex;align-items:center;gap:6px">',
      '  <span style="font-weight:bold;flex:1">好友 / 黑名单</span>',
      '  <button data-act="refresh" style="background:#333;color:#fff;border:0;border-radius:3px;padding:2px 8px;cursor:pointer">刷新</button>',
      '  <button data-act="add"     style="background:#2c9c4a;color:#fff;border:0;border-radius:3px;padding:2px 8px;cursor:pointer">加</button>',
      '  <button data-act="close"   style="background:#444;color:#fff;border:0;border-radius:3px;padding:2px 8px;cursor:pointer">×</button>',
      '</div>',
      '<div data-body style="overflow-y:auto;padding:6px 10px;line-height:1.65"></div>',
    ].join('');
    document.body.appendChild(panel);
    body = panel.querySelector('[data-body]');

    panel.querySelector('button[data-act=close]').addEventListener('click', () => Friend.close());
    panel.querySelector('button[data-act=refresh]').addEventListener('click', () => Friend.refresh());
    panel.querySelector('button[data-act=add]').addEventListener('click', () => promptAdd());
    panel.addEventListener('keydown', (e) => e.stopPropagation());

    body.addEventListener('click', (e) => {
      const a = e.target.closest('button[data-pid]');
      if (!a) return;
      const pid = Number(a.dataset.pid);
      const op = a.dataset.op;
      if (op === 'whisper') {
        if (G.Chat) G.Chat.setWhisperTarget(pid);
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

  function promptAdd() {
    const raw = window.prompt('输入对方 pid（数字），格式：1234 或 1234,block', '');
    if (!raw) return;
    const parts = raw.split(',').map(s => s.trim());
    const pid = Number(parts[0]);
    const kind = parts[1] === 'block' ? 'block' : 'friend';
    if (!pid || Number.isNaN(pid)) { alert('pid 必须是数字'); return; }
    Net.request('social.add', { pid, kind }).then(Friend.refresh).catch(showErr);
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
      const dot = e.online ? '<span style="color:#5dd55d">●</span>' : '<span style="color:#666">●</span>';
      const map = e.online && e.mapId != null ? ` <span style="color:#888">@map${e.mapId}</span>` : '';
      const buttons = kind === 'friend'
        ? `<button data-pid="${e.pid}" data-op="whisper" style="background:#3a82ff;color:#fff;border:0;border-radius:3px;padding:0 6px;font-size:11px;cursor:pointer">私聊</button>
           <button data-pid="${e.pid}" data-op="remove-friend" style="background:#666;color:#fff;border:0;border-radius:3px;padding:0 6px;font-size:11px;cursor:pointer;margin-left:4px">删</button>`
        : `<button data-pid="${e.pid}" data-op="unblock" style="background:#666;color:#fff;border:0;border-radius:3px;padding:0 6px;font-size:11px;cursor:pointer">解除</button>`;
      return `<div style="display:flex;align-items:center;justify-content:space-between;padding:1px 0">
        <span>${dot} ${escape(e.name)} <span style="color:#888">#${e.pid}</span>${map}</span>
        <span>${buttons}</span>
      </div>`;
    };
    body.innerHTML =
      '<div style="font-weight:bold;color:#ffd070;margin-top:2px">好友 (' + fs.length + ')</div>' +
      (fs.length ? fs.map(e => renderEntry(e, 'friend')).join('') : '<div style="color:#888">空</div>') +
      '<div style="font-weight:bold;color:#ff7070;margin-top:8px">黑名单 (' + bs.length + ')</div>' +
      (bs.length ? bs.map(e => renderEntry(e, 'block')).join('') : '<div style="color:#888">空</div>');
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
