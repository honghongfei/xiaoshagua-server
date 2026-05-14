//=============================================================================
// XdRs_Online_Pet.js
//=============================================================================
/*:
 * @target MZ
 * @plugindesc 联机-宠物 | 服务端权威云宠物面板（与 XdRs_Arder 并行，不替换）
 * @author xsg-online
 *
 * @param toggleKey
 * @text 打开宠物面板热键
 * @type string
 * @default P
 *
 * @help
 * 按 P 打开「云宠物」面板：
 *   - 列出当前角色名下的服务端宠物
 *   - 喂养 / 训练 / 进化按钮（4 小时冷却，服务端校验）
 *   - 「领养」按钮可创建新宠（speciesId / 名字）
 *
 * 设计原因：原生 XdRs_Arder 仍负责本地宠物玩法；这里只新增「联机云宠物」副数据。
 * 后续可以让 XdRs_Arder 的喂养接口通过 Pet.adoptFromArder 同步过来。
 */
(() => {
  'use strict';
  const G = window.XdRsOnline;
  if (!G || !G.Net || !G.Core) {
    console.error('[XSG-Online] Pet: deps missing');
    return;
  }
  const Util = G.Util;
  const Net = G.Net;
  const Core = G.Core;
  const params = PluginManager.parameters('XdRs_Online_Pet');
  const cfg = { toggleKey: String(params.toggleKey || 'P') };

  const Pet = (G.Pet = G.Pet || {});
  Pet.cache = [];

  let panel = null;
  let body = null;
  let opened = false;

  function build() {
    panel = document.createElement('div');
    panel.id = 'xsg-online-pet';
    Object.assign(panel.style, {
      position: 'absolute', right: '10px', top: '10px',
      width: '320px', maxHeight: '70%',
      background: 'rgba(20,20,28,0.92)', color: '#eee',
      borderRadius: '6px', fontFamily: 'sans-serif', fontSize: '12px',
      display: 'none', flexDirection: 'column',
      zIndex: '9050', boxShadow: '0 4px 14px rgba(0,0,0,0.6)',
    });
    panel.innerHTML = [
      '<div style="padding:6px 10px;border-bottom:1px solid #333;display:flex;align-items:center;gap:6px">',
      '  <span style="font-weight:bold;flex:1">云宠物</span>',
      '  <button data-act="refresh" style="background:#333;color:#fff;border:0;border-radius:3px;padding:2px 8px;cursor:pointer">刷</button>',
      '  <button data-act="adopt"   style="background:#2c9c4a;color:#fff;border:0;border-radius:3px;padding:2px 8px;cursor:pointer">领养</button>',
      '  <button data-act="close"   style="background:#444;color:#fff;border:0;border-radius:3px;padding:2px 8px;cursor:pointer">×</button>',
      '</div>',
      '<div data-body style="overflow-y:auto;padding:6px 10px;line-height:1.7"></div>',
    ].join('');
    document.body.appendChild(panel);
    body = panel.querySelector('[data-body]');

    panel.querySelector('button[data-act=close]').addEventListener('click', () => Pet.close());
    panel.querySelector('button[data-act=refresh]').addEventListener('click', () => Pet.refresh());
    panel.querySelector('button[data-act=adopt]').addEventListener('click', promptAdopt);
    panel.addEventListener('keydown', (e) => e.stopPropagation());

    body.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-pid]');
      if (!btn) return;
      const petId = Number(btn.dataset.pid);
      const action = btn.dataset.action;
      Net.request('pet.act', { petId, action }).then((res) => {
        Util.log('info', 'pet.act', action, 'pet=', petId, 'res=', res && res.delta);
        Pet.refresh();
      }).catch((err) => {
        const msg = (err && err.code ? err.code + ': ' : '') + (err && err.message || '失败');
        alert(msg);
      });
    });
  }

  function promptAdopt() {
    const raw = window.prompt('领养：speciesId,name  例：3,小傻瓜', '1,小宠');
    if (!raw) return;
    const parts = raw.split(',').map(s => s.trim());
    const speciesId = Number(parts[0]);
    const name = parts[1];
    if (!speciesId || !name) { alert('格式不对'); return; }
    Net.request('pet.adopt', { speciesId, name }).then(() => Pet.refresh()).catch((err) => alert(err && err.message || '失败'));
  }

  Pet.refresh = function () {
    if (!Core.isOnline()) return;
    return Net.request('pet.list', {}).then((res) => {
      Pet.cache = res && res.pets || [];
      render();
    }).catch((err) => Util.log('warn', 'pet.list failed:', err && err.message));
  };

  function fmtCool(coolUntil) {
    const ms = coolUntil - Date.now();
    if (ms <= 0) return '可操作';
    const m = Math.floor(ms / 60000);
    const h = Math.floor(m / 60);
    return h > 0 ? `${h}小时${m % 60}分` : `${m}分钟`;
  }

  function render() {
    if (!body) return;
    if (!Pet.cache.length) {
      body.innerHTML = '<div style="color:#888">暂无云宠物。点上方「领养」试试。</div>';
      return;
    }
    body.innerHTML = Pet.cache.map((p) => {
      const cooling = p.coolUntil > Date.now();
      const btnStyle = (color, disabled) => `background:${color};color:#fff;border:0;border-radius:3px;padding:2px 6px;font-size:11px;cursor:${disabled ? 'default' : 'pointer'};opacity:${disabled ? '0.5' : '1'}`;
      return `
        <div style="padding:4px 0;border-bottom:1px solid #333">
          <div><b>${escape(p.name)}</b> <span style="color:#888">阶${p.stage} / Lv${p.level} / Exp${p.exp}</span></div>
          <div style="color:#9fd8ff">species#${p.speciesId} · ${fmtCool(p.coolUntil)}</div>
          <div style="margin-top:2px">
            <button data-pid="${p.id}" data-action="feed"  ${cooling ? 'disabled' : ''} style="${btnStyle('#3a82ff', cooling)}">喂养</button>
            <button data-pid="${p.id}" data-action="train" ${cooling ? 'disabled' : ''} style="${btnStyle('#2c9c4a', cooling)}">训练</button>
            <button data-pid="${p.id}" data-action="evolve" style="${btnStyle('#a0790f', false)};margin-left:4px">进化</button>
          </div>
        </div>
      `;
    }).join('');
  }

  function escape(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  Pet.open = function () { if (!panel) build(); panel.style.display = 'flex'; opened = true; Pet.refresh(); };
  Pet.close = function () { if (panel) panel.style.display = 'none'; opened = false; };
  Pet.toggle = function () { opened ? Pet.close() : Pet.open(); };

  document.addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    if (!Core.isOnline()) return;
    if (!(SceneManager._scene instanceof Scene_Map)) return;
    if (e.key && e.key.toUpperCase() === cfg.toggleKey.toUpperCase()) {
      e.preventDefault();
      Pet.toggle();
    }
  });
})();
