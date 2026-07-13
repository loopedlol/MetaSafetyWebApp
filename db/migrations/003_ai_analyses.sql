CREATE TABLE ai_analyses (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  upload_id TEXT NOT NULL,
  session_id TEXT,
  entry_type TEXT NOT NULL CHECK(entry_type IN ('new_hazard', 'near_miss')),
  mode TEXT NOT NULL,
  provider TEXT NOT NULL,
  model_version TEXT,
  requested_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  normalized_suggestion_json TEXT NOT NULL,
  human_decision TEXT NOT NULL DEFAULT 'pending'
    CHECK(human_decision IN ('pending', 'accepted', 'edited', 'rejected')),
  edited_suggestion_json TEXT,
  reviewer_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  reviewer_label TEXT,
  reviewed_at TEXT,
  UNIQUE(id, owner_id),
  FOREIGN KEY(upload_id, owner_id) REFERENCES evidence_uploads(id, owner_id) ON DELETE RESTRICT,
  FOREIGN KEY(session_id, owner_id) REFERENCES tbm_sessions(id, owner_id) ON DELETE RESTRICT
);

CREATE INDEX idx_ai_analyses_owner_upload ON ai_analyses(owner_id, upload_id);
CREATE INDEX idx_ai_analyses_session ON ai_analyses(session_id, owner_id);
