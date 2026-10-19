CREATE TABLE IF NOT EXISTS login_attempts (
  ip_hash TEXT PRIMARY KEY,
  window_started INTEGER NOT NULL,
  attempts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_locks (
  lock_id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
