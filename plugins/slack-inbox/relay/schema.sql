-- AUTOINCREMENT never reuses an id, so a pull cursor can't skip or repeat a row after a delete.
-- expires_at is unused, always 0: events now stay until space is needed, and removing it would mean rebuilding the table.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  sealed TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
DROP INDEX IF EXISTS events_expires_at;
