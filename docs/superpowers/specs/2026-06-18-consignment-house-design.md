# 寄售行设计（Consignment House / Marketplace）

- 日期：2026-06-18
- 状态：待用户审查（实现前定稿）
- 范围：服务端（`xiaoshagua-server/server`）+ 客户端联机插件（`xiaoshagua/js/plugins`，镜像到 `client-plugins/`）
- 一句话：玩家把背包里的道具/武器/防具按「物品 ×N + 单价」挂到全服寄售行，其他玩家**可按数量拆分购买**；卖家承担 20% 手续费（金币销毁），开格扩容也烧金币。异步成交、离线补发通知。

## 1. 背景与问题

现有交易系统（已读代码确认 `domain/trade/tradeService.ts`）是**面对面同步交易**：双方必须**同时在线**、走 invite→offer→lock→confirm 五段提交，内存态 `trades` Map，提交时一笔事务原子转账（`invRepo.applyGoldDelta` / `applyItemDelta`），记 `trade_log`。

痛点：卖家想出货必须蹲点等买家在线对面交易。寄售行解决「异步挂单 + 全服可买 + 离线也能卖出」的需求，是对现有同步交易的补充，不替代它。

经济侧：寄售行引入**金币销毁（sink）**——手续费 + 开格费都直接销毁，不进任何人口袋，用于对冲全服金币通胀。

## 2. 目标 / 非目标

**目标**

- 玩家把背包物品挂单（item/weapon/armor），全服玩家可浏览并**按数量购买（支持拆分）**。
- 上架即托管（escrow）：物品当场从卖家背包扣除，挂在挂单里；下架退回剩余、售出按量转给买家。
- 成交原子：买家付款（单价 × 购买数量）→ 卖家得 80% → 20% 销毁 → 对应数量物品转买家 → 挂单剩余量递减/售罄，全在一笔 SQLite 事务里完成；**并发拆分购买靠原子数量扣减保证不超卖**。
- 格位系统：默认 2 格，最多 10 格，顺序解锁，解锁费销毁；**已解锁格数 = 同时在售挂单上限**。
- 通知：卖家在线即时推送成交结果；离线进通知队列（邮箱），下次登录补发。买卖双方都能看到「卖给/买自谁、什么、多少钱」。
- 服务端为唯一权威；客户端 UI 仅展示与发起请求，所有校验在服务端兜底。

**非目标（YAGNI，v1 不做）**

- 不做挂单限时 / 自动过期退回（长期有效，直到售出或手动下架；以后可加）。
- 不做一口价以外的拍卖/竞价/还价（支持按数量拆分购买，但价格为固定单价，无竞价/还价）。
- 不做卖家信誉卡 / 历史成交统计面板（用户选 A 方案：仅列表显示卖家名 + 成交双方互见）。
- 不做跨服 / 分页搜索引擎级筛选（v1 只做按类型筛选 + 名字模糊 + 简单分页）。
- 不做关键/重要道具寄售（客户端隐藏 + 服务端类型白名单兜底）。

## 3. 关键决策（已与用户锁定 + 默认）

已锁定（用户确认）：

- **手续费**：卖家承担，费率 20%，**销毁**（不归买家、不归系统账户）。卖家实得 = 本次成交额（单价 × 数量）− 手续费。
- **格位**：默认 2，最多 10；解锁价 3=1万 / 4=5万 / 5=30万 / 6=150万 / 7=600万 / 8=2000万 / 9=5000万 / 10=1亿；**顺序解锁**，扣的金币**销毁**；**格数 = 同时在售上限**（一个挂单无论卖剩多少，只要未售罄/未下架就占 1 格）。
- **挂单形态**：一个挂单 = 某物品 ×N，定**单价**（每个的价格，整数）；买家可**按数量拆分购买**（1 .. 剩余量），买走部分后挂单剩余量减少，售罄即下架。
- **价格范围**：单价 1 ~ 999,000,000（9.99亿，记为 `GOLD_CAP`）；单笔购买额受买家金币上限约束（≤ `GOLD_CAP`）。
- **挂单时效**：长期有效，直到售罄或手动下架。
- **可卖类型**：道具 / 武器 / 防具；客户端隐藏关键/重要道具避免误卖。
- **不能买自己的单**。
- **售出通知**：在线即时推、离线进队列登录补发，含买家名 + 本次到手金币 + 手续费 + 数量。
- **「增加用户信息」= A 方案**：寄售列表显示挂单卖家名；成交后买卖双方都收到信息（买了谁的、卖给了谁、什么、多少、多少钱）。

