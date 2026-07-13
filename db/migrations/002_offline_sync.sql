ALTER TABLE tbm_sessions ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;

CREATE TABLE client_operations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  UNIQUE(owner_id, idempotency_key)
);

CREATE INDEX idx_client_operations_owner_entity
ON client_operations(owner_id, entity_id, processed_at DESC);
