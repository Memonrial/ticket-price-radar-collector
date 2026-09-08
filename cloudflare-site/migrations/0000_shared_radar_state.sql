CREATE TABLE IF NOT EXISTS shared_radar_state (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  targets_json TEXT NOT NULL,
  show_groups_json TEXT NOT NULL,
  revision INTEGER DEFAULT 1 NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO shared_radar_state
  (id, targets_json, show_groups_json, revision, updated_at)
VALUES
  (1, '[]', '[]', 1, '2026-09-08T00:00:00.000Z');
