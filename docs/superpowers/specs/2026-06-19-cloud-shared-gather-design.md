# 地上物云端共享 / 宝宝联机采集设计（Cloud-Shared Ground Resources & Pet Gather）

- 日期：2026-06-19
- 状态：待用户审查（实现前定稿）
- 范围：服务端（`xiaoshagua-server/server`，新增 `domain/gather`）+ 客户端联机插件（`xiaoshagua/js/plugins`，镜像 `client-plugins/`）+ 数据管线（从 `data/Map*.json` 提取资源槽位）
- 一句话：把地上可采集物（带 `<Resource>` note 的事件 / `Game_Botany`）的**存在性、刷新、采集发放**收归服务端权威：服务端按槽位表全服统一 spawn/respawn 并广播，本体宝宝走到资源点后向服务端**认领（claim）**，服务端仲裁防双采、由服务端库存发货。
- 关联：① 在线挂机采集 + ② 联机可见见 `2026-06-19-native-pet-afk-visibility-design.md`。③ 依赖①让宝宝失焦也能发认领；与②共用同图广播。

## 1. 背景与问题

现状（已读源码）：

- 资源 = 地图上带 `<Resource>` note 的事件（`XdRs_GatherAsync.js` `isResourceEvent` 用 `resourceTagRegex` 默认 `<Resource>`）+ `Game_Botany` 植物（`Arder_Objects.js:183/311`）。
- 采集 = 宝宝（`Game_Follower`）`seekResource/updatePickup` 到点 `event.start()` → `GatherAsync` 非阻塞 channeling → `$gameParty.gainItem()`，**100% 本地**。
- 刷新 = 本地开关 / wall-clock（各玩家独立，`XdRs_TimeOffline.js` 一带）。

痛点：用户要「地上物刷新云端化 + 宝宝联机采集」——即全服同一份资源、统一刷新节奏、采集结果一致且防作弊。当前本地模型无法满足（各采各的、可改本地造物、无法竞争）。

经济/安全侧：本地 `gainItem` 等于客户端可任意造物，且共享资源若无服务端仲裁会被多端/多开重复采。故 ③ 的核心是**把存在性与发货迁到服务端**。

## 2. 目标 / 非目标

**目标**

- 服务端为地上资源的**唯一权威**：按「每图资源槽位表」统一 spawn / respawn，并广播给同图玩家（全服同一份、同一节奏）。
- 宝宝走到资源点 → 客户端发 `gather.claim` → 服务端仲裁（防双采）→ 通过则由**服务端库存**发货并广播 despawn。
- 最大化复用 Arder 宝宝采集 AI（seek/寻路/到点零改），仅替换「结算点」。
- 复用现有 world 分图广播（`room(mapId)` / `world.delta` tick）与 inventory 发货（`inventoryService.gainItem`）。

**非目标（YAGNI）**

- 不做强反作弊（坐标基于客户端上报，做容差 range 校验即可；休闲合作场景）。
- 不做资源 node 持久化（内存态 + 启动按槽位表重生；认领历史不落库）。
- 不做离线采集 / 关游戏采集（见 ① 文，用户已否定）。
- v1 不做稀有点拍卖/争夺特殊规则；统一「先到先得」。

## 3. 关键决策（待用户确认）

- **资源模型 = 全服竞争（默认）**：一份资源、先到先得、被认领即对全员 despawn。
  - 备选「共享刷新节奏但各采各份」：去掉认领仲裁、despawn 只对认领者本人；其余架构照用。**此项需用户拍板。**
- **存在性服务端权威，AI 仍客户端**（G1 方案）：服务端广播 spawn/claimed，客户端把资源**镜像**为可被 `getResource/seekResource` 命中的实体，宝宝寻路逻辑零改。
- **发货服务端化**：到点不再本地 `gainItem`，改 `gather.claim`；物品由 `inventoryService.gainItem`（`inventoryService.ts:116`）发放并走既有库存增量推送。
- **复用同一 tick**：`worldService.startTick`（`worldService.ts:24-33`）的世界 tick 同时驱动资源 delta flush，不另起定时器。
- **进图快照**：`player.enterMap` 的 ack 响应附 `resources:[...]`（复用既有 snapshot 通道 `worldService.ts:106-108`）。

