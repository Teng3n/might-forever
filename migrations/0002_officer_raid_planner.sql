CREATE TABLE officer_raid_plans (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  plan_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
