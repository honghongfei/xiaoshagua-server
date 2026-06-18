# 客户端多开设计（Client Multi-Instance）

- 日期：2026-06-18
- 方案：多开启动器（自动递增）+ `--user-data-dir` 隔离登录态 + hook 隔离本地存档
- 场景：同机同时登录**不同账号**（大号 + 小号搬砖，最常见）
- 状态：待用户审查

## 1. 背景与问题

客户端是 NW.js 应用（manifest `xiaoshagua/package.json`，`main: index.html`，可执行文件 `Game.exe`）。当前 `chromium-args` 只有性能参数，**无** `--user-data-dir`、**无**单实例配置。裸多开会在三处互踩：

| 冲突点 | 现状 | 代码位置 |
| --- | --- | --- |
| 登录态 | localStorage 存 `xsg.token`，多实例共用同一份 | `XdRs_Online_Reconnect.js:44` |
| 本地存档 | `save/` 目录固定在游戏目录，多实例共用 | `rmmz_managers.js:758` `StorageManager.fileDirectoryPath` |
| 单实例 | NW.js 同 user-data-dir 二次启动只聚焦旧窗 | NW.js / chromium 默认行为 |

存档锁（`2026-06-18-save-account-lock-design.md`）已上线，其第 5 节明确："多开兼容——每个客户端实例登录各自账号，`makeSaveContents` 按各自 pid 盖章；多开本身不破坏锁定。多开是独立功能，另开规格。" 本文档即该独立规格。

## 2. 目标 / 非目标

**目标**

- 同一台电脑能同时开多个游戏窗口，每个窗口登录**不同账号**，登录态与本地存档互不干扰。
- 玩家零学习成本：双击一个"多开启动器"即可再开一个独立实例；可连续双击开任意多个（自动递增空号）。
- 主实例（直接双击 `Game.exe`）行为**零变化**，老玩家存档与登录态原地不动。
- 不破坏既有云存档、存档锁、存档迁移逻辑。

**非目标（YAGNI）**

- 不支持同机**同一账号**多开（会与服务端会话/云存档强冲突，需冲突仲裁，收益低）。正常用法每窗一个号。
- 不做实例间通信/共享窗口管理 UI。
- 不改服务端任何代码（多开是纯客户端 + 启动器 + 打包问题）。

## 3. 方案概览

核心是一个 `--user-data-dir` 参数同时解决两件事，再补一处 hook 隔离本地存档：

1. **登录态隔离 + 绕过单实例**：多开实例以**独立 `--user-data-dir`** 启动 `Game.exe`。chromium 的 localStorage（含 `xsg.token`）天然按 user-data-dir 分家；不同 user-data-dir 也让 chromium 单例锁失效，从而真正开出第二个进程。
2. **本地存档隔离**：`StorageManager.fileDirectoryPath()` 不随 user-data-dir 变，需新增插件 hook，让多开实例改用各自的存档目录。
3. **自动递增启动器**：一个 `.bat` 负责找到下一个空闲实例号 N，准备其数据目录，带参数启动 `Game.exe`。

数据目录布局（全部放游戏目录内，与主存档一致、绿色便携）：

```
游戏目录/
  Game.exe
  save/                      ← 主实例存档（不变）
  多开启动器.bat
  save2/                     ← 2 号实例存档
    .userdata/               ← 2 号实例 chromium user-data-dir（含登录态）
  save3/                     ← 3 号实例存档
    .userdata/
  ...
```

## 4. 详细设计

### 4.1 多开启动器（`多开启动器.bat`，自动递增）

放发布包根目录，与 `Game.exe` 同级。双击后逻辑：

1. 以脚本所在目录为游戏根目录 `ROOT`。
2. 从 `N = 2` 起递增，找到第一个**空闲**号：判定"号 N 是否在运行"以 `ROOT\saveN\.userdata` 是否被进程独占为准（见下方"空号判定"）。
3. 选定 N 后：
   - 确保目录 `ROOT\saveN\.userdata` 存在。
   - 启动：`Game.exe --user-data-dir="ROOT\saveN\.userdata" --xsg-save-dir="ROOT\saveN"`
