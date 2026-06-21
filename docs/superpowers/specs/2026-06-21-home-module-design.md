# 家园模块设计（Home / Private Housing）

- 日期：2026-06-21
- 状态：待用户审查（实现前定稿）
- 范围：服务端（`xiaoshagua-server/server`）+ 客户端联机插件（`xiaoshagua/js/plugins`，镜像到 `client-plugins/`）+ 一个数据抽取脚本
- 一句话：把原版**单机已有的"房型升级 + 装修地图 + 家具道具"**搬上线，做成**每人一间的私有实例化家园**——房型/风格/家具布局/花园解锁全部**服务端权威持久化**；房主可设可见性（私密/好友/公开）；新增**家具自由 DIY 摆放**；好友可串门、实时同步。

## 1. 背景与问题

现状（已读代码与游戏数据确认）：

- **房型升级已存在（单机）**：`data/CommonEvents.json` 中 id 702~731「升X级房型XX系」一长串，每个 = 播放装修动画(212, animationId=119) + 用 `Control Switches`(121) **单选翻转开关 582~611**（开选中风格、关同组其它）。
- **装修地图已存在**：`data/MapInfos.json` 里「椰树大厦1层B（家）」「空中花园1层B（家）」几十张不同等级+配色的成品图；家地图用 **parallax 远景图**（如 `Map061` 的 `parallaxName:"HomeMap00"`）做底，"换底图" = 换 parallax + 瓦片。
- **房型→地图机制**：家门事件（如 `Map017`「B传送」）用**多页条件传送**：默认页传送低级装修图（如 Map42），开关 582 ON 的页传送更高装修图。即房型开关决定进门落哪张装修图。
- **家具已是物品**：`data/Items.json` 一大批 `⭐家具-*`（沙发/床/墙纸/地砖/壁画/餐桌…），`itypeId:1`、有图标/价格(1500~4200)、`note:"<SRateType:0>"`。
- **经济已存在**：任务文本提到「房产中心」买「2级/3级房型券」升级、促销、贵宾卡。
- **花园已存在**：开关 585（=4级房型）解锁种花区（`Map017`「椰树大厦花园传送」），接种植系统。
- **功能家具已存在**：床 = `Map061`「睡觉恢复体力+100」是地图事件。

痛点（用户原话）：

1. **所有玩家挤在同一个房间**——因为大家进的是**同一个真实 mapId**，`worldService.enterMap` 把同 mapId 的人放进同一个 `room('map:'+mapId)` socket 房间互相可见。
2. **家具没法自由调整**——家具只是物品 + 预置在装修图里的装饰，**没有自由摆放系统**（`XdRs_Arder_Objects.js` 是种植/宠物对象系统，非家具摆放）。
3. **房子要能升级**——升级机制有，但状态是**本地单机存档里的开关/变量**，上线后不可信、不跨设备。

结论：本功能**不是从零做**，而是「把现成单机家园搬上线 + 补一个家具 DIY 系统」。复用全部美术与大部分玩法逻辑，新增联机层 + 服务端权威 + 自由摆放。

## 2. 目标 / 非目标

**目标**

- **私有实例化**：每个角色一间家园，复用副本式虚拟地图实例（`dungeonService` 模式），但**按 ownerPid 确定性 + 持久化**（每次回同一间，区别于副本的临时随机实例）。
- **可见性由房主设**：`private`（仅自己）/ `friends`（好友可访客，复用 `socialService.listFriends`）/ `public`（任何人，黑名单挡）。编辑权 v1 仅房主。
- **房型升级服务端权威**：房型等级/风格/楼栋/花园解锁存服务端；客户端开关 582~611 降级为"渲染触发器"，进门时按服务端值设置。升级走服务端校验（消耗房型券 / 金币）。
- **复用现成装修美术**：tier 0~17 的 parallax 装修图、两栋楼（椰树大厦低阶 / 空中花园高阶）、升级动画全部沿用。
- **家具自由 DIY（新增）**：家具道具可在家中自由摆放（放/移/转/收），布局服务端持久化；家具拥有复用现有 `inventory`（家具=item）。
- **访客实时同步**：进别人家看到房主的房型外观 + 已摆家具 + 在场玩家走动（玩家走动复用现有 `world.delta`）。
- **服务端唯一权威**：客户端只展示与发起请求，所有校验服务端兜底。

