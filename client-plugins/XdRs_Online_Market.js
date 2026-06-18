//=============================================================================
// XdRs_Online_Market.js
//=============================================================================
/*:
 * @target MZ
 * @plugindesc 联机-寄售行 | 异步挂单市场（单价制 + 拆分购买 + 开格 + 离线成交通知）
 * @author xsg-online
 *
 * @help
 * 全服寄售行：把背包里的道具/武器/防具按「物品 ×N + 单价」挂单，其他玩家可按数量
 * 拆分购买。卖家承担 20% 手续费（金币销毁），开格扩容也烧金币。
 *
 * 协议（与服务端 router market.* 对应）：
 *   market.browse  浏览全服在售挂单（含卖家名）
 *   market.mine    我的格位 / 金币 / 在售挂单
 *   market.create  上架（上架即从背包托管扣物）
 *   market.cancel  下架（退回剩余托管物）
 *   market.buy     购买（{listingId, qty} 拆分购买）
 *   market.unlockSlot 开下一格（扣费销毁）
 *   服务端推送 market.notify.evt：成交回执（在线即时 / 离线登录补发）。
 *
 * 入口：联机中心宫格「寄售行」。依赖 Util/Net/Core/Inventory，需在 Hub 之前加载。
 */
(() => {
  'use strict';
  const G = window.XdRsOnline;
  if (!G || !G.Net || !G.Core) {
    console.error('[XSG-Online] Market: deps missing');
    return;
  }
  const Util = G.Util;
  const Net = G.Net;
  const Core = G.Core;

  const Market = (G.Market = G.Market || {});
  const Z_MODAL = 9150;
  const Z_TOAST = 9350;

  let modal = null;
  let bodyEl = null;
  let statusEl = null;
  let tab = 'browse';
  const browseState = { kind: '', q: '' };

  // ---------- 工具 ----------
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function fmtGold(n) {
    return Number(n || 0).toLocaleString();
  }
  function kindLabel(k) {
    return k === 'item' ? '道具' : k === 'weapon' ? '武器' : k === 'armor' ? '防具' : k;
  }
  function itemData(kind, id) {
    if (typeof $dataItems === 'undefined') return null;
    const arr = kind === 'item' ? $dataItems : kind === 'weapon' ? $dataWeapons : $dataArmors;
    return arr ? arr[id] : null;
  }
  function displayName(kind, id) {
    const d = itemData(kind, id);
    return d && d.name ? d.name : kind + '#' + id;
  }
  function stopBubble(el) {
    ['mousedown', 'mouseup', 'click', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'wheel', 'contextmenu'].forEach((evt) => {
      el.addEventListener(evt, (e) => { e.stopPropagation(); }, evt === 'touchstart' || evt === 'touchend' || evt === 'wheel' ? { passive: false } : undefined);
    });
    el.addEventListener('keydown', (e) => e.stopPropagation());
  }
  function handleErr(err) {
    setStatus((err && err.code ? err.code + ': ' : '') + (err && err.message || '操作失败'), true);
  }
  function setStatus(s, isErr) {
    if (!statusEl) return;
    statusEl.textContent = s || '';
    statusEl.style.color = isErr ? '#ff7070' : '#ffb84d';
  }
  function reconcileInv() {
    if (G.Inv && typeof G.Inv.reconcileLocal === 'function') {
      Net.request('inventory.snapshot', {}, 4000)
        .then((snap) => G.Inv.reconcileLocal(snap, { fullReplace: true }))
        .catch(() => {});
    }
  }
  function myPid() {
    return Core.session && Core.session.character ? Core.session.character.pid : null;
  }

  // ---------- UI 骨架 ----------
  function ensureUI() {
    if (modal) return;
    modal = document.createElement('div');
    modal.id = 'xsg-online-market';
    Object.assign(modal.style, {
      position: 'absolute', left: '0', top: '0', right: '0', bottom: '0',
      background: 'rgba(0,0,0,0.45)', display: 'none', alignItems: 'center', justifyContent: 'center',
      zIndex: String(Z_MODAL), fontFamily: 'sans-serif', color: '#eee',
    });
    modal.innerHTML = [
      '<div style="background:#1b1c20;border-radius:10px;width:720px;max-width:96%;max-height:88%;display:flex;flex-direction:column;box-shadow:0 8px 24px rgba(0,0,0,0.6)">',
      '  <div style="padding:10px 14px;border-bottom:1px solid #333;display:flex;align-items:center;gap:8px">',
      '    <span style="flex:1;font-weight:bold;letter-spacing:1px">寄售行</span>',
      '    <button data-tab="browse" style="background:#3a82ff;color:#fff;border:0;border-radius:4px;padding:4px 12px;cursor:pointer">浏览</button>',
      '    <button data-tab="mine"   style="background:#333;color:#fff;border:0;border-radius:4px;padding:4px 12px;cursor:pointer">我的寄售</button>',
      '    <button data-tab="sell"   style="background:#333;color:#fff;border:0;border-radius:4px;padding:4px 12px;cursor:pointer">上架</button>',
      '    <button data-act="close"  style="background:#444;color:#fff;border:0;border-radius:3px;padding:2px 8px;cursor:pointer">×</button>',
      '  </div>',
      '  <div data-body style="flex:1;overflow-y:auto;padding:10px 14px;line-height:1.6;min-height:220px"></div>',
      '  <div style="padding:6px 14px;border-top:1px solid #333"><span data-status style="font-size:12px;color:#ffb84d"></span></div>',
      '</div>',
    ].join('');
    document.body.appendChild(modal);
    bodyEl = modal.querySelector('[data-body]');
    statusEl = modal.querySelector('[data-status]');
    stopBubble(modal);
    modal.querySelector('button[data-act=close]').addEventListener('click', close);
    modal.querySelectorAll('button[data-tab]').forEach((b) => {
      b.addEventListener('click', () => switchTab(b.dataset.tab));
    });
    // 事件委托：body 内所有按钮 / 输入都在这里统一处理（每次 render 用 innerHTML 重建）。
    bodyEl.addEventListener('click', onBodyClick);
    bodyEl.addEventListener('input', onBodyInput);
    bodyEl.addEventListener('change', onBodyChange);
  }

  function updateTabBar() {
    if (!modal) return;
    modal.querySelectorAll('button[data-tab]').forEach((b) => {
      b.style.background = b.dataset.tab === tab ? '#3a82ff' : '#333';
    });
  }

  function open() {
    if (!Core.isOnline()) return;
    ensureUI();
    modal.style.display = 'flex';
    switchTab(tab || 'browse');
  }
  function close() {
    if (modal) modal.style.display = 'none';
  }
  Market.open = open;
  Market.close = close;

  function switchTab(t) {
    tab = t;
    updateTabBar();
    setStatus('');
    if (t === 'browse') renderBrowse();
    else if (t === 'mine') renderMine();
    else renderSell();
  }

  // ---------- 浏览 ----------
  function renderBrowse() {
    bodyEl.innerHTML = '<div style="color:#888">加载中…</div>';
    Net.request('market.browse', { kind: browseState.kind || undefined, q: browseState.q || undefined, limit: 50 }, 6000)
      .then((data) => paintBrowse(data || { listings: [], total: 0 }))
      .catch((err) => { bodyEl.innerHTML = '<div style="color:#ff7070">加载失败: ' + escapeHtml(err && err.message || '?') + '</div>'; });
  }

  function paintBrowse(data) {
    const filterBar = [
      '<div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">',
      '  <select data-filter-kind style="background:#111;color:#fff;border:1px solid #333;border-radius:3px;padding:3px 6px">',
      '    <option value=""', browseState.kind === '' ? ' selected' : '', '>全部</option>',
      '    <option value="item"', browseState.kind === 'item' ? ' selected' : '', '>道具</option>',
      '    <option value="weapon"', browseState.kind === 'weapon' ? ' selected' : '', '>武器</option>',
      '    <option value="armor"', browseState.kind === 'armor' ? ' selected' : '', '>防具</option>',
      '  </select>',
      '  <input data-filter-q placeholder="按卖家名搜索" value="', escapeHtml(browseState.q), '" style="flex:1;background:#111;color:#fff;border:1px solid #333;border-radius:3px;padding:3px 6px"/>',
      '  <button data-act="browse-refresh" style="background:#3a82ff;color:#fff;border:0;border-radius:3px;padding:3px 12px;cursor:pointer">刷新</button>',
      '</div>',
    ].join('');
    const list = (data.listings || []);
    let rows;
    if (list.length === 0) {
      rows = '<div style="color:#888;padding:8px 0">暂无在售挂单。</div>';
    } else {
      rows = list.map((l) => {
        const total = l.unitPrice * l.count;
        const buyCtl = l.mine
          ? '<span style="color:#888;font-size:12px">（我的）</span>'
          : [
              '<input data-buy-qty type="number" min="1" max="' + l.count + '" value="1" style="width:58px;background:#111;color:#fff;border:1px solid #333;border-radius:3px;padding:2px 4px"/>',
              '<button data-act="buy" data-id="' + l.id + '" data-max="' + l.count + '" style="background:#2c9c4a;color:#fff;border:0;border-radius:3px;padding:3px 12px;cursor:pointer">购买</button>',
            ].join('');
        return [
          '<div data-listing="' + l.id + '" style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid #2c2d33">',
          '  <span style="flex:1">' + escapeHtml(displayName(l.kind, l.dataId)) + ' <span style="color:#888;font-size:11px">' + kindLabel(l.kind) + ' ×' + l.count + '</span></span>',
          '  <span style="color:#9fd8ff;min-width:120px">卖家 ' + escapeHtml(l.sellerName || ('#' + l.sellerId)) + '</span>',
          '  <span style="color:#ffd070;min-width:130px;text-align:right">单价 ' + fmtGold(l.unitPrice) + ' / 共 ' + fmtGold(total) + '</span>',
          '  <span style="display:flex;gap:4px;align-items:center">' + buyCtl + '</span>',
          '</div>',
        ].join('');
      }).join('');
      if (data.total > list.length) {
        rows += '<div style="color:#888;padding:6px 0">仅显示前 ' + list.length + ' / ' + data.total + ' 条，请用筛选缩小范围。</div>';
      }
    }
    bodyEl.innerHTML = filterBar + rows;
  }

  // ---------- 我的寄售 ----------
  function renderMine() {
    bodyEl.innerHTML = '<div style="color:#888">加载中…</div>';
    Net.request('market.mine', {}, 6000)
      .then((data) => paintMine(data))
      .catch((err) => { bodyEl.innerHTML = '<div style="color:#ff7070">加载失败: ' + escapeHtml(err && err.message || '?') + '</div>'; });
  }

  function paintMine(d) {
    const slotLine = '已开格 ' + d.usedSlots + ' / ' + d.slots + '（上限 ' + d.maxSlots + '）';
    const unlockBtn = (d.nextSlotPrice != null)
      ? '<button data-act="unlock" style="background:#a0790f;color:#fff;border:0;border-radius:3px;padding:3px 12px;cursor:pointer">开下一格（' + fmtGold(d.nextSlotPrice) + ' 金币）</button>'
      : '<span style="color:#888">已达最大格位</span>';
    const head = [
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid #2c2d33">',
      '  <span style="flex:1">' + slotLine + '　金币 <b style="color:#ffd070">' + fmtGold(d.gold) + '</b></span>',
      '  ' + unlockBtn,
      '</div>',
    ].join('');
    const list = d.listings || [];
    let rows;
    if (list.length === 0) {
      rows = '<div style="color:#888;padding:6px 0">没有在售挂单。去「上架」挂点东西吧。</div>';
    } else {
      rows = list.map((l) => [
        '<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid #2c2d33">',
        '  <span style="flex:1">' + escapeHtml(displayName(l.kind, l.dataId)) + ' <span style="color:#888;font-size:11px">' + kindLabel(l.kind) + ' 剩 ' + l.count + ' / ' + l.origCount + '</span></span>',
        '  <span style="color:#ffd070;min-width:150px;text-align:right">单价 ' + fmtGold(l.unitPrice) + ' / 共 ' + fmtGold(l.unitPrice * l.count) + '</span>',
        '  <button data-act="cancel" data-id="' + l.id + '" style="background:#a05050;color:#fff;border:0;border-radius:3px;padding:3px 12px;cursor:pointer">下架</button>',
        '</div>',
      ].join('')).join('');
    }
    bodyEl.innerHTML = head + rows;
  }

  // ---------- 上架 ----------
  function listSellable() {
    if (typeof $gameParty === 'undefined' || !$gameParty) return [];
    const out = [];
    const pushArr = (kind, dataArr, bucket) => {
      if (!Array.isArray(dataArr) || !bucket) return;
      for (let i = 1; i < dataArr.length; i++) {
        const d = dataArr[i];
        if (!d || !d.name) continue;
        const have = bucket[i] | 0;
        if (have <= 0) continue;
        if (kind === 'item' && d.itypeId === 2) continue; // 关键道具不可寄售
        if (d.meta && (d.meta.noSell || d.meta.xsgNoSell)) continue; // <noSell>/<xsgNoSell>
        out.push({ kind, dataId: i, name: d.name, have });
      }
    };
    pushArr('item', $dataItems, $gameParty._items);
    pushArr('weapon', $dataWeapons, $gameParty._weapons);
    pushArr('armor', $dataArmors, $gameParty._armors);
    return out;
  }

  function renderSell() {
    const list = listSellable();
    if (list.length === 0) {
      bodyEl.innerHTML = '<div style="color:#888;padding:8px 0">背包里没有可寄售的物品（关键道具不可寄售）。</div>';
      return;
    }
    const rows = list.map((it) => {
      const key = it.kind + '#' + it.dataId;
      return [
        '<div data-sell-row="' + key + '" data-kind="' + it.kind + '" data-id="' + it.dataId + '" data-have="' + it.have + '" style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid #2c2d33">',
        '  <span style="flex:1">' + escapeHtml(it.name) + ' <span style="color:#888;font-size:11px">' + kindLabel(it.kind) + ' 持有 ' + it.have + '</span></span>',
        '  <label style="color:#9fd8ff">数量<input data-sell-count type="number" min="1" max="' + it.have + '" value="1" style="width:62px;background:#111;color:#fff;border:1px solid #333;border-radius:3px;padding:2px 4px;margin-left:4px"/></label>',
        '  <label style="color:#9fd8ff">单价<input data-sell-price type="number" min="1" value="1" style="width:90px;background:#111;color:#fff;border:1px solid #333;border-radius:3px;padding:2px 4px;margin-left:4px"/></label>',
        '  <span data-sell-total style="color:#ffd070;min-width:96px;text-align:right">共 1</span>',
        '  <button data-act="create" style="background:#2c9c4a;color:#fff;border:0;border-radius:3px;padding:3px 12px;cursor:pointer">上架</button>',
        '</div>',
      ].join('');
    }).join('');
    bodyEl.innerHTML = '<div style="color:#888;margin-bottom:6px">挂单即从背包托管扣除；卖出收 20% 手续费（金币销毁）。</div>' + rows;
  }

  function recalcSellTotal(row) {
    const cnt = Number(row.querySelector('input[data-sell-count]').value) | 0;
    const price = Number(row.querySelector('input[data-sell-price]').value) | 0;
    const totalEl = row.querySelector('[data-sell-total]');
    if (totalEl) totalEl.textContent = '共 ' + fmtGold(Math.max(0, cnt) * Math.max(0, price));
  }

  // ---------- 事件委托 ----------
  function onBodyInput(e) {
    const t = e.target;
    if (!t) return;
    if (t.matches && (t.matches('input[data-sell-count]') || t.matches('input[data-sell-price]'))) {
      const row = t.closest('div[data-sell-row]');
      if (row) recalcSellTotal(row);
    }
  }

  function onBodyChange(e) {
    const t = e.target;
    if (!t || !t.matches) return;
    if (t.matches('select[data-filter-kind]')) {
      browseState.kind = t.value;
      renderBrowse();
    }
  }

  function onBodyClick(e) {
    const t = e.target;
    if (!t || !t.closest) return;
    const btn = t.closest('button[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'browse-refresh') {
      const qEl = bodyEl.querySelector('input[data-filter-q]');
      const kEl = bodyEl.querySelector('select[data-filter-kind]');
      browseState.q = qEl ? qEl.value.trim() : '';
      browseState.kind = kEl ? kEl.value : '';
      renderBrowse();
      return;
    }
    if (act === 'buy') {
      const id = Number(btn.dataset.id);
      const max = Number(btn.dataset.max) || 1;
      const row = btn.closest('div[data-listing]');
      const qtyEl = row ? row.querySelector('input[data-buy-qty]') : null;
      let qty = qtyEl ? Number(qtyEl.value) | 0 : 1;
      if (qty < 1) qty = 1;
      if (qty > max) qty = max;
      setStatus('购买中…');
      Net.request('market.buy', { listingId: id, qty }, 8000)
        .then((res) => {
          setStatus('已买入 ' + displayName(res.kind, res.dataId) + ' ×' + res.qty + '，花费 ' + fmtGold(res.cost) + ' 金币');
          reconcileInv();
          renderBrowse();
        })
        .catch(handleErr);
      return;
    }
    if (act === 'cancel') {
      const id = Number(btn.dataset.id);
      setStatus('下架中…');
      Net.request('market.cancel', { listingId: id }, 8000)
        .then((res) => {
          setStatus('已下架，退回 ' + res.returned + ' 个');
          reconcileInv();
          renderMine();
        })
        .catch(handleErr);
      return;
    }
    if (act === 'unlock') {
      setStatus('开格中…');
      Net.request('market.unlockSlot', {}, 8000)
        .then((res) => {
          setStatus('已开格，当前 ' + res.slots + ' 格（花费 ' + fmtGold(res.spent) + ' 金币）');
          reconcileInv();
          renderMine();
        })
        .catch(handleErr);
      return;
    }
    if (act === 'create') {
      const row = btn.closest('div[data-sell-row]');
      if (!row) return;
      const kind = row.dataset.kind;
      const dataId = Number(row.dataset.id);
      const have = Number(row.dataset.have) || 0;
      let count = Number(row.querySelector('input[data-sell-count]').value) | 0;
      const unitPrice = Number(row.querySelector('input[data-sell-price]').value) | 0;
      if (count < 1) count = 1;
      if (count > have) count = have;
      if (unitPrice < 1) { setStatus('单价必须 ≥ 1', true); return; }
      setStatus('上架中…');
      Net.request('market.create', { kind, dataId, count, unitPrice }, 8000)
        .then(() => {
          setStatus('已上架 ' + displayName(kind, dataId) + ' ×' + count + '（单价 ' + fmtGold(unitPrice) + '）');
          reconcileInv();
          renderSell();
        })
        .catch(handleErr);
    }
  }

  // ---------- 成交通知 toast（右下角，复用交易邀请样式）----------
  let toastWrap = null;
  function ensureToastWrap() {
    if (toastWrap) return toastWrap;
    toastWrap = document.createElement('div');
    toastWrap.id = 'xsg-online-market-toast';
    Object.assign(toastWrap.style, {
      position: 'absolute', right: '14px', bottom: '14px', width: '300px',
      display: 'flex', flexDirection: 'column', gap: '8px', zIndex: String(Z_TOAST),
      fontFamily: 'sans-serif', fontSize: '13px', pointerEvents: 'none',
    });
    document.body.appendChild(toastWrap);
    return toastWrap;
  }
  function pushToast(html) {
    ensureToastWrap();
    const card = document.createElement('div');
    Object.assign(card.style, {
      background: 'rgba(20,20,28,0.96)', color: '#eee', border: '1px solid #2c9c4a',
      borderRadius: '8px', padding: '10px 12px', boxShadow: '0 6px 20px rgba(0,0,0,0.6)',
    });
    card.innerHTML = html;
    toastWrap.appendChild(card);
    setTimeout(() => { try { toastWrap.removeChild(card); } catch (e) { /* ignore */ } }, 9000);
  }
  function notifyText(n) {
    const p = n && n.payload ? n.payload : {};
    if (n.type === 'market_sold') {
      const tail = p.remaining > 0 ? ('，剩余 ' + p.remaining) : '，已售罄';
      return '💰 你的 <b>' + escapeHtml(displayName(p.kind, p.dataId)) + '</b> ×' + p.qty
        + ' 卖给了 <b>' + escapeHtml(p.buyerName || ('#' + p.buyerId)) + '</b>，到手 <b style="color:#ffd070">'
        + fmtGold(p.proceeds) + '</b> 金币（手续费 ' + fmtGold(p.fee) + '）' + tail;
    }
    if (n.type === 'market_bought') {
      return '🛍 你买入了 <b>' + escapeHtml(displayName(p.kind, p.dataId)) + '</b> ×' + p.qty
        + '（卖家 ' + escapeHtml(p.sellerName || ('#' + p.sellerId)) + '），花费 ' + fmtGold(p.cost) + ' 金币';
    }
    return escapeHtml(n.type || '通知');
  }
  function showNotifications(items) {
    if (!Array.isArray(items) || items.length === 0) return;
    // 离线攒太多时合并提示，避免刷屏
    if (items.length > 4) {
      const sold = items.filter((n) => n && n.type === 'market_sold');
      const gained = sold.reduce((a, n) => a + ((n.payload && n.payload.proceeds) | 0), 0);
      pushToast('💰 你不在时寄售成交 <b>' + sold.length + '</b> 笔，合计到手 <b style="color:#ffd070">' + fmtGold(gained) + '</b> 金币');
      return;
    }
    items.forEach((n) => pushToast(notifyText(n)));
  }

  Net.on('market.notify.evt', (e) => {
    if (e && Array.isArray(e.items)) showNotifications(e.items);
  });
  Net.on('__disconnect__', close);

  Util.log('info', 'Market (寄售行) loaded');
})();
