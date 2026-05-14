# xiaoshagua-server

《我的小傻瓜》RMMZ 单机游戏的**联机服务端 + 客户端联机插件**。

提供完整的 M1\~M6 功能：账号 / 同场可见 / 三频道聊天 / 好友黑名单 / 服务器权威金币物品 / 共享开关 / 云存档 / 两段提交交易 / 服端权威宠物 / 多人副本 / 断线自动 resume。

> 这个仓库只放**服务端源码 + 客户端联机插件**。原版游戏的 NW.js 运行时与素材（约 1GB）需要玩家本地装好。

## 仓库结构

```
xiaoshagua-server/
  server/                  Node + TypeScript 服务端（M1~M6 全部实现）
    src/                   源码（domain / gateway / util / db）
    test/                  vitest 测试（25 个用例全绿）
    scripts/               copy-assets / loadtest / gm CLI
    package.json
    DEPLOY.md              详细部署文档（pm2 + Caddy + 备份）
    README.md              服务端 README（事件协议表）

  client-plugins/          14 个客户端联机插件
    XdRs_Online_*.js
    README.md              安装步骤
```

## 一键部署到云

服务端的部署脚本仓库：https://github.com/honghongfei/xsg-deploy

云服上 SSH 后跑：

```bash
curl -fsSL https://raw.githubusercontent.com/honghongfei/xsg-deploy/main/install.sh \
  | bash -s -- --repo https://github.com/honghongfei/xiaoshagua-server.git
```

脚本会自动装 Node.js 20 + pm2 + 编译 + 起服务，最后告诉你公网 IP 和怎么改客户端。

## 本地开发

```bash
cd server
npm ci
npm run dev       # tsx watch，改一存自动重启
npm test          # vitest，25 个用例
npm run typecheck # 仅类型检查
```

## 协议文档

服务端事件清单见 [server/README.md](server/README.md)。

部署上云详细步骤见 [server/DEPLOY.md](server/DEPLOY.md)。

## 里程碑实现

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M1 骨架 | 账号 / 连接 / 位置上报 / 同场可见 | ✅ |
| M2 社交 | 三频道聊天 / 好友 / 黑名单 / 上下线公告 | ✅ |
| M3 资产 | 金币物品服端权威 / 共享开关变量 / 云存档 | ✅ |
| M4 交易+宠物 | 两段提交交易 / 服端宠物（喂养训练进化）| ✅ |
| M5 副本+重连 | 多人副本实例 / localStorage token 自动 resume | ✅ |
| M6 部署 | pm2 + Caddy + DEPLOY.md + loadtest + GM CLI | ✅ |

## 客户端怎么用

1. `client-plugins/` 里的 14 个 `XdRs_Online_*.js` 复制到游戏目录 `js/plugins/` 下
2. `client-plugins/README.md` 给出了在 `js/plugins.js` 末尾追加的内容
3. 修改 `XdRs_Online_Net` 插件参数 `serverUrl` 指向你的服务器（`ws://1.2.3.4:3000`）

## 安全注意

裸 IP + ws:// 部署时账号密码是**明文传输**。只用于朋友圈小范围联机，别用重要密码。
要 HTTPS 见 [server/DEPLOY.md](server/DEPLOY.md) 第 4 节（Caddy 自动 HTTPS）。

## 协议

MIT。
