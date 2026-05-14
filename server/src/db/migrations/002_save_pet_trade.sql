-- Cloud save blob (one per character, latest wins for v1)
CREATE TABLE IF NOT EXISTS savefile_cloud (
  character_id    INTEGER PRIMARY KEY REFERENCES character(id) ON DELETE CASCADE,
  ts              INTEGER NOT NULL,
  contents        TEXT    NOT NULL,
  meta            TEXT
);

-- Pet inventory (richer table to support XdRs_Arder hooks)
ALTER TABLE pet ADD COLUMN species_name TEXT;
ALTER TABLE pet ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;

-- Pet daily action log (optional, for cooldown audit)
CREATE TABLE IF NOT EXISTS pet_action_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              INTEGER NOT NULL,
  pet_id          INTEGER NOT NULL,
  character_id    INTEGER NOT NULL,
  action          TEXT    NOT NULL,
  result          TEXT
);
CREATE INDEX IF NOT EXISTS idx_pet_action_log_pet ON pet_action_log(pet_id);

-- Reservation lock for map events (prevents double-pickup of shared event items)
CREATE TABLE IF NOT EXISTS map_event_claim (
  map_id          INTEGER NOT NULL,
  event_id        INTEGER NOT NULL,
  character_id    INTEGER NOT NULL,
  ts              INTEGER NOT NULL,
  PRIMARY KEY (map_id, event_id)
);
