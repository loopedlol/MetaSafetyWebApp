ALTER TABLE tbm_sessions ADD COLUMN attendance_expected_count INTEGER CHECK(attendance_expected_count BETWEEN 0 AND 99);
ALTER TABLE tbm_sessions ADD COLUMN attendance_present_count INTEGER CHECK(attendance_present_count BETWEEN 0 AND 99);
ALTER TABLE tbm_sessions ADD COLUMN attendance_capture_source TEXT;
ALTER TABLE tbm_sessions ADD COLUMN attendance_device_observed_at TEXT;

ALTER TABLE corrective_actions ADD COLUMN immediate_response_category TEXT;
ALTER TABLE corrective_actions ADD COLUMN responsible_party TEXT;
ALTER TABLE corrective_actions ADD COLUMN due_period TEXT;

ALTER TABLE evidence_uploads ADD COLUMN source_classification TEXT NOT NULL DEFAULT 'unknown_legacy_source';
ALTER TABLE mock_evidence ADD COLUMN source_classification TEXT NOT NULL DEFAULT 'unknown_legacy_source';

ALTER TABLE sharing_events ADD COLUMN proof_type TEXT;