4. 启动器自身随即退出（实例锁由 `Game.exe` 的 chromium 进程持有）。

**空号判定（实现阶段择优，带安全底线）**

- 首选：探测 `saveN\.userdata` 下 chromium 单例锁（`SingletonLock` / `lockfile`）是否被占用（用内联 PowerShell 尝试独占打开）。
- 次选：用 `tasklist` + 命令行匹配 `--user-data-dir=...saveN...` 判断该号进程是否存在。
- **安全底线**：即便空号判定失误，最坏情况只是"聚焦了旧窗"或"多建一个空号目录"，**绝不会**两个实例共用同一 `user-data-dir`（因为每号目录不同）——因此**绝不串档**。这是判定逻辑的硬约束。

### 4.2 客户端插件（`XdRs_Online_MultiInstance.js`，隔离本地存档）

新增插件，注册进 `plugins.js`，**在最前面加载**（早于所有读写存档的插件，且早于核心 RMMZ 存档使用）。职责单一：读启动参数，若为多开实例则把存档目录指向传入路径。

```js
(() => {
  'use strict';
  let saveDir = null;
  try {
    const argv = (typeof nw !== 'undefined' && nw.App && nw.App.argv) || [];
    for (const a of argv) {
      const m = /^--xsg-save-dir=(.+)$/.exec(a);
      if (m) { saveDir = m[1]; break; }
    }
  } catch (e) { /* 非 NW 环境，忽略 */ }

  if (saveDir) {
    const path = require('path');
    StorageManager.fileDirectoryPath = function () {
      return path.join(saveDir, 'save/'); // 多开实例：ROOT\saveN\save\
    };
    if (window.XdRsOnline && XdRsOnline.Util) {
      XdRsOnline.Util.log('info', '[MultiInstance] save dir -> ' + saveDir);
    }
  }
})();
```

