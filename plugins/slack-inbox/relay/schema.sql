-- AUTOINCREMENT never reuses an id, so a pull cursor can't skip or repeat a row after a delete.
-- expires_at is when an event gets deleted, collected or not, in milliseconds.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  sealed TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
DROP INDEX IF EXISTS events_expires_at;
-- Rows stored while events had no time limit. Safe to repeat: new rows are never 0.
UPDATE events SET expires_at = (unixepoch() + 14 * 86400) * 1000 WHERE expires_at = 0;
