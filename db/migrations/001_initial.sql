CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE sites (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  site_name TEXT NOT NULL,
  site_area TEXT NOT NULL DEFAULT '',
  gps_latitude REAL,
  gps_longitude REAL,
  gps_accuracy_meters REAL,
  created_at TEXT NOT NULL,
  UNIQUE(owner_id, site_name, site_area),
  UNIQUE(id, owner_id)
);

CREATE TABLE tbm_sessions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  site_id TEXT NOT NULL,
  schema_version TEXT,
  session_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft', 'actions_open', 'completed')),
  task_name TEXT NOT NULL DEFAULT '',
  work_type TEXT NOT NULL DEFAULT '',
  planned_work_description TEXT NOT NULL DEFAULT '',
  supervisor_name TEXT NOT NULL DEFAULT '',
  supervisor_role TEXT NOT NULL DEFAULT '',
  device_platform TEXT,
  device_app_version TEXT,
  device_input_mode TEXT,
  worker_feedback_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  saved_at TEXT NOT NULL,
  finalized_at TEXT,
  completed_at TEXT,
  client_observed_created_at TEXT,
  client_observed_started_at TEXT,
  client_observed_exported_at TEXT,
  UNIQUE(id, owner_id),
  FOREIGN KEY(site_id, owner_id) REFERENCES sites(id, owner_id) ON DELETE RESTRICT
);

CREATE INDEX idx_tbm_sessions_owner_saved ON tbm_sessions(owner_id, saved_at DESC);

CREATE TABLE workers (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(id, owner_id)
);

CREATE TABLE session_participants (
  session_id TEXT NOT NULL REFERENCES tbm_sessions(id) ON DELETE CASCADE,
  worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE RESTRICT,
  owner_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY(session_id, worker_id),
  UNIQUE(session_id, position),
  UNIQUE(session_id, worker_id, owner_id),
  FOREIGN KEY(session_id, owner_id) REFERENCES tbm_sessions(id, owner_id) ON DELETE CASCADE,
  FOREIGN KEY(worker_id, owner_id) REFERENCES workers(id, owner_id) ON DELETE RESTRICT
);

CREATE TABLE attendance_records (
  session_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  present INTEGER NOT NULL CHECK(present IN (0, 1)),
  recorded_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY(session_id, worker_id),
  FOREIGN KEY(session_id, worker_id, owner_id) REFERENCES session_participants(session_id, worker_id, owner_id) ON DELETE CASCADE
);

CREATE TABLE acknowledgment_records (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  acknowledgment_type TEXT NOT NULL CHECK(acknowledgment_type IN ('supervisor_recorded', 'independently_verified')),
  recorded_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  recorded_by_label TEXT,
  method TEXT,
  source TEXT,
  recorded_at TEXT NOT NULL,
  client_observed_at TEXT,
  FOREIGN KEY(session_id, worker_id, owner_id) REFERENCES session_participants(session_id, worker_id, owner_id) ON DELETE CASCADE,
  UNIQUE(session_id, worker_id, acknowledgment_type)
);

CREATE TABLE hazards (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  source TEXT,
  title TEXT NOT NULL,
  category TEXT,
  location TEXT,
  risk_level TEXT,
  risk_description TEXT,
  recommended_action TEXT,
  memo TEXT,
  ai_suggestion_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(session_id, external_id),
  UNIQUE(session_id, position),
  UNIQUE(id, owner_id),
  FOREIGN KEY(session_id, owner_id) REFERENCES tbm_sessions(id, owner_id) ON DELETE CASCADE
);

CREATE TABLE hazard_reviews (
  id TEXT PRIMARY KEY,
  hazard_id TEXT NOT NULL UNIQUE REFERENCES hazards(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('controlled', 'action_required', 'not_checked')),
  reviewed INTEGER NOT NULL CHECK(reviewed IN (0, 1)),
  reviewed_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_by_label TEXT,
  reviewed_at TEXT,
  client_observed_reviewed_at TEXT
);