- 主实例（无 `--xsg-save-dir`）：不 hook，`fileDirectoryPath` 保持原样（`游戏目录/save/`）。
- 多开实例：本地存档落 `ROOT\saveN\save\`；该实例的存档迁移、云存档读写都经 `StorageManager` → 自动落该目录。
- `--user-data-dir` 由 chromium 消费（不出现在 `nw.App.argv`），登录态自动隔离，插件无需处理。

**加载顺序风险**：`fileDirectoryPath` 必须在任何存档读写前被替换。`plugins.js` 中本插件放在 `XdRs_Online_Util` 之后、其余联机插件之前（或更靠前），并确认 NW.js 启动早期、`Scene_Boot` 读 config/global 之前已生效（实现阶段验证）。

### 4.3 登录态隔离（`--user-data-dir`）

- 由 4.1 启动器传入，chromium 自动隔离 localStorage（`xsg.token`）、缓存、IndexedDB。
- `Reconnect.js` 的 `saveToken/loadToken/clearToken` 全部走 `localStorage`，天然按实例分家，**无需改动**。
- 主实例不传该参数，用默认 user-data-dir，登录态原地不动。

### 4.4 打包脚本改动（`tools/build_release.ps1`）

- 启动器 `多开启动器.bat` 放源目录根，robocopy `/E` 自动纳入发布包，无需额外配置（当前排除列表无 `.bat`）。
- 排除运行期生成的多开数据目录：在 `$ExcludePaths` 增加对 `save2..saveN`、或统一排除匹配 `save?*` 的目录（保留主 `save` 也已在排除列表，发布包本就不带本地存档）。实现阶段用一条通配规则覆盖 `save` 及 `save<N>`，避免把开发期测试多开存档打进玩家包。

## 5. 兼容性（与云存档 / 存档锁）

**结论：不受影响。** 云存档与存档锁都按账号（pid）工作，与客户端本地用哪个目录、开第几个窗口无关。多开做的隔离，等价于"每个窗口是一台独立电脑"。

- **云存档**：服务端按 `character_id`(pid) 存一行（`storageService.ts` UPSERT），`save.upload` 用会话 `s.pid` 而非客户端传值。实例1登大号 → 写大号那行；实例2登小号 → 写小号那行。不同账号 = 不同行，互不覆盖。
- **存档锁**：`makeSaveContents` 按当前登录账号 pid 盖 `xsgOwner` 章；上传门禁校验 `章.pid === 当前 pid`，服务端兜底校验 `xsgOwner.pid === characterId`。各实例各账号各目录各盖章，全部吻合放行。
- **存档迁移 / 云同步**：均经 `StorageManager`，多开实例落各自 `saveN\save\`，读写一致。
- **老玩家**：主实例零变化。

## 6. 边界与风险

- **同一账号被开进两个窗口**（误用）：云档会互相覆盖、服务端可能把先登的挤下线——这是"同号多登"固有问题，非本方案引入。缓解：启动器与玩家须知提示"多开请登不同账号"；不做技术强制（YAGNI）。
- **`nw.App.argv` 是否带自定义参数**：需实现阶段验证 NW.js 当前版本对 `--xsg-save-dir` 的透传（必要时改用 `nw.App.fullArgv` 解析，或换用环境变量传递）。
- **hook 时机**：`fileDirectoryPath` 必须在首次存档读写前替换，否则 config/global 可能落错目录。实现阶段以最早加载点 + 实测确认。
- **磁盘占用**：多开越多本地存档副本越多；可接受（玩家自控），文档提示。
- **回滚**：删除启动器 + 插件 + 还原打包脚本即可；主实例从未被改动，零风险。

## 7. 测试计划

客户端联机自测：

- 双击 `Game.exe`（主实例）→ 登录大号 A → 存档落 `save\`，登录态正常。
- 双击 `多开启动器.bat` → 开 2 号 → 登录小号 B → 存档落 `save2\save\`，登录态独立（不踢掉主实例）。
- 再双击启动器 → 开 3 号 → 登录账号 C → 落 `save3\save\`，三窗并存互不干扰。
- 在 2 号窗口做云存档上传/下载 → 只影响小号 B 的云档，大号 A 云档不变。
- 在 2 号窗口存档迁移上传 → 存档锁按小号 B 的 pid 盖章/校验，通过；拷大号 A 存档到 2 号窗口上传 → 被存档锁拦截（`SAVE_FOREIGN`）。
- 关闭 2 号窗口后再双击启动器 → 复用 2 号空位（自动递增正确回收）。

回归：

- 主实例存档/读档/联机/云同步与多开上线前一致。

## 8. 影响面 / 改动文件

客户端（`xiaoshagua/`，并按既有惯例镜像到 `xiaoshagua-server/client-plugins/`）：

- 新增 `多开启动器.bat`（根目录）。
- 新增 `js/plugins/XdRs_Online_MultiInstance.js`，注册进 `js/plugins.js`（最前）。
- 改 `tools/build_release.ps1`：排除 `saveN` 运行期目录（启动器自动纳入，无需额外）。

服务端：**无改动**。

## 9. 验证方法（上线前）

- `node --check js/plugins/XdRs_Online_MultiInstance.js` 通过；`plugins.js` JSON 合法。
- ReadLints 新增/改动文件无错。
- 按第 7 节联机自测全过。
- `build_release.ps1` 跑一次，确认产物含 `多开启动器.bat`、不含任何 `saveN` 本地存档。

## 10. 待实现确认点（实现阶段敲定）

1. `nw.App.argv` 对 `--xsg-save-dir` 的透传是否可用（否则改 `fullArgv` / 环境变量）。
2. 空号判定的具体检测手段（SingletonLock 独占探测 vs tasklist 命令行匹配）。
3. `XdRs_Online_MultiInstance.js` 在 `plugins.js` 中的精确插入位置与 hook 生效时机实测。
4. `build_release.ps1` 排除多开目录的通配写法。
