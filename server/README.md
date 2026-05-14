# xiaoshagua-server (XSG-Online M1 → M6)

权威游戏服务器。覆盖完整方案的 6 个里程碑：

| 里程碑 | 内容 |
|---|---|
| **M1** | 账号注册/登录/resume、连接、位置上报、同地图广播、200ms tick 合并 |
| **M2** | 三频道聊天（world / nearby / whisper）、好友、黑名单、上下线公告 |
| **M3** | 服务器权威金币/物品、共享开关/变量、云存档 |
| **M4** | 两段提交交易（lock 重置语义）、服务端权威宠物（喂养/训练/进化 + 冷却）|
| **M5** | 多人副本实例（virtualMapId 隔离）、localStorage token 自动重连 |
| **M6** | pm2 + Caddy 部署、SQLite 备份、50 人 loadtest、GM CLI |

## 启动

```bash
cd server
cp .env.example .env
npm install
npm run dev
```

启动后：

- HTTP/WS 监听 `http://localhost:3000`
- 健康检查 `GET /healthz`
- 运维只读 `GET /stats`（在线人数、地图数、内存、运行时长）
- SQLite 数据库写入 `server/data/xsg.db`

## 协议总览

所有事件走 Socket.IO 默认 JSON 编码（msgpack 优化留到 M3+）。带 ack 的请求统一返回：

```
{ok:true, data:...} 或 {ok:false, error:{code, message}}
```

### M1 - 身份、世界
| 事件 | 方向 | payload | 说明 |
|---|---|---|---|
| `auth.register` | C→S | `{username, password, charName?, ...}` | 注册并自动登录 |
| `auth.login` | C→S | `{username, password}` | 登录 |
| `auth.resume` | C→S | `{token, lastSeq?}` | 令牌恢复 |
| `player.enterMap` | C→S | `{mapId, x, y, d}` | 入场 |
| `player.move` | C→S | `{x, y, d, ts?}` | 5Hz 节流上报 |
| `player.action` | C→S | `{type}` | 跳/挥手等 |
| `world.delta` | S→C | `{seq, enter[], leave[], move[], action[]}` | 200ms 合并广播 |
| `sys.error` / `sys.notice` | S→C | `{code/level, msg/text}` | 错误 / 系统公告 |

### M2 - 社交
| 事件 | 方向 | payload |
|---|---|---|
| `chat.send` | C→S | `{channel: 'world'\|'nearby'\|'whisper', text, targetPid?}` |
| `chat.evt` | S→C | `{channel, fromPid, fromName, toPid?, text, ts}` |
| `social.list` | C→S | `{}` → `{friends[], blocks[]}` |
| `social.add` / `social.remove` | C→S | `{pid, kind: 'friend'\|'block'}` |
| `social.lookup` | C→S | `{pid}` → `{found, entry?}` |

### M3 - 资产、状态、云存档
| 事件 | 方向 | payload |
|---|---|---|
| `inventory.snapshot` | C→S | `{}` → `{gold, items[]}` |
| `inventory.gainGold` | C→S | `{amount, reason?}` → `{appliedDelta, newTotal}` |
| `inventory.gainItem` | C→S | `{kind, dataId, amount, reason?}` → `{appliedDelta, newTotal}` |
| `inventory.use` | C→S | `{kind, dataId, count}` → `{appliedDelta, newTotal}` |
| `inventory.delta` | S→C | `{gold?, items?[]}` 推送 |
| `state.snapshot` | C→S | `{}` → `{switches[], vars[]}` |
| `state.setSwitch` / `state.setVar` | C→S | `{id, value}` → `{changed}` |
| `state.switchEvt` / `state.varEvt` | S→C | `{id, value, ts}` |
| `save.upload` | C→S | `{contents, meta?}` → `{ts}` |
| `save.download` | C→S | `{}` → `{found, blob?}` |
| `save.exists` | C→S | `{}` → `{exists}` |

### M4 - 交易、宠物
| 事件 | 方向 | payload |
|---|---|---|
| `trade.invite` | C→S | `{targetPid}` → `{tradeId}` |
| `trade.invite.evt` | S→C | `{tradeId, fromPid, fromName}` |
| `trade.respond` | C→S | `{tradeId, accept}` |
| `trade.opened.evt` | S→C | `{tradeId, peer}` |
| `trade.offer` | C→S | `{tradeId, gold, items[]}` |
| `trade.update.evt` | S→C | `{tradeId, state, a, b}` |
| `trade.lock` / `trade.unlock` / `trade.confirm` / `trade.cancel` | C→S | `{tradeId}` |
| `trade.done.evt` | S→C | `{tradeId, ok, reason}` |
| `pet.list` | C→S | `{}` → `{pets[]}` |
| `pet.adopt` | C→S | `{speciesId, name}` → `pet` |
| `pet.act` | C→S | `{petId, action: 'feed'\|'train'\|'evolve'}` → `{pet, delta}` |

### M5 - 副本、重连
| 事件 | 方向 | payload |
|---|---|---|
| `dungeon.enter` | C→S | `{dungeonId, partyIds?[]}` → `{instanceId, virtualMapId, baseMapId, spawn, party}` |
| `dungeon.leave` | C→S | `{}` |
| `dungeon.enter.evt` / `dungeon.leave.evt` / `dungeon.peerLeft.evt` | S→C | 副本内广播 |

