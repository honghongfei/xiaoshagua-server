# 本体宝宝·在线挂机采集 + 联机可见设计（Native Pet AFK Gather + Online Visibility）

- 日期：2026-06-19
- 状态：待用户审查（实现前定稿）
- 范围：客户端联机插件（`xiaoshagua/js/plugins`，镜像到 `xiaoshagua-server/client-plugins/`）；② 含极小服务端透传（`server/src/domain/world`）
- 一句话：让 RMMZ 原生跟随者（本体「宝宝」，由 `XdRs_Arder_*`「宠物休闲工程」驱动）在 ① 窗口失焦/挂后台时继续自动采集，并 ② 被同图其他玩家看见。
- 关联：③ 地上物云端共享见 `2026-06-19-cloud-shared-gather-design.md`（本设计的 ①② 不依赖 ③，可独立落地；③ 落地后采集结算会改走服务端，见该文）。

## 1. 背景与问题

「宝宝」澄清：用户指的不是自研 `XdRs_Online_Pet.js`，而是**本体自带**的 `XdRs_Arder_*`「宠物休闲工程」宠物。已读源码确认其真身与现状：

- **本体宝宝 = RMMZ 原生 `Game_Follower`**（队伍跟随者）。`XdRs_Arder_Objects.js`：
  - `Game_Follower.seekResource()`（:649）在 `view` 半径内找最近的资源事件（`Game_Map.getResource` :555-566）。
  - `Game_Follower.updatePickup()`（:669）自动寻路走到资源、到点 `event.start()` 触发采集。
- 采集结算走 `XdRs_GatherAsync.js`「非阻塞采集」channeling，最终 `$gameParty.gainItem()`——**纯本地客户端**。
- **失焦冻结根因**：`SceneManager.updateScene`（`js/rmmz_managers.js:2093-2105`）内 `if (this.isGameActive())` 才 `_scene.update()`；`isGameActive()`（:2107-2115）= `window.top.document.hasFocus()`。失焦 → `Scene_Map.update()` 整段跳过 → 宝宝的移动与采集停摆。
- **现状已是「半 update」**：`XdRs_Arder_Core.js:320-326` 已包裹 `updateScene`，把 `$gameSystem.updateBotanyLife()`（植物成长）放在门控**之外**，失焦也跑；但宝宝采集仍在被门控的 `Scene_Map.update()` 内。
- 主循环本身未被后台节流：`package.json` 的 `chromium-args` 已含 `--disable-background-timer-throttling --disable-renderer-backgrounding` 等。
- **联机可见现状**：`XdRs_Online_PlayerSync.js` / `XdRs_Online_Core.js` 中**搜不到任何 follower 同步**——远端只同步主角，看不到本体宝宝。

痛点：① 玩家想挂后台让宝宝自动采集，失焦即停；② 别人看不到自己的宝宝，缺乏联机观赏/社交感。

## 2. 目标 / 非目标

**目标**

- ① 客户端**在线**且当前在 `Scene_Map` 时，窗口失焦/挂后台，宝宝继续自动 seek + 采集；其余场景（菜单/战斗/标题）维持原生失焦冻结。
- ① 提供玩家可关的总开关（默认开），随存档持久化；可选失焦降帧省电。
- ② 把本机**可见**的 `Game_Follower` 广播给同图玩家，并在本机渲染他人的宝宝（位置、贴图、朝向、进化形象）。
- ② 最大化复用现有玩家同步链路（`player.move` / `player.enterMap` / `world.delta`），不新增协议族。

**非目标（YAGNI）**

- 不做「关闭游戏也采集」（用户明确否定）；离线采集不在本设计。
- 不做采集结算服务端化（那是 ③ 的事；本设计 ① 采集仍本地结算，③ 落地后再切）。
- 不做宝宝战斗/属性/AI 重写——只复用 Arder 现有跟随者采集 AI。
- ② 不持久化宝宝位置（重连由 owner 重新广播重建）。

## 3. 关键决策（默认，待用户确认）