**非目标（YAGNI，v1 不做）**

- 不做「好友代建/共同装修」（编辑权仅房主；以后加白名单）。
- 不做多房间/分区串联（C 轴，留待后期）。
- 不做家园等级加成产出（D 轴，列入二期；本规格只预留字段，不实现结算）。
- 不做家具交易/赠送（家具走现有寄售行/交易即可，不在本模块特设）。
- 不做家具碰撞物理/可踩踏判定的复杂规则（v1 用简单格子占位 + 层级，不做寻路阻挡）。
- 不重画任何美术（完全沿用现有 parallax 装修图与家具图标）。

## 3. 关键决策（已与用户锁定 + 默认）

已锁定（用户确认）：

- **可见性由房主设**：`private / friends / public` 三档，房主在家园面板切换。`friends` 复用好友表，`public` 受黑名单约束。
- **家具来源 = A+B+C**：商店买（金币，复用现有家具商店/寄售）+ 采集合成（材料→合成，二期细化）+ 活动掉落（副本/任务直接发家具入库）。家具拥有统一进**现有 `inventory` 权威表**。
- **升级沿用原版"换底图"**：复用现成房型开关 + 装修地图 + 升级动画，**不需要新美术**。
- **升级分期 A→D→B→C**：A 槽位（地基）→ D 加成产出（留存，二期）→ B 换底图（图都在，低成本）→ C 多房间（最后）。

默认（本设计补充）：

- **房型真值模型**：服务端 `home.tier`（0~17 整数）+ `home.style`（风格枚举）+ `home.building`（`coconut` 椰树大厦 / `skygarden` 空中花园）。客户端据此把对应开关 582~611 置位来渲染（单选）。
- **开关只读化**：582~611 在联机态仅由"进门时根据服务端房型值设置"驱动，玩家不能再本地直接翻（升级走服务端）。单机离线态保持原逻辑（向后兼容）。
- **家具识别**：给家具物品加 notetag `<HomeFurniture>`（可选 `<FurnitureLayer:n>`、`<FurnitureSize:wxh>`）；构建期用脚本从 `Items.json` 抽出家具 id 白名单给服务端校验（沿用 `scripts/extract-resources.ts` / gather spawnTable 的数据抽取先例）。过渡期可按名称前缀 `⭐家具-` 兜底识别。
- **家具拥有 = inventory**：不新建拥有表。家具是 `kind='item'` 的物品，已在权威 `inventory`。摆放 = `inventory` 扣 1 + `home_furniture` 插一行；收回 = 删行 + `inventory` 加 1（单事务，杜绝复制）。
- **实例化偏移**：家园虚拟地图 `HOME_VBASE = 20_000_000`（避开副本的 `10_000_000` 与真实地图），`homeVirtualMapId = HOME_VBASE + ownerPid`，确定性、可重入、可串门。
- **家具槽位**：`home.furniture_slots` 默认按房型等级给一个基数（如 tier×N + 基础值），上限随升级提升；v1 简单线性即可。
- **升级成本**：沿用「房型券」物品——`home.upgrade` 在服务端事务里消耗对应等级券（`inventory` 扣券）+ `tier++`；无券时可配置金币兜底价（`config.homeUpgradePrices`，金币销毁 sink）。

## 4. 数据模型（新增迁移 `004_home.sql`）

沿用既有迁移机制（`db/migrate.ts` 按文件名排序、`_migration` 去重、事务内 `db.exec(sql)`）。金币整数；时间戳 unix epoch ms。

