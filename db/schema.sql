CREATE TABLE metric_latest (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE metric_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
);

CREATE TABLE incident_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target TEXT NOT NULL,
  status TEXT NOT NULL,
  details_json TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE INDEX idx_history_key_time ON metric_history(key, recorded_at);
CREATE INDEX idx_incident_target_time ON incident_log(target, started_at);