默认（本设计补充，未特别说明即按此）：

- **单价为权威**：为支持拆分购买且避免取整漂移，挂单**存单价**。UI 可让卖家输入「总价」并即时换算单价展示，但落库以单价为准（总价 = 单价 × 数量）。这样每次拆分购买都是 `单价 × 购买数量` 的精确整数，无除法取整误差。
- **托管模型**：上架即扣物（escrow）全部 N 个，而非「成交时再校验持有」。理由：异步挂单期间卖家可能把物品用掉/交易掉/迁移存档覆盖，成交时再扣会频繁失败或被钻空子。金币侧不预扣（手续费从成交款里出）。
- **手续费取整**：单次成交额 `cost = unit_price × qty`，`fee = floor(cost × 20%)`，`proceeds = cost − fee`（向下取整，每笔独立计算）。
- **金币上限**：卖家入账后若超过 `GOLD_CAP`，超出部分**销毁**（入账 clamp 到 `GOLD_CAP`）。买家付款照常全额扣。属极端边界，记日志。
- **挂单可见性**：浏览列表默认展示全服 `active`（剩余量 > 0）挂单（含自己的，但自己的单买入按钮禁用）；「我的寄售」单独面板管理下架与开格。

## 4. 数据模型（新增迁移 `003_market.sql`）

沿用既有迁移机制（`db/migrate.ts` 按文件名排序、`_migration` 表去重、事务内 `db.exec(sql)`）。金额单位与全库一致：金币为整数；时间戳为 unix epoch ms。

```sql
-- 寄售挂单（escrow：上架即从卖家背包扣全部 N 个，托管于挂单；拆分购买递减 count）
CREATE TABLE IF NOT EXISTS market_listing (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id     INTEGER NOT NULL REFERENCES character(id) ON DELETE CASCADE,
  kind          TEXT    NOT NULL CHECK(kind IN ('item','weapon','armor')),
  data_id       INTEGER NOT NULL,
  orig_count    INTEGER NOT NULL CHECK(orig_count > 0),   -- 上架原始数量（展示用）
  count         INTEGER NOT NULL CHECK(count >= 0),       -- 剩余可售数量（拆分购买递减）
  unit_price    INTEGER NOT NULL CHECK(unit_price > 0),   -- 每个单价
  status        TEXT    NOT NULL DEFAULT 'active'
                CHECK(status IN ('active','sold','cancelled')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  sold_at       INTEGER                                   -- 售罄时间（count 归 0 时）
);
CREATE INDEX IF NOT EXISTS idx_market_listing_active ON market_listing(status, created_at);
CREATE INDEX IF NOT EXISTS idx_market_listing_seller ON market_listing(seller_id, status);

-- 寄售格位（默认 2；slots = 当前已解锁格数 2..10）
CREATE TABLE IF NOT EXISTS market_slot (
  character_id  INTEGER PRIMARY KEY REFERENCES character(id) ON DELETE CASCADE,
  slots         INTEGER NOT NULL DEFAULT 2,
  updated_at    INTEGER NOT NULL
);

-- 离线通知队列（通用邮箱；登录补发。寄售成交/购买都落这里）
CREATE TABLE IF NOT EXISTS notification (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id  INTEGER NOT NULL REFERENCES character(id) ON DELETE CASCADE,
  type          TEXT    NOT NULL,                      -- 'market_sold' | 'market_bought'
  payload_json  TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  read_at       INTEGER                                -- null = 未读/未送达
);
CREATE INDEX IF NOT EXISTS idx_notification_unread ON notification(character_id, read_at);

-- 成交流水（每笔购买一行；审计 + 经济统计 + 销毁额留痕）
CREATE TABLE IF NOT EXISTS market_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  listing_id    INTEGER NOT NULL,
  seller_id     INTEGER NOT NULL,
  buyer_id      INTEGER NOT NULL,
  kind          TEXT    NOT NULL,
  data_id       INTEGER NOT NULL,
  qty           INTEGER NOT NULL,                      -- 本次购买数量
  unit_price    INTEGER NOT NULL,
  cost          INTEGER NOT NULL,                      -- unit_price × qty（买家付）
  fee           INTEGER NOT NULL,                      -- 销毁额
  proceeds      INTEGER NOT NULL                       -- 卖家实得
);
CREATE INDEX IF NOT EXISTS idx_market_log_ts ON market_log(ts);
```

