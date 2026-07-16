CREATE TABLE evidence_requests (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  restricted_session_id TEXT REFERENCES glasses_sessions(id) ON DELETE RESTRICT,
  session_id TEXT NOT NULL,
  hazard_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'uploading', 'completed', 'cancelled', 'expired', 'failed')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  completed_at TEXT,
  cancelled_at TEXT,
  attached_at TEXT,
  upload_id TEXT,
  source_category TEXT CHECK(source_category IN ('phone_camera', 'phone_gallery', 'future_native_glasses_camera')),
  provider TEXT CHECK(provider IN ('phone_browser_camera', 'phone_browser_gallery', 'native_dat_camera')),
  UNIQUE(id, owner_id),
  FOREIGN KEY(session_id, owner_id) REFERENCES tbm_sessions(id, owner_id) ON DELETE RESTRICT,
  FOREIGN KEY(hazard_id, owner_id) REFERENCES hazards(id, owner_id) ON DELETE RESTRICT,
  FOREIGN KEY(upload_id, owner_id) REFERENCES evidence_uploads(id, owner_id) ON DELETE RESTRICT,
  CHECK(expires_at > created_at),
  CHECK((status = 'completed' AND completed_at IS NOT NULL AND upload_id IS NOT NULL AND source_category IS NOT NULL AND provider IS NOT NULL) OR status != 'completed'),
  CHECK((status = 'cancelled' AND cancelled_at IS NOT NULL) OR status != 'cancelled')
);

CREATE INDEX idx_evidence_requests_owner_status ON evidence_requests(owner_id, status, created_at DESC);
CREATE INDEX idx_evidence_requests_glasses ON evidence_requests(restricted_session_id, created_at DESC);
CREATE INDEX idx_evidence_requests_expiry ON evidence_requests(status, expires_at);