- **门控放行条件**：`Net.isConnected() && scene instanceof Scene_Map && afkGatherEnabled()` 三者皆真才放行失焦 update。任一不满足回退原生冻结。
- **承载方式**：新增独立插件 `XdRs_AfkGather.js`（plugins.js 顺序放在 Arder 之后、Online 系列之后），避免改动 Arder/核心；纯 hook。
- **降帧**：默认满帧；提供 `afkFpsDivider`（默认 1=满帧），失焦时每 N 帧才 `Graphics.render`，逻辑照 tick。
- **② 广播形态**：宝宝位置**挂载**进现有 `player.move` / `player.enterMap` 负载的 `followers` 字段，不开新事件；服务端原样透传（或轻校验）。
- **② 渲染**：新增 `Sprite_OtherFollower`（≈ `Sprite_OtherPlayer` 去名字标签）。
- **② 可见性过滤**：仅 `follower.isVisible()`（Arder：`actor().isFollow()`）的宝宝才广播/渲染。

## 4. ① 在线挂机采集（焦点门控）

### 4.1 组件
新增 `XdRs_AfkGather.js`：

```js
(() => {
  const _active = SceneManager.isGameActive;
  SceneManager.isGameActive = function () {
    const N = window.XdRsOnline && window.XdRsOnline.Net;
    if (N && N.isConnected()
        && this._scene instanceof Scene_Map
        && $gameSystem && $gameSystem.afkGatherEnabled && $gameSystem.afkGatherEnabled()) {
      return true; // 在线 + 地图 + 开关开 → 失焦也 update
    }
    return _active.call(this);
  };
})();
```

- `Game_System.prototype.afkGatherEnabled()`：读 `this._afkGather !== false`（默认开）；配套 setter + 设置项入口；随存档序列化（`Game_System` 自动随存档保存）。

### 4.2 数据流（失焦时）
主循环（未被节流）→ `SceneManager.updateMain`（rmmz_managers:1938/2052）→ `updateScene` → 门控放行 → `Scene_Map.update()` → `$gameMap/$gamePlayer.update` → `Game_Follower.update → updatePickup → seekResource`（Arder_Objects:649/669）→ 命中 `<Resource>` 事件 → `GatherAsync` 非阻塞 `gainItem`。

### 4.3 降帧省电（可选）
在 `SceneManager.updateMain` 或 `renderScene` 处，对「失焦 + 放行」状态按 `afkFpsDivider` 跳过部分 `Graphics.render()`（只跳渲染、不跳逻辑 update）。设计为可配置，默认不启用以免影响观感。

### 4.4 边界 / 风险
- **仅放行 Scene_Map**：切菜单/战斗/读条/标题自动恢复冻结（`instanceof` 判定）。
- **输入**：失焦本就收不到键鼠；宝宝采集是自动 `event.start()`，不依赖输入。**实现时验证** `GatherAsync` 无「等待玩家输入」阻塞分支。
- **断线回退**：`Net.isConnected()` 转 false 后失焦即回原生冻结。
- **插件冲突**：已核仅 `XdRs_Arder_Core.js:320-326` hook 了 `updateScene`、无其它插件改 `isGameActive`，本 hook 安全叠加。
- **多开**：`XdRs_Online_MultiInstance.js` 已隔离存档/登录；各实例各采本地资源，互不影响（③ 共享后由服务端按账号兜底，见 ③ 文）。

## 5. ② 本体宝宝联机可见

### 5.1 复用的现成地基（已核源码）
- 本机上报：`Net.emit('player.move', {x,y,d,ts})` 5Hz 节流、变格/转向才发（`PlayerSync.js:120-134`）；`player.enterMap {mapId,x,y,d,charSet,charIndex}` 带贴图（:159-164），ack 返回 `others` 快照。
- 远端渲染：`Sprite_OtherPlayer(view)` + `applyRemoteMove(x,y,d)`，挂进 `spriteset._characterSprites/_tilemap`（`addOther` :180-194）。
- 驱动：`Net.on('world.delta', {enter,leave,move})`（:236-249）；离场 `removeOther` + `destroyOtherSprite` 有严谨的名字 Bitmap 释放纪律（:196-229），新精灵须沿用。

