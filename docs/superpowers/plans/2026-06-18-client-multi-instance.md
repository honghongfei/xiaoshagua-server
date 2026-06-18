# 客户端多开 实现计划

> **面向 AI 代理的工作者：** 用 executing-plans 逐任务实现。完整设计见 `../specs/2026-06-18-client-multi-instance-design.md`，本计划只列可执行步骤与验证，不重复设计论证。

**目标：** 同机多开游戏、每窗登录不同账号，登录态与本地存档互不干扰。
**架构：** 多开启动器(.bat)用独立 `--user-data-dir` 启动 `Game.exe`（隔离登录态 + 绕过单实例）并传 `--xsg-save-dir=<目录>`；新增插件读该参数，hook `StorageManager.fileDirectoryPath` 重定向本地存档；打包脚本排除运行期多开目录。主实例零改动。
**技术栈：** NW.js、RMMZ、Windows bat + PowerShell。

## 文件结构

- 新增 `xiaoshagua/js/plugins/XdRs_Online_MultiInstance.js`：读 `--xsg-save-dir`，多开实例 hook 本地存档目录；主实例直接 return 不改行为。
- 改 `xiaoshagua/js/plugins.js`：把上述插件注册为**数组第一项**（最早加载，hook 早于任何存档读写）。
- 新增 `xiaoshagua/多开启动器.bat`：自动递增找空号（进程命令行匹配 user-data-dir 判占用），带参启动 Game.exe。
- 改 `xiaoshagua/tools/build_release.ps1`：排除运行期 `save<N>` 目录，避免打进发布包。
- 镜像 `xiaoshagua-server/client-plugins/XdRs_Online_MultiInstance.js` + README 插件表加一行。

## 任务

1. 写插件 hook（设计 §4.2，增强：同时查 `nw.App.argv` 与 `fullArgv`）。验证：`node --check XdRs_Online_MultiInstance.js`。
2. `plugins.js` 注册为第一项。验证：`node tools/check_plugins_js.js`（或 `node -e` 解析 `$plugins` 数组合法）。
3. 写 `多开启动器.bat`（自动递增 + 安全底线：判定失误最坏聚焦旧窗/多建空目录，绝不串档）。验证：真实环境双击实测（用户侧，开发机无 Game.exe）。
4. 改 `build_release.ps1` 排除 `^save\d+$` 目录。验证：`-SkipZip` 跑一次，stage 内无 `save<N>`。
5. 镜像插件到 `client-plugins/` + README 插件表补一行。验证：两份插件 `node --check` 一致通过。
6. 全部改动文件 ReadLints 无错。

## 验证（上线前汇总，见设计 §9）

- `node --check` 插件两份通过；`$plugins` JSON 合法。
- `build_release.ps1 -SkipZip` 产物不含任何 `save<N>`、含 `多开启动器.bat`。
- 联机自测：按设计 §7（主实例 + 2/3 号实例各登不同账号，云档/存档锁互不影响）。