`market_slot` 行惰性创建：玩家第一次开寄售面板 / 第一次开格时 `INSERT OR IGNORE (character_id, 2, now)`，缺行按默认 2 处理。

## 5. 配置常量（`server/src/config.ts` 追加）

```
marketFeeBps:        2000,            // 手续费 20% = 2000/10000
marketDefaultSlots:  2,
marketMaxSlots:      10,
// 第 3..10 格的解锁价（index 0 = 第3格）
marketSlotPrices:    [10_000, 50_000, 300_000, 1_500_000, 6_000_000, 20_000_000, 50_000_000, 100_000_000],
goldCap:             999_000_000,     // 9.99亿；单价上限 & 金币上限
marketMaxUnitPrice:  999_000_000,     // 单价上限
marketMaxStack:      9999,            // 单挂单最大数量
marketBrowsePageMax: 50,
```

（均可被环境变量覆盖，沿用现有 `num()` 读取风格。）

## 6. 服务端详细设计

新增 `server/src/domain/market/marketService.ts` + `marketRepo.ts`，在 `gateway/router.ts` 注册 socket 事件，复用：

- 资产读写：`invRepo.getGold / applyGoldDelta / applyItemDelta / listInventory / tx`（已存在，事务内安全）。
- 在线判定 / 推送：`getOnlineByPid(pid)` 拿 `socketId`，`io.to(socketId).emit('market.*.evt', payload)`。
- 角色名：`findCharacterById(pid).name`。
- 错误：`AppError(code, msg)`；校验：`util/schema.ts` 加 zod schema；router 用 `parse()`、`requireAuth()`、`takeToken()` 限流、`okAck/failAck` 返回（与既有 handler 完全一致）。

### 6.1 事件清单（socket，全部走 ack）

请求类（client → server）：

- `market.browse` `{ offset?, limit?, kind?, q? }` → `{ listings:[{id, sellerId, sellerName, kind, dataId, origCount, count, unitPrice, createdAt, mine}], total }`
- `market.mine` `{}` → `{ slots, maxSlots, usedSlots, nextSlotIndex, nextSlotPrice, gold, listings:[ 我的 active 挂单(含剩余量) ] }`
- `market.create` `{ kind, dataId, count, unitPrice }` → `{ listingId }`（escrow 扣全部 count 个）
- `market.cancel` `{ listingId }` → `{ ok:true, returned }`（退回剩余托管物）
- `market.buy` `{ listingId, qty }` → `{ ok:true, kind, dataId, qty, cost }`（原子拆分成交）
- `market.unlockSlot` `{}` → `{ slots, spent }`（开下一格，扣费销毁）
- `market.notifications` `{}` → `{ items:[{id, type, payload, createdAt}] }`（拉未读）
- `market.ack` `{ ids:[...] }` → `{ ok:true }`（标记已读）

推送类（server → client）：

- `market.sold.evt`（卖家在线时即时推，每笔购买一次）：`{ listingId, kind, dataId, qty, unitPrice, cost, fee, proceeds, remaining, buyerId, buyerName }`
- `market.notify.evt`（登录/进图补发离线队列）：`{ items:[...] }`

### 6.2 上架 `create`（事务）

```
parse: kind∈{item,weapon,armor}, dataId>0, 1<=count<=marketMaxStack, 1<=unitPrice<=GOLD_CAP
tx:
  slots = getSlots(pid)              // 缺行=2
  used  = countActiveListings(pid)   // status='active' 计数
  if used >= slots  -> NO_SLOT
  have  = listInventory(pid) 中该 (kind,dataId) 的 count
  if have < count   -> NOT_ENOUGH_ITEM
  applyItemDelta(db, pid, kind, dataId, -count)   // escrow 扣全部 count 个
  INSERT market_listing(... orig_count=count, count=count, unit_price, status='active', created_at=now, updated_at=now)
  return listingId
```

