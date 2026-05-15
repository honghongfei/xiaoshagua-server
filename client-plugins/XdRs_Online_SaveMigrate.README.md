# XdRs_Online_SaveMigrate — 存档迁移插件

## 干嘛用的

给从单机切到联机的老玩家「搬家」用：把 `save/file*.rmmzsave` 里的本地存档**双向迁移**到云端。

- **上传**：本地任意槽 → 云端（覆盖云端唯一一份）
- **下载**：云端唯一存档 → 本地任意槽（旧存档会 confirm 后覆盖）

不会自动同步、不会接管 saveGame/loadGame。**纯一次性 UI 工具**。

## 与 XdRs_Online_SaveCloud 的区别

| 维度 | SaveCloud | SaveMigrate |
|---|---|---|
| 触发时机 | 联机进游戏后自动 | 玩家手动点按钮 |
| 入口 | 透明（玩家看不到）| 标题界面右侧浮动按钮 + 已登录菜单条目 |
| 何时用 | 日常云存档同步 | 一次性把老存档搬上云 / 把云存档拷到另一台机器 |

两者**互不冲突**，可以同时启用。

## 入口

- 标题界面右上角第二个按钮 **「存档迁移（S）」**（紫色）
- 标题界面快捷键 **`S`**
- 已登录联机菜单的第二项 **「存档迁移」**（在「进入游戏」和「退出联机」之间）

## UI 流程

```
┌─────────── 存档迁移 ───────────┐
│  📤 本地 → 云端                  │
│  ┌─────────────────────────────┐│
│  │ 槽1  小傻瓜  3小时  📤 上传  │ │
│  │ 槽2  小傻瓜  1小时  📤 上传  │ │
│  └─────────────────────────────┘│
│                                  │
│  📥 云端 → 本地                  │
│  ┌─────────────────────────────┐│
│  │ 小傻瓜  ⏱5小时  上传 5/16   │ │
│  │ 大小 1234 KB  [迁移]         │ │
│  │ 下载到 [槽3 (已有, 会覆盖) ▼]│ │
│  │           📥 下载             │ │
│  └─────────────────────────────┘│
│  [🔄 刷新]  [关闭 (Esc)]         │
└──────────────────────────────────┘
```

## 关键安全机制

1. **只在标题/已登录菜单可用** — 不允许在 Scene_Map 中误操作覆盖正在玩的进度
2. **覆盖前必有 `confirm`** — 上传若云端已有 / 下载到非空槽，都先弹原生 confirm
3. **大小硬上限** — 客户端拦 1.9MB（服务端拦 2MB），超出直接拒绝
4. **未登录态友好** — 没登录时云端栏显示「请先按 M 登录」，不是空白报错
5. **buildInfoFromContents 防御性 try/catch** — 即使坏存档也不会卡死面板
6. **状态快照恢复** — 临时 extractSaveContents 时用闭包保存 `$game*` 引用，结束后立刻恢复，不污染外部状态

## 依赖关系

需要这些插件按顺序加载（已在 `plugins.js` 配好）：
1. `vendor/socket.io.min`
2. `XdRs_Online_Util`
3. `XdRs_Online_Net`
4. `XdRs_Online_Core`
5. `XdRs_Online_Login` ← Scene_OnlineMenu / Window_OnlineMenuCommand 在这里定义
6. `XdRs_Online_SaveMigrate` ← 我们

服务端复用现有 `save.upload` / `save.download` / `save.exists` 三个 socket 事件，**无需服务端改动**。

## 参数

| 字段 | 默认 | 含义 |
|---|---|---|
| titleButtonText | `存档迁移` | 标题界面浮动按钮文字 |
| hotkey | `S` | 标题界面快捷键（单字母） |
| showOnTitle | `true` | 是否在标题界面显示按钮 |
| showInOnlineMenu | `true` | 是否在已登录菜单中插入选项 |

## 回滚

`plugins.js` 里把 `XdRs_Online_SaveMigrate` 的 `"status":true` → `"status":false`，重启游戏即关闭。**完全无副作用**，不修改任何已有数据。

## 给纯单机老玩家的最小迁移包

如果要发一个"只为搬存档"的简版给老玩家，最小需要的插件清单：

```
js/libs/                          (整个 RMMZ 库)
js/plugins/vendor/socket.io.min.js
js/plugins/XdRs_Online_Util.js
js/plugins/XdRs_Online_Net.js
js/plugins/XdRs_Online_Core.js
js/plugins/XdRs_Online_Reconnect.js
js/plugins/XdRs_Online_Login.js
js/plugins/XdRs_Online_SaveMigrate.js
```

然后 `plugins.js` 只保留这 7 个 + 项目原本的 RMMZ 内置依赖。其它联机功能（Inventory/Chat/PlayerSync 等）都不用装。

老玩家的流程：
1. 解压到游戏目录覆盖
2. 启动游戏 → 标题界面按 `M` 登录联机服
3. 按 `S` 打开存档迁移 → 选要上传的槽 → 📤
4. 换到新机器 → 同样登录 → 按 `S` → 📥 下载到指定槽 → 关闭面板 → 选「读取游戏」继续
