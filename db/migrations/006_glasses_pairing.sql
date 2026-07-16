CREATE TABLE glasses_pairings (
  id TEXT PRIMARY KEY,
  code_digest TEXT NOT NULL UNIQUE,
  supervisor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  scope_type TEXT NOT NULL CHECK(scope_type IN ('site', 'tbm_session')),
  scope_site_id TEXT,
  scope_session_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  redeemed_at TEXT,
  cancelled_at TEXT,
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK(failed_attempts >= 0),
  max_attempts INTEGER NOT NULL CHECK(max_attempts > 0),
  restricted_session_id TEXT,
  CHECK(
    (scope_type = 'site' AND scope_site_id IS NOT NULL AND scope_session_id IS NULL) OR
    (scope_type = 'tbm_session' AND scope_session_id IS NOT NULL AND scope_site_id IS NOT NULL)
  ),
  UNIQUE(id, supervisor_user_id)
);

CREATE INDEX idx_glasses_pairings_supervisor_created
  ON glasses_pairings(supervisor_user_id, created_at DESC);
CREATE INDEX idx_glasses_pairings_expiry
  ON glasses_pairings(expires_at);

CREATE TABLE glasses_sessions (
  id TEXT PRIMARY KEY,
  pairing_id TEXT NOT NULL UNIQUE,
  supervisor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  scope_type TEXT NOT NULL CHECK(scope_type IN ('site', 'tbm_session')),
  scope_site_id TEXT NOT NULL,
  scope_session_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  last_seen_at TEXT,
  FOREIGN KEY(pairing_id, supervisor_user_id)
    REFERENCES glasses_pairings(id, supervisor_user_id) ON DELETE RESTRICT,
  CHECK(
    (scope_type = 'site' AND scope_session_id IS NULL) OR
    (scope_type = 'tbm_session' AND scope_session_id IS NOT NULL)
  )
);

CREATE INDEX idx_glasses_sessions_supervisor
  ON glasses_sessions(supervisor_user_id, expires_at);
