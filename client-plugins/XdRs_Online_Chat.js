//=============================================================================
// XdRs_Online_Chat.js
//=============================================================================
/*:
 * @target MZ
 * @plugindesc 联机-聊天 | 三频道聊天面板 + 头顶气泡 + 系统公告
 * @author xsg-online
 *
 * @param toggleKey
 * @text 打开聊天热键
 * @type string
 * @default Enter
 *
 * @param bubbleDurationMs
 * @text 头顶气泡显示时间(ms)
 * @type number
 * @default 4500
 *
 * @help
 * 按 Enter 打开聊天输入。聊天面板可托住拖动。频道：世界/附近/私聊。
 */
(() => {
  'use strict';
  const G = window.XdRsOnline;
  if (!G || !G.Net || !G.Core) {
    console.error('[XSG-Online] Chat: deps missing');
    return;
  }
  const Util = G.Util;
  const Net = G.Net;
  const Core = G.Core;
  const params = PluginManager.parameters('XdRs_Online_Chat');
  const cfg = {
    toggleKey: String(params.toggleKey || 'Enter'),
    bubbleMs: Number(params.bubbleDurationMs || 4500),
  };

  const Chat = (G.Chat = G.Chat || {});
  Chat.history = []; // {channel, fromPid, fromName, text, ts, toPid?}
  Chat.currentChannel = 'nearby';
  Chat.whisperTarget = null;

  // ---------- Panel ----------
  let panel = null;
  let messagesEl = null;
  let inputEl = null;
  let channelSel = null;
  let statusEl = null;
  let opened = false;

  function build() {
    panel = document.createElement('div');
    panel.id = 'xsg-online-chat';
    Object.assign(panel.style, {
      position: 'absolute',
      left: '10px', bottom: '10px',
      width: '380px', height: '210px',
      background: 'rgba(20,20,28,0.82)',
      color: '#eee',
      borderRadius: '6px',
      fontFamily: 'sans-serif', fontSize: '12px',
      display: 'none',
      zIndex: '9000',
      flexDirection: 'column',
      boxShadow: '0 4px 14px rgba(0,0,0,0.6)',
    });

    const header = document.createElement('div');
    Object.assign(header.style, {
      padding: '6px 10px', borderBottom: '1px solid #333',
      display: 'flex', alignItems: 'center', gap: '8px',
    });
    header.innerHTML =
      '<span style="font-weight:bold">聊天</span>' +
      '<select data-sel="ch" style="flex:1;background:#111;color:#eee;border:1px solid #333;padding:2px 4px;border-radius:3px">' +
      '<option value="world">世界</option><option value="nearby" selected>附近</option><option value="whisper">私聊</option>' +
      '</select>' +
      '<button data-act="close" style="background:#444;color:#fff;border:0;border-radius:3px;padding:2px 8px;cursor:pointer">×</button>';
    panel.appendChild(header);

    messagesEl = document.createElement('div');
    Object.assign(messagesEl.style, {
      flex: '1', overflowY: 'auto', padding: '6px 10px', lineHeight: '1.55',
    });
    panel.appendChild(messagesEl);

    const inputRow = document.createElement('div');
    Object.assign(inputRow.style, {
      display: 'flex', gap: '6px', padding: '6px 10px', borderTop: '1px solid #333',
    });
    inputRow.innerHTML =
      '<input data-input style="flex:1;background:#111;color:#fff;border:1px solid #333;padding:4px 8px;border-radius:3px;outline:none" maxlength="200" placeholder="输入消息后回车…" />' +
      '<button data-act="send" style="background:#3a82ff;color:#fff;border:0;border-radius:3px;padding:4px 10px;cursor:pointer">发送</button>';
    panel.appendChild(inputRow);

    statusEl = document.createElement('div');
    Object.assign(statusEl.style, {
      padding: '0 10px 4px', fontSize: '11px', color: '#ffb84d', minHeight: '14px',
    });
    panel.appendChild(statusEl);

    document.body.appendChild(panel);

    channelSel = panel.querySelector('select[data-sel=ch]');
    inputEl = panel.querySelector('input[data-input]');
    channelSel.addEventListener('change', () => { Chat.currentChannel = channelSel.value; });

    panel.querySelector('button[data-act=close]').addEventListener('click', () => Chat.close());
    panel.querySelector('button[data-act=send]').addEventListener('click', () => doSend());

    inputEl.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); doSend(); }
      else if (e.key === 'Escape') { Chat.close(); }
    });
    panel.addEventListener('keydown', (e) => e.stopPropagation());
    panel.addEventListener('keyup', (e) => e.stopPropagation());

    renderHistory();
  }

  function setStatus(s, isErr) {
    if (!statusEl) return;
    statusEl.textContent = s || '';
    statusEl.style.color = isErr ? '#ff7070' : '#ffb84d';
  }

  function doSend() {
    if (!Core.isOnline()) { setStatus('未登录联机服', true); return; }
    const text = inputEl.value.trim();
    if (!text) return;
    const channel = channelSel.value;
    const payload = { channel, text };
    if (channel === 'whisper') {
      if (!Chat.whisperTarget) { setStatus('未选择私聊对象，先点别人名字', true); return; }
      payload.targetPid = Chat.whisperTarget;
    }
    inputEl.disabled = true;
    Net.request('chat.send', payload, 6000)
      .then(() => { inputEl.value = ''; setStatus(''); })
      .catch((err) => { setStatus((err && err.code ? err.code + ': ' : '') + (err && err.message || '发送失败'), true); })
      .finally(() => { inputEl.disabled = false; inputEl.focus(); });
  }

  Chat.open = function () {
    if (!panel) build();
    panel.style.display = 'flex';
    opened = true;
    setTimeout(() => inputEl && inputEl.focus(), 30);
  };

  Chat.close = function () {
    if (panel) panel.style.display = 'none';
    opened = false;
    if (inputEl) inputEl.blur();
  };

  Chat.toggle = function () { opened ? Chat.close() : Chat.open(); };

  Chat.setWhisperTarget = function (pid) {
    Chat.whisperTarget = pid;
    if (channelSel) {
      channelSel.value = 'whisper';
      Chat.currentChannel = 'whisper';
    }
    Chat.open();
  };

  // ---------- History rendering ----------
  function renderHistory() {
    if (!messagesEl) return;
    const html = Chat.history.slice(-100).map(renderMsg).join('');
    messagesEl.innerHTML = html;
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function escape(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function renderMsg(m) {
    const t = new Date(m.ts).toTimeString().slice(0, 5);
    const isSys = m.channel === '__sys__';
    if (isSys) {
      return `<div style="color:#9fd8ff;opacity:.85">[${t}] [系统] ${escape(m.text)}</div>`;
    }
    const ch = m.channel === 'world' ? '世界' : m.channel === 'nearby' ? '附近' : '密';
    const chColor = m.channel === 'world' ? '#a9ffa9' : m.channel === 'nearby' ? '#fff5a0' : '#ffaaff';
    const targetTip = m.toPid ? ` → <a href="#" data-pid="${m.toPid}" style="color:#9fd8ff;text-decoration:none">[#${m.toPid}]</a>` : '';
    return `<div>[${t}] <span style="color:${chColor}">[${ch}]</span> <a href="#" data-pid="${m.fromPid}" style="color:#ffd070;text-decoration:none">${escape(m.fromName)}</a>${targetTip}: ${escape(m.text)}</div>`;
  }

  function pushHistory(m) {
    Chat.history.push(m);
    if (Chat.history.length > 500) Chat.history.splice(0, Chat.history.length - 500);
    renderHistory();
  }

  // ---------- Above-head bubble ----------
  function showBubble(pid, text) {
    if (!G.PlayerSync) return;
    let sprite;
    if (Core.session && Core.session.character && Core.session.character.pid === pid) {
      const ss = SceneManager._scene && SceneManager._scene._spriteset;
      if (!ss || !ss._characterSprites) return;
      for (const s of ss._characterSprites) {
        if (s._character === $gamePlayer) { sprite = s; break; }
      }
    } else {
      sprite = G.PlayerSync.others.get(pid);
    }
    if (!sprite) return;

    const bmp = new Bitmap(220, 28);
    bmp.fontSize = 14;
    bmp.outlineColor = 'rgba(0,0,0,0.85)';
    bmp.outlineWidth = 4;
    bmp.textColor = '#ffffff';
    const trimmed = text.length > 24 ? text.slice(0, 24) + '…' : text;
    bmp.drawText(trimmed, 0, 0, 220, 28, 'center');
    const bubble = new Sprite(bmp);
    bubble.anchor.x = 0.5;
    bubble.anchor.y = 1;
    bubble.y = -64;
    sprite.addChild(bubble);

    setTimeout(() => {
      if (bubble.parent) bubble.parent.removeChild(bubble);
    }, cfg.bubbleMs);
  }

  // ---------- Click on name -> whisper ----------
  function bindClicks() {
    if (!messagesEl) return;
    messagesEl.addEventListener('click', (e) => {
      const a = e.target.closest('a[data-pid]');
      if (!a) return;
      e.preventDefault();
      const pid = Number(a.dataset.pid);
      if (!pid) return;
      Chat.setWhisperTarget(pid);
    });
  }

  // ---------- Hook input handling ----------
  // RMMZ uses keyboard for menu; we want Enter (when no scene-input) to open chat.
  document.addEventListener('keydown', (e) => {
    if (opened) return;
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    if (!Core.isOnline()) return;
    if (!(SceneManager._scene instanceof Scene_Map)) return;
    if (e.key === cfg.toggleKey || (cfg.toggleKey === 'Enter' && e.key === 'Enter')) {
      e.preventDefault();
      Chat.open();
    }
  });

  // Patch Input to ignore Enter while chat opened (avoid OK in maps)
  const _Input_isPressed = Input.isPressed;
  Input.isPressed = function (keyName) {
    if (opened && (keyName === 'ok' || keyName === 'menu')) return false;
    return _Input_isPressed.call(this, keyName);
  };
  const _Input_isTriggered = Input.isTriggered;
  Input.isTriggered = function (keyName) {
    if (opened && (keyName === 'ok' || keyName === 'menu')) return false;
    return _Input_isTriggered.call(this, keyName);
  };

  // ---------- Server -> client events ----------
  Net.on('chat.evt', (msg) => {
    if (!msg) return;
    pushHistory({
      channel: msg.channel,
      fromPid: msg.fromPid,
      fromName: msg.fromName,
      toPid: msg.toPid,
      text: msg.text,
      ts: msg.ts || Date.now(),
    });
    if (msg.channel === 'nearby' || msg.channel === 'world') {
      showBubble(msg.fromPid, msg.text);
    } else if (msg.channel === 'whisper' && Core.session && msg.fromPid !== Core.session.character.pid) {
      showBubble(msg.fromPid, msg.text);
    }
  });

  Net.on('sys.notice', (n) => {
    if (!n) return;
    pushHistory({ channel: '__sys__', text: n.text || '', ts: n.ts || Date.now(), fromName: '系统', fromPid: 0 });
  });

  // ---------- Build on map enter so dom exists when needed ----------
  const _Scene_Map_start = Scene_Map.prototype.start;
  Scene_Map.prototype.start = function () {
    _Scene_Map_start.call(this);
    if (!panel) build();
    bindClicks();
    if (Core.isOnline()) panel.style.display = 'flex';
  };

  const _Scene_Map_terminate = Scene_Map.prototype.terminate;
  Scene_Map.prototype.terminate = function () {
    if (panel) panel.style.display = 'none';
    _Scene_Map_terminate.call(this);
  };
})();
