//=============================================================================
// XdRs_PlantContinuous.js  v1.0
//=============================================================================
/*:
 * @target MZ
 * @plugindesc 种植连发 | 选种后保留种植态, 可连续点种, 右键 / 种子用完才退出
 * @author xsg-online
 *
 * @param keepCursorOnEmpty
 * @text 种子耗尽时是否保留种植态
 * @desc 默认 false → 种子用完后自动退出种植态。
 *       true → 仍保留, 玩家可手动右键退出 (鼠标贴图会一直挂着, 不推荐)。
 * @type boolean
 * @default false
 *
 * @param playSeOnExit
 * @text 自动退出时播放取消音效
 * @desc 种子用完自动退出时, 是否播放 SoundManager.playCancel().
 *       默认 true. 玩家能听到"咔"声知道动作结束。
 * @type boolean
 * @default true
 *
 * @help
 * 解决的痛点
 * ----------------------------------------------------------------------------
 * 旧流程: 开背包 → 选种子 → 点地图种 1 个 → 自动退出种植态 → 还要再开背包 →
 *         再选种子 → 再点 → 退出 ... 想种 20 个就要重复 20 次"开包-选种"
 *
 * 新流程: 开背包 → 选种子 → 进入种植态 → 在地图上连续左键点点点, 把背包
 *         里所有这种种子一次种完 → 右键取消 (或种子用完自动退) 退出
 *
 * 实现机制
 * ----------------------------------------------------------------------------
 * Hook Scene_Map.prototype.plant: 复用原版 90% 的判定 (canPlant / 扣种子 /
 *   播放音效 / 注册 botany), 只把"成功后立刻 setPlantSelect()"那行移除.
 *
 * 退出条件 (满足任一就退出种植态):
 *   1. 玩家右键 (TouchInput.isCancelled): 走原版 updateDestination 里的逻辑
 *      不需要本插件干预
 *   2. 种子已耗尽 (numItems === 0): 自动退出 + 可选播放 cancel 音效
 *   3. 移除/卖掉了背包里那个种子, 触发其他剧情等: 同 2
 *
 * 兼容性
 * ----------------------------------------------------------------------------
 * - 与 XdRs_Arder_Scene 兼容 (本插件晚于其加载, hook 链正常)
 * - 与 XdRs_TimeOffline / XdRs_Online_* 完全独立
 * - 无新存档字段, 卸载即恢复原版行为
 */
(() => {
  'use strict';
  const PLUGIN = 'XdRs_PlantContinuous';
  const params = PluginManager.parameters(PLUGIN);
  const CFG = {
    keepCursorOnEmpty: String(params.keepCursorOnEmpty || 'false') === 'true',
    playSeOnExit: String(params.playSeOnExit || 'true') === 'true',
  };

  // 原版 Scene_Map.plant 在 XdRs_Arder_Scene.js:183 处定义.
  // 我们直接重写, 保留原行为但去掉"种完立即退出"那一步.
  // 注意: 必须晚于 XdRs_Arder_Scene 加载, 见 plugins.js 顺序.
  if (typeof Scene_Map === 'undefined' || !Scene_Map.prototype.plant) {
    console.warn('[PlantContinuous] Scene_Map.plant not found; XdRs_Arder_Scene missing?');
    return;
  }

  Scene_Map.prototype.plant = function () {
    if (!$gameTemp.isPlantSelect()) return false;
    if (SceneManager.isHoveredSomeMenuWindow()) return false;

    const x = $gameMap.canvasToMapX(TouchInput.x);
    const y = $gameMap.canvasToMapY(TouchInput.y);
    if (!$gameMap.canPlant(x, y)) {
      SoundManager.playBuzzer();
      return false;
    }

    const id = $gameTemp._plantSelectId;
    if (!id) return false;
    const item = $dataItems[id];
    if (!item) return false;

    SoundManager.playUseItem();
    $gameSystem.addBotany(x, y, id);
    $gameParty.loseItem(item, 1);

    // 关键差异: 种完后**不**调用 $gameTemp.setPlantSelect(), 让玩家继续种.
    //
    // 退出条件:
    //   - 种子已耗尽 → 自动退出 (除非配置 keepCursorOnEmpty)
    //   - 玩家右键 → 由 Scene_Map.updateDestination 内 isCancelled 分支处理
    if (!CFG.keepCursorOnEmpty && $gameParty.numItems(item) <= 0) {
      $gameTemp.setPlantSelect();
      if (CFG.playSeOnExit) SoundManager.playCancel();
    }

    return true;
  };
})();
