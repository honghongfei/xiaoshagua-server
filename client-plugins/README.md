# client-plugins

《小傻瓜》联机客户端插件，14 个 `XdRs_Online_*.js`。

## 安装

### 1. 拷贝插件文件

把本目录所有 `XdRs_Online_*.js` 拷贝到游戏目录的 `js/plugins/` 下：

```
你的游戏/
  js/
    plugins/
      vendor/
        socket.io.min.js          ← 这个需要你自己放（socket.io-client v4 vendor）
      XdRs_Online_Util.js
      XdRs_Online_Net.js
      XdRs_Online_Core.js
      XdRs_Online_Reconnect.js
      XdRs_Online_Login.js
      XdRs_Online_PlayerSync.js
      XdRs_Online_SharedState.js
      XdRs_Online_Inventory.js
      XdRs_Online_SaveCloud.js
      XdRs_Online_Chat.js
      XdRs_Online_Friend.js
      XdRs_Online_Trade.js
      XdRs_Online_Pet.js
      XdRs_Online_Dungeon.js
```

### 2. 准备 socket.io 客户端

下载 socket.io-client v4 的浏览器版到 `js/plugins/vendor/socket.io.min.js`：

```
https://cdn.socket.io/4.8.0/socket.io.min.js
```

### 3. 在 `js/plugins.js` 末尾追加

打开游戏目录 `js/plugins.js`，把数组最后一项后面追加（注意 JSON 格式）：

```js
{"name":"vendor/socket.io.min","status":true,"description":"vendor: socket.io-client v4","parameters":{}},
{"name":"XdRs_Online_Util","status":true,"description":"联机-工具 (XSG-Online)","parameters":{}},
{"name":"XdRs_Online_Net","status":true,"description":"联机-网络层 (XSG-Online)","parameters":{"serverUrl":"ws://8.163.32.142:3000","reconnectDelayMs":"3000","ackTimeoutMs":"8000"}},
{"name":"XdRs_Online_Core","status":true,"description":"联机-核心 (XSG-Online)","parameters":{"logLevel":"info"}},
{"name":"XdRs_Online_Reconnect","status":true,"description":"联机-断线重连 (XSG-Online)","parameters":{"storageKey":"xsg.token","autoResumeOnBoot":"true"}},
{"name":"XdRs_Online_Login","status":true,"description":"联机-登录 (XSG-Online)","parameters":{"titleCommandText":"联机","defaultMapId":"1","defaultSpawnX":"8","defaultSpawnY":"6"}},
{"name":"XdRs_Online_PlayerSync","status":true,"description":"联机-位置同步 (XSG-Online)","parameters":{"moveReportHz":"5"}},
{"name":"XdRs_Online_SharedState","status":true,"description":"联机-共享状态 (XSG-Online)","parameters":{"sharedSwitchIds":"","sharedVariableIds":""}},
{"name":"XdRs_Online_Inventory","status":true,"description":"联机-资产 (XSG-Online)","parameters":{"strictMode":"false"}},
{"name":"XdRs_Online_SaveCloud","status":true,"description":"联机-云存档 (XSG-Online)","parameters":{}},
{"name":"XdRs_Online_Chat","status":true,"description":"联机-聊天 (XSG-Online)","parameters":{"toggleKey":"Enter","bubbleDurationMs":"4500"}},
{"name":"XdRs_Online_Friend","status":true,"description":"联机-好友/黑名单 (XSG-Online)","parameters":{"toggleKey":"F"}},
{"name":"XdRs_Online_Trade","status":true,"description":"联机-交易 (XSG-Online)","parameters":{}},
{"name":"XdRs_Online_Pet","status":true,"description":"联机-宠物 (XSG-Online)","parameters":{"toggleKey":"P"}},
{"name":"XdRs_Online_Dungeon","status":true,"description":"联机-副本 (XSG-Online)","parameters":{"triggerRegionId":"20","defaultDungeonId":"test_cave","exitRegionId":"21"}}
```

注意：
- 顺序不能乱，每个插件依赖前面的
- `serverUrl` 已填好 `ws://8.163.32.142:3000`（如果服务器换 IP 记得改）

### 4. 默认热键

| 键 | 作用 |
|---|---|
| Enter | 在 Scene_Map 上按下打开聊天面板（再按 Enter 发送） |
| F | 打开/关闭好友 + 黑名单面板 |
| P | 打开/关闭云宠物面板 |
| 踩 regionId=20 | 进入副本（test_cave）|
| 踩 regionId=21 | 离开副本 |

### 5. 共享开关/变量配置

在 `XdRs_Online_SharedState` 插件参数：
- `sharedSwitchIds`: 逗号分隔的开关 ID，如 `1,5,12`。这些开关的 setValue 会同步给所有玩家
- `sharedVariableIds`: 同上，变量 ID

不在列表里的开关/变量保持原生 RMMZ 本地行为。

## 插件列表 + 作用

| 插件 | 里程碑 | 作用 |
|---|---|---|
| `XdRs_Online_Util.js` | M1 | 全局命名空间、日志、节流、deferred |
| `XdRs_Online_Net.js` | M1 | socket 封装，`request()` 返 Promise，含重连 + ack 超时 |
| `XdRs_Online_Core.js` | M1 | 生命周期 + session 状态 |
| `XdRs_Online_Reconnect.js` | M5 | localStorage 持久化 token + 开机自动 resume |
| `XdRs_Online_Login.js` | M1 | 标题菜单追加「联机」入口，DOM 登录窗 |
| `XdRs_Online_PlayerSync.js` | M1 | 5Hz 节流上报，他人 `Sprite_OtherPlayer` 渲染 |
| `XdRs_Online_SharedState.js` | M3 | 指定 switch/var id 走服务端全局同步 |
| `XdRs_Online_Inventory.js` | M3 | `gainGold/gainItem` 拦截走服务器 |
| `XdRs_Online_SaveCloud.js` | M3 | `DataManager.saveGame/loadGame` 走云存档 |
| `XdRs_Online_Chat.js` | M2 | 三频道聊天面板 + 头顶气泡 |
| `XdRs_Online_Friend.js` | M2 | 好友/黑名单 DOM 面板 |
| `XdRs_Online_Trade.js` | M4 | 两段提交交易 DOM 窗 |
| `XdRs_Online_Pet.js` | M4 | 云宠物面板（与原 XdRs_Arder 并行） |
| `XdRs_Online_Dungeon.js` | M5 | regionId 触发副本进入/离开 |
