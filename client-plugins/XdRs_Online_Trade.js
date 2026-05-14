//=============================================================================
// XdRs_Online_Trade.js
//=============================================================================
/*:
 * @target MZ
 * @plugindesc 联机-交易 | 两段提交交易 DOM 窗（金币 + 物品）
 * @author xsg-online
 *
 * @help
 * 协议：
 *   1. 邀请 (trade.invite)            → 对方收到 trade.invite.evt
 *   2. 对方 trade.respond accept=true → 双方 trade.opened.evt
 *   3. 任意一方 trade.offer 修改物品/金币 → trade.update.evt 推给两人；锁被重置
 *   4. 双方 trade.lock → 状态变 locked；不能再改物品，只能 confirm/unlock
 *   5. 双方 trade.confirm → 服务端原子转账并 trade.done.evt
 *
 * 在面板里点别人头像 / 在好友列表里点「邀请交易」按钮触发。
 */
(() => {
  'use strict';
  const G = window.XdRsOnline;
  if (!G || !G.Net || !G.Core) {
    console.error('[XSG-Online] Trade: deps missing');
    return;
  }
  const Util = G.Util;
  const Net = G.Net;
  const Core = G.Core;

  const Trade = (G.Trade = G.Trade || {});
  Trade.current = null; // {tradeId, peer, state, a, b, mySide}

  // ---------- UI ----------
  let modal = null;

  function ensureUI() {
    if (modal) return;
    modal = document.createElement('div');
    modal.id = 'xsg-online-trade';
    Object.assign(modal.style, {
      position: 'absolute', left: '0', top: '0', right: '0', bottom: '0',
      background: 'rgba(0,0,0,0.4)',
      display: 'none', alignItems: 'center', justifyContent: 'center',
      zIndex: '9100', fontFamily: 'sans-serif', color: '#eee',
    });
    modal.innerHTML = [
      '<div style="background:#1b1c20;border-radius:10px;width:640px;max-width:95%;display:flex;flex-direction:column;box-shadow:0 8px 24px rgba(0,0,0,0.6)">',
      '  <div style="padding:10px 14px;border-bottom:1px solid #333;display:flex;align-items:center;gap:8px"><span data-title style="flex:1;font-weight:bold">交易</span><button data-act="close" style="background:#444;color:#fff;border:0;border-radius:3px;padding:2px 8px;cursor:pointer">×</button></div>',
      '  <div style="display:flex;gap:0">',
      '    <div data-side="me"   style="flex:1;padding:10px 12px;border-right:1px solid #333"></div>',
      '    <div data-side="peer" style="flex:1;padding:10px 12px;background:#181a1f"></div>',
      '  </div>',
      '  <div style="padding:8px 14px;border-top:1px solid #333;display:flex;gap:8px;align-items:center">',
      '    <div data-status style="flex:1;font-size:12px;color:#ffb84d"></div>',
      '    <button data-act="lock"    style="background:#3a82ff;color:#fff;border:0;border-radius:3px;padding:6px 12px;cursor:pointer">锁定</button>',
      '    <button data-act="confirm" style="background:#2c9c4a;color:#fff;border:0;border-radius:3px;padding:6px 12px;cursor:pointer">确认</button>',
      '    <button data-act="cancel"  style="background:#a05050;color:#fff;border:0;border-radius:3px;padding:6px 12px;cursor:pointer">取消</button>',
      '  </div>',
      '</div>',
    ].join('');
    document.body.appendChild(modal);

    modal.addEventListener('keydown', (e) => e.stopPropagation());
    modal.querySelector('button[data-act=close]').addEventListener('click', () => endLocal('user_close'));
    modal.querySelector('button[data-act=cancel]').addEventListener('click', () => {
      if (Trade.current) Net.request('trade.cancel', { tradeId: Trade.current.tradeId }).catch(handleErr);
    });
    modal.querySelector('button[data-act=lock]').addEventListener('click', () => {
      if (!Trade.current) return;
      const op = Trade.current.mySide.locked ? 'trade.unlock' : 'trade.lock';
      Net.request(op, { tradeId: Trade.current.tradeId }).catch(handleErr);
    });
    modal.querySelector('button[data-act=confirm]').addEventListener('click', () => {
      if (Trade.current) Net.request('trade.confirm', { tradeId: Trade.current.tradeId }).catch(handleErr);
    });
  }

  function handleErr(err) {
    const msg = (err && err.code ? err.code + ': ' : '') + (err && err.message || '失败');
    setStatus(msg, true);
  }

  function setStatus(s, isErr) {
    if (!modal) return;
    const el = modal.querySelector('[data-status]');
    el.textContent = s || '';
    el.style.color = isErr ? '#ff7070' : '#ffb84d';
  }

  // ---------- Render ----------
  function render() {
    if (!Trade.current || !modal) return;
    const t = Trade.current;
    modal.querySelector('[data-title]').textContent =
      '交易 与 ' + (t.peer ? t.peer.name : '?') + '  [' + t.state + ']';

    const me = t.mySide;
    const peer = t.peerSide;

    const meHtml = renderSide(me, true);
    const peerHtml = renderSide(peer, false);
    modal.querySelector('div[data-side=me]').innerHTML = meHtml;
    modal.querySelector('div[data-side=peer]').innerHTML = peerHtml;

    const lockBtn = modal.querySelector('button[data-act=lock]');
    lockBtn.textContent = me && me.locked ? '解锁' : '锁定';
    const confirmBtn = modal.querySelector('button[data-act=confirm]');
    confirmBtn.disabled = !(t.state === 'locked');
    confirmBtn.style.opacity = confirmBtn.disabled ? '0.5' : '1';
    confirmBtn.style.cursor = confirmBtn.disabled ? 'default' : 'pointer';
    if (me && me.confirmed && peer && peer.confirmed) setStatus('双方确认，正在提交…');
    else if (me && me.locked && peer && peer.locked) setStatus('双方已锁定，可点确认');
    else if (me && me.locked) setStatus('已锁定，等对方');

    bindEditing();
  }

  function renderSide(side, isMe) {
    const head = (isMe ? '我' : '对方') + (side.locked ? ' 🔒' : '') + (side.confirmed ? ' ✓' : '');
    const goldEditor = isMe
      ? `金币：<input data-goldedit type="number" min="0" value="${side.gold | 0}" style="width:90px;background:#111;color:#fff;border:1px solid #333;padding:2px 4px;border-radius:3px"/>`
      : `金币：<b>${side.gold | 0}</b>`;
    const itemRows = (side.items || []).map((it) => {
      const name = displayItem(it);
      const rm = isMe ? `<button data-rmitem data-kind="${it.kind}" data-id="${it.dataId}" style="background:#a05050;color:#fff;border:0;border-radius:3px;padding:0 6px;font-size:11px;margin-left:6px;cursor:pointer">移</button>` : '';
      return `<div style="padding:1px 0">${escape(name)} ×${it.count}${rm}</div>`;
    }).join('') || '<div style="color:#888">（无物品）</div>';
    const addBtn = isMe ? `<button data-act="additem" style="background:#3a82ff;color:#fff;border:0;border-radius:3px;padding:2px 8px;font-size:11px;cursor:pointer;margin-top:4px">+ 物品</button>` : '';
    return `
      <div style="font-weight:bold;margin-bottom:6px">${head}</div>
      <div style="margin-bottom:6px">${goldEditor}</div>
      <div style="margin-bottom:6px">物品：</div>
      ${itemRows}
      ${addBtn}
    `;
  }

  function displayItem(it) {
    if (typeof $dataItems !== 'undefined') {
      const arr = it.kind === 'item' ? $dataItems : it.kind === 'weapon' ? $dataWeapons : $dataArmors;
      const data = arr && arr[it.dataId];
      if (data && data.name) return data.name + ' (' + it.kind + '#' + it.dataId + ')';
    }
    return it.kind + '#' + it.dataId;
  }

  function bindEditing() {
    const me = modal.querySelector('div[data-side=me]');
    const goldInp = me.querySelector('input[data-goldedit]');
    if (goldInp) {
      goldInp.addEventListener('change', () => sendOffer({ gold: Number(goldInp.value) | 0 }));
    }
    const addBtn = me.querySelector('button[data-act=additem]');
    if (addBtn) addBtn.addEventListener('click', promptAddItem);
    me.querySelectorAll('button[data-rmitem]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const kind = btn.dataset.kind;
        const id = Number(btn.dataset.id);
        const items = Trade.current.mySide.items.filter((it) => !(it.kind === kind && it.dataId === id));
        sendOffer({ items });
      });
    });
  }

  function promptAddItem() {
    const raw = window.prompt('物品格式：kind#id×count （kind=item/weapon/armor）。例：item#5×3', 'item#1×1');
    if (!raw) return;
    const m = raw.match(/^(item|weapon|armor)#(\d+)[x×*](\d+)$/i);
    if (!m) { setStatus('格式不对', true); return; }
    const it = { kind: m[1].toLowerCase(), dataId: Number(m[2]), count: Number(m[3]) };
    const items = (Trade.current.mySide.items || []).slice();
    const exist = items.find((x) => x.kind === it.kind && x.dataId === it.dataId);
    if (exist) exist.count = it.count;
    else items.push(it);
    sendOffer({ items });
  }

  function sendOffer(patch) {
    if (!Trade.current) return;
    const cur = Trade.current.mySide;
    const gold = patch.gold != null ? patch.gold : cur.gold;
    const items = patch.items != null ? patch.items : cur.items;
    Net.request('trade.offer', { tradeId: Trade.current.tradeId, gold, items }).catch(handleErr);
  }

  // ---------- API ----------
  Trade.inviteTo = function (targetPid) {
    Net.request('trade.invite', { targetPid }).then((res) => {
      setStatus('已发送邀请，等待对方接受…');
      // We'll fully open via trade.opened.evt
      Trade.current = { tradeId: res.tradeId, peer: { pid: targetPid }, state: 'invited', mySide: emptySide(), peerSide: emptySide() };
      ensureUI();
      modal.style.display = 'flex';
      render();
    }).catch(handleErr);
  };

  function emptySide() { return { gold: 0, items: [], locked: false, confirmed: false }; }

  function endLocal(reason) {
    Trade.current = null;
    if (modal) modal.style.display = 'none';
    Util.log('info', 'trade ended:', reason);
  }

  // ---------- Server events ----------
  Net.on('trade.invite.evt', (e) => {
    if (!e) return;
    const ok = window.confirm((e.fromName || '#' + e.fromPid) + ' 想跟你交易，接受？');
    Net.request('trade.respond', { tradeId: e.tradeId, accept: ok }).catch(handleErr);
  });

  Net.on('trade.opened.evt', (e) => {
    if (!e) return;
    ensureUI();
    Trade.current = {
      tradeId: e.tradeId,
      peer: e.peer || null,
      state: 'open',
      mySide: emptySide(),
      peerSide: emptySide(),
    };
    modal.style.display = 'flex';
    setStatus('');
    render();
  });

  Net.on('trade.update.evt', (e) => {
    if (!e || !Trade.current || Trade.current.tradeId !== e.tradeId) return;
    const myPid = Core.session && Core.session.character && Core.session.character.pid;
    const me = e.a && e.a.pid === myPid ? e.a : e.b;
    const peer = e.a && e.a.pid === myPid ? e.b : e.a;
    Trade.current.state = e.state;
    Trade.current.mySide = me || emptySide();
    Trade.current.peerSide = peer || emptySide();
    render();
  });

  Net.on('trade.done.evt', (e) => {
    if (!e) return;
    if (Trade.current && Trade.current.tradeId === e.tradeId) {
      const text = e.ok ? '交易成功' : ('交易结束: ' + (e.reason || ''));
      setStatus(text);
      setTimeout(() => endLocal(e.reason || 'done'), 1200);
    }
  });
})();