```sql
-- 家园主表（每角色一间；惰性创建）
CREATE TABLE IF NOT EXISTS home (
  owner_id        INTEGER PRIMARY KEY REFERENCES character(id) ON DELETE CASCADE,
  building        TEXT    NOT NULL DEFAULT 'coconut'
                  CHECK(building IN ('coconut','skygarden')),  -- 椰树大厦 / 空中花园
  tier            INTEGER NOT NULL DEFAULT 0,                  -- 房型等级 0(毛坯)..17
  style           TEXT    NOT NULL DEFAULT 'base',             -- 风格/配色枚举（对应开关）
  visibility      TEXT    NOT NULL DEFAULT 'private'
                  CHECK(visibility IN ('private','friends','public')),
  furniture_slots INTEGER NOT NULL DEFAULT 20,                 -- 家具摆放上限（随等级提升）
  garden_unlocked INTEGER NOT NULL DEFAULT 0,                  -- 4级花园解锁 0/1
  bonus_json      TEXT,                                        -- 预留：D 轴加成产出参数（v1 不用）
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- 已摆放家具布局（每件一行；拥有量仍在 inventory，这里只记"摆出来的"）
CREATE TABLE IF NOT EXISTS home_furniture (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id      INTEGER NOT NULL REFERENCES character(id) ON DELETE CASCADE,
  furniture_id  INTEGER NOT NULL,                  -- = $dataItems 里 ⭐家具-* 的 itemId
  x             INTEGER NOT NULL CHECK(x >= 0 AND x <= 999),
  y             INTEGER NOT NULL CHECK(y >= 0 AND y <= 999),
  dir           INTEGER NOT NULL DEFAULT 2 CHECK(dir IN (2,4,6,8)),
  layer         INTEGER NOT NULL DEFAULT 1,        -- 0地板/1家具/2墙面/3顶饰
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_home_furniture_owner ON home_furniture(owner_id);

-- 家具白名单（构建期从 Items.json 抽取；服务端校验"这是家具且可摆"）
CREATE TABLE IF NOT EXISTS home_furniture_catalog (
  furniture_id  INTEGER PRIMARY KEY,
  layer         INTEGER NOT NULL DEFAULT 1,
  w             INTEGER NOT NULL DEFAULT 1,
  h             INTEGER NOT NULL DEFAULT 1
);
```

- `home` 行惰性创建：玩家首次 `home.enter` 自己家时 `INSERT OR IGNORE (owner_id, 'coconut', 0, 'base', 'private', 20, 0, null, now, now)`。
- 家具拥有量不在此表——复用 `inventory(kind='item', data_id=furniture_id, count)`。
- `home_furniture_catalog` 由 `extract-resources` 脚本生成填充，亦可纯客户端持有目录、服务端仅用 id 集合做白名单（择一，详见 §6）。

## 5. 配置常量（`server/src/config.ts` 追加）

```
homeVirtualBase:     20_000_000,   // 家园虚拟地图号起点（避开副本 10_000_000）
homeMaxTier:         17,           // 房型最高等级
homeBaseFurnSlots:   20,           // 0 级家具槽位
homeFurnSlotPerTier: 4,            // 每升一级 +N 槽位
homeGardenTier:      4,            // 解锁花园的等级
// 升级金币兜底价（无房型券时；index = 目标 tier-1），扣的金币销毁
homeUpgradePrices:   [/* tier1价, tier2价, ... */],
homeMaxFurniture:    300,          // 单家园摆放硬上限（防滥用）
```

（均可被环境变量覆盖，沿用 `num()/str()` 读取风格。）

## 6. 服务端详细设计

新增 `server/src/domain/home/homeService.ts` + `homeRepo.ts`，在 `gateway/router.ts` 注册 socket 事件。复用：

