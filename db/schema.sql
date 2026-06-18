CREATE TABLE IF NOT EXISTS readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tower TEXT NOT NULL DEFAULT 'camp-main',
  feet REAL NOT NULL,
  psi REAL NOT NULL,
  battery REAL NOT NULL,
  rssi REAL NOT NULL,
  snr REAL NOT NULL,
  seq INTEGER,
  timestamp TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_readings_timestamp ON readings(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_readings_tower_timestamp ON readings(tower, timestamp DESC);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pump_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  mode TEXT NOT NULL,
  pump_on INTEGER NOT NULL,
  feet REAL,
  settings TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pump_events_timestamp ON pump_events(timestamp DESC);
