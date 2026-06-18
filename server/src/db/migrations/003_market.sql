-- 寄售行（Consignment House / Marketplace）schema (v1)
-- 异步挂单：上架即从卖家背包托管（escrow）；买家可按数量拆分购买。
-- 手续费 20% 销毁、开格费销毁。所有金额为整数；时间戳 unix epoch ms。

-- 挂单：orig_count=上架原始量（展示）；count=剩余可售量（拆分购买递减，0=售罄）；unit_price=单价。
CREATE TABLE IF NOT EXISTS market_listing (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id     INTEGER NOT NULL REFERENCES character(id) ON DELETE CASCADE,
  kind          TEXT    NOT NULL CHECK(kind IN ('item','weapon','armor')),
  data_id       INTEGER NOT NULL,
  orig_count    INTEGER NOT NULL CHECK(orig_count > 0),
  count         INTEGER NOT NULL CHECK(count >= 0),
  unit_price    INTEGER NOT NULL CHECK(unit_price > 0),
  status        TEXT    NOT NULL DEFAULT 'active' CHECK(status IN ('active','sold','cancelled')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  sold_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_market_listing_active ON market_listing(status, created_at);
CREATE INDEX IF NOT EXISTS idx_market_listing_seller ON market_listing(seller_id, status);

-- 寄售格位：slots = 当前已解锁格数（默认 2，最多 10）。= 同时在售挂单上限。
CREATE TABLE IF NOT EXISTS market_slot (
  character_id  INTEGER PRIMARY KEY REFERENCES character(id) ON DELETE CASCADE,
  slots         INTEGER NOT NULL DEFAULT 2,
  updated_at    INTEGER NOT NULL
);

-- 通用离线通知队列（邮箱）：寄售成交/购买都落这里；登录补发后置 read_at。
CREATE TABLE IF NOT EXISTS notification (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id  INTEGER NOT NULL REFERENCES character(id) ON DELETE CASCADE,
  type          TEXT    NOT NULL,
  payload_json  TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  read_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_notification_unread ON notification(character_id, read_at);

-- 成交流水：每笔购买一行；cost=买家付，fee=销毁额，proceeds=卖家实得。
CREATE TABLE IF NOT EXISTS market_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  listing_id    INTEGER NOT NULL,
  seller_id     INTEGER NOT NULL,
  buyer_id      INTEGER NOT NULL,
  kind          TEXT    NOT NULL,
  data_id       INTEGER NOT NULL,
  qty           INTEGER NOT NULL,
  unit_price    INTEGER NOT NULL,
  cost          INTEGER NOT NULL,
  fee           INTEGER NOT NULL,
  proceeds      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_market_log_ts ON market_log(ts);