- 资产读写：`invRepo.getGold / applyItemDelta / listInventory / tx`（家具摆放/收回的原子增减）。
- 实例化参考：`dungeonService` 的 virtualMapId 思路（本模块自管一份确定性映射）。
- 同场可见 / 走动：**直接复用 `worldService`**——家园 = 一个 virtualMapId，玩家 `player.enterMap(homeVirtualMapId,...)` 后 `world.delta` 自动广播同实例玩家走动。本模块**不重做玩家同步**。
- 在线/推送：`getOnlineByPid`、`io.to(socketId).emit(...)`。
- 好友/黑名单：`socialService.listFriends / listBlocks`（可见性校验）。
- 错误：`AppError`；校验：`util/schema.ts` 加 zod；router 用 `parse()/requireAuth()/takeToken()/okAck/failAck`。

### 6.1 家园实例化（确定性，复用 world 房间）

- `homeVirtualMapId(ownerPid) = config.homeVirtualBase + ownerPid`（纯函数，无状态）。
- 进入家园 = 客户端拿到 `{ virtualMapId, baseMapId, tier, style, building, gardenUnlocked }` 后：① 加载 `baseMapId`（按房主 building+tier+style 解析出的装修地图 id）的地图素材；② 按房型值设置开关 582~611 渲染装修；③ 调既有 `player.enterMap(virtualMapId, spawn...)` 进入该实例的 world 房间。
- 访客与房主进的是**同一个 virtualMapId**（= 房主的 `HOME_VBASE+ownerPid`）→ 自动同房可见。
- `baseMapId` 解析：服务端维护 `(building,tier,style) → realMapId` 映射表（从 `MapInfos.json` 抽取/手配，沿用 spawnTable 配置风格），随 `home.enter` 一并下发，避免客户端写死。

### 6.2 事件清单（socket，全部走 ack）

请求类（client → server）：

- `home.enter` `{ ownerPid? }` → `{ ownerPid, virtualMapId, baseMapId, building, tier, style, gardenUnlocked, visibility, canEdit, furniture:[{id,furnitureId,x,y,dir,layer}], spawn:{x,y,d} }`（不传 ownerPid = 进自己家；进别人家先过可见性校验）
- `home.leave` `{}` → `{ ok:true }`
- `home.setVisibility` `{ visibility }` → `{ visibility }`（仅房主）
- `home.setStyle` `{ style }` → `{ style }`（仅房主；style 必须在当前 tier 已解锁集合内）
- `home.upgrade` `{}` → `{ tier, furnitureSlots, gardenUnlocked }`（消耗房型券或金币，tier++）
- `home.furniture.place` `{ furnitureId, x, y, dir, layer }` → `{ id }`（inventory 扣 1 + 插 home_furniture）
- `home.furniture.move` `{ id, x, y, dir }` → `{ ok:true }`（仅房主，移动已摆家具）
- `home.furniture.remove` `{ id }` → `{ ok:true, furnitureId }`（删行 + inventory 加 1）
- `home.furniture.snapshot` `{ ownerPid }` → `{ furniture:[...] }`（访客拉布局兜底）

推送类（server → client，广播到 `room('map:'+virtualMapId)`）：

- `home.furniture.evt` `{ op:'place'|'move'|'remove', item:{id,furnitureId,x,y,dir,layer} }`（房主改动 → 实时同步给在场访客）
- `home.update.evt` `{ tier?, style?, gardenUnlocked?, visibility? }`（房型/风格/可见性变化 → 在场访客刷新外观）

### 6.3 进入家园 `enter`

```
parse: ownerPid? (正整数)
self = requireAuth(socket).pid
target = ownerPid ?? self
ensureHomeRow(target)                 // INSERT OR IGNORE 默认行
home = getHome(target)
if target != self:                    // 串门可见性校验
  if home.visibility == 'private'                 -> FORBIDDEN
  if home.visibility == 'friends' && !isFriend(target, self) -> NOT_FRIEND
  if isBlocked(target, self)                       -> BLOCKED
canEdit = (target == self)            // v1 仅房主可编辑
baseMapId = resolveMap(home.building, home.tier, home.style)
furniture = listFurniture(target)
return { ownerPid: target, virtualMapId: HOME_VBASE+target, baseMapId,
         building, tier, style, gardenUnlocked, visibility, canEdit, furniture, spawn }
```

