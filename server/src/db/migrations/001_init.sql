-- XSG-Online initial schema (v1)
-- All timestamps are unix epoch milliseconds unless noted.

CREATE TABLE IF NOT EXISTS account (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  username        TEXT    NOT NULL UNIQUE,
  password_hash   TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  last_login_at   INTEGER,
  banned          INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_account_username ON account(username);

CREATE TABLE IF NOT EXISTS character (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id      INTEGER NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  name            TEXT    NOT NULL,
  actor_id        INTEGER NOT NULL DEFAULT 1,
  map_id          INTEGER NOT NULL DEFAULT 1,
  x               INTEGER NOT NULL DEFAULT 0,
  y               INTEGER NOT NULL DEFAULT 0,
  direction       INTEGER NOT NULL DEFAULT 2,
  char_set        TEXT,
  char_index      INTEGER NOT NULL DEFAULT 0,
  gold            INTEGER NOT NULL DEFAULT 0,
  level           INTEGER NOT NULL DEFAULT 1,
  exp             INTEGER NOT NULL DEFAULT 0,
  extra_json      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_character_account ON character(account_id);
CREATE INDEX IF NOT EXISTS idx_character_name ON character(name);

CREATE TABLE IF NOT EXISTS inventory (
  character_id    INTEGER NOT NULL REFERENCES character(id) ON DELETE CASCADE,
  kind            TEXT    NOT NULL CHECK(kind IN ('item','weapon','armor')),
  data_id         INTEGER NOT NULL,
  count           INTEGER NOT NULL,
  PRIMARY KEY (character_id, kind, data_id)
);

CREATE TABLE IF NOT EXISTS pet (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id    INTEGER NOT NULL REFERENCES character(id) ON DELETE CASCADE,
  species_id      INTEGER NOT NULL,
  name            TEXT,
  stage           INTEGER NOT NULL DEFAULT 0,
  level           INTEGER NOT NULL DEFAULT 1,
  exp             INTEGER NOT NULL DEFAULT 0,
  cool_until      INTEGER NOT NULL DEFAULT 0,
  extra_json      TEXT,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pet_character ON pet(character_id);

CREATE TABLE IF NOT EXISTS shared_switches (
  id              INTEGER PRIMARY KEY,
  value           INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS shared_variables (
  id              INTEGER PRIMARY KEY,
  value           INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS character_switches (
  character_id    INTEGER NOT NULL REFERENCES character(id) ON DELETE CASCADE,
  id              INTEGER NOT NULL,
  value           INTEGER NOT NULL,
  PRIMARY KEY (character_id, id)
);

CREATE TABLE IF NOT EXISTS character_variables (
  character_id    INTEGER NOT NULL REFERENCES character(id) ON DELETE CASCADE,
  id              INTEGER NOT NULL,
  value           INTEGER NOT NULL,
  PRIMARY KEY (character_id, id)
);

CREATE TABLE IF NOT EXISTS social_relation (
  a               INTEGER NOT NULL REFERENCES character(id) ON DELETE CASCADE,
  b               INTEGER NOT NULL REFERENCES character(id) ON DELETE CASCADE,
  kind            TEXT    NOT NULL CHECK(kind IN ('friend','block')),
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (a, b, kind)
);

CREATE TABLE IF NOT EXISTS chat_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              INTEGER NOT NULL,
  channel         TEXT    NOT NULL,
  from_id         INTEGER NOT NULL,
  to_id           INTEGER,
  text            TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_log_ts ON chat_log(ts);
CREATE INDEX IF NOT EXISTS idx_chat_log_from ON chat_log(from_id);

CREATE TABLE IF NOT EXISTS trade_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              INTEGER NOT NULL,
  a               INTEGER NOT NULL,
  b               INTEGER NOT NULL,
  items_json      TEXT    NOT NULL,
  gold_a          INTEGER NOT NULL DEFAULT 0,
  gold_b          INTEGER NOT NULL DEFAULT 0,
  ok              INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_trade_log_ts ON trade_log(ts);

CREATE TABLE IF NOT EXISTS auth_token (
  token           TEXT    PRIMARY KEY,
  account_id      INTEGER NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  character_id    INTEGER NOT NULL REFERENCES character(id) ON DELETE CASCADE,
  issued_at       INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_token_account ON auth_token(account_id);
CREATE INDEX IF NOT EXISTS idx_auth_token_expires ON auth_token(expires_at);
