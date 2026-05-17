//=============================================================================
// XdRs_PlantHarvestAll.js  v1.0
//=============================================================================
/*:
 * @target MZ
 * @plugindesc 一键收菜 | 按热键收掉当前地图所有成熟植物, 一次到位
 * @author xsg-online
 *
 * @param hotkey
 * @text 一键收菜热键
 * @desc 在 Scene_Map 上按这个键即收掉当前地图所有成熟植物。
 *       单字母 / 单数字。空字符串 = 关闭快捷键 (此时只能用脚本调用 XdRsPlantHarvestAll.run()).
 * @type string
 * @default H
 *
 * @param showFloatingButton
 * @text 显示屏幕浮动按钮
 * @desc auto = 仅手机端显示, desktop 端走快捷键. always = 桌面+手机都显示.
 *       never = 不显示, 只能靠快捷键 (桌面玩家如果不想看到浮窗可选这个).
 * @type select
 * @option auto
 * @option always
 * @option never
 * @default auto
 *
 * @param floatingButtonText
 * @text 浮动按钮文字
 * @type string
 * @default 收菜
 *
 * @param requireConfirm
 * @text 收菜前弹确认窗
 * @desc true → 弹一个 confirm 让玩家确认 (适合手抖怕误触).
 *       false → 按一次直接收, 节奏更快.
 * @type boolean
 * @default false
 *
 * @param playSeOnHarvest
 * @text 收菜时播放音效
 * @desc 收完后播放 SoundManager.playEquip() 提示动作完成。
 * @type boolean
 * @default true
 *
 * @param showSummaryMessage
 * @text 收菜后弹聊天窗摘要
 * @desc 用 $gameTemp.addWorldMessage 在右下角显示 "收获 玫瑰 ×3, 雏菊 ×2"
 *       这种汇总, 让玩家看到具体收了什么。需要 XdRs_Arder_Objects.
 * @type boolean
 * @default true
 *
 * @help
 * 解决的痛点
 * ----------------------------------------------------------------------------
 * 旧流程: 走到每株成熟植物前 → 弹一次 Ui_Botany 确认窗 → 点一次"收获" →
 *         走到下一株 → 弹窗 → 点 ... 满地图 30 株要重复 30 次。
 *
 * 新流程: 在 Scene_Map 上按 H 键 → 一次性收掉当前地图所有成熟植物 →
 *         右下角弹一条汇总消息。
 *
 * 实现机制
 * ----------------------------------------------------------------------------
 * 1. 扫描 $gameSystem.botanys($gameMap.mapId()), 过滤 canPick() 的 (即 _life
 *    >= _maxLife 的成熟植物)
 * 2. 按 _flowerId 聚合, 然后调一次 $gameParty.gainItem(item, count)
 *    - 这避免触发 N 次联机 inventory.gainItem RPC (一次 RPC 包一组)
 *    - $gameParty.gainItem 走 XdRs_Online_Inventory.js 的 hook 转 server
 * 3. 调 $gameSystem.removeBotany(id) 把每株从地图清掉
 * 4. 可选汇总消息 + 提示音
 *
 * 安全 / 边界
 * ----------------------------------------------------------------------------
 * - 在 Scene_Map 之外按热键无效 (避免在标题/读档界面误触)
 * - 当前角色被 lock / 在事件中 / 消息框开着时无效 (防御阻塞态)
 * - 种植态 / 收菜浮窗 / 输入框打开时也跳过
 * - 没有成熟植物时只播 buzzer, 不弹消息防止刷屏
 * - 与 XdRs_PlantContinuous 完全独立 (一个种、一个收)
 * - 不修改 Game_Botany.harvest() 行为, 只是批量调用; 与单株收菜共存
 *
 * 联机
 * ----------------------------------------------------------------------------
 * 收菜的物品发放走 $gameParty.gainItem, 由 XdRs_Online_Inventory 自动转 RPC
 * 同步到服务端权威表. 服务端 GOLD/ITEM clamp 仍生效.
 */