- 进门后客户端再走既有 `player.enterMap(virtualMapId, spawn)` 接入 world 房间（同步走动）。
- 玩家离开/断线：复用现有 `disconnect`/`leaveMap`，无需特设（virtualMapId 空了自然回收）。

### 6.4 房型升级 `upgrade`（事务）

```
tx:
  home = getHome(pid)                 // 缺行先建
  if home.tier >= homeMaxTier         -> TIER_MAXED
  nextTier = home.tier + 1
  voucherId = voucherItemFor(nextTier)         // 该等级对应房型券 itemId（配置）
  if hasItem(pid, voucherId) >= 1:
    applyItemDelta(db, pid, 'item', voucherId, -1)     // 消耗房型券
  else:
    price = config.homeUpgradePrices[nextTier-1]
    if price == null                  -> NO_VOUCHER
    if getGold(pid) < price           -> NOT_ENOUGH_GOLD
    applyGoldDelta(db, pid, -price)                     // 金币兜底，销毁
  slots = config.homeBaseFurnSlots + nextTier * config.homeFurnSlotPerTier
  garden = nextTier >= config.homeGardenTier ? 1 : home.garden_unlocked
  UPDATE home SET tier=nextTier, furniture_slots=slots, garden_unlocked=garden, updated_at=now
  return { tier:nextTier, furnitureSlots:slots, gardenUnlocked:garden }
提交后：广播 home.update.evt 给在场访客
```

- 升级后客户端播放既有装修动画(119) + 重设房型开关 + 重载 baseMapId。
- `style` 升级时可能要重置到该 tier 的默认风格，或保留兼容风格（`setStyle` 单独管风格切换）。

### 6.5 家具摆放 `place` / 移动 `move` / 收回 `remove`（事务）

```
place:
  parse: furnitureId>0, 0<=x,y<=999, dir∈{2,4,6,8}, layer∈0..3
  tx:
    if !isFurniture(furnitureId)            -> NOT_FURNITURE   // 白名单校验
    placed = countFurniture(pid)
    if placed >= min(home.furniture_slots, homeMaxFurniture) -> SLOT_FULL
    have = inventoryCount(pid,'item',furnitureId)
    if have < 1                             -> NOT_OWNED
    if occupied(pid, x, y, layer)           -> CELL_OCCUPIED   // 同层同格不可叠
    applyItemDelta(db, pid, 'item', furnitureId, -1)           // 从背包扣 1
    id = INSERT home_furniture(pid, furnitureId, x, y, dir, layer, now)
    return { id }
  提交后：广播 home.furniture.evt {op:'place', item}

move:  仅房主；UPDATE home_furniture SET x,y,dir WHERE id=? AND owner_id=pid（校验目标格未占）→ 广播 evt
remove: 仅房主；tx: row=SELECT...; DELETE WHERE id AND owner_id; applyItemDelta(+1 回背包) → 广播 evt
```

- **原子防复制**：摆放/收回的 inventory 增减与 home_furniture 增删在**同一事务**，与交易/寄售同套思路。
- **访客只读**：`place/move/remove` 均 `requireOwner`（target==self）；访客只能 `enter` + `snapshot` 看。

### 6.6 可见性 `setVisibility` / 风格 `setStyle`

```
setVisibility: 仅房主；value∈{private,friends,public}；UPDATE home → 广播 home.update.evt
setStyle:      仅房主；style 必须在 stylesForTier(building,tier) 集合内（防越级/非法风格）→ UPDATE → 广播
```

### 6.7 家具白名单来源

