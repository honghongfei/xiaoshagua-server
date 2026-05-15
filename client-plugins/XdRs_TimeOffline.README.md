# XdRs_TimeOffline — 离线时间补偿

## 解决什么

| 旧痛点 | 新行为 |
|---|---|
| 关游戏 12 小时回来，植物**一阶段都没长** | 关游戏 8 小时（默认上限）= 长 8 阶段（被 maxLife 自然封顶） |
| 玩家只玩 5 分钟一次，**采集点永远不刷新**（CommonEvent 325 要 7 游戏分钟连续） | 进 Scene_Map 时若距上次刷新 ≥ 7 分钟，**立即翻开关** |

## 怎么实现

**纯本地、不联网**，单机/联机一致工作。

### 植物 (Game_Botany.update)
- 替换原版"每帧 _lifeCount++"
- 用 `_lastUpdateTs`（随存档保存）算 wall-clock 差值
- 累积到 60 秒就 `addLife()` 一次（与原版 60 秒/阶段对齐）
- delta 上限 = `maxOfflineGrowSec`（防改时钟速生）
- delta < 0（倒拨时钟）取 0
- 老存档兼容：字段缺失初始化为 `now`，本帧不补偿

### 采集点 (Scene_Map.start)
- 检查 `$gameSystem._lastGatherRefreshTs`
- 距上次 ≥ `gatherRefreshIntervalSec` 就批量 `setValue(701..2979 + 4003..4090, true)`
- 立刻更新时间戳，连续切图不会刷过头
- 老存档第一次进图：仅初始化时间戳，不刷
- 旧的并行 CommonEvent 325 仍在跑，**双保险**（setSwitch 幂等无副作用）

## 参数

| 字段 | 默认 | 含义 |
|---|---|---|
| `maxOfflineGrowSec` | 28800 (8h) | 单次离线最多补偿多少秒生长 |
| `gatherRefreshIntervalSec` | 420 (7min) | 采集点刷新间隔 |
| `gatherSwitchRange1Start/End` | 701/2979 | 第一段开关 |
| `gatherSwitchRange2Start/End` | 4003/4090 | 第二段开关 |
| `botanyEnabled` | true | 启用植物补偿 |
| `gatherEnabled` | true | 启用采集刷新 |
| `logLevel` | info | off / info / debug |

## 调试

F12 控制台：

```js
// 查看所有植物状态
XdRsTimeOffline.botanyStatus()

// 强制立刻刷一次采集开关
XdRsTimeOffline.forceRefreshGather()

// 看当前配置
XdRsTimeOffline.cfg
```

## 回滚

`plugins.js` 把 `XdRs_TimeOffline` 的 `"status":true` 改 `false`，重启游戏完全恢复原行为。新字段（`_lastUpdateTs` 等）留在存档里 RMMZ 静默忽略，无副作用。

## 兼容性

- ✅ XdRs_Arder_*（Core / Objects 等）— 直接 hook 它定义的 Game_Botany
- ✅ XdRs_Online_*（包括 SaveCloud / SaveMigrate）— 新字段随 RMMZ saveContents 序列化，自动同步
- ✅ XdRs_GatherAsync — 完全独立，互不影响
- ✅ SFCYtimecore 签到 — 不重叠

## 设计取舍说明

### 为什么没做"签到云端化"
原版 `SFCYtimecore` 用 `recentlyday/recentlymouth/recentlyyear` 已经保证一天最多触发一次签到 CommonEvent；这些变量本来就在存档里，存档已被 SaveCloud 同步到云端 → **跨设备一致性已自动获得**。改本地系统时间作弊一天领多次的收益对小群体爱好游戏不构成威胁，**不为它增加复杂度**。

### 为什么 maxOfflineGrowSec 默认 8 小时
- 太小（如 1 小时）：玩家一晚上不开游戏 = 没补偿，等于没改
- 太大（如 24 小时）：感觉不真实，且改时钟收益变大
- 8 小时 = 一个工作日 / 一觉睡醒，符合直觉

需要的话可以在 plugins.js 里调。