- 上架不收手续费（手续费只在每笔成交时从卖家款里扣）。
- 客户端在 ack 成功后本地 reconcile 背包（`inventory.snapshot` → `G.Inv.reconcileLocal({fullReplace:true})`，与 Trade 成交后同款做法）。

### 6.3 下架 `cancel`（事务）

```
tx:
  row = SELECT * FROM market_listing WHERE id=?
  if !row || row.seller_id != pid     -> FORBIDDEN
  if row.status != 'active'           -> BAD_STATE
  remaining = row.count
  n = UPDATE ... SET status='cancelled', updated_at=now WHERE id=? AND status='active'
  if n != 1                           -> LISTING_GONE（并发兜底）
  if remaining > 0:
    applyItemDelta(db, pid, row.kind, row.data_id, +remaining)   // 退回剩余托管物
  return { ok, returned: remaining }
```

### 6.4 购买 `buy`（事务，核心：拆分 + 原子数量扣减）

```
parse: listingId>0, qty>=1
tx:
  row = SELECT * FROM market_listing WHERE id=?
  if !row || row.status != 'active' || row.count <= 0  -> LISTING_GONE
  if row.seller_id == pid             -> CANNOT_BUY_OWN
  if qty > row.count                  -> BAD_QTY（买超剩余量；客户端应已 clamp）
  cost     = row.unit_price * qty
  buyerGold = getGold(pid)
  if buyerGold < cost                 -> NOT_ENOUGH_GOLD
  fee      = floor(cost * marketFeeBps / 10000)
  proceeds = cost - fee
  // 原子扣减剩余量：并发买家同时买，谁的 count>=qty 条件不满足谁拿到 n=0
  n = UPDATE market_listing
        SET count = count - qty,
            status = CASE WHEN count - qty = 0 THEN 'sold' ELSE 'active' END,
            sold_at = CASE WHEN count - qty = 0 THEN now ELSE sold_at END,
            updated_at = now
        WHERE id=? AND status='active' AND count >= qty
  if n != 1                           -> LISTING_GONE（已被买空/下架/并发抢先）
  applyGoldDelta(db, pid, -cost)                       // 买家付 cost
  creditSeller(db, row.seller_id, proceeds)            // 卖家得 80%，clamp 到 GOLD_CAP，超出销毁
  applyItemDelta(db, pid, row.kind, row.data_id, +qty) // qty 个物品给买家
  INSERT market_log(... qty, unit_price, cost, fee, proceeds)
  enqueueNotification(db, row.seller_id, 'market_sold',  {buyerName, qty, cost, fee, proceeds, remaining: count-qty, ...})
  enqueueNotification(db, pid,           'market_bought', {sellerName, qty, cost, ...})
return { ok, kind, dataId, qty, cost }
```

- **拆分 + 并发安全**：`UPDATE ... WHERE status='active' AND count >= qty` 的原子条件扣减是关键——同一挂单的并发购买不会超卖；剩余不足者拿 `n=0` → `LISTING_GONE`。better-sqlite3 同步 + `withTx` 串行化进一步保证单进程内不并行。
- **售罄**：`count - qty == 0` 时 `status='sold'` 并置 `sold_at`；否则保持 `active` 继续可买。
- **卖家在线推送**：事务**提交成功后**（非事务内）若 `getOnlineByPid(seller)` 命中，`io.to(socketId).emit('market.sold.evt', ...)`，并把该通知行 `read_at=now` 标已送达。提交后再推，避免「推了但事务回滚」。
- **买家**：在线（刚下单），`buy` 的 ack 直接带回结果；客户端 reconcile 背包 + 金币。买家那行 `market_bought` 用于历史留痕，ack 时即可标已读。

### 6.5 开格 `unlockSlot`（事务）

