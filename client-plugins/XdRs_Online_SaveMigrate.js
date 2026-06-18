//=============================================================================
// XdRs_Online_SaveMigrate.js  v1.0
//=============================================================================
/*:
 * @target MZ
 * @plugindesc 联机-存档迁移 | 老玩家本地存档双向迁移到云端 (上传 / 下载)
 * @author xsg-online
 *
 * @param titleButtonText
 * @text 标题按钮文字
 * @desc 标题界面右侧浮动按钮的文字。
 * @type string
 * @default 存档迁移
 *
 * @param hotkey
 * @text 标题界面快捷键
 * @desc 在标题界面按下该按键打开迁移面板（单个字母 / 数字）。
 * @type string
 * @default S
 *
 * @param showOnTitle
 * @text 在标题界面显示按钮
 * @type boolean
 * @default true
 *
 * @param showInOnlineMenu
 * @text 在已登录菜单中显示「存档迁移」选项
 * @type boolean
 * @default true
 *
 * @help
 * ============================================================================
 * 用途
 * ============================================================================
 * 给从单机切换到联机的老玩家用：把本地 save/file*.rmmzsave 上传到云端、
 * 把云端存档下载到本地任意槽位。
 *
 * 与 XdRs_Online_SaveCloud 的区别：
 *   - SaveCloud 在「联机进游戏后」自动 saveGame/loadGame 走云端 (透明同步)
 *   - SaveMigrate 是「显式 UI 一键迁移」, 不进游戏也能操作, 给老玩家"搬家"用
 *
 * 工作机制
 * ----------------------------------------------------------------------------
 * 上传:  StorageManager.loadObject(saveN) → JsonEx.stringify → save.upload
 *        (与 SaveCloud 用的格式一致, 双向兼容)
 * 下载:  save.download → JsonEx.parse → StorageManager.saveObject(saveN, ...)
 *        + 同步刷新 DataManager._globalInfo[N], 让标题/读取界面立刻看见
 *
 * 对存档槽位:
 *   - 服务端目前是「角色 1 角色 1 份云档」的设计 (storageService 单行 UPSERT)
 *   - 上传时只会把当前槽位的 contents 推上云, 下次再上传会覆盖云端那一份
 *   - 下载时玩家自己挑要写到哪个本地槽 (1~maxSavefiles, 默认 20)
 *
 * 安全
 * ----------------------------------------------------------------------------
 *   - 只在 Scene_Title / Scene_OnlineMenu 可用, 防止在游戏中误覆盖现场进度
 *   - 下载到非空槽前必须 confirm
 *   - 上传 contents 大小 > 1.9MB 时拒绝 (服务端硬上限 2MB)
 *   - 必须已登录联机服务器才能上传/下载, 未登录显示「请先点联机登录」+ 跳转
 *
 * 依赖
 * ----------------------------------------------------------------------------
 *   XdRs_Online_Util, XdRs_Online_Net, XdRs_Online_Core, XdRs_Online_Login
 */
