ALTER TABLE evidence_requests ADD COLUMN native_ready_at TEXT;
ALTER TABLE evidence_requests ADD COLUMN superseded_at TEXT;
ALTER TABLE evidence_requests ADD COLUMN superseded_by_request_id TEXT REFERENCES evidence_requests(id) ON DELETE RESTRICT;

CREATE TABLE native_device_registrations (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  device_name TEXT NOT NULL CHECK(length(device_name) BETWEEN 1 AND 100),
  code_digest TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  redeemed_at TEXT,
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK(failed_attempts >= 0),
  max_attempts INTEGER NOT NULL CHECK(max_attempts BETWEEN 1 AND 20),
  CHECK(expires_at > created_at)
);

CREATE INDEX idx_native_device_registrations_owner ON native_device_registrations(owner_id, created_at DESC);
CREATE INDEX idx_native_device_registrations_expiry ON native_device_registrations(expires_at);

CREATE TABLE native_devices (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
  credential_digest TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT,
  UNIQUE(id, owner_id)
);

CREATE INDEX idx_native_devices_owner ON native_devices(owner_id, revoked_at, last_seen_at DESC);

CREATE TABLE native_capture_claims (
  request_id TEXT PRIMARY KEY REFERENCES evidence_requests(id) ON DELETE RESTRICT,
  owner_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('claimed', 'capturing', 'captured', 'uploaded', 'failed', 'released')),
  claimed_at TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  failure_code TEXT,
  upload_id TEXT,
  FOREIGN KEY(request_id, owner_id) REFERENCES evidence_requests(id, owner_id) ON DELETE RESTRICT,
  FOREIGN KEY(device_id, owner_id) REFERENCES native_devices(id, owner_id) ON DELETE RESTRICT,
  FOREIGN KEY(upload_id, owner_id) REFERENCES evidence_uploads(id, owner_id) ON DELETE RESTRICT
);

CREATE INDEX idx_native_capture_claims_device ON native_capture_claims(device_id, status, lease_expires_at);
