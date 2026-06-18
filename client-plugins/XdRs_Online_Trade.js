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
  // 非阻塞交易邀请提示(替代 window.confirm 阻塞弹窗)
  let inviteEl = null;
  let inviteTicker = null;
  let inviteDeadline = 0;
  let pendingInviteId = null;

  function ensureUI() {
    if (modal) return;
    modal = document.createElement('div');
    modal.id = 'xsg-online-trade';
    modal.className = 'xsg-overlay';
    Object.assign(modal.style, {
      display: 'none', zIndex: '9100',
    });
    modal.innerHTML = [
      '<div class="xsg-win" style="width:640px;max-width:95%">',
      '  <div class="xsg-titlebar"><span data-title class="xsg-title">交易</span><button data-act="close" class="xsg-btn-close">×</button></div>',
      '  <div class="xsg-body" style="display:flex;gap:0;padding:0">',
      '    <div data-side="me"   style="flex:1;padding:10px 12px;border-right:2px solid var(--xsg-panel-edge)"></div>',
      '    <div data-side="peer" style="flex:1;padding:10px 12px"></div>',
      '  </div>',
      '  <div class="xsg-statusbar" style="display:flex;gap:8px;align-items:center">',
      '    <div data-status class="xsg-status" style="flex:1;font-size:12px"></div>',
      '    <button data-act="lock"    class="xsg-btn">锁定</button>',
      '    <button data-act="confirm" class="xsg-btn-primary">确认</button>',
      '    <button data-act="cancel"  class="xsg-btn-danger">取消</button>',
      '  </div>',
      '</div>',
    ].join('');
    document.body.appendChild(modal);

    // 防止 modal 上的指针事件冒泡到 document 触发 RMMZ TouchInput 的"地图点击-寻路"。
    // RMMZ 的 TouchInput._setupEventHandlers 直接在 document 上挂 mousedown / mouseup /
    // touchstart / touchend, 所以 DOM 弹窗必须把 pointer 事件链整个截断, 否则玩家点
    // "锁定 / 确认 / 取消" 按钮时角色会向那个屏幕坐标走过去.
    [
      'mousedown', 'mouseup', 'click',
      'pointerdown', 'pointerup',
      'touchstart', 'touchend',
      'wheel', 'contextmenu',
    ].forEach((evt) => {
      modal.addEventListener(evt, (e) => { e.stopPropagation(); }, evt === 'touchstart' || evt === 'touchend' || evt === 'wheel' ? { passive: false } : undefined);
    });

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

    // 事件委托: "我方"面板内的金币输入 / 加物品 / 移除物品按钮都是 render() 用 innerHTML
    // 重建的子节点. 把监听绑在持久容器上一次, 不随每次 render 重复 addEventListener.
    const meSide = modal.querySelector('div[data-side=me]');
    if (meSide) {
      meSide.addEventListener('change', (e) => {
        const t = e.target;
        if (t && t.matches && t.matches('input[data-goldedit]')) {
          sendOffer({ gold: Number(t.value) | 0 });
        }
      });
      meSide.addEventListener('click', (e) => {
        const t = e.target;
        if (!t || !t.closest) return;
        if (t.closest('button[data-act=additem]')) {
          promptAddItem();
          return;
        }
        const rm = t.closest('button[data-rmitem]');
        if (rm && Trade.current) {
          const kind = rm.dataset.kind;
          const id = Number(rm.dataset.id);
          const items = Trade.current.mySide.items.filter((it) => !(it.kind === kind && it.dataId === id));
          sendOffer({ items });
        }
      });
    }
  }

  function handleErr(err) {
    const msg = (err && err.code ? err.code + ': ' : '') + (err && err.message || '失败');
    setStatus(msg, true);
  }

  function setStatus(s, isErr) {
    if (!modal) return;
    const el = modal.querySelector('[data-status]');
    el.textContent = s || '';
    el.style.color = isErr ? '#ff7070' : '#fff2c2';
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
    // 编辑事件已在 ensureUI() 用委托绑定, render 不再重复 addEventListener
  }

  function renderSide(side, isMe) {
    const head = (isMe ? '我' : '对方') + (side.locked ? ' 🔒' : '') + (side.confirmed ? ' ✓' : '');
    const goldEditor = isMe
      ? `金币：<input data-goldedit class="xsg-input" type="number" min="0" value="${side.gold | 0}" style="width:90px"/>`
      : `金币：<b class="xsg-gold">${side.gold | 0}</b>`;
    const itemRows = (side.items || []).map((it) => {
      const name = displayItem(it);
      const rm = isMe ? `<button data-rmitem data-kind="${it.kind}" data-id="${it.dataId}" class="xsg-btn-danger" style="font-size:11px;padding:0 6px;margin-left:6px">移</button>` : '';
      return `<div style="padding:1px 0">${escape(name)} ×${it.count}${rm}</div>`;
    }).join('') || '<div class="xsg-muted">（无物品）</div>';
    const addBtn = isMe ? `<button data-act="additem" class="xsg-btn-primary" style="font-size:11px;padding:2px 8px;margin-top:4px">+ 物品</button>` : '';
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

  // 三步闭环 - 交易加物品 UI
  //   发起端: 玩家在 picker 里选物 + 数量 -> sendOffer({items})
  //   服端:    trade.offer 已有 schema 验证 + 数量上限
  //   表现端:  trade.update.evt 回调里重新 render()
  // 兜底: 数量<=0 / 数量>持有量 都 clamp; 角色无该物时不允许选; 重叠物品自动合并
  let pickerRoot = null;

  function listOwnedItems() {
    if (typeof $gameParty === 'undefined' || !$gameParty) return [];
    const out = [];
    const push = (kind, arr, bucket) => {
      if (!Array.isArray(arr) || !bucket) return;
      for (let i = 1; i < arr.length; i++) {
        const data = arr[i];
        if (!data || !data.name) continue;
        const have = bucket[i] | 0;
        if (have > 0) out.push({ kind, dataId: i, name: data.name, iconIndex: data.iconIndex || 0, have });
      }
    };
    push('item',   $dataItems,   $gameParty._items);
    push('weapon', $dataWeapons, $gameParty._weapons);
    push('armor',  $dataArmors,  $gameParty._armors);
    return out;
  }

  function ensurePickerUI() {
    if (pickerRoot) return pickerRoot;
    pickerRoot = document.createElement('div');
    pickerRoot.id = 'xsg-online-trade-picker';
    pickerRoot.className = 'xsg-overlay';
    Object.assign(pickerRoot.style, {
      display: 'none', zIndex: '9200',
    });
    pickerRoot.innerHTML = [
      '<div class="xsg-win" style="width:520px;max-width:95%;max-height:80%">',
      '  <div class="xsg-titlebar">',
      '    <span class="xsg-title">选择物品加入交易</span>',
      '    <button data-act="close-picker" class="xsg-btn-close">×</button>',
      '  </div>',
      '  <div data-picker-list class="xsg-body"></div>',
      '</div>',
    ].join('');
    document.body.appendChild(pickerRoot);
    // 同样防止指针事件穿透到 RMMZ canvas 触发寻路.
    [
      'mousedown', 'mouseup', 'click',
      'pointerdown', 'pointerup',
      'touchstart', 'touchend',
      'wheel', 'contextmenu',
    ].forEach((evt) => {
      pickerRoot.addEventListener(evt, (e) => { e.stopPropagation(); }, evt === 'touchstart' || evt === 'touchend' || evt === 'wheel' ? { passive: false } : undefined);
    });
    pickerRoot.addEventListener('keydown', (e) => e.stopPropagation());
    pickerRoot.querySelector('button[data-act=close-picker]').addEventListener('click', () => {
      pickerRoot.style.display = 'none';
    });
    pickerRoot.addEventListener('click', (e) => {
      if (e.target === pickerRoot) pickerRoot.style.display = 'none';
    });
    return pickerRoot;
  }

  function promptAddItem() {
    if (!Trade.current) return;
    ensurePickerUI();
    const list = listOwnedItems();
    const listEl = pickerRoot.querySelector('[data-picker-list]');
    if (list.length === 0) {
      listEl.innerHTML = '<div class="xsg-muted">背包是空的，没有可交易的物品。</div>';
    } else {
      const offered = Trade.current.mySide.items || [];
      const offeredMap = new Map(offered.map((it) => [it.kind + '#' + it.dataId, it.count | 0]));
      listEl.innerHTML = list.map((it) => {
        const key = it.kind + '#' + it.dataId;
        const inOffer = offeredMap.get(key) || 0;
        return [
          '<div class="xsg-row" data-row="' + key + '">',
          '  <span style="flex:1">' + escape(it.name) + ' <span class="xsg-muted" style="font-size:11px">(' + it.kind + '#' + it.dataId + ')</span></span>',
          '  <span style="color:#2a5b8a;min-width:60px;text-align:right">持有:' + it.have + '</span>',
          '  <span class="xsg-gold" style="min-width:64px;text-align:right">已上桌:' + inOffer + '</span>',
          '  <input data-amt class="xsg-input" type="number" min="0" max="' + it.have + '" value="' + inOffer + '" style="width:64px"/>',
          '  <button data-act="set" class="xsg-btn-primary" style="padding:2px 10px">放入</button>',
          '</div>',
        ].join('');
      }).join('');

      listEl.querySelectorAll('div[data-row]').forEach((row) => {
        const key = row.dataset.row;
        const [kind, idStr] = key.split('#');
        const dataId = Number(idStr);
        // 防御: list 里可能并不包含某个 row (理论上不会, 但万一 picker 渲染期间
        // 玩家 _items 又被 reconcile 改了); 直接读 .have 会在条目缺失时炸成
        // "Cannot read property 'have' of undefined".
        const owned = list.find((x) => x.kind === kind && x.dataId === dataId);
        const have = owned ? owned.have : 0;
        row.querySelector('button[data-act=set]').addEventListener('click', () => {
          const inp = row.querySelector('input[data-amt]');
          let amount = inp ? Number(inp.value) | 0 : 0;
          if (amount < 0) amount = 0;
          if (amount > have) amount = have;
          const items = (Trade.current.mySide.items || []).slice().filter((it) => !(it.kind === kind && it.dataId === dataId));
          if (amount > 0) items.push({ kind, dataId, count: amount });
          sendOffer({ items });
        });
      });
    }
    pickerRoot.style.display = 'flex';
  }

  function escape(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
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

  // ---------- 非阻塞邀请提示 ----------
  function ensureInviteUI() {
    if (inviteEl) return inviteEl;
    const el = document.createElement('div');
    el.id = 'xsg-online-trade-invite';
    el.className = 'xsg-toast';
    Object.assign(el.style, {
      position: 'absolute', right: '14px', bottom: '14px',
      minWidth: '260px', zIndex: '9300', fontSize: '13px', display: 'none',
    });
    el.innerHTML = [
      '<div data-msg style="margin-bottom:8px"></div>',
      '<div style="display:flex;gap:8px;justify-content:flex-end">',
      '  <button data-act="accept" class="xsg-btn-primary" style="padding:4px 14px">接受</button>',
      '  <button data-act="decline" class="xsg-btn-danger" style="padding:4px 14px">拒绝</button>',
      '</div>',
    ].join('');
    ['mousedown', 'mouseup', 'click', 'pointerdown', 'pointerup', 'touchstart', 'touchend'].forEach((evt) => {
      el.addEventListener(evt, (e) => { e.stopPropagation(); }, evt === 'touchstart' || evt === 'touchend' ? { passive: false } : undefined);
    });
    el.querySelector('button[data-act=accept]').addEventListener('click', () => respondInvite(true));
    el.querySelector('button[data-act=decline]').addEventListener('click', () => respondInvite(false));
    document.body.appendChild(el);
    inviteEl = el;
    return el;
  }

  function closeInvite() {
    if (inviteTicker) { clearInterval(inviteTicker); inviteTicker = null; }
    if (inviteEl) inviteEl.style.display = 'none';
    pendingInviteId = null;
  }

  function respondInvite(accept) {
    const tradeId = pendingInviteId;
    closeInvite();
    if (!tradeId) return;
    Net.request('trade.respond', { tradeId, accept }).catch(handleErr);
  }

  function showInvite(e) {
    ensureInviteUI();
    pendingInviteId = e.tradeId;
    const who = e.fromName || ('#' + e.fromPid);
    const ttl = Math.max(5000, Number(e.ttlMs) || 30000);
    inviteDeadline = Date.now() + ttl;
    const msgEl = inviteEl.querySelector('[data-msg]');
    const tick = () => {
      const left = Math.max(0, Math.ceil((inviteDeadline - Date.now()) / 1000));
      msgEl.innerHTML = '<b>' + escape(who) + '</b> 想跟你交易 <span style="color:#b5481c;font-weight:bold">(' + left + 's)</span>';
      if (left <= 0) respondInvite(false);
    };
    tick();
    if (inviteTicker) clearInterval(inviteTicker);
    inviteTicker = setInterval(tick, 500);
    inviteEl.style.display = 'block';
  }

  // ---------- Server events ----------
  Net.on('trade.invite.evt', (e) => {
    if (!e) return;
    showInvite(e);
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
    // 邀请阶段就被取消(对方撤回/超时): 关掉待应答的非阻塞提示
    if (e.tradeId && pendingInviteId === e.tradeId) closeInvite();
    if (Trade.current && Trade.current.tradeId === e.tradeId) {
      const text = e.ok ? '交易成功' : ('交易结束: ' + (e.reason || ''));
      setStatus(text);
      // 交易成功后立即拉一次 inventory.snapshot 同步本地 (服端原子转账已完成).
      // 用 fullReplace=true: 服端 inventory 表对清零物品会 DELETE 掉那行, snapshot
      // 不会包含该 dataId. 默认 reconcile 是"按 snap 写入", 不会清掉本地多余 key,
      // 这会导致玩家把某物品全部交易出去后, 本地 _items[id] 仍残留旧 count, 下次开
      // 交易看到鬼物品 → 提交时服务端找不到行 → NOT_ENOUGH_ITEM.
      if (e.ok && G.Inv && typeof G.Inv.reconcileLocal === 'function') {
        Net.request('inventory.snapshot', {}, 4000)
          .then((snap) => G.Inv.reconcileLocal(snap, { fullReplace: true }))
          .catch(() => {});
      }
      // 关掉物品挑选浮层 (如果还开着), 防止用户在交易已结束后还误以为可以继续操作
      if (pickerRoot) pickerRoot.style.display = 'none';
      setTimeout(() => endLocal(e.reason || 'done'), 1200);
    }
  });
})();