```
tx:
  slots = getSlots(pid)               // 缺行=2，先 INSERT OR IGNORE
  if slots >= marketMaxSlots          -> SLOT_MAXED
  price = marketSlotPrices[slots - 2] // slots=2 → 开第3格 → index 0
  if getGold(pid) < price             -> NOT_ENOUGH_GOLD
  applyGoldDelta(db, pid, -price)     // 扣费即销毁（不入任何账户）
  UPDATE market_slot SET slots=slots+1, updated_at=now WHERE character_id=?
return { slots: slots+1, spent: price }
```

### 6.6 离线通知队列

- 通用 `notification` 表，`type + payload_json`。每笔成交写 `market_sold`（给卖家）、`market_bought`（给买家）。
- **补发时机**：玩家 `player.enterMap` 成功后（已确有在线 socket），服务端查该 pid `read_at IS NULL` 的通知 → `market.notify.evt` 批量推 → 标记 `read_at=now`。也提供 `market.notifications` 主动拉 + `market.ack` 兜底（防推送丢失）。
- 卖家离线期间成交：金币 / 物品在 DB 权威表已结算，登录后 `inventory.snapshot` 自然带出新金币；通知只负责「讲清楚卖了多少给谁、到手多少、还剩多少」。

## 7. 客户端详细设计（`XdRs_Online_Market.js`）

新增插件，DOM 浮层风格**完全照搬 `XdRs_Online_Trade.js`**（已读）：`position:absolute` 全屏遮罩 + 居中卡片；对 `mousedown/mouseup/click/pointer*/touch*/wheel/contextmenu` 全部 `stopPropagation`（否则点按钮会触发 RMMZ TouchInput 寻路）；`keydown` 也拦截。

### 7.1 入口

- 在 `XdRs_Online_Hub.js`（联机中心宫格菜单，已读其 FAB + 宫格结构）加一格「寄售行」，点开 Market 面板。
- 可选：地图上「寄售行 NPC / 区域」触发（沿用 Dungeon 的 regionId 思路）留待美术/地图配置，v1 先走 Hub 入口。

### 7.2 面板（三个 Tab）

- **浏览**：`market.browse` 拉列表，每行「物品名 | 卖家名 | 剩余 count | 单价 | [购买]」。顶部类型筛选 + 名字搜索 + 翻页。自己的单买入禁用并标「(我的)」。点购买 → 弹**数量选择**（1 .. 剩余量，默认 1；显示 `应付 = 单价 × 数量`）→ 二次确认 → `market.buy {listingId, qty}` → 成功后 reconcile + toast「已买入 [物品]×qty，花费 [cost]」。
- **我的寄售**：`market.mine` 显示「格位 used/slots」「下一格解锁价 [nextSlotPrice]（[开格]按钮）」「我的金币」「在售挂单（剩余量/原始量）+ [下架]」。下架 → `market.cancel` → reconcile 退物。
- **上架**：复用 Trade 的物品 picker（`listOwnedItems()` 读 `$gameParty._items/_weapons/_armors` + `$dataItems/$dataWeapons/$dataArmors`）。选物 + 数量 + **单价**（同时实时显示「总价 = 单价 × 数量」）→ `market.create`。**过滤关键/重要道具**：`item` 且 `$dataItems[id].itypeId === 2`（关键道具）排除；备注含 `<noSell>` / `<xsgNoSell>` 的排除。

### 7.3 成交通知（toast）

- 复用 Trade 的右下角非阻塞浮层样式。监听 `market.sold.evt`：弹「💰 你的 [物品]×qty 已售出给 [买家]，到手 [proceeds]（手续费 [fee]），剩余 [remaining]」。
- 监听 `market.notify.evt`（登录补发）：逐条弹，量大时合并「你不在时卖出 N 笔，合计到手 X」，可展开明细。
- 进图后兜底 `market.notifications` 拉一次，防 evt 丢失。

### 7.4 注册

- `plugins.js` 在 `XdRs_Online_Trade` 之后插入 `{"name":"XdRs_Online_Market","status":true,...}`（依赖 Util/Net/Core，在 Hub 之前，便于 Hub 引用其 open 方法）。
- 文件同时镜像到 `xiaoshagua-server/client-plugins/XdRs_Online_Market.js`（与 SaveOwner/SaveMigrate 同规矩，便于 `_deploy-*.js` 分发）。

