# M14 修：联机三连 BUG 修复

## 症状

1. **别人切地图后角色卡在原地** - 你看到的隔壁玩家明明已经走到别的地图，他在你屏幕上的 sprite 永远不消失。
2. **下线了也不消失** - 玩家断线后，你那边他依然站着，过几分钟才偶尔消失，且经常完全不消失。
3. **每个地图右下角都广播一次"上线"** - 别人每切一次图，你右下角就刷一条 "X 上线了"，刷屏严重。

## 根因

### Bug 1 + 2：旧地图永远收不到 leave

`gateway/router.ts` 在 `player.enterMap` handler 内的调用顺序：

```ts
// 旧逻辑
markOnline({ ..., mapId: input.mapId, ... });   // 这步把 onlineByPid[pid].mapId 提前覆盖为新 mapId
const player = getOnlineBySocket(socket.id);
const { snapshot } = enterMap(player, input.mapId, ...); // 此时 player.mapId 已经是 input.mapId
```

而 `worldService.enterMap` 用 `player.mapId !== mapId` 判断要不要把玩家从旧地图移除：

```ts
// 旧逻辑
if (player.mapId && player.mapId !== mapId) {  // 永远是 false（被 markOnline 提前改了）
  leaveMap(player.pid, player.mapId);
}
```

所以 **`leaveMap(旧mapId)` 从来没有执行过**。结果：
- 旧地图的 `MapState.players` 一直留着这个 pid
- 旧地图的 `pending.leave` 永远不会加上这个 pid
- 旧地图剩下的玩家永远不会收到 `world.delta { leave: [pid] }`
- 他们看到的 sprite 卡在原地

而 `disconnect` 走的是 `markOffline` → `leaveMap(p.pid, p.mapId)` — 但 `p.mapId` 是最新一次 enterMap 的 mapId（新地图），所以 leaveMap 也只在**新地图**移除，**旧地图引用泄漏**。

→ Bug 1 (切图卡住) 和 Bug 2 (下线不消失) 同源。

### Bug 3：每次切图都广播

`router.ts:240` 旧版：

```ts
const { snapshot } = enterMap(player, input.mapId, ...);
broadcastSystem(`${player.name} 上线了`);  // 每次 enterMap 都触发
cb?.(okAck(snapshot));
```

`Scene_Map.start` 在客户端**每张地图都会触发一次** `Net.request('player.enterMap', ...)`，所以服端无脑广播一次 "X 上线了"。

加上 socket 重连时 `disconnect → connect` 也会触发一次 `下线了 → 上线了` 风暴。

## 修复

### Server / `gateway/router.ts`

1. 在 `markOnline` 之前先抓 `previous = getOnlineBySocket(socket.id)`，用 previous.mapId 作为旧 mapId。如果旧 mapId 与新 mapId 不同，**先调一次 `leaveMap(pid, oldMapId)`**，这样旧地图能正确收到 leave 事件。
2. 加 `wasOnline` 标志，仅当玩家**真的首次上线**（previous 不存在）时才 broadcast `上线了`。
3. 加 `OFFLINE_GRACE_MS = 5000` 延迟广播池：`disconnect` 时不立刻广播 `下线了`，而是 `setTimeout` 排队 5s；如果该 pid 在 5s 内重连进来，取消队列里的下线广播 + 跳过上线广播。
4. 同时在 `enterMap` 内加防御：扫所有 `maps`，把当前 pid 从其它 map 清掉，作为兜底（即使外部调用方写错也不会泄漏）。

### Server / `domain/world/worldService.ts`

`enterMap` 加防御性清理逻辑（见上）。

### Client / `XdRs_Online_PlayerSync.js`

加客户端兜底，防止网络抖动 / 服务端遗留 bug：

1. `Sync.others` 中每个 sprite 记录 `_lastSeenAt`（每次 world.delta.move 更新）。
2. 每 30s 调一次 `player.enterMap` 拉 snapshot.others，与本地做差集，**新增缺的 + 删除多的**（不全删全建免闪烁）。
3. 每 5s 扫一次 stale：
   - 60s 没动 → opacity 减半（视觉提示"可能掉线"）
   - 120s 没动 → 强制 `removeOther`

## 验证

新增测试 `test/worldService.test.ts`，3 case 全过；总 28 个 test 全过。

```cmd
node_modules\.bin\vitest.cmd run
   Test Files  4 passed (4)
   Tests       28 passed (28)
```

## 回滚

- 服务端：`git diff src/gateway/router.ts src/domain/world/worldService.ts` 即可看到全部改动；reset 即回滚。
- 客户端：`git diff js/plugins/XdRs_Online_PlayerSync.js`；删除最末尾 "M14 客户端兜底" 段即可。