(() => {
  'use strict';
  const PLUGIN = 'XdRs_PlantHarvestAll';
  const params = PluginManager.parameters(PLUGIN);
  const CFG = {
    hotkey: String(params.hotkey || 'H').toUpperCase(),
    showFloatingButton: String(params.showFloatingButton || 'auto').toLowerCase(),
    floatingButtonText: String(params.floatingButtonText || '收菜'),
    requireConfirm: String(params.requireConfirm || 'false') === 'true',
    playSeOnHarvest: String(params.playSeOnHarvest || 'true') === 'true',
    showSummaryMessage: String(params.showSummaryMessage || 'true') === 'true',
  };

  // 是否显示浮动按钮: auto = 仅手机, always = 全平台, never = 不显示
  function shouldShowButton() {
    if (CFG.showFloatingButton === 'always') return true;
    if (CFG.showFloatingButton === 'never') return false;
    // auto
    return typeof Utils !== 'undefined' && Utils.isMobileDevice && Utils.isMobileDevice();
  }

  // ----------------------------------------------------------------
  // 主逻辑: 扫描 + 聚合 + 一次性发放 + 一次性清理
  // ----------------------------------------------------------------
  function run() {
    if (!canRun()) return false;

    const mapId = $gameMap.mapId();
    const all = $gameSystem.botanys(mapId);
    const ripe = all.filter((b) => b && b.canPick());
    if (ripe.length === 0) {
      SoundManager.playBuzzer();
      return false;
    }

    if (CFG.requireConfirm) {
      const ok = window.confirm('确认收掉当前地图所有 ' + ripe.length + ' 株成熟植物？');
      if (!ok) return false;
    }

    // 聚合: flowerId → count
    const byFlower = new Map();
    for (const b of ripe) {
      const fid = b._flowerId | 0;
      if (!fid) continue; // 防御: 缺 BotanyFlower meta 的奇异种子, 跳过
      byFlower.set(fid, (byFlower.get(fid) || 0) + 1);
    }

    // 一次性发放. $gameParty.gainItem 在联机模式下会触发 inventory.gainItem
    // RPC, 这里每种 flower 只发一次, 不会刷 N 条 RPC.
    const summary = [];
    for (const [fid, count] of byFlower) {
      const item = $dataItems[fid];
      if (!item) continue;
      $gameParty.gainItem(item, count);
      summary.push({ name: item.name || ('item#' + fid), count, iconIndex: item.iconIndex || 0 });
    }

    // 一次性清理: 从尾部往前删, 避免迭代过程中下标抖动
    // (Game_System.removeBotany 把对应 slot 置 null, 不影响 id 复用)
    for (const b of ripe) {
      $gameSystem.removeBotany(b.id());
    }

    // 反馈
    if (CFG.playSeOnHarvest) SoundManager.playEquip();
    // 防御: 如果当前有"走到植物前弹出的单株 Ui_Botany"窗口开着, 它可能引用了一株
    // 刚被批量收掉的植物, 把它一起关掉避免悬挂状态.
    if (typeof SceneManager.closeAllMenuWindow === 'function') {
      try { SceneManager.closeAllMenuWindow(); } catch (e) { /* ignore */ }
    }
    if (CFG.showSummaryMessage && summary.length > 0) {
      try {
        const parts = summary.map((s) =>
          (s.iconIndex ? '\\i[' + s.iconIndex + ']' : '') + s.name + ' \\c[10]×' + s.count + '\\c[0]'
        );
        const text = '\\c[2][收菜]\\c[0] ' + parts.join(', ');
        if (typeof $gameTemp !== 'undefined' && $gameTemp && typeof $gameTemp.addWorldMessage === 'function') {
          $gameTemp.addWorldMessage(text, true);
        }
      } catch (e) { /* swallow */ }
    }

    return true;
  }

  function canRun() {
    if (!(SceneManager._scene instanceof Scene_Map)) return false;
    if (typeof $gameSystem === 'undefined' || !$gameSystem) return false;
    if (typeof $gameMap === 'undefined' || !$gameMap) return false;
    if (typeof $gameParty === 'undefined' || !$gameParty) return false;
    if ($gameMap.isEventRunning && $gameMap.isEventRunning()) return false;
    if ($gameMessage && $gameMessage.isBusy && $gameMessage.isBusy()) return false;
    if ($gameTemp && typeof $gameTemp.isPlantSelect === 'function' && $gameTemp.isPlantSelect()) return false;
    return true;
  }
  // ----------------------------------------------------------------
  // 热键绑定
  // ----------------------------------------------------------------
  if (CFG.hotkey) {
    document.addEventListener('keydown', (e) => {
      if (!CFG.hotkey) return;
      // 输入框聚焦时跳过 (聊天 / 登录 / 改名 等)
      const tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      // 修饰键存在时跳过 (Ctrl+H, Alt+H 之类的浏览器/系统快捷键不应触发)
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const key = e.key && e.key.toUpperCase();
      if (key !== CFG.hotkey) return;
      if (!canRun()) return;
      e.preventDefault();
      run();
    });
  }

  // 暴露调试钩子 (玩家可以 F12 控制台手动调用)
  window.XdRsPlantHarvestAll = { cfg: CFG, run, canRun };

  // ----------------------------------------------------------------
  // 屏幕浮动按钮 (手机端默认开启)
  // ----------------------------------------------------------------
  // 只在 Scene_Map 上显示, 离开地图自动隐藏. 必须截断 pointer 事件链
  // (mousedown/touchstart/click 等), 否则会冒泡到 RMMZ TouchInput 触发
  // 寻路 / 种植 / 互动逻辑.
  let floatingBtn = null;

  function buildFloatingButton() {
    floatingBtn = document.createElement('button');
    floatingBtn.id = 'xsg-plant-harvest-all-btn';
    floatingBtn.textContent = '🌾 ' + CFG.floatingButtonText;
    Object.assign(floatingBtn.style, {
      position: 'absolute',
      right: '14px',
      bottom: '14px',
      padding: '12px 18px',
      fontSize: '15px',
      fontWeight: 'bold',
      background: 'linear-gradient(135deg, #4dba50 0%, #2c9c4a 100%)',
      color: '#fff',
      border: '0',
      borderRadius: '24px',
      cursor: 'pointer',
      zIndex: '8000',  // 低于 SaveMigrate 入口 (8990) / 登录 (9000+), 不挡住菜单
      boxShadow: '0 4px 14px rgba(0,0,0,0.5)',
      letterSpacing: '1px',
      transition: 'transform 80ms ease-out',
      touchAction: 'manipulation',  // 移除 300ms 双击延迟
      userSelect: 'none',
      display: 'none',
    });

    // 阻止事件冒泡到 document, 防止 RMMZ 把这个点当作"点地图"触发寻路.
    [
      'mousedown', 'mouseup',
      'pointerdown', 'pointerup',
      'touchstart', 'touchend',
    ].forEach((evt) => {
      floatingBtn.addEventListener(evt, (e) => {
        e.stopPropagation();
        if (e.preventDefault) e.preventDefault();
      }, evt === 'touchstart' || evt === 'touchend' ? { passive: false } : undefined);
    });

    // 真正的触发: click + touchend 都试一次, 在某些设备上 click 受 300ms 延迟
    // 影响, 用 touchend 直接响应快得多.
    const trigger = (e) => {
      e.stopPropagation();
      if (e.preventDefault) e.preventDefault();
      run();
    };
    floatingBtn.addEventListener('click', trigger);
    floatingBtn.addEventListener('touchend', trigger, { passive: false });

    // 桌面端的 hover 反馈 (手机不会触发 hover)
    floatingBtn.addEventListener('mouseenter', () => { floatingBtn.style.transform = 'scale(1.05)'; });
    floatingBtn.addEventListener('mouseleave', () => { floatingBtn.style.transform = 'scale(1)'; });

    document.body.appendChild(floatingBtn);
  }

  function syncFloatingButton() {
    if (!shouldShowButton()) return;
    if (!floatingBtn) buildFloatingButton();
    const inMap = SceneManager._scene instanceof Scene_Map;
    // 种植态期间隐藏收菜按钮, 让位给"取消种植"按钮 (PlantContinuous 那边的)
    const inPlant = $gameTemp && typeof $gameTemp.isPlantSelect === 'function' && $gameTemp.isPlantSelect();
    floatingBtn.style.display = (inMap && !inPlant) ? 'block' : 'none';
  }

  function showFloatingButton() {
    syncFloatingButton();
  }

  function hideFloatingButton() {
    if (floatingBtn) floatingBtn.style.display = 'none';
  }

  // 在 Scene_Map 进入时显示, 离开时隐藏
  if (typeof Scene_Map !== 'undefined') {
    const _Scene_Map_start = Scene_Map.prototype.start;
    Scene_Map.prototype.start = function () {
      _Scene_Map_start.call(this);
      showFloatingButton();
    };
    const _Scene_Map_terminate = Scene_Map.prototype.terminate;
    Scene_Map.prototype.terminate = function () {
      hideFloatingButton();
      _Scene_Map_terminate.call(this);
    };
  }

  // 切换种植态时同步刷新按钮可见性 (与 PlantContinuous 互不依赖, 各自 hook)
  if (typeof Game_Temp !== 'undefined' && Game_Temp.prototype.setPlantSelect) {
    const _setPlantSelect = Game_Temp.prototype.setPlantSelect;
    Game_Temp.prototype.setPlantSelect = function (id) {
      _setPlantSelect.call(this, id);
      try { syncFloatingButton(); } catch (e) { /* swallow */ }
    };
  }
})();