## 8. 错误码（沿用 `AppError(code,msg)`，无需枚举）

- `NO_SLOT`：在售挂单已达格位上限。
- `NOT_ENOUGH_ITEM`：上架数量超过持有。
- `NOT_ENOUGH_GOLD`：买入/开格金币不足。
- `CANNOT_BUY_OWN`：不能买自己的挂单。
- `BAD_QTY`：购买数量 ≤ 0 或超过剩余量。
- `LISTING_GONE`：挂单已售罄/已下架/并发抢先（剩余不足）。
- `BAD_STATE`：对非 active 挂单下架。
- `FORBIDDEN`：操作非本人挂单。
- `SLOT_MAXED`：已达 10 格上限。
- `BAD_INPUT`：单价/数量越界（由 zod 兜底）。

## 9. 防滥用 / 经济安全

- **格位 = 在售上限**：天然限制单人挂单数量与刷屏（部分售出仍占格直到售罄/下架）。
- **托管扣物**：上架即扣全部 N 个，杜绝「挂单后把物品交易掉/用掉/存档覆盖再被买」造成的负库存。
- **不能自买**：`seller_id == buyer` 直接拒；防左右手刷量/洗金币（自买也要烧 20%，无套利，但仍显式禁止）。
- **原子拆分扣减**：`WHERE count >= qty` 条件更新，杜绝并发超卖。
- **单价/数量区间**：zod + CHECK 双层；防 0 元单 / 溢出。
- **金币上限 clamp**：卖家入账封顶 `GOLD_CAP`，超出销毁，防整数膨胀。
- **限流**：所有写事件经 `takeToken(socket)`（既有 20 msg/s 桶）。
- **服务端权威**：客户端隐藏关键道具仅为体验；服务端类型白名单（item/weapon/armor）+ 持有量校验兜底。
- **审计**：`market_log` 每笔成交一行（含 fee/proceeds），便于统计销毁总额与通胀对冲效果。

## 10. 边界与风险

- **角色删除/封号**：`ON DELETE CASCADE` 连带删除其 `market_listing`，**托管中的剩余物品随之消失**（可接受：v1 不退回已删号资产）。更稳妥做法：删号脚本先 `cancel` 其 active 挂单退物——列入运维脚本，不在 v1 自动化。
- **物品 dataId 在游戏更新后失效**：买家仍按 (kind,dataId) 入库，客户端无名称时显示原始 id，不崩。
- **金币达上限的卖家**：入账被 clamp、超出销毁，记 warn 日志。极少见。
- **离线补发风暴**：长期离线攒了很多通知 → 合并展示「卖出 N 笔，合计到手 X」，明细可展开（参考 router 里上线公告防抖思路）。
- **拆分后剩 1 个的零头单**：正常可买/可下架，无特殊处理。
- **与同步交易并存**：寄售与 `tradeService` 互不影响；托管物已不在背包，不会被同步交易二次上桌。

## 11. 测试计划

服务端（`server/test/marketService.test.ts`，vitest；参考既有 `storageService.test.ts` 的 DB 初始化方式）：

- create：扣全部 count 物 + 占 1 格 + 落 active 行（orig_count=count）；无空格 → `NO_SLOT`；持有不足 → `NOT_ENOUGH_ITEM`；单价/数量越界 → `BAD_INPUT`。
- cancel：退回**剩余** count 物；非本人 → `FORBIDDEN`；非 active → `BAD_STATE`。
- buy 全量：qty == 剩余 → 状态 sold、count=0、sold_at 置位。
- buy 拆分：qty < 剩余 → count 递减、status 仍 active；可再次购买直到售罄。
- buy 金额：买家扣 `cost=unit×qty`、卖家得 80%、20% 销毁（验金币守恒：买家付 − 卖家得 = fee）、买家得 qty 物。
- buy 拒绝：自买 → `CANNOT_BUY_OWN`；金币不足 → `NOT_ENOUGH_GOLD`；qty>剩余 → `BAD_QTY`；买已售罄 → `LISTING_GONE`。
- 并发拆分：两笔购买 qty 之和 > 剩余 → 仅一笔成功，另一笔 `LISTING_GONE`/`BAD_QTY`（验不超卖）。
- 费率取整：unit=10,qty=10 → cost=100,fee=20,proceeds=80；cost=99 → fee=19,proceeds=80（floor 验证）。
- unlockSlot：slots 递增 + 扣费销毁 + 顺序价正确（2→3 收 1万…9→10 收 1亿）；达 10 → `SLOT_MAXED`；金币不足 → `NOT_ENOUGH_GOLD`。
- notification：每笔成交给卖家落 `market_sold`、给买家落 `market_bought`；`notifications` 拉取 + `ack` 标已读。
- 金币上限：卖家入账超 `GOLD_CAP` → clamp 到上限、差额销毁。

