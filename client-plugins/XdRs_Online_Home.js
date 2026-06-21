//=============================================================================
// XdRs_Online_Home.js
//=============================================================================
/*:
 * @target MZ
 * @plugindesc 联机-家园 | 私人实例化家园 + 家具DIY + 升级换底图 + 访客同步 (XSG-Online)
 * @author xsg-online
 *
 * @help
 * 把原版“房型升级 + 装修地图 + 家具道具”搬上线，做成每人一间的私有实例化家园。
 * 服务端权威：房型等级/风格/家具布局都存服务端；本插件只负责渲染与发起请求。
 *
 * 进家流程（复用副本式虚拟地图实例）：
 *   Net.request('home.enter', {ownerPid?}) -> { virtualMapId, baseMapId, tier, building,
 *     style, visibility, canEdit, furniture[], spawn }
 *   -> Home.current = res；reserveTransfer 到 baseMapId（装修图）；
 *   -> PlayerSync.enterCurrentMap 读 Home.current.virtualMapId 让服务端按实例路由广播。
 *
 * 家具 DIY（仅房主，需先开“装修模式”）：
 *   - 选背包里的家具 -> 点空格子 = 摆放(home.furniture.place)
 *   - 点已摆家具 = 收回(home.furniture.remove，退回背包)
 *   - 访客实时收 home.furniture.evt 同步显示
 *
 * 依赖：Util / Net / Core / PlayerSync。须在它们之后、Hub 之前加载。
 * 注意：本插件需配合服务端 home.* 协议；运行期请按联机自测验证摆放/升级/串门。
 */