CREATE TABLE corrective_actions (
  id TEXT PRIMARY KEY,
  hazard_id TEXT NOT NULL UNIQUE REFERENCES hazards(id) ON DELETE CASCADE,
  required INTEGER NOT NULL CHECK(required IN (0, 1)),
  immediate_control TEXT,
  assigned_to TEXT,
  due_at TEXT,
  work_status TEXT CHECK(work_status IS NULL OR work_status IN ('stopped', 'permitted_with_controls')),
  verification_status TEXT NOT NULL CHECK(verification_status IN ('open', 'verified')),
  verified_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  verified_by_label TEXT,
  verified_at TEXT,
  client_observed_verified_at TEXT,
  closure_evidence_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);

CREATE TABLE near_misses (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  source TEXT,
  title TEXT NOT NULL,
  category TEXT,
  location TEXT,
  risk_level TEXT,
  description TEXT,
  action_taken TEXT,
  reported_by TEXT,
  reported_at TEXT,
  ai_suggestion_json TEXT,
  UNIQUE(session_id, position),
  UNIQUE(id, owner_id),
  FOREIGN KEY(session_id, owner_id) REFERENCES tbm_sessions(id, owner_id) ON DELETE CASCADE
);

CREATE TABLE evidence_uploads (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  internal_filename TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL CHECK(mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
  sha256_hash TEXT NOT NULL,
  uploaded_at TEXT NOT NULL,
  client_observed_uploaded_at TEXT,
  UNIQUE(id, owner_id)
);

CREATE TABLE hazard_evidence (
  hazard_id TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY(hazard_id, upload_id),
  UNIQUE(hazard_id, position),
  FOREIGN KEY(hazard_id, owner_id) REFERENCES hazards(id, owner_id) ON DELETE CASCADE,
  FOREIGN KEY(upload_id, owner_id) REFERENCES evidence_uploads(id, owner_id) ON DELETE RESTRICT
);

CREATE TABLE near_miss_evidence (
  near_miss_id TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY(near_miss_id, upload_id),
  UNIQUE(near_miss_id, position),
  FOREIGN KEY(near_miss_id, owner_id) REFERENCES near_misses(id, owner_id) ON DELETE CASCADE,
  FOREIGN KEY(upload_id, owner_id) REFERENCES evidence_uploads(id, owner_id) ON DELETE RESTRICT
);

CREATE TABLE mock_evidence (
  id TEXT PRIMARY KEY,
  hazard_id TEXT REFERENCES hazards(id) ON DELETE CASCADE,
  near_miss_id TEXT REFERENCES near_misses(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  original_name TEXT,
  data_url TEXT NOT NULL,
  observed_at TEXT,
  CHECK((hazard_id IS NOT NULL) != (near_miss_id IS NOT NULL))
);

CREATE TABLE sharing_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('not_recorded', 'not_shared', 'shared')),
  method TEXT,
  recipients TEXT,
  acknowledgment_results TEXT,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  recorded_at TEXT NOT NULL,
  shared_at TEXT,
  client_observed_shared_at TEXT,
  FOREIGN KEY(session_id, owner_id) REFERENCES tbm_sessions(id, owner_id) ON DELETE CASCADE
);

CREATE INDEX idx_sharing_events_session_time ON sharing_events(session_id, recorded_at DESC);

CREATE TABLE audit_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  server_timestamp TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  previous_event_hash TEXT,
  current_event_hash TEXT NOT NULL UNIQUE
);

CREATE TRIGGER audit_events_no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit events are append-only');
END;

CREATE TRIGGER audit_events_no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit events are append-only');
END;

CREATE TABLE legacy_imports (
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  imported_entity_type TEXT NOT NULL,
  imported_entity_id TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  PRIMARY KEY(source_type, source_id)
);