客户端（手测/联机自测）：

- 上架后背包对应物品减少 count 个、占 1 格；浏览列表能看到（含卖家名 + 剩余量 + 单价）。
- A 买 B 的单一部分：A 金币减 `cost`、背包多 qty 物；挂单剩余量减少仍在售；B 在线收到 `market.sold.evt` toast（买家名/数量/到手/手续费/剩余）。
- A 把单买空：挂单消失；B 同样收到 toast。
- B 离线时被买 → B 登录后收到补发通知，且金币已到账。
- 下架退回剩余物品；关键道具不出现在上架 picker。
- 并发：两端同时买同一单且总量超剩余，仅一端成功，另一端提示「已被买走/数量不足」。

## 12. 影响面 / 改动文件

服务端（`xiaoshagua-server/server/src/`）：

- 新增 `db/migrations/003_market.sql`（4 张表 + 索引）。
- 新增 `domain/market/marketRepo.ts`（表 CRUD）+ `domain/market/marketService.ts`（业务 + 事务 + 推送 + 通知）。
- 改 `gateway/router.ts`：`import` + `attachMarketIo(io)` + 8 个 `socket.on('market.*')` handler + 在 `player.enterMap` 成功分支补「补发离线通知」。
- 改 `util/schema.ts`：新增 `MarketBrowse / MarketCreate / MarketBuy / MarketIdOnly / MarketAck` 及类型。
- 改 `config.ts`：第 5 节常量。
- 新增 `server/test/marketService.test.ts`。

客户端（`xiaoshagua/js/plugins/`，镜像 `xiaoshagua-server/client-plugins/`）：

- 新增 `XdRs_Online_Market.js`。
- 改 `js/plugins.js`：注册（Trade 之后、Hub 之前）。
- 改 `XdRs_Online_Hub.js`：宫格加「寄售行」入口。

## 13. 验证方法（上线前）

- 服务端：`npm run typecheck` 0 错、`npm test` 全绿（含新用例）、`npm run build` 0 错、`npm run migrate` 应用 `003`。
- 客户端：`node --check` 改动文件、`plugins.js` JSON 合法、ReadLints 无错。
- 联机自测：按第 11 节客户端场景全跑一遍（含拆分购买、离线补发、并发超卖防护）。
- 部署：服务端走已验证的 `_deploy-live.js`（git pull 快进 + build + migrate + pm2 重启 + healthz）；客户端重打包分发（用户手动）。

## 14. 实现顺序建议（TDD）

1. `003_market.sql` + `marketRepo` + `config` 常量。
2. 先写 `marketService.test.ts`（红）→ 实现 `marketService`（create/cancel/buy 拆分/unlockSlot/通知）让其转绿（TDD）。
3. router 接线 + schema + enterMap 补发。
4. 客户端 `XdRs_Online_Market.js` + Hub 入口 + plugins.js。
5. 全量 typecheck/test/build → 联机自测 → 部署。

## 15. 回滚

- 全部为**新增**（新表 / 新插件 / 新 handler），不改既有交易/存档/资产逻辑。
- 回滚 = `plugins.js` 把 `XdRs_Online_Market` 置 `status:false` + 摘除 router 的 market handler；新表保留无害。
- 回滚前若有 active 挂单：跑一次性脚本把所有 `active` 挂单 `cancel`（退回剩余托管物）再下线，避免玩家物品被锁死在挂单里。