(() => {
  'use strict';
  const G = window.XdRsOnline;
  if (!G || !G.Net || !G.Core) {
    console.error('[XSG-Online] Home: deps missing (need Util/Net/Core)');
    return;
  }
  const Util = G.Util;
  const Net = G.Net;
  const Core = G.Core;

  const Home = (G.Home = G.Home || {});
  Home.current = null; // { ownerPid, virtualMapId, baseMapId, building, tier, style, visibility, canEdit, furniture, spawn }

  let editMode = false;
  let selectedFurnitureId = null;
  const furnitureSprites = new Map(); // homeFurnitureId -> Sprite
  const Z = { panel: 9550 };
  let panel = null;
  let bodyEl = null;

  // ---------- 公共工具（与 Hub 同款） ----------
  function flash(text) {
    if (typeof $gameTemp !== 'undefined' && $gameTemp && typeof $gameTemp.addWorldMessage === 'function') {
      $gameTemp.addWorldMessage('\\c[10][家园]\\c[0] ' + text, true);
    } else {
      console.log('[XSG-Online][Home] ' + text);
    }
  }
  function onErr(err) {
    flash((err && err.code ? err.code + ': ' : '') + ((err && err.message) || '操作失败'));
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function stopBubble(el) {
    ['mousedown', 'mouseup', 'click', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'wheel', 'contextmenu'].forEach((evt) => {
      el.addEventListener(evt, (e) => { e.stopPropagation(); }, evt === 'touchstart' || evt === 'touchend' || evt === 'wheel' ? { passive: false } : undefined);
    });
    el.addEventListener('keydown', (e) => e.stopPropagation());
  }
  function inHomeMap() {
    return !!(Home.current && SceneManager._scene instanceof Scene_Map && $gameMap && $gameMap.mapId() === Home.current.baseMapId);
  }
  function currentSpriteset() {
    return SceneManager._scene && SceneManager._scene._spriteset;
  }

  function buildingName(b) {
    return b === 'skygarden' ? '空中花园' : '椰树大厦';
  }

  // ---------- 老存档迁移（H-D）：本地开关 582~611 -> 房型(tier,style) ----------
  // 映射来自 data/CommonEvents.json 的「升X级房型YY系」事件（每个翻一个开关）。
  const SWITCH_HOUSE = {
    582: { t: 2, s: '米黄' }, 583: { t: 3, s: '米黄' }, 584: { t: 3, s: '普通' },
    585: { t: 4, s: '米黄' }, 586: { t: 4, s: '粉黄' }, 587: { t: 4, s: '浅蓝' }, 588: { t: 4, s: '浅绿' },
    589: { t: 5, s: '米黄' }, 590: { t: 5, s: '浅粉' },
    591: { t: 6, s: '米黄' }, 592: { t: 6, s: '温馨' }, 593: { t: 6, s: '七彩' }, 594: { t: 6, s: '古典' }, 595: { t: 6, s: '幽兰' },
    596: { t: 7, s: '七彩' }, 597: { t: 7, s: '黑色' }, 598: { t: 7, s: '绯红' }, 599: { t: 7, s: '普通' }, 600: { t: 7, s: '简约' },
    601: { t: 8, s: '仙女座' }, 602: { t: 9, s: '古典' }, 603: { t: 10, s: '七彩' }, 604: { t: 10, s: '普通' },
    605: { t: 11, s: '双鱼座' }, 606: { t: 12, s: '巨熊座' }, 607: { t: 13, s: '未来系' }, 608: { t: 14, s: '天燕座' },
    609: { t: 15, s: '海豚座' }, 610: { t: 16, s: '巨蟹座' }, 611: { t: 17, s: '巨蛇座' },
  };
  let _migrateTried = false;

  function readLocalHouse() {
    if (typeof $gameSwitches === 'undefined' || !$gameSwitches) return null;
    let best = null;
    for (const sid of Object.keys(SWITCH_HOUSE)) {
      if ($gameSwitches.value(Number(sid))) {
        const info = SWITCH_HOUSE[sid];
        if (!best || info.t > best.tier) best = { tier: info.t, style: info.s };
      }
    }
    return best;
  }

  // ---------- 进入 / 离开家园 ----------
  function applyEnter(res) {
    Home.current = res;
    editMode = false;
    selectedFurnitureId = null;
    // 直接传送到服务端指定的装修底图（装修由 baseMapId 决定，无需设开关）。
    $gamePlayer.reserveTransfer(res.baseMapId, res.spawn.x, res.spawn.y, res.spawn.d || 2, 0);
    flash('进入' + (res.canEdit ? '你的家园' : ((res.ownerName || ('#' + res.ownerPid)) + ' 的家园')) + '（' + buildingName(res.building) + ' Lv' + res.tier + '）');
    Util.log('info', 'home enter ok owner=' + res.ownerPid + ' virt=' + res.virtualMapId + ' base=' + res.baseMapId);
  }

  Home.enterHome = function (ownerPid) {
    if (!Core.isOnline()) { flash('未联机'); return; }
    const isOwn = !ownerPid;
    Net.request('home.enter', ownerPid ? { ownerPid } : {})
      .then((res) => {
        // H-D 老存档一次性迁移：仅自家、服务端仍初始档(tier<=0)、本地开关有更高房型时
        if (isOwn && res.canEdit && !_migrateTried && res.tier <= 0) {
          _migrateTried = true;
          const local = readLocalHouse();
          if (local && local.tier > res.tier) {
            return Net.request('home.migrate', { tier: local.tier, style: local.style }, 6000)
              .then((m) => {
                if (m && m.migrated) {
                  flash('已迁移你的老房型到云端：Lv' + m.tier + ' ' + (m.style || ''));
                  return Net.request('home.enter', {}).then(applyEnter); // 拉迁移后底图
                }
                return applyEnter(res);
              })
              .catch(() => applyEnter(res)); // 迁移失败不阻断进家
          }
        }
        return applyEnter(res);
      })
      .catch(onErr);
  };

  // ---------- 家具精灵（IconSet 图标，挂 tilemap 随地图滚动） ----------
  function makeFurnitureSprite(item) {
    const sp = new Sprite();
    sp.bitmap = ImageManager.loadSystem('IconSet');
    const data = $dataItems && $dataItems[item.furnitureId];
    const iconIndex = (data && data.iconIndex) || 0;
    const pw = 32;
    const ph = 32;
    const sx = (iconIndex % 16) * pw;
    const sy = Math.floor(iconIndex / 16) * ph;
    sp.setFrame(sx, sy, pw, ph);
    sp.anchor.x = 0.5;
    sp.anchor.y = 1;
    sp._homeId = item.id;
    sp._tileX = item.x;
    sp._tileY = item.y;
    sp._layer = item.layer;
    sp.z = 3; // 家具显示在地面之上
    sp.update = function () {
      Sprite.prototype.update.call(this);
      if (!$gameMap) return;
      const tw = $gameMap.tileWidth();
      const th = $gameMap.tileHeight();
      this.x = Math.round($gameMap.adjustX(this._tileX) * tw + tw / 2);
      this.y = Math.round($gameMap.adjustY(this._tileY) * th + th);
      this.opacity = editMode ? 255 : 255;
    };
    return sp;
  }

  function addFurnitureSprite(item) {
    if (furnitureSprites.has(item.id)) return; // 去重（自己摆放也会收到 evt）
    const ss = currentSpriteset();
    if (!ss || !ss._tilemap) return;
    const sp = makeFurnitureSprite(item);
    furnitureSprites.set(item.id, sp);
    ss._tilemap.addChild(sp);
  }

  function removeFurnitureSprite(id) {
    const sp = furnitureSprites.get(id);
    if (!sp) return;
    furnitureSprites.delete(id);
    if (sp.parent) sp.parent.removeChild(sp);
    if (typeof sp.destroy === 'function') {
      try { sp.destroy(); } catch (e) { /* ignore */ }
    }
  }

  function clearFurnitureSprites() {
    for (const id of Array.from(furnitureSprites.keys())) removeFurnitureSprite(id);
  }

  function renderAllFurniture() {
    clearFurnitureSprites();
    if (!Home.current || !Array.isArray(Home.current.furniture)) return;
    for (const item of Home.current.furniture) addFurnitureSprite(item);
  }

  function furnitureAtTile(x, y) {
    for (const sp of furnitureSprites.values()) {
      if (sp._tileX === x && sp._tileY === y) return sp;
    }
    return null;
  }

  // ---------- 编辑：摆放 / 收回 ----------
  function placeAt(x, y) {
    if (selectedFurnitureId == null) { flash('先在面板里选一件家具'); return; }
    Net.request('home.furniture.place', { furnitureId: selectedFurnitureId, x, y, dir: $gamePlayer.direction() || 2, layer: 1 }, 6000)
      .then(() => {
        // 服务端会广播 home.furniture.evt(op:place)，由事件统一加精灵；这里刷背包面板
        if (typeof $gameParty !== 'undefined' && $gameParty.loseItem && $dataItems[selectedFurnitureId]) {
          // 本地背包由服务端权威库存兜底，这里仅刷新面板显示
        }
        refreshPanel();
      })
      .catch(onErr);
  }

  function removeFurnitureById(id) {
    Net.request('home.furniture.remove', { id }, 6000)
      .then(() => { refreshPanel(); })
      .catch(onErr);
  }

  // 编辑模式下拦截地图点击：点已摆家具=收回；点空格+已选家具=摆放。
  const _Game_Temp_setDestination = Game_Temp.prototype.setDestination;
  Game_Temp.prototype.setDestination = function (x, y) {
    if (editMode && Home.current && Home.current.canEdit && inHomeMap()) {
      const hit = furnitureAtTile(x, y);
      if (hit) { removeFurnitureById(hit._homeId); return; }
      if (selectedFurnitureId != null) { placeAt(x, y); return; }
    }
    _Game_Temp_setDestination.call(this, x, y);
  };

  // ---------- 离家清理：传送到非家图时清 Home.current（让 PlayerSync 上报真实图） ----------
  const _Game_Player_reserveTransfer = Game_Player.prototype.reserveTransfer;
  Game_Player.prototype.reserveTransfer = function (mapId, x, y, d, fadeType) {
    if (Home.current && mapId !== Home.current.baseMapId) {
      Home.current = null;
      editMode = false;
      selectedFurnitureId = null;
      clearFurnitureSprites();
      if (panel && panel.style.display !== 'none') Home.close();
    }
    _Game_Player_reserveTransfer.call(this, mapId, x, y, d, fadeType);
  };

  // ---------- 进入家图后渲染家具 ----------
  const _Scene_Map_start = Scene_Map.prototype.start;
  Scene_Map.prototype.start = function () {
    _Scene_Map_start.call(this);
    if (inHomeMap()) {
      // 等 spriteset 就绪后挂家具
      setTimeout(renderAllFurniture, 0);
    }
  };
  const _Scene_Map_terminate = Scene_Map.prototype.terminate;
  Scene_Map.prototype.terminate = function () {
    clearFurnitureSprites();
    _Scene_Map_terminate.call(this);
  };

  // ---------- 升级 / 可见性 ----------
  function doUpgrade() {
    Net.request('home.upgrade', {}, 8000)
      .then((r) => {
        flash('升级成功：' + buildingName(r.building) + ' Lv' + r.tier);
        // 等级变了底图可能换栋，重新进家拉新 baseMapId
        Home.enterHome();
        Home.close();
      })
      .catch(onErr);
  }
  function doSetVisibility(v) {
    Net.request('home.setVisibility', { visibility: v }, 6000)
      .then(() => { if (Home.current) Home.current.visibility = v; flash('可见性已设为：' + visLabel(v)); refreshPanel(); })
      .catch(onErr);
  }
  function visLabel(v) {
    return v === 'public' ? '公开可逛' : v === 'friends' ? '好友可访' : '仅自己';
  }

  // ---------- 背包家具 ----------
  function getOwnedFurniture() {
    const out = [];
    if (typeof $gameParty === 'undefined' || !$gameParty._items) return out;
    const items = $gameParty._items;
    for (const idStr of Object.keys(items)) {
      const id = Number(idStr);
      const cnt = items[idStr];
      if (!cnt || cnt <= 0) continue;
      const d = $dataItems && $dataItems[id];
      if (!d) continue;
      const isFurn = (d.note && /<HomeFurniture>/i.test(d.note)) || (d.name && /^⭐?家具-/.test(d.name));
      if (isFurn) out.push({ id, name: d.name, count: cnt });
    }
    return out;
  }

  // ---------- DOM 面板 ----------
  function buildPanel() {
    panel = document.createElement('div');
    panel.id = 'xsg-online-home';
    panel.className = 'xsg-win';
    Object.assign(panel.style, {
      position: 'absolute', right: '14px', top: '56px', width: '330px', maxHeight: '70%',
      zIndex: String(Z.panel), display: 'none', fontSize: '12px',
    });
    panel.innerHTML = [
      '<div class="xsg-titlebar">',
      '  <span class="xsg-title">我的家园</span>',
      '  <button class="xsg-btn-close" data-act="close">×</button>',
      '</div>',
      '<div class="xsg-body" data-body></div>',
    ].join('');
    document.body.appendChild(panel);
    bodyEl = panel.querySelector('[data-body]');
    stopBubble(panel);
    panel.querySelector('button[data-act=close]').addEventListener('click', Home.close);
    bodyEl.addEventListener('click', onBodyClick);
    bodyEl.addEventListener('change', onBodyChange);
  }

  function onBodyClick(e) {
    const b = e.target.closest('button');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'upgrade') doUpgrade();
    else if (act === 'editToggle') { editMode = !editMode; refreshPanel(); flash(editMode ? '装修模式开（点格子摆/点家具收）' : '装修模式关'); }
    else if (act === 'selFurn') { selectedFurnitureId = Number(b.dataset.fid); refreshPanel(); }
  }
  function onBodyChange(e) {
    const sel = e.target.closest('select[data-act=visibility]');
    if (sel) doSetVisibility(sel.value);
  }

  function refreshPanel() {
    if (!bodyEl || !panel || panel.style.display === 'none') return;
    const h = Home.current;
    if (!h) { bodyEl.innerHTML = '<div class="xsg-muted">未进入家园</div>'; return; }
    const owned = getOwnedFurniture();
    const parts = [];
    parts.push('<div class="xsg-row" style="justify-content:space-between">'
      + '<span>' + buildingName(h.building) + ' <b>Lv' + h.tier + '</b> · ' + escapeHtml(h.style) + '</span>'
      + '<span class="xsg-muted">' + (h.canEdit ? '我的家' : '访客') + '</span></div>');
    if (h.canEdit) {
      parts.push('<div class="xsg-row" style="gap:6px;margin-top:6px">'
        + '<button class="xsg-btn-primary" data-act="upgrade">升级房型</button>'
        + '<button class="xsg-btn' + (editMode ? '-warn' : '') + '" data-act="editToggle">' + (editMode ? '退出装修' : '装修模式') + '</button>'
        + '</div>');
      parts.push('<div class="xsg-row" style="gap:6px;margin-top:6px">可见性：'
        + '<select data-act="visibility">'
        + '<option value="private"' + (h.visibility === 'private' ? ' selected' : '') + '>仅自己</option>'
        + '<option value="friends"' + (h.visibility === 'friends' ? ' selected' : '') + '>好友可访</option>'
        + '<option value="public"' + (h.visibility === 'public' ? ' selected' : '') + '>公开可逛</option>'
        + '</select></div>');
      if (editMode) {
        parts.push('<div class="xsg-muted" style="margin-top:8px">选一件家具，点地图空格摆放；点已摆家具收回：</div>');
        if (owned.length === 0) {
          parts.push('<div class="xsg-muted" style="padding:6px 0">背包里没有家具（去商店买 ⭐家具-）</div>');
        } else {
          parts.push('<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px">'
            + owned.map((it) => '<button class="xsg-btn' + (selectedFurnitureId === it.id ? '-primary' : '') + '" data-act="selFurn" data-fid="' + it.id
              + '" style="font-size:11px;padding:2px 6px">' + escapeHtml(it.name) + '×' + it.count + '</button>').join('')
            + '</div>');
        }
      }
    } else {
      parts.push('<div class="xsg-muted" style="margin-top:6px">这是别人的家，仅可参观。</div>');
    }
    bodyEl.innerHTML = parts.join('');
  }

  Home.open = function () {
    if (!panel) buildPanel();
    panel.style.display = 'flex';
    refreshPanel();
  };
  Home.close = function () {
    if (panel) panel.style.display = 'none';
  };

  // ---------- 服务端事件 ----------
  Net.on('home.furniture.evt', (e) => {
    if (!e || !e.item || !inHomeMap()) return;
    if (e.op === 'place') addFurnitureSprite(e.item);
    else if (e.op === 'remove') removeFurnitureSprite(e.item.id);
    else if (e.op === 'move') { removeFurnitureSprite(e.item.id); addFurnitureSprite(e.item); }
    // 同步内存 furniture 列表
    if (Home.current && Array.isArray(Home.current.furniture)) {
      if (e.op === 'remove') Home.current.furniture = Home.current.furniture.filter((f) => f.id !== e.item.id);
      else {
        const idx = Home.current.furniture.findIndex((f) => f.id === e.item.id);
        if (idx >= 0) Home.current.furniture[idx] = e.item; else Home.current.furniture.push(e.item);
      }
    }
  });

  Net.on('home.update.evt', (e) => {
    if (!e || !Home.current) return;
    if (e.tier != null) Home.current.tier = e.tier;
    if (e.building != null) Home.current.building = e.building;
    if (e.style != null) Home.current.style = e.style;
    if (e.visibility != null) Home.current.visibility = e.visibility;
    refreshPanel();
  });

  Net.on('__disconnect__', () => {
    Home.current = null;
    editMode = false;
    _migrateTried = false;
    clearFurnitureSprites();
    Home.close();
  });

  Util.log('info', 'Home (家园) loaded');
})();