重连：使用 `auth.resume` + `XdRs_Online_Reconnect.js` 客户端 localStorage 持久化 token。

## 脚本

- `npm run dev`：tsx watch 热重载
- `npm run typecheck`：仅类型检查
- `npm test`：vitest 一次性
- `npm run test:watch`：vitest watch 模式
- `npm run build`：编译到 `dist/`（同步拷贝 `db/migrations/*.sql`）
- `npm run start`：跑 `dist/main.js`
- `npm run migrate`：单独跑数据库迁移
- `npm run loadtest -- --players 50 --duration 60`：50 个机器人随机走 60 秒
- `npm run gm list-accounts` / `npm run gm grant-gold 1 5000` 等：见 `DEPLOY.md` 第 10 节

## 目录

```
src/
  main.ts              入口
  config.ts            env 解析
  log.ts               pino 日志
  db/
    sqlite.ts          连接（WAL）
    migrate.ts         迁移 runner
    migrations/        SQL
  util/
    schema.ts          zod 入参校验
    crypto.ts          argon2 密码
    throttle.ts        token bucket
    ids.ts             nanoid
    errors.ts          AppError
  domain/
    player/
      playerRepo.ts    DB 封装
      playerService.ts 账号 + 在线状态
    world/
      mapState.ts      单地图状态
      worldService.ts  入场/广播/tick
  domain/
    chat/              M2 chatRepo + chatService
    social/            M2 socialRepo + socialService
    inventory/         M3 inventoryRepo + inventoryService
    state/             M3 stateService (shared switches/variables)
    storage/           M3 storageService (cloud save)
    trade/             M4 tradeService (two-phase commit)
    pet/               M4 petRepo + petService
    dungeon/           M5 dungeonService (instance isolation)
  gateway/
    types.ts           Socket 扩展
    middleware.ts      会话绑定 + 限流
    io.ts              Socket.IO 启动 + /healthz /stats
    router.ts          全部事件路由

test/
  schema.test.ts       M1 zod 入参校验
  schema.m2.test.ts    M2 schema
  mapState.test.ts     单地图状态机

scripts/
  copy-assets.mjs      build 时拷贝 SQL/资源到 dist/
  loadtest.ts          压测：N 个机器人随机走
  gm.ts                GM CLI：账号/封禁/资产/dump
```

部署见 [DEPLOY.md](./DEPLOY.md)。

## 客户端联机插件

位于游戏目录 `js/plugins/`（已自动在 `plugins.js` 末尾追加，按以下顺序加载）：

| 插件 | 里程碑 | 作用 |
|---|---|---|
| `vendor/socket.io.min.js` | M1 | socket.io-client v4 vendor |
| `XdRs_Online_Util.js` | M1 | 全局命名空间、日志、节流 |
| `XdRs_Online_Net.js` | M1 | socket 封装，`request()` 返 Promise |
| `XdRs_Online_Core.js` | M1 | 生命周期 + 会话 |
| `XdRs_Online_Reconnect.js` | M5 | localStorage token + 开机自动 resume |
| `XdRs_Online_Login.js` | M1 | 标题菜单追加「联机」入口，DOM 登录窗 |
| `XdRs_Online_PlayerSync.js` | M1 | 5Hz 节流上报，他人 `Sprite_OtherPlayer` |
| `XdRs_Online_SharedState.js` | M3 | 指定 switch/var id 走服务端全局同步 |
| `XdRs_Online_Inventory.js` | M3 | `gainGold/gainItem` 拦截，乐观本地 + 服务端校准 |
| `XdRs_Online_SaveCloud.js` | M3 | `DataManager.saveGame/loadGame` 走云存档 |
| `XdRs_Online_Chat.js` | M2 | Enter 唤起聊天面板 + 头顶气泡 |
| `XdRs_Online_Friend.js` | M2 | F 唤起好友/黑名单面板 |
| `XdRs_Online_Trade.js` | M4 | 两段提交交易 DOM 窗 |
| `XdRs_Online_Pet.js` | M4 | P 唤起云宠物面板 |
| `XdRs_Online_Dungeon.js` | M5 | regionId 触发副本进入/离开 |

要换服务器地址，在 RMMZ 插件管理器里编辑 `XdRs_Online_Net` 的 `serverUrl` 参数（默认 `ws://127.0.0.1:3000`）。

### 默认热键

| 键 | 动作 |
|---|---|
| Enter | 打开聊天面板（聊天面板已打开时按 Enter 发送） |
| F | 切换好友面板 |
| P | 切换云宠物面板 |
| 踩 regionId=20 | 进入副本（test_cave）|
| 踩 regionId=21 | 离开副本 |

### 共享开关/变量配置

在 `XdRs_Online_SharedState` 插件参数 `sharedSwitchIds` / `sharedVariableIds` 填逗号分隔 ID，例如 `1,5,12`。这些 ID 的 `setValue` 会同步给全服。其他开关/变量保持原生 RMMZ 行为（本地）。