## 4. 架构：新增 gather 领域（镜像 world 层）

现有 world：`MapState.pending{enter,leave,move,action}` → `flushOne` 每 tick `io.to(room).emit('world.delta', ...)`（`worldService.ts:140-161`）。③ 照搬该模式。

```
server/src/domain/gather/
  resourceState.ts   // 每图资源态 + pending（类比 mapState.ts）
  gatherService.ts   // spawn/respawn 调度、claim 仲裁、delta flush（类比 worldService.ts）
  gatherRepo.ts      // 槽位表加载（来自数据管线产物）+ 可选快照
  spawnTable.ts      // 槽位表类型与按 mapId 查询
```

### 4.1 ResourceState（每图）
```ts
interface ResourceNode { rid: number; x: number; y: number; itemId: number; kind: 'item'|'botany'; state: 'active'|'claimed'; }
class ResourceState {
  readonly mapId: number;
  nodes = new Map<number, ResourceNode>();
  private pending = { spawn: [] as ResourceNode[], claimed: [] as {rid:number; byPid:number}[] };
  seq = 0;
  // spawn(node) / claim(rid, byPid) / drainDelta() / snapshot()
}
```

### 4.2 广播协议（增量）
- 新事件 `gather.delta { seq, spawn:[{rid,x,y,itemId,kind}], claimed:[{rid,byPid}] }`，`io.to(room(mapId)).emit`。
- 与 `world.delta` 同 tick flush（`gatherService.flushAll` 挂入 `worldService.startTick` 或并列 `setInterval(config.worldTickMs)`）。
- 进图快照：在 `router` 的 `player.enterMap` ack 里附 `resources: resourceState.snapshot(mapId)`。

## 5. 认领协议（防双采核心）

### 5.1 客户端
宝宝走到资源格（Arder `updatePickup` 到点）→ 不再本地 `event.start()` 结算，改：
```js
window.XdRsOnline.Net.request('gather.claim', { rid })
  .then(ok => { /* 服务端已发货并广播 despawn；本地播采集成功表现 */ })
  .catch(err => { /* CLAIMED_BY_OTHER：移除镜像、宝宝 clearResourceEvent 重选 */ });
```

### 5.2 服务端（`router.ts` 注册，范式同 `socket.on('player.enterMap',(raw,ack)=>...)` :270 / `player.move` :332）
```
socket.on('gather.claim', (raw, ack) => {
  const { rid } = parse(raw);
  const r = gatherService.tryClaim(session.pid, rid);
  ack(r);  // {ok:true} | {ok:false, code:'CLAIMED_BY_OTHER'|'OUT_OF_RANGE'|'NO_SUCH_NODE'}
});
```
`gatherService.tryClaim(pid, rid)` 校验（全过才发货）：
1. node 存在且 `state==='active'`；
2. 认领者在该 map 房间（`getOnlineByPid(pid).mapId === node.mapId`）；
3. 认领者**本人或其宝宝**坐标与 node 距离 ≤ 容差（防瞬移；宝宝坐标来自 ② 的 followers 上报）；
通过 → `state='claimed'`，`inventoryService.gainItem(characterId, mapItemIdToData(node.itemId), qty, 'gather')`，入 `pending.claimed` 广播 despawn，排程 respawn。

## 6. 刷新（spawn / respawn 权威）

- 服务端按「每图资源槽位表」调度：槽位空闲且 respawn 计时到 → 在该槽位 spawn 一个 node → 入 `pending.spawn` 广播。这就是「地上物刷新云端化」，全服同一节奏。
- respawn 间隔来自槽位配置（可每槽不同），认领成功后启动该槽计时。