- 新增/扩展 `server/scripts/extract-resources.ts`：扫 `Items.json`，把 `note` 含 `<HomeFurniture>`（或名称前缀 `⭐家具-`）的 item 抽成 `home_furniture_catalog`（含 layer/尺寸，若 notetag 提供）。
- 服务端 `isFurniture(id)` 查该表/集合。客户端持有完整目录（贴图/图标本就在游戏 data 里）。

## 7. 客户端详细设计（`XdRs_Online_Home.js`）

新增插件，DOM 浮层风格照搬 `XdRs_Online_Trade.js` / `XdRs_Online_Market.js`（全屏遮罩 + 居中卡片，拦截 `mousedown/mouseup/click/pointer*/touch*/wheel/contextmenu/keydown` 防穿透到 RMMZ 寻路）。

### 7.1 入口

- 在 `XdRs_Online_Hub.js` 宫格加「我的家园」；好友面板（`XdRs_Online_Friend.js`）/ 在线列表加「去TA家」。
- 地图上保留原版"回家门"事件做物理入口（可选，二期）；v1 走 Hub。

### 7.2 进入家园流程（客户端）

1. `home.enter {ownerPid?}` 拿 `{virtualMapId, baseMapId, building, tier, style, gardenUnlocked, furniture, canEdit, spawn}`。
2. 按 `building/tier/style` 把房型开关 582~611 单选置位（仅渲染用）。
3. `$gamePlayer.reserveTransfer(baseMapId, spawn.x, spawn.y, d)` 进装修地图；同时 `player.enterMap(virtualMapId, spawn)` 接入 world 房间（拿同房玩家走动）。
4. 渲染家具叠加层（见 7.3）。

### 7.3 家具 DIY 叠加层（核心新功能）

- 在地图 parallax/瓦片之上挂一个 `Sprite` 容器，按 `furniture` 列表逐件绘制家具图标/图块（用 `iconIndex` 或家具专用图集）。
- **编辑态**（仅 `canEdit`）：进入"装修模式" → 从背包家具列表选一件 → 拖到格子 → `home.furniture.place`；点已摆家具可拖动(`move`)/旋转(`dir`)/收回(`remove`)。每次操作乐观更新 + ack 校正。
- **访客态**：只渲染，不可编辑；监听 `home.furniture.evt` 实时反映房主改动。
- 占位/层级：v1 简单格子 + layer 排序，不做寻路阻挡（YAGNI）。

### 7.4 升级 / 风格 / 可见性 UI

- 家园面板：显示当前等级/风格/可见性/家具槽位 used/slots。
- 「升级房型」→ `home.upgrade`（成功播原版装修动画 119 + 重载地图）。
- 「换风格」→ `home.setStyle`（当前等级已解锁风格列表）。
- 「可见性」→ `home.setVisibility`（私密/好友/公开三选一）。

### 7.5 注册

- `plugins.js` 在 `XdRs_Online_Market` 之后、`XdRs_Online_Hub` 之前插入 `{"name":"XdRs_Online_Home","status":true,...}`（依赖 Util/Net/Core）。
- 镜像到 `xiaoshagua-server/client-plugins/XdRs_Online_Home.js`。

## 8. 错误码（沿用 `AppError(code,msg)`）

- `FORBIDDEN`：进私密家园 / 非房主编辑。
- `NOT_FRIEND`：好友可见家园但非好友。
- `BLOCKED`：被房主拉黑。
- `TIER_MAXED`：已达最高房型。
- `NO_VOUCHER`：无房型券且无金币兜底价。
- `NOT_ENOUGH_GOLD`：金币兜底升级不足。
- `NOT_FURNITURE`：该物品不是可摆家具（白名单外）。
- `NOT_OWNED`：背包无该家具。
- `SLOT_FULL`：家具摆放已达上限。
- `CELL_OCCUPIED`：目标格同层已占。
- `BAD_INPUT`：坐标/朝向/层越界（zod 兜底）。

