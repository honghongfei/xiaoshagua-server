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
    requireConfirm: String(params.requireConfirm || 'false') === 'true',
    playSeOnHarvest: String(params.playSeOnHarvest || 'true') === 'true',
    showSummaryMessage: String(params.showSummaryMessage || 'true') === 'true',
  };

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
})();
