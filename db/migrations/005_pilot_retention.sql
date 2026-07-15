ALTER TABLE users ADD COLUMN deleted_at TEXT;
ALTER TABLE users ADD COLUMN deletion_reason TEXT;
CREATE INDEX idx_users_deleted_at ON users(deleted_at);
CREATE INDEX idx_evidence_uploads_uploaded_at ON evidence_uploads(uploaded_at);
