# XSG-Online 部署手册（M6）

目标受众：30 在线，单机部署，朋友圈玩。

## 0. 准备

- 服务器：2C4G 起步，Ubuntu 22.04 LTS，5Mbps 公网带宽
- 域名（如要给朋友远程玩）：备案完成；国内必须备案
- 客户端：玩家本地装好原版游戏 + 这些联机插件

## 1. 服务器基础环境

```bash
# 安装 Node.js 20（推荐 nvm）
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
exec $SHELL -l
nvm install 20
nvm alias default 20

# 安装 pm2 & Caddy
npm i -g pm2
sudo apt update && sudo apt install caddy -y

# 创建运行用户（可选）
sudo useradd -m -s /bin/bash xsg
sudo -i -u xsg
```

## 2. 拉代码

```bash
cd /srv
sudo git clone <your-repo-url> xsg
sudo chown -R xsg:xsg xsg
cd xsg/server
cp .env.example .env
vim .env  # 改 PORT/DB_PATH 等

npm ci --omit=dev
npm run build
```

`.env` 关键项：

```
NODE_ENV=production
PORT=3000
HOST=0.0.0.0
DB_PATH=/srv/xsg/data/xsg.db
LOG_LEVEL=info
MAX_MESSAGES_PER_SEC=20
MAX_PLAYERS_PER_MAP=50
WORLD_TICK_MS=200
TOKEN_TTL_SEC=86400
```

## 3. pm2 起进程

```bash
cd /srv/xsg/server
pm2 start pm2.config.js --env production
pm2 save
pm2 startup     # 按提示复制命令以 root 跑一次，开机自启
```

查日志：

```bash
pm2 logs xsg-server --lines 200
pm2 monit
```

热重启（不丢连接，但慢约 1-2 秒）：

```bash
pm2 reload xsg-server
```

## 4. Caddy 反代 + 自动证书

`/etc/caddy/Caddyfile`：

```
xsg.your.domain.cn {
    encode zstd gzip
    reverse_proxy localhost:3000
}
```

```bash
sudo systemctl reload caddy
```

之后客户端 `XdRs_Online_Net` 的 `serverUrl` 改成 `wss://xsg.your.domain.cn`。

## 5. 备份

每日 4 点 SQLite 在线热备：

```bash
crontab -e
```

```
0 4 * * * /usr/bin/sqlite3 /srv/xsg/data/xsg.db ".backup '/srv/xsg/backup/xsg-$(date +\%F).db'" && find /srv/xsg/backup -name 'xsg-*.db' -mtime +14 -delete
```

每周一次推到对象存储（可选）：

```bash
# 假设有 rclone 配好
30 4 * * 0 /usr/bin/rclone copy /srv/xsg/backup remote:xsg-backup --max-age 8d
```

## 6. 监控 / 告警

最小化方案：
- `GET /healthz` → 接 UptimeRobot 之类，5 分钟拨测
- `GET /stats` → 看在线、地图数、内存
- pm2 自带 `pm2 monit`

升级方案（v2 再做）：
- pino 输出 JSON 行，让 vector/promtail 收到 Loki
- prom-client 暴露 `/metrics`，Grafana 看趋势

## 7. 升级流程

```bash
cd /srv/xsg
git pull
cd server
npm ci --omit=dev
npm run build
pm2 reload xsg-server
```

如果 SQL 有新 migration：直接重启会自动跑（main.ts 启动时自动 runMigrations）。

## 8. 故障排查

| 症状 | 排查 |
|---|---|
| 客户端连不上 | 1) `curl http://server:3000/healthz` 看进程  2) Caddy `journalctl -u caddy -n 100`  3) 防火墙 80/443/3000  4) NW.js 客户端 F12 看 WebSocket 错误 |
| 玩家位置不同步 | `pm2 logs` 搜 `world tick` 是否启动；客户端 F12 看 `world.delta` 是否到达 |
| 数据库锁 | `lsof | grep xsg.db`；强制关 `pm2 stop xsg-server` 再 `pm2 start` |
| 内存爬升 | `pm2 monit` 看 RSS；80% 时自动 max_memory_restart |

## 9. 压测

```bash
cd /srv/xsg/server
npx tsx scripts/loadtest.ts --players 50 --duration 60 --url http://127.0.0.1:3000
```

观察：
- `top` 进程 CPU < 30%
- `/stats` 显示 `online: 50`
- 客户端不卡顿

## 10. GM 操作

```bash
# 看账号列表
npm run gm list-accounts

# 封禁
npm run gm ban 5

# 给 5 号角色加 1000 金币
npm run gm grant-gold 5 1000

# 给 5 号加 3 个 1 号道具
npm run gm grant-item 5 item 1 3

# 看某人完整状态
npm run gm dump-character 5

# 清理过期 token
npm run gm prune-tokens
```
