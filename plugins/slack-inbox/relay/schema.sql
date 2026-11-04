-- AUTOINCREMENT never reuses an id, so a pull cursor can't skip or repeat a row after a delete.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  sealed TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_expires_at ON events (expires_at);
