CREATE TABLE character_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER NOT NULL,
  character_slug TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  gear_hash TEXT NOT NULL,
  equipped_item_level INTEGER,
  average_item_level INTEGER,
  honorable_kills INTEGER NOT NULL DEFAULT 0,
  is_baseline INTEGER NOT NULL DEFAULT 0 CHECK (is_baseline IN (0, 1)),
  gear_json TEXT NOT NULL
);

CREATE INDEX character_snapshots_character_time
  ON character_snapshots (character_id, captured_at DESC);

CREATE TABLE character_items (
  character_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  first_seen_at TEXT NOT NULL,
  first_snapshot_id INTEGER NOT NULL,
  first_seen_as_baseline INTEGER NOT NULL DEFAULT 0 CHECK (first_seen_as_baseline IN (0, 1)),
  item_name TEXT NOT NULL,
  item_level INTEGER,
  quality TEXT NOT NULL,
  slot_type TEXT NOT NULL,
  PRIMARY KEY (character_id, item_id),
  FOREIGN KEY (first_snapshot_id) REFERENCES character_snapshots(id)
);

CREATE TABLE character_gear_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER NOT NULL,
  character_slug TEXT NOT NULL,
  event_type TEXT NOT NULL DEFAULT 'GAINED' CHECK (event_type = 'GAINED'),
  item_id INTEGER NOT NULL,
  item_name TEXT NOT NULL,
  item_level INTEGER,
  quality TEXT NOT NULL,
  slot_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  snapshot_id INTEGER NOT NULL,
  UNIQUE (character_id, item_id, event_type),
  FOREIGN KEY (snapshot_id) REFERENCES character_snapshots(id)
);

CREATE INDEX character_gear_events_character_time
  ON character_gear_events (character_id, occurred_at DESC);
