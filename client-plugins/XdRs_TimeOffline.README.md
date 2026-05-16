# XdRs_TimeOffline — 离线时间补偿

## 解决什么

| 旧痛点 | 新行为 |
|---|---|
| 关游戏 12 小时回来，植物**一阶段都没长** | 关游戏 8 小时（默认上限）= 长 8 阶段（被 maxLife 自然封顶） |
| 玩家只玩 5 分钟一次 / 切图很频繁 / 后台挂机，**采集点永远不刷新** | 三路触发任一满足就刷：进图 / 60 秒轮询 / 旧 CommonEvent 325，默认间隔 1 小时 |

## 怎么实现

**纯本地、不联网**，单机/联机一致工作。

### 植物 (Game_Botany.update)
- 替换原版"每帧 _lifeCount++"
- 用 `_lastUpdateTs`（随存档保存）算 wall-clock 差值
- 累积到 60 秒就 `addLife()` 一次（与原版 60 秒/阶段对齐）
- delta 上限 = `maxOfflineGrowSec`（防改时钟速生）
- delta < 0（倒拨时钟）取 0
- 老存档兼容：字段缺失初始化为 `now`，本帧不补偿

### 采集点 (三路并行触发)
- `$gameSystem._lastGatherRefreshTs` 随存档保存
- **(a)** `Scene_Map.start` 时检查间隔 → 立即翻开关
- **(b)** 在地图上每 **60 秒轮询** 一次 → 覆盖 AFK / 后台挂机
- **(c)** 旧的并行 CommonEvent 325 仍跑（在线连续 7 游戏分钟也能触发）→ 双保险
- 翻开关方向：**与 CommonEvent 325 严格一致**（params[2]=1 → setValue(id, false)），让消耗过的资源点 conditions 不再满足，回到有页面状态
- 开关是全局的，**翻一次 = 全地图所有 `*采集点*` 同时复活**（不只是当前地图）
- 老存档第一次启动：仅初始化时间戳，不立刻刷

## 参数

| 字段 | 默认 | 含义 |
|---|---|---|
| `maxOfflineGrowSec` | 28800 (8h) | 单次离线最多补偿多少秒生长 |
| `gatherRefreshIntervalSec` | **3600 (1h)** | 采集点刷新间隔 |
| `gatherSwitchRange1Start/End` | 701/2979 | 第一段开关 |
| `gatherSwitchRange2Start/End` | 4003/4090 | 第二段开关 |
| `botanyEnabled` | true | 启用植物补偿 |
| `gatherEnabled` | true | 启用采集刷新 |
| `logLevel` | info | off / info / debug |

## 调试

F12 控制台：

```js
// 看所有植物当前进度
XdRsTimeOffline.botanyStatus()

// 查看采集刷新时间窗口（距上次多久 / 还差多久才能刷）
XdRsTimeOffline.gatherStatus()
// → { lastRefreshAt: '...', idleSec: 1200, intervalSec: 3600, nextRefreshIn: 2400 }

// 强制立刻刷一次采集开关（测试用）
XdRsTimeOffline.forceRefreshGather()

// 看当前生效配置
XdRsTimeOffline.cfg
```

## 回滚

`plugins.js` 把 `XdRs_TimeOffline` 的 `"status":true` 改 `false`，重启游戏完全恢复原行为。新字段（`_lastUpdateTs` / `_lastGatherRefreshTs`）留在存档里 RMMZ 静默忽略，无副作用。

## 兼容性

- ✅ XdRs_Arder_*（Core / Objects 等）— 直接 hook 它定义的 Game_Botany
- ✅ XdRs_Online_*（包括 SaveCloud / SaveMigrate）— 新字段随 RMMZ saveContents 序列化，自动同步
- ✅ XdRs_GatherAsync — 完全独立，互不影响
- ✅ SFCYtimecore 签到 — 不重叠

## 设计取舍说明

### 为什么默认 1 小时（不是原版的 7 分钟）
- 原版 7 分钟需要"连续在地图前台"，对玩家来说几乎无感（每张图待 7 分钟 = 几乎不会刷）
- 我们的版本是 wall-clock，**离线/挂机/最小化都计时**，所以更激进会破坏经济（隔 7 分钟就一波资源涌出）
- 1 小时 = 离线一节课/一顿饭回来 = 一波刷新，符合"歇会儿再来"的节奏感

### 为什么旧 CommonEvent 325 仍保留
- 服务端联机时玩家可能同时跑两端
- setSwitch 幂等，重复执行不会乱
- 多一层安全网，万一插件出 bug 自动回退到原版行为

### 为什么开关是 setValue(id, **false**) 而不是 true
- 看 `data/CommonEvents.json` id=325：`code:121 parameters:[701,2979,1]`
- RMMZ `command121`：`params[2] === 0 ? true : false`，参数 `1` 等价于 `setValue(id, false)`
- 资源事件页 1 多数 conditions 是 `switch=ON → 空页 (page2)`，置 OFF 让它回到 page1（有资源）
- v1.0 版我写反了（`setValue(id, true)`）会一次性消耗所有资源点 — **本次修复**

需要的话可以在 plugins.js 里调任意参数。