(() => {
  'use strict';
  const PLUGIN = 'XdRs_Online_SaveMigrate';
  const G = window.XdRsOnline;
  if (!G || !G.Net || !G.Core) {
    console.error('[XSG-Online] SaveMigrate: deps missing (Util/Net/Core)');
    return;
  }
  const Util = G.Util;
  const Net  = G.Net;
  const Core = G.Core;

  const params = PluginManager.parameters(PLUGIN);
  const CFG = {
    btnText:      String(params.titleButtonText || '存档迁移'),
    hotkey:       String(params.hotkey || 'S').toUpperCase(),
    showOnTitle:  params.showOnTitle !== 'false',
    showInOnlineMenu: params.showInOnlineMenu !== 'false',
    maxBlobBytes: 1_900_000,    // 留 100KB 给协议开销, 服务端硬限 2MB
  };

  const Migrate = (G.SaveMigrate = G.SaveMigrate || {});

  // ============================================================
  // 1. 本地 / 云端存档读写 helper
  // ============================================================
  function maxSlots() {
    return (DataManager.maxSavefiles && DataManager.maxSavefiles()) || 20;
  }

  function localSlotInfo(savefileId) {
    if (!DataManager._globalInfo) return null;
    return DataManager._globalInfo[savefileId] || null;
  }

  function localSlotExists(savefileId) {
    try {
      return DataManager.savefileExists(savefileId);
    } catch (e) {
      return false;
    }
  }

  // 把指定槽位的本地存档读成 JsonEx 字符串 (与 SaveCloud 对齐的格式)
  // 顺便消毒: 若本地老存档里 system._bgmOnSave/_bgsOnSave 已经是 null,
  //          这里就在内存里改成空音频对象再 stringify, 避免把坏数据传上云.
  async function readLocalSlotAsString(savefileId) {
    const saveName = DataManager.makeSavename(savefileId);
    const contents = await StorageManager.loadObject(saveName);
    if (contents && contents.system) {
      const empty = { name: '', volume: 0, pitch: 0, pan: 0, pos: 0 };
      if (contents.system._bgmOnSave == null || typeof contents.system._bgmOnSave !== 'object') {
        contents.system._bgmOnSave = empty;
      }
      if (contents.system._bgsOnSave == null || typeof contents.system._bgsOnSave !== 'object') {
        contents.system._bgsOnSave = { name: '', volume: 0, pitch: 0, pan: 0, pos: 0 };
      }
    }
    return JsonEx.stringify(contents);
  }

  // 把云端 contents 字符串写到本地槽
  async function writeLocalSlotFromString(savefileId, contentsString) {
    const contents = JsonEx.parse(contentsString);
    if (!contents) throw new Error('云存档解析失败');
    const saveName = DataManager.makeSavename(savefileId);
    // 1. 主操作: 把存档文件写到磁盘. 这一步成功即代表"下载完成", 后面 globalInfo
    //    刷新只是为了让标题界面读取列表能显示预览(角色头像/时长), 失败也不影响读档.
    await StorageManager.saveObject(saveName, contents);
    // 2. Best-effort 刷新预览; 任何异常都吞掉, 不让用户看到下载报错.
    try {
      const info = buildInfoFromContents(contents);
      if (info && DataManager._globalInfo) {
        DataManager._globalInfo[savefileId] = info;
        try { DataManager.saveGlobalInfo(); } catch (e) {
          Util.log('warn', 'saveGlobalInfo failed (save file already on disk):', e && e.message);
        }
      }
    } catch (e) {
      Util.log('warn', 'globalInfo refresh failed (save file already on disk):', e && e.message);
    }
  }

  // 从 contents 派生 globalInfo. 借助临时 $game* 状态计算, 算完恢复.
  // 任何一步出错都返回 fallback minimal info, 至少让槽位显示出来.
  // 调用时机受限: 只在 Scene_Title / Scene_OnlineMenu 时(无活跃游戏状态)运行.
  function buildInfoFromContents(contents) {
    // 最小可用 fallback. 老存档 / 坏存档 / 数据库变动都会让原版 makeSavefileInfo 抛错,
    // 失败时用这个让"读取游戏"列表至少能列出该槽.
    const fallback = {
      title: ($dataSystem && $dataSystem.gameTitle) || '云存档',
      characters: [],
      faces: [],
      playtime: '?',
      timestamp: Date.now(),
    };

    const snap = {
      $gameSystem:       window.$gameSystem,
      $gameScreen:       window.$gameScreen,
      $gameTimer:        window.$gameTimer,
      $gameSwitches:     window.$gameSwitches,
      $gameVariables:    window.$gameVariables,
      $gameSelfSwitches: window.$gameSelfSwitches,
      $gameActors:       window.$gameActors,
      $gameParty:        window.$gameParty,
      $gameMap:          window.$gameMap,
      $gamePlayer:       window.$gamePlayer,
    };
    try {
      DataManager.createGameObjects();
      DataManager.extractSaveContents(contents);
      // 关键: 移除 invalid actor 引用, 否则 makeSavefileInfo 里的
      // $gameParty.battleMembers().map(a => a.characterName()) 会对 null 取 .name
      try { DataManager.correctDataErrors(); } catch (_) { /* ignore */ }
      const info = DataManager.makeSavefileInfo();
      if (info && typeof info === 'object') return info;
      return fallback;
    } catch (e) {
      Util.log('warn', 'makeSavefileInfo threw, using minimal fallback:', e && e.message);
      return fallback;
    } finally {
      // 恢复, 不污染外部状态
      for (const k of Object.keys(snap)) window[k] = snap[k];
    }
  }

  // 云端探测: 只查存在
  function probeCloudExists() {
    if (!Core.isOnline()) return Promise.resolve({ ok: false, reason: 'offline' });
    return Net.request('save.exists', {}, 6000).then((r) => ({
      ok: true,
      exists: !!(r && r.exists),
    }));
  }

  // 云端拉完整 blob (附 meta)
  function downloadCloudBlob() {
    return Net.request('save.download', {}, 12000).then((r) => {
      if (!r || !r.found || !r.blob) return null;
      return r.blob; // { ts, contents, meta }
    });
  }

  // 上传本地槽到云端
  // 关键: 只写 savefile_cloud blob 是不够的 — 服务端的 character.gold / inventory
  // 表是金币和物品的"权威源", reconcile 会把它直接刷到 $gameParty._gold. 老玩家
  // 的本地存档第一次同步时这两张表是空的, 如果只 save.upload 不做 inventory.replace,
  // 下次进游戏 Scene_Map.start 拉 inventory.snapshot 会拿到 gold=0 / items=[], 把
  // 内存里刚从 blob 加载的 _gold (含【钻石】之类的关键物品) 全部清零, 30s 后
  // SaveCloud 自动镜像把这份归零状态推回云端, 钻石和金币就这么永久没了.
  //
  // 修复: 上传前先从存档 contents 里抽出 _gold / _items / _weapons / _armors,
  //       同步调用 inventory.replace 全量覆盖权威表; 任一调用失败都视为整体失败,
  //       让用户看到错误而不是默默丢档.
  async function uploadSlotToCloud(savefileId) {
    const saveName = DataManager.makeSavename(savefileId);
    const contents = await StorageManager.loadObject(saveName);
    if (!contents || !contents.party) throw new Error('本地存档为空或损坏');
    // 1. 消毒音频字段 (与之前保持一致)
    if (contents.system) {
      const empty = { name: '', volume: 0, pitch: 0, pan: 0, pos: 0 };
      if (contents.system._bgmOnSave == null || typeof contents.system._bgmOnSave !== 'object') {
        contents.system._bgmOnSave = empty;
      }
      if (contents.system._bgsOnSave == null || typeof contents.system._bgsOnSave !== 'object') {
        contents.system._bgsOnSave = { name: '', volume: 0, pitch: 0, pan: 0, pos: 0 };
      }
    }
    // 1.5 存档锁账号: 校验归属, 必须卡在 inventory.replace 之前.
    //   - 有章且 pid 不是当前账号 -> 拒绝(不跑 inventory.replace, 不上传)
    //   - 无章(老档) -> TOFU 盖成当前账号, best-effort 写回本地, 让以后被拷也带章
    const myPid = (Core.session && Core.session.character && typeof Core.session.character.pid === 'number')
      ? Core.session.character.pid : null;
    if (myPid == null) throw new Error('未登录, 无法校验存档归属');
    const ownerStamp = contents.xsgOwner;
    if (ownerStamp && typeof ownerStamp.pid === 'number' && ownerStamp.pid !== myPid) {
      throw new Error('此存档属于其他账号 (owner=' + ownerStamp.pid + '), 无法上传');
    }
    if (!ownerStamp) {
      const acctId = (Core.session.character.accountId != null) ? Core.session.character.accountId : null;
      contents.xsgOwner = { v: 1, pid: myPid, accountId: acctId, at: Date.now() };
      try {
        await StorageManager.saveObject(saveName, contents);
      } catch (e) {
        Util.log('warn', 'SaveMigrate TOFU 写回本地失败 (不影响上传):', e && e.message);
      }
    }

    // 2. 从 contents.party 抽资产, 准备 inventory.replace 载荷
    const party = contents.party || {};
    const gold = Math.max(0, (party._gold | 0));
    const items = [];
    const pushBucket = (bucket, kind) => {
      if (!bucket || typeof bucket !== 'object') return;
      for (const idStr of Object.keys(bucket)) {
        const dataId = Number(idStr);
        const count = bucket[idStr] | 0;
        if (!Number.isInteger(dataId) || dataId <= 0 || count <= 0) continue;
        items.push({ kind, dataId, count });
      }
    };
    pushBucket(party._items, 'item');
    pushBucket(party._weapons, 'weapon');
    pushBucket(party._armors, 'armor');

    // 3. 序列化整份存档
    const contentsStr = JsonEx.stringify(contents);
    const byteLen = (typeof Blob !== 'undefined')
      ? new Blob([contentsStr]).size
      : contentsStr.length * 2; // UTF-16 估算
    if (byteLen > CFG.maxBlobBytes) {
      throw new Error('存档过大 (' + Math.round(byteLen / 1024) + ' KB), 超过云端上限 ' + Math.round(CFG.maxBlobBytes / 1024) + ' KB');
    }
    const info = localSlotInfo(savefileId) || {};
    const meta = {
      savefileId,
      source: 'migrate',
      title: info.title || ($dataSystem && $dataSystem.gameTitle) || '',
      playtime: info.playtime || '',
      timestamp: info.timestamp || Date.now(),
      uploadedAt: Date.now(),
      goldSnapshot: gold,
      itemCountSnapshot: items.length,
    };

    // 4. 先写权威资产 (失败直接抛错, blob 都不上传)
    Util.log('info', 'migrate uploading inventory: gold=' + gold + ' items=' + items.length);
    const invRes = await Net.request('inventory.replace', { gold, items, reason: 'migrate' }, 12000);
    Util.log('info', 'migrate inventory replaced: ' + JSON.stringify(invRes));

    // 5. 再写 blob
    return Net.request('save.upload', { contents: contentsStr, meta }, 12000);
  }

  Migrate.uploadSlotToCloud = uploadSlotToCloud;
  Migrate.downloadCloudBlob = downloadCloudBlob;
  Migrate.writeLocalSlotFromString = writeLocalSlotFromString;
  Migrate.maxSlots = maxSlots;

  // ============================================================
  // 1.5 健壮 onAfterLoad: 兜底坏存档里的 null _bgmOnSave / _bgsOnSave
  // ============================================================
  // 现象: 玩家从云端下载存档读取进游戏 → Cannot read property 'name' of null
  //       at AudioManager.playBgm (rmmz_managers.js:1121)
  //       at Game_System.onAfterLoad (rmmz_objects.js:353)
  //
  // 根因: 某次 saveGame 时 $gameSystem._bgmOnSave 被序列化成 null (各种原因都可能 -
  //   云端旧存档、初始云存档、云存档重写时 AudioManager 状态异常等), onAfterLoad
  //   把 null 直接传给 playBgm, playBgm 立刻读 .name 炸.
  //
  // 修复策略: hook Game_System.onAfterLoad, 把 null 变成空音频对象 ({ name:'', vol:0, pitch:0 })
  //   等价于"没在播任何 BGM" 的标准状态. 这样老坏存档也能进游戏.
  //   完成后顺手把 _bgmOnSave / _bgsOnSave 修正成空对象写回, 下次保存就不再坏了.
  if (Game_System && Game_System.prototype && !Game_System.prototype._xsg_safe_onAfterLoad) {
    const _onAfterLoad = Game_System.prototype.onAfterLoad;
    Game_System.prototype.onAfterLoad = function () {
      const empty = { name: '', volume: 0, pitch: 0, pan: 0, pos: 0 };
      if (this._bgmOnSave == null || typeof this._bgmOnSave !== 'object') {
        console.warn('[SaveMigrate] _bgmOnSave was', this._bgmOnSave, '→ replaced with empty audio object');
        this._bgmOnSave = empty;
      }
      if (this._bgsOnSave == null || typeof this._bgsOnSave !== 'object') {
        console.warn('[SaveMigrate] _bgsOnSave was', this._bgsOnSave, '→ replaced with empty audio object');
        this._bgsOnSave = { name: '', volume: 0, pitch: 0, pan: 0, pos: 0 };
      }
      return _onAfterLoad.call(this);
    };
    Game_System.prototype._xsg_safe_onAfterLoad = true;
  }

  // ============================================================
  // 2. DOM 面板
  // ============================================================
  let panelRoot = null;
  let cachedCloud = null; // 缓存最近一次云端 blob (避免反复下载 2MB)

  function ensurePanel() {
    if (panelRoot) return panelRoot;
    panelRoot = document.createElement('div');
    panelRoot.id = 'xsg-savemigrate';
    Object.assign(panelRoot.style, {
      position: 'absolute',
      left: '0', top: '0', right: '0', bottom: '0',
      background: 'rgba(0, 0, 0, 0.55)',
      display: 'none',
      alignItems: 'center', justifyContent: 'center',
      zIndex: '9700',
      fontFamily: 'sans-serif',
      color: '#eee',
    });

    panelRoot.innerHTML = [
      '<div data-modal style="background:#1c1c22;border:1px solid #333;border-radius:10px;width:560px;max-height:80vh;overflow-y:auto;box-shadow:0 6px 32px rgba(0,0,0,.55);padding:18px 22px">',
      '  <div style="font-size:18px;font-weight:bold;letter-spacing:2px;margin-bottom:12px;text-align:center">存档迁移</div>',
      '  <div data-status style="font-size:12px;color:#ffb84d;text-align:center;min-height:18px;margin-bottom:8px"></div>',
      '',
      '  <div style="font-size:14px;color:#a9d8ff;margin:14px 0 6px">📤 本地 → 云端</div>',
      '  <div data-local-list style="border:1px solid #333;border-radius:6px;background:#15151a;padding:6px"></div>',
      '',
      '  <div style="font-size:14px;color:#a9d8ff;margin:14px 0 6px">📥 云端 → 本地</div>',
      '  <div data-cloud-card style="border:1px solid #333;border-radius:6px;background:#15151a;padding:10px 12px;line-height:1.7"></div>',
      '',
      '  <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end">',
      '    <button data-act="refresh" style="padding:6px 14px;background:#3a82ff;color:#fff;border:0;border-radius:4px;cursor:pointer">🔄 刷新</button>',
      '    <button data-act="close"   style="padding:6px 14px;background:#555;color:#fff;border:0;border-radius:4px;cursor:pointer">关闭 (Esc)</button>',
      '  </div>',
      '</div>',
    ].join('');
    document.body.appendChild(panelRoot);

    // 防止点击穿透到底层 RMMZ canvas
    ['mousedown','mouseup','click','pointerdown','pointerup','wheel','contextmenu'].forEach((evt) => {
      panelRoot.addEventListener(evt, (e) => { e.stopPropagation(); });
    });
    panelRoot.addEventListener('click', (e) => {
      // 点击空白处关闭
      if (e.target === panelRoot) closePanel();
    });
    document.addEventListener('keydown', (e) => {
      if (panelRoot.style.display !== 'flex') return;
      if (e.key === 'Escape') {
        e.preventDefault();
        closePanel();
      }
    });

    panelRoot.querySelector('button[data-act=close]').addEventListener('click', closePanel);
    panelRoot.querySelector('button[data-act=refresh]').addEventListener('click', () => refreshPanel({ force: true }));
    return panelRoot;
  }

  function setStatus(text, isError) {
    if (!panelRoot) return;
    const el = panelRoot.querySelector('[data-status]');
    if (!el) return;
    el.textContent = text || '';
    el.style.color = isError ? '#ff7a7a' : '#ffb84d';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (m) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));
  }

  function fmtTimestamp(ts) {
    if (!ts) return '?';
    const d = new Date(ts);
    return d.getFullYear() + '-' +
      String(d.getMonth()+1).padStart(2,'0') + '-' +
      String(d.getDate()).padStart(2,'0') + ' ' +
      String(d.getHours()).padStart(2,'0') + ':' +
      String(d.getMinutes()).padStart(2,'0');
  }

  function renderLocalList() {
    if (!panelRoot) return;
    const wrap = panelRoot.querySelector('[data-local-list]');
    const max = maxSlots();
    const lines = [];
    let nonEmpty = 0;
    for (let i = 1; i <= max; i++) {
      const exists = localSlotExists(i);
      const info = exists ? localSlotInfo(i) : null;
      if (!exists) continue;
      nonEmpty++;
      const playtime = info && info.playtime ? info.playtime : '?';
      const ts = info && info.timestamp ? fmtTimestamp(info.timestamp) : '?';
      const title = info && info.title ? escapeHtml(info.title) : '(无标题)';
      lines.push(
        `<div data-slot="${i}" style="display:flex;align-items:center;padding:6px 8px;border-bottom:1px solid #2a2a2e">
          <div style="width:42px;color:#ffd13a;font-weight:bold">槽${i}</div>
          <div style="flex:1;font-size:12px;line-height:1.4">
            <div>${title}</div>
            <div style="color:#888">⏱ ${escapeHtml(playtime)}　 ${escapeHtml(ts)}</div>
          </div>
          <button data-upload="${i}" style="padding:4px 10px;background:#2c9c4a;color:#fff;border:0;border-radius:3px;cursor:pointer">📤 上传</button>
        </div>`
      );
    }
    if (nonEmpty === 0) {
      lines.push('<div style="padding:12px;text-align:center;color:#888">没有找到本地存档（save/file*.rmmzsave）</div>');
    }
    wrap.innerHTML = lines.join('');
    wrap.querySelectorAll('button[data-upload]').forEach((btn) => {
      btn.addEventListener('click', () => onUploadClick(Number(btn.dataset.upload)));
    });
  }

  function renderCloudCard() {
    if (!panelRoot) return;
    const card = panelRoot.querySelector('[data-cloud-card]');
    if (!Core.isOnline()) {
      card.innerHTML = `
        <div style="color:#ffb84d">未登录联机服务器</div>
        <div style="margin-top:6px;color:#888;font-size:12px">请先点标题界面右上角的「联机」按钮登录, 或按 M 键。</div>`;
      return;
    }
    if (cachedCloud === undefined) {
      card.innerHTML = `<div style="color:#888">正在查询...</div>`;
      return;
    }
    if (cachedCloud === null) {
      card.innerHTML = `<div style="color:#888">云端暂无该角色的存档</div>`;
      return;
    }
    const m = cachedCloud.meta || {};
    const ts = cachedCloud.ts ? fmtTimestamp(cachedCloud.ts) : '?';
    const playtime = m.playtime || '?';
    const title = m.title || '(无 title)';
    const sourceTag = m.source === 'migrate' ? ' <span style="color:#5dd55d">[迁移]</span>' : '';
    const sizeKb = cachedCloud.contents ? Math.round(cachedCloud.contents.length / 1024) : 0;

    const max = maxSlots();
    const slotOpts = [];
    for (let i = 1; i <= max; i++) {
      const occupied = localSlotExists(i);
      const tip = occupied ? '（已有存档, 会覆盖）' : '（空）';
      slotOpts.push(`<option value="${i}">槽 ${i} ${tip}</option>`);
    }

    card.innerHTML = `
      <div style="font-size:13px"><b>${escapeHtml(title)}</b>${sourceTag}</div>
      <div style="color:#888;font-size:12px">⏱ ${escapeHtml(playtime)}　 上传时间 ${escapeHtml(ts)}　 大小 ${sizeKb} KB</div>
      <div style="margin-top:10px;display:flex;align-items:center;gap:8px">
        <span>下载到</span>
        <select data-target-slot style="padding:4px 6px;background:#222;color:#eee;border:1px solid #444;border-radius:3px">${slotOpts.join('')}</select>
        <button data-act="download" style="padding:4px 12px;background:#3a82ff;color:#fff;border:0;border-radius:3px;cursor:pointer">📥 下载</button>
      </div>
    `;
    card.querySelector('button[data-act=download]').addEventListener('click', () => {
      const slot = Number(card.querySelector('[data-target-slot]').value || 1);
      onDownloadClick(slot);
    });
  }

  function setBusy(b) {
    if (!panelRoot) return;
    panelRoot.querySelectorAll('button').forEach((btn) => {
      if (btn.dataset.act === 'close') return; // close 始终可用
      btn.disabled = !!b;
      btn.style.opacity = b ? '0.45' : '1';
      btn.style.cursor = b ? 'default' : 'pointer';
    });
  }

  function refreshPanel({ force } = {}) {
    if (!panelRoot) return;
    renderLocalList();
    if (!Core.isOnline()) {
      cachedCloud = null;
      renderCloudCard();
      return;
    }
    if (force || cachedCloud === undefined || cachedCloud == null) {
      cachedCloud = undefined; // loading state
      renderCloudCard();
      probeCloudExists()
        .then((r) => {
          if (!r.ok) { cachedCloud = null; renderCloudCard(); return; }
          if (!r.exists) { cachedCloud = null; renderCloudCard(); return; }
          return downloadCloudBlob().then((blob) => {
            cachedCloud = blob;
            renderCloudCard();
          });
        })
        .catch((err) => {
          cachedCloud = null;
          renderCloudCard();
          setStatus('查询云存档失败: ' + (err && err.message || err), true);
        });
    } else {
      renderCloudCard();
    }
  }

  function openPanel() {
    ensurePanel();
    panelRoot.style.display = 'flex';
    setStatus('');
    refreshPanel();
  }
  Migrate.open = openPanel;

  function closePanel() {
    if (panelRoot) panelRoot.style.display = 'none';
  }
  Migrate.close = closePanel;

  // ------------------------------------------------------------
  // 3. 操作回调
  // ------------------------------------------------------------
  async function onUploadClick(savefileId) {
    if (!Core.isOnline()) {
      setStatus('未登录, 无法上传', true);
      return;
    }
    if (!localSlotExists(savefileId)) {
      setStatus('槽 ' + savefileId + ' 是空的', true);
      return;
    }
    const overwriteCloud = !!cachedCloud;
    const ok = window.confirm(
      overwriteCloud
        ? '会覆盖当前角色的云存档（你账号上唯一的一份云档）, 继续吗？'
        : '把槽 ' + savefileId + ' 上传到云端？'
    );
    if (!ok) return;
    setBusy(true);
    setStatus('正在上传槽 ' + savefileId + '...');
    try {
      const res = await uploadSlotToCloud(savefileId);
      setStatus('上传成功！时间戳 ' + fmtTimestamp(res && res.ts), false);
      // 刷新云端缓存
      cachedCloud = undefined;
      refreshPanel({ force: true });
    } catch (err) {
      setStatus('上传失败: ' + ((err && err.message) || err), true);
    } finally {
      setBusy(false);
    }
  }

  async function onDownloadClick(targetSlot) {
    if (!Core.isOnline()) {
      setStatus('未登录, 无法下载', true);
      return;
    }
    if (!cachedCloud) {
      setStatus('云端没有存档', true);
      return;
    }
    if (localSlotExists(targetSlot)) {
      const ok = window.confirm('槽 ' + targetSlot + ' 已有存档, 下载后会覆盖, 继续吗？');
      if (!ok) return;
    }
    setBusy(true);
    setStatus('正在下载...');
    try {
      // 用最新的 cachedCloud 直接写; 但保险起见再下载一次
      const blob = await downloadCloudBlob();
      if (!blob) throw new Error('云端忽然没了');
      await writeLocalSlotFromString(targetSlot, blob.contents);
      cachedCloud = blob;
      setStatus('下载完成 → 本地槽 ' + targetSlot + '. 回到标题界面即可读取', false);
      renderLocalList();
    } catch (err) {
      setStatus('下载失败: ' + ((err && err.message) || err), true);
    } finally {
      setBusy(false);
    }
  }

  // ============================================================
  // 4. Scene_Title 浮动按钮
  // ============================================================
  let titleBtn = null;
  let keyBound = false;

  function buildTitleButton() {
    titleBtn = document.createElement('button');
    titleBtn.id = 'xsg-savemigrate-entry';
    titleBtn.textContent = CFG.btnText + (CFG.hotkey ? '（' + CFG.hotkey + '）' : '');
    Object.assign(titleBtn.style, {
      position: 'absolute',
      right: '14px', top: '64px',  // 在「联机」按钮下方
      padding: '8px 18px',
      fontSize: '15px',
      fontWeight: 'bold',
      background: 'linear-gradient(135deg, #6a4dd0 0%, #d04dc0 100%)',
      color: '#fff', border: '0', borderRadius: '8px',
      cursor: 'pointer', zIndex: '8990',
      boxShadow: '0 4px 14px rgba(0,0,0,0.5)',
      letterSpacing: '1px',
      transition: 'transform 80ms ease-out',
      display: 'none',
    });
    ['mousedown','mouseup','pointerdown','pointerup'].forEach((evt) => {
      titleBtn.addEventListener(evt, (e) => { e.stopPropagation(); if (e.preventDefault) e.preventDefault(); });
    });
    titleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.preventDefault) e.preventDefault();
      openPanel();
    });
    titleBtn.addEventListener('mouseenter', () => { titleBtn.style.transform = 'scale(1.05)'; });
    titleBtn.addEventListener('mouseleave', () => { titleBtn.style.transform = 'scale(1)'; });
    document.body.appendChild(titleBtn);
  }

  function bindKey() {
    if (keyBound) return;
    keyBound = true;
    document.addEventListener('keydown', (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      if (!(SceneManager._scene instanceof Scene_Title)) return;
      if (CFG.hotkey && e.key && e.key.toUpperCase() === CFG.hotkey) {
        e.preventDefault();
        openPanel();
      }
    });
  }

  if (CFG.showOnTitle) {
    const _Scene_Title_start = Scene_Title.prototype.start;
    Scene_Title.prototype.start = function () {
      _Scene_Title_start.call(this);
      if (!titleBtn) buildTitleButton();
      titleBtn.style.display = 'block';
      bindKey();
    };
    const _Scene_Title_terminate = Scene_Title.prototype.terminate;
    Scene_Title.prototype.terminate = function () {
      if (titleBtn) titleBtn.style.display = 'none';
      closePanel();
      _Scene_Title_terminate.call(this);
    };
  }

  // ============================================================
  // 5. 集成到「已登录」联机菜单 (Scene_OnlineMenu, Login 插件提供)
  // ============================================================
  if (CFG.showInOnlineMenu) {
    // Scene_OnlineMenu 是 Login 插件内部定义的, 通过 hook Window_OnlineMenuCommand
    // 的 makeCommandList 来加新条目, 同时给 Scene_OnlineMenu 加 handler.
    function tryPatchOnlineMenu() {
      const W = window.Window_OnlineMenuCommand;
      const S = window.Scene_OnlineMenu;
      if (!W || !S) return false;
      if (W.prototype._xsg_migrate_patched) return true;
      W.prototype._xsg_migrate_patched = true;

      const _makeList = W.prototype.makeCommandList;
      W.prototype.makeCommandList = function () {
        // 原版顺序: enter, logout, cancel
        // 我们想插在 logout 之前
        const orig = _makeList ? _makeList : function () {};
        // 执行原版生成命令
        orig.call(this);
        // 找到 logout 位置插入
        const list = this._list || [];
        const idx = list.findIndex((c) => c && c.symbol === 'logout');
        const cmd = { name: '存档迁移', symbol: 'xsgMigrate', enabled: true, ext: null };
        if (idx >= 0) list.splice(idx, 0, cmd);
        else list.push(cmd);
      };

      const _create = S.prototype.create;
      S.prototype.create = function () {
        _create.call(this);
        if (this._commandWindow) {
          this._commandWindow.setHandler('xsgMigrate', () => {
            // 关掉菜单后弹 Migrate 面板; 关闭后回到 OnlineMenu
            this._commandWindow.deactivate();
            openPanel();
            // 当 panel 关闭, 重新激活命令
            const reactivate = () => {
              if (panelRoot && panelRoot.style.display === 'none') {
                if (this._commandWindow) this._commandWindow.activate();
                document.removeEventListener('click', reactivate, true);
                clearInterval(intv);
              }
            };
            const intv = setInterval(reactivate, 250);
          });
        }
      };

      // 由于 Window_Command 在 makeCommandList 之前已 setupSize, 重做高度计算
      const _commandWindowRect = S.prototype.commandWindowRect;
      if (_commandWindowRect) {
        S.prototype.commandWindowRect = function () {
          // 让 4 行也能装下 (原本 3 行)
          const r = _commandWindowRect.call(this);
          if (this.calcWindowHeight) {
            r.height = this.calcWindowHeight(4, true);
            r.y = Math.floor((Graphics.boxHeight - r.height) / 2);
          }
          return r;
        };
      }
      return true;
    }
    // Login 插件加载顺序在我们前面, 但 Scene_OnlineMenu/Window 是 Login 模块内的
    // 全局变量, 应在 Login IIFE 执行后立即可见; 兜底用 setTimeout 异步重试一次
    if (!tryPatchOnlineMenu()) {
      setTimeout(tryPatchOnlineMenu, 0);
    }
  }

  Util.log('info', 'SaveMigrate plugin loaded; hotkey=' + CFG.hotkey);
})();