### 5.2 广播侧（我的宝宝）
- 扩展上报负载，附 `followers` 数组（仅 `isVisible()` 跟随者，按队列序）：
  - `player.move`：`followers: [{x,y,d}]`
  - `player.enterMap`：`followers: [{x,y,d,charSet,charIndex}]`（带贴图，含进化后形象）
- **变更检测扩展**：现有 `lastSent = {x,y,d}` 只比对玩家；宝宝采集会脱离队形独立走，须把 followers 的 `{x,y,d}` 并入 `lastSent` 比对，任一变化即上报（仍受 5Hz 节流）。

### 5.3 渲染侧（别人的宝宝）
- 新增 `Sprite_OtherFollower`（≈ `Sprite_OtherPlayer`，去名字标签，读 `{x,y,d,charSet,charIndex}` + `applyRemoteMove`）。
- `addOther(view)` 扩展：按 `view.followers` 为该远端玩家建 N 个 follower 精灵，存于 `sp._followers`，一并 push 进 `_characterSprites` / `_tilemap`。
- `world.delta.move` 扩展：对 `m.followers` 逐个 `applyRemoteMove`。
- `removeOther(pid)` 扩展：连带从 `_characterSprites` 摘除并 `destroy` `sp._followers`（follower 精灵无独占名字 Bitmap，destroy 仅释放本 sprite 包装、不动 ImageManager 共享纹理，安全）。

### 5.4 进化形象同步
Arder 宝宝会进化（`Arder_Core` elWord 进化提示），`charSet/charIndex` 变化。需在进化点补发一次轻量 `pet.appearance {followerIndex, charSet, charIndex}`（或在 enterMap 形象带版本号），远端据此热换贴图，避免看到旧形象。

### 5.5 服务端触点（极小）
- `server/src/domain/world/mapState.ts` 的 `RemotePlayerView` / `MoveDelta` 增 `followers?` 字段；`toView` / `applyMove` 透传。
- `worldService.flushOne`（:147-161）广播时带上 followers；`enterMap` 快照（:106-108）带上 followers。
- 轻校验：followers 数量上限（如 ≤ 8）、坐标范围合法，防恶意大包。
- **不落库**：`flushPositions` 不持久化宝宝位置。

## 6. 错误处理 / 边界

- 形变不可推算：宝宝采集脱队，远端无法由队长路径反推 → 必须广播真实坐标（本设计已如此）。
- 带宽：N 玩家 × F 宝宝；缓解：只发变化项、多数玩家仅 1 只、沿用 5Hz、可按距离裁剪只渲染近处玩家的宝宝。
- 精灵数/性能：地图角色精灵增多，列为性能观察点。
- 进图竞态：enterMap 快照与首个 world.delta 的先后由现有 seq 机制兜底（worldService `seq`）。

## 7. 测试

- ① 失焦后宝宝持续移动并采集、背包增长；切菜单/战斗失焦冻结；断线后失焦回退冻结；`afkFpsDivider` 对 CPU 实测差异。
- ② A 看得到 B 的宝宝随 B 移动、采集脱队走动；B 宝宝进化后 A 端形象更新；B 离场/切图后 A 端 B 的宝宝精灵全部清除、无 Bitmap 泄漏；多人多宝宝帧率/带宽实测。
- 服务端：`server/test` 扩 `worldService.test.ts` / `mapState.test.ts`（vitest）覆盖 followers 透传与校验。

## 8. 影响面 / 回滚

- 影响文件：新增 `XdRs_AfkGather.js`；改 `XdRs_Online_PlayerSync.js`（广播+渲染）；微改 `mapState.ts` / `worldService.ts`；Arder 进化点补一行 appearance 发送。
- 回滚：① 摘掉 `XdRs_AfkGather.js`（plugins.js 关闭）即恢复原生失焦冻结；② followers 字段缺省即退化为「只同步主角」，服务端透传向后兼容（旧客户端无 followers 字段也不报错）。

## 9. 实现顺序与依赖

1. ①（独立、最小，先落地验证失焦采集）。
2. ②（依赖现有 PlayerSync 通道；与 ① 无强耦合，可并行）。
3. 二者均不阻塞 ③；③ 落地后把 ① 的本地采集结算改走 ③ 的服务端认领（见 ③ 文「客户端集成」）。