## 7. 数据管线（槽位表来源）

- 新增构建脚本（`server/scripts/` 下，如 `extract-resources.ts`）：扫描 `xiaoshagua/data/Map*.json`，提取带 `<Resource>` note 的事件坐标 + 其产出 itemId（解析事件页 `gainItem` 命令 code 126，参考 `GatherAsync` `cmd_gainItem`），生成 `gather/spawn-table.json`（{mapId:[{x,y,itemId,respawnMs}]}）。
- 改图后重跑脚本刷新槽位表（纳入发布流程）。
- itemId 映射：node.itemId 直接对应 data items id；`mapItemIdToData` 仅做校验。

## 8. 持久化

- 资源 node 走**内存态 + 启动按槽位表重生**，认领历史不落库（休闲游戏无需 durable）。
- 可选每 60s 快照当前 node 状态（类比 `worldService.flushPositions` :163-174），重启可热恢复；不做也可（重启即按槽位表重生，玩家无感）。

## 9. 错误处理 / 边界

- **坐标信任**：range 校验基于客户端上报坐标，非强反作弊；标记为安全权衡（休闲合作可接受）。
- **抖动/RTT**：claim 往返有延迟；客户端可本地先播采集动画、收到 ack 再确认入包，失败回滚动画。
- **断线**：claim 在途断线 → 服务端 ack 失败/超时不发货，node 保持 active（不会卡死）。
- **多开/同账号**：claim 按 pid 仲裁，同账号多开抢同一 rid 也只第一笔成功，其余 `CLAIMED_BY_OTHER`，根治多开刷物。
- **MAP_FULL/换图**：换图时清退出图 node 镜像；服务端按 room 精确投递。
- **与 ①②联动**：① 让宝宝失焦也发 claim；② 远端宝宝走向某 node 时本机同时收 despawn → 表现一致。

## 10. 测试

- 两客户端宝宝抢同一 node：仅一方得物，另一方收 `CLAIMED_BY_OTHER` 并重选目标。
- respawn 节奏全服一致；进图快照正确重建当前资源。
- 服务端重启后按槽位表重生；库存只由服务端增量到账（客户端无本地造物）。
- range 校验：伪造远距 claim 被拒（`OUT_OF_RANGE`）。
- vitest：新增 `server/test/gatherService.test.ts`（spawn/claim/respawn/并发抢同 rid），扩 `worldService` 集成（沿用现有测试范式）。

## 11. 影响面 / 回滚

- 新增：`server/src/domain/gather/*`、`server/scripts/extract-resources.ts`、`gather/spawn-table.json`、客户端资源镜像 + claim 改造（`XdRs_GatherAsync.js` 结算点 + 一个新插件 `XdRs_Online_Gather.js`）。
- 改动：`router.ts`（注册 `gather.claim` + enterMap ack 附 resources）、`worldService.startTick`（挂 gather flush）、`inventoryService` 复用（无需改）。
- 回滚：关闭 `XdRs_Online_Gather.js` + 服务端不广播 gather.delta → 客户端回退到本地 `<Resource>` 采集（① 仍可用本地结算）。设计保证「未启用 ③ 时本地采集照旧」。

## 12. 子任务拆分（writing-plans 时各成计划）

- ③a 服务端资源层：`resourceState` + `gatherService` spawn/respawn + `gather.delta` 广播 + enterMap 快照。
- ③b 认领与发货：`gather.claim` RPC + `tryClaim` 校验 + `inventoryService.gainItem` + despawn 广播。
- ③c 客户端集成：资源镜像（可被 seekResource 命中）+ 采集结算改 claim + 失败重选 + 库存增量到账。
- ③d 数据管线：`extract-resources.ts` + `spawn-table.json` + 发布流程接入。

> ③ 体量大，建议按 ③a→③b→③c→③d 顺序，各自一个实现计划（plans/）。