## 9. 防滥用 / 经济与防作弊安全（重点）

- **房型真值服务端权威**：tier/style/building/garden 全在 `home` 表；客户端开关 582~611 仅渲染。改客户端**改不动真值** → 杜绝"免费满级豪宅"。
- **家具拥有 = inventory 权威**：摆放从背包扣、收回还背包，单事务原子；改客户端无法凭空摆出未拥有家具。
- **升级走服务端校验**：消耗房型券/金币在事务内完成，金币兜底走 sink（销毁）对冲通胀。
- **编辑权限**：所有写操作 `requireOwner`；访客只读。
- **可见性 + 黑名单**：私密/好友档服务端校验；public 受 `listBlocks` 约束。
- **摆放上限**：`furniture_slots` + `homeMaxFurniture` 双层，防刷爆。
- **白名单**：`isFurniture` 防把非家具物品塞进家具表。
- **限流**：所有写事件走 `takeToken`（20 msg/s 桶）；DIY 拖拽建议客户端节流 + 落点才发 `move`。
- **遗留风险联动**：本模块不引入新的"信任客户端发货"路径；若二期做 D 轴加成产出，**产出结算必须服务端计算并入库**（与现有"采集发货信任客户端"遗留问题一并整改）。

## 10. 边界与风险

- **房型→地图映射表**：`(building,tier,style) → realMapId` 需从 `MapInfos.json` 完整梳理（几十张图），建议脚本抽取 + 人工校对，避免手写遗漏。**实现前需补全这张映射**（当前为已知缺口）。
- **单机/联机双态**：离线单机仍走原版开关逻辑；联机态开关只读。需在客户端区分两态，避免互相污染本地存档开关。
- **老存档迁移**：老玩家本地已有房型（开关 582~611 已置位） → 首次上线 `home.enter` 时，可读本地开关反推 tier/style 灌入服务端（一次性迁移，类似 `SaveMigrate` 思路）。列为实现细节。
- **家具坐标与地图尺寸**：不同装修图尺寸不同，升级换图后家具坐标可能越界 → 升级时校验/夹取越界家具，或按相对锚点重映射（v1 简单：越界家具收回背包并提示）。
- **角色删除**：`ON DELETE CASCADE` 连带删 `home` + `home_furniture`；已摆家具（不在背包那部分）随之消失，可接受（v1）。
- **访客实时性**：家具改动靠 `home.furniture.evt` 广播；丢包用 `home.furniture.snapshot` 兜底。

## 11. 测试计划

服务端（`server/test/homeService.test.ts`，vitest；参考 `storageService.test.ts` 的 DB 初始化）：

- enter：自己家惰性建行；私密家被他人进 → `FORBIDDEN`；好友档好友可进、非好友 `NOT_FRIEND`；public 被拉黑 → `BLOCKED`。
- upgrade：有券 → 扣券 tier++ + 槽位增 + 4级置 garden；无券有金币 → 扣金币（销毁）tier++；满级 → `TIER_MAXED`；无券无金币 → `NO_VOUCHER`/`NOT_ENOUGH_GOLD`。
- place：扣背包 1 + 插行；非家具 → `NOT_FURNITURE`；不持有 → `NOT_OWNED`；满槽 → `SLOT_FULL`；占格 → `CELL_OCCUPIED`。
- move：房主移动成功；访客移动 → `FORBIDDEN`；目标占格拒绝。
- remove：删行 + 背包 +1；非房主 → `FORBIDDEN`。
- 守恒：place 后再 remove，背包数量回到初值（验证不增不减、无复制）。
- setVisibility/setStyle：仅房主；非法风格/越级 → 拒绝。
- 实例化：`homeVirtualMapId(pid)` 确定性、不与副本/真实图冲突。

客户端（联机自测）：

