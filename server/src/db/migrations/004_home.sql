-- 家园模块（Home / Private Housing）
-- home: 每角色一间家园（惰性创建）。房型等级/风格/楼栋/可见性/花园解锁服务端权威。
CREATE TABLE IF NOT EXISTS home (
  owner_id        INTEGER PRIMARY KEY REFERENCES character(id) ON DELETE CASCADE,
  building        TEXT    NOT NULL DEFAULT 'coconut' CHECK(building IN ('coconut','skygarden')),
  tier            INTEGER NOT NULL DEFAULT 0,
  style           TEXT    NOT NULL DEFAULT 'base',
  visibility      TEXT    NOT NULL DEFAULT 'private' CHECK(visibility IN ('private','friends','public')),
  furniture_slots INTEGER NOT NULL DEFAULT 20,
  garden_unlocked INTEGER NOT NULL DEFAULT 0,
  bonus_json      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- home_furniture: 已摆放家具布局（每件一行）。拥有量仍在 inventory，这里只记“摆出来的”。
CREATE TABLE IF NOT EXISTS home_furniture (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id      INTEGER NOT NULL REFERENCES character(id) ON DELETE CASCADE,
  furniture_id  INTEGER NOT NULL,
  x             INTEGER NOT NULL CHECK(x >= 0 AND x <= 999),
  y             INTEGER NOT NULL CHECK(y >= 0 AND y <= 999),
  dir           INTEGER NOT NULL DEFAULT 2 CHECK(dir IN (2,4,6,8)),
  layer         INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_home_furniture_owner ON home_furniture(owner_id);

-- home_furniture_catalog: 家具白名单（构建期从 Items.json 抽取；服务端校验“这是可摆家具”）。
CREATE TABLE IF NOT EXISTS home_furniture_catalog (
  furniture_id  INTEGER PRIMARY KEY,
  layer         INTEGER NOT NULL DEFAULT 1,
  w             INTEGER NOT NULL DEFAULT 1,
  h             INTEGER NOT NULL DEFAULT 1
);
