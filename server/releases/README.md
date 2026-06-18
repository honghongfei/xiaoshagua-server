# releases/ · 云更新发布目录

服务端通过 `GET /update/manifest` 和 `GET /update/download/<file>` 把本目录的内容下发给客户端。

## 文件约定

- `manifest.json`：默认（stable）渠道清单。
- `manifest.<channel>.json`：可选，指定渠道（如 `manifest.beta.json`），客户端 `?channel=beta` 时优先命中。
- `xiaoshagua-vX.Y.Z-test.zip`：整包，文件名由 `manifest.full.file` 指定。

## manifest.json 字段

- `latest`：最新版本号（如 `1.5.3`）。
- `channel`：渠道名。
- `mandatory`：true 时为强制更新（客户端低于 `minVersion` 不能跳过）。
- `minVersion`：低于该版本必须更新。
- `notes`：更新日志（支持 Markdown，客户端弹窗展示）。
- `full.file` / `full.sha256` / `full.size`：整包文件名、SHA256、字节数（客户端下载后校验）。

## 发布流程

1. 客户端机器跑打包：
   ```powershell
   PowerShell -ExecutionPolicy Bypass -File tools\build_release.ps1
   ```
   产出 `xiaoshagua-releases\xiaoshagua-vX.zip` + `xiaoshagua-releases\manifest.json`。
2. 把产物发布到服务端本目录：
   ```bash
   npm run publish:release -- "D:\agentsxiaoshagua\xiaoshagua-releases"
   ```
   （或手动把 zip + manifest.json 拷进本目录）
3. 客户端下次启动 / 点「检查更新」即可拉到新版本。

## 安全

- 下载端点限制为单层文件名、禁止路径穿越。
- 强烈建议经 Caddy 走 HTTPS（见 `server/DEPLOY.md`），客户端再用 SHA256 兜底校验防篡改。
- `RELEASES_DIR` 环境变量可改目录位置（默认 `server/releases`）。