- 进自己家 → 看到对应装修图 + 已摆家具；编辑模式摆/移/收家具，背包数量同步变化。
- 好友进我家（friends 档）→ 能进、看到我的装修与家具、看到彼此走动；陌生人进 → 被拒。
- 切可见性 private → 好友再进被拒。
- 升级房型 → 装修图变化 + 槽位增加；4 级解锁花园（种植区可用）。
- 房主摆家具，在场访客实时看到（`home.furniture.evt`）。

## 12. 影响面 / 改动文件

服务端（`xiaoshagua-server/server/src/`）：

- 新增 `db/migrations/004_home.sql`（3 张表 + 索引）。
- 新增 `domain/home/homeRepo.ts` + `domain/home/homeService.ts`。
- 改 `gateway/router.ts`：import + 9 个 `home.*` handler。
- 改 `util/schema.ts`：`HomeEnter/HomeVisibility/HomeStyle/HomeFurniturePlace/HomeFurnitureMove/HomeIdOnly/HomePidOnly` 及类型。
- 改 `config.ts`：§5 常量。
- 改/新增 `scripts/extract-resources.ts`：抽家具白名单 + （建议）房型→地图映射表。
- 新增 `server/test/homeService.test.ts`。

客户端（`xiaoshagua/js/plugins/`，镜像 `client-plugins/`）：

- 新增 `XdRs_Online_Home.js`（含家具 DIY 叠加层 + 面板 + 双态开关处理）。
- 改 `js/plugins.js`：注册（Market 之后、Hub 之前）。
- 改 `XdRs_Online_Hub.js`：宫格加「我的家园」入口；`XdRs_Online_Friend.js`：加「去TA家」。
- 给家具物品 `Items.json` 补 `<HomeFurniture>` notetag（数据，非代码）。

## 13. 验证方法（上线前）

- 服务端：`npm run typecheck` 0 错、`npm test` 全绿（含 `homeService.test.ts`）、`npm run build` 0 错、`npm run migrate` 应用 `004`。
- 客户端：`node --check` 改动文件、`plugins.js` JSON 合法、ReadLints 无错。
- 联机自测：按 §11 客户端场景全跑（含可见性三档、升级换图、家具 DIY 实时同步、防作弊：改客户端开关不改服务端房型）。
- 部署：服务端走既有部署流程（git pull + build + migrate + pm2 重启 + healthz）；客户端重打包分发。

## 14. 实现顺序建议（TDD，对齐分期 A）

1. `004_home.sql` + `homeRepo` + `config` 常量 + 房型→地图映射表抽取。
2. 先写 `homeService.test.ts`（红）→ 实现 `homeService`（enter/可见性/upgrade/家具 place·move·remove）转绿。
3. router 接线 + schema。
4. 客户端 `XdRs_Online_Home.js`：先做"进自己家 + 渲染现成装修图 + 房型服务端化"，再做"家具 DIY 叠加层"，最后"串门 + 实时同步"。
5. 老存档房型迁移（读本地开关→灌服务端）。
6. 全量 typecheck/test/build → 联机自测 → 部署。

> 分期对齐：本规格覆盖**期1（私有实例化 + 现成家园搬上线 + 房型服务端权威 + A 槽位）+ 期2 的家具 DIY 联机化**。D 轴加成产出、C 轴多房间留作后续规格（本表已预留 `bonus_json` 字段与扩展点）。

## 15. 回滚

- 全部为**新增**（新表 / 新插件 / 新 handler / 数据 notetag），不改既有交易/存档/资产/世界逻辑。
- 回滚 = `plugins.js` 把 `XdRs_Online_Home` 置 `status:false` + 摘除 router 的 home handler；新表保留无害。
- 回滚前若有玩家已摆家具：可跑一次性脚本把 `home_furniture` 全部 `remove`（家具退回各自 `inventory`），避免家具被锁在布局表里。
- 房型真值已在服务端，回滚到单机态时客户端回退用本地开关（向后兼容）。
