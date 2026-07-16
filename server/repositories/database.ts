// @ts-nocheck
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getRecordStatus, normalizeSessionRecord } from '../../src/domain/workflow.ts';

const AUDIT_REDACTED_KEYS = /password|passphrase|secret|registration.?key|api.?key|cookie|authorization|token|credential/i;

function json(value, fallback = null) {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

export function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

export function sanitizeAuditMetadata(value) {
  if (Array.isArray(value)) return value.map(sanitizeAuditMetadata);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !AUDIT_REDACTED_KEYS.test(key))
      .map(([key, item]) => [key, sanitizeAuditMetadata(item)])
  );
}

function hashAuditEvent(event) {
  return createHash('sha256').update(stableStringify(event)).digest('hex');
}

function deterministicId(...parts) {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);
}

function runMigrations(db, migrationsDir, now) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((row) => row.version));
  const files = readdirSync(migrationsDir).filter((file) => file.endsWith('.sql')).sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(path.join(migrationsDir, file), 'utf8');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(file, now());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

export function openDatabase({ databasePath, migrationsDir, now = () => new Date().toISOString() }) {
  if (databasePath !== ':memory:') mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  if (databasePath !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  runMigrations(db, migrationsDir, now);

  function transaction(operation) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function appendAuditEvent({ entityType, entityId, action, actorUserId = null, metadata = {} }) {
    const previous = db
      .prepare('SELECT current_event_hash FROM audit_events ORDER BY sequence DESC LIMIT 1')
      .get()?.current_event_hash ?? null;
    const event = {
      eventId: randomUUID(),
      entityType,
      entityId,
      action,
      actorUserId,
      serverTimestamp: now(),
      metadata: sanitizeAuditMetadata(metadata),
      previousEventHash: previous
    };
    const currentHash = hashAuditEvent(event);
    db.prepare(`
      INSERT INTO audit_events(
        event_id, entity_type, entity_id, action, actor_user_id, server_timestamp,
        metadata_json, previous_event_hash, current_event_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.eventId,
      event.entityType,
      event.entityId,
      event.action,
      event.actorUserId,
      event.serverTimestamp,
      stableStringify(event.metadata),
      event.previousEventHash,
      currentHash
    );
    return { ...event, currentEventHash: currentHash };
  }

  function verifyAuditIntegrity() {
    const rows = db.prepare('SELECT * FROM audit_events ORDER BY sequence').all();
    let previous = null;
    for (const row of rows) {
      const event = {
        eventId: row.event_id,
        entityType: row.entity_type,
        entityId: row.entity_id,
        action: row.action,
        actorUserId: row.actor_user_id,
        serverTimestamp: row.server_timestamp,
        metadata: json(row.metadata_json, {}),
        previousEventHash: row.previous_event_hash
      };
      const expected = hashAuditEvent(event);
      if (row.previous_event_hash !== previous || row.current_event_hash !== expected) {
        return {
          valid: false,
          checkedEvents: rows.indexOf(row),
          failedEventId: row.event_id,
          reason: row.previous_event_hash !== previous ? 'previous hash mismatch' : 'current hash mismatch'
        };
      }
      previous = row.current_event_hash;
    }
    return { valid: true, checkedEvents: rows.length, headHash: previous };
  }

  function findUserByEmail(email) {
    const row = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE AND deleted_at IS NULL').get(email);
    return row ? mapUser(row) : null;
  }

  function findUserById(id) {
    const row = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(id);
    return row ? mapUser(row) : null;
  }

  function mapUser(row) {
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      role: row.role,
      passwordHash: row.password_hash,
      createdAt: row.created_at
    };
  }

  function createUser(user, { audit = true } = {}) {
    return transaction(() => {
      db.prepare(`
        INSERT INTO users(id, name, email, role, password_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(user.id, user.name, user.email, user.role, user.passwordHash, user.createdAt ?? now());
      if (audit) {
        appendAuditEvent({
          entityType: 'user',
          entityId: user.id,
          action: 'user.registered',
          actorUserId: user.id,
          metadata: { email: user.email, role: user.role }
        });
      }
      return findUserById(user.id);
    });
  }

  function listUsers() {
    return db.prepare('SELECT * FROM users ORDER BY created_at, id').all().map(mapUser);
  }

  function createEvidenceUploads(records, actorUserId, sourceClassification = 'browser_file_picker') {
    return transaction(() => {
      const serverTime = now();
      const statement = db.prepare(`
        INSERT INTO evidence_uploads(
          id, owner_id, internal_filename, original_name, mime_type, size_bytes, sha256_hash,
          uploaded_at, client_observed_uploaded_at, source_classification
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const record of records) {
        statement.run(
          record.id,
          record.ownerId,
          record.filename,
          record.originalName,
          record.mimeType,
          record.size,
          record.hash,
          serverTime,
          record.uploadedAt ?? null,
          sourceClassification
        );
        appendAuditEvent({
          entityType: 'evidence_upload',
          entityId: record.id,
          action: 'evidence.uploaded',
          actorUserId,
          metadata: { mimeType: record.mimeType, size: record.size, sha256Hash: record.hash }
        });
      }
      return records.map((record) => ({ ...record, uploadedAt: serverTime }));
    });
  }

  function mapUpload(row) {
    return row
      ? {
          id: row.id,
          ownerId: row.owner_id,
          filename: row.internal_filename,
          originalName: row.original_name,
          mimeType: row.mime_type,
          size: row.size_bytes,
          hash: row.sha256_hash,
          uploadedAt: row.uploaded_at,
          clientObservedUploadedAt: row.client_observed_uploaded_at,
          source: row.source_classification ?? 'unknown_legacy_source'
        }
      : null;
  }

  function getUploadForOwner(id, ownerId) {
    return mapUpload(db.prepare('SELECT * FROM evidence_uploads WHERE id = ? AND owner_id = ?').get(id, ownerId));
  }

  function getUploadsForOwner(ownerId) {
    return db.prepare('SELECT * FROM evidence_uploads WHERE owner_id = ?').all(ownerId).map(mapUpload);
  }

  function listAbandonedUploadsBefore(cutoff) {
    return db.prepare(`
      SELECT e.* FROM evidence_uploads e
      WHERE e.uploaded_at < ?
        AND NOT EXISTS (SELECT 1 FROM hazard_evidence h WHERE h.upload_id = e.id)
        AND NOT EXISTS (SELECT 1 FROM near_miss_evidence n WHERE n.upload_id = e.id)
        AND NOT EXISTS (SELECT 1 FROM ai_analyses a WHERE a.upload_id = e.id)
        AND NOT EXISTS (SELECT 1 FROM evidence_requests r WHERE r.upload_id = e.id AND r.status = 'completed')
      ORDER BY e.uploaded_at, e.id
    `).all(cutoff).map(mapUpload);
  }

  function deleteAbandonedUpload(uploadId) {
    return transaction(() => {
      const upload = mapUpload(db.prepare('SELECT * FROM evidence_uploads WHERE id = ?').get(uploadId));
      if (!upload) return false;
      const deleted = db.prepare(`DELETE FROM evidence_uploads WHERE id = ?
        AND NOT EXISTS (SELECT 1 FROM hazard_evidence WHERE upload_id = ?)
        AND NOT EXISTS (SELECT 1 FROM near_miss_evidence WHERE upload_id = ?)
        AND NOT EXISTS (SELECT 1 FROM ai_analyses WHERE upload_id = ?)
        AND NOT EXISTS (SELECT 1 FROM evidence_requests WHERE upload_id = ? AND status = 'completed')`)
        .run(uploadId, uploadId, uploadId, uploadId, uploadId).changes === 1;
      if (deleted) {
        appendAuditEvent({
          entityType: 'evidence_upload', entityId: uploadId, action: 'evidence.abandoned_deleted',
          metadata: { sha256Hash: upload.hash, uploadedAt: upload.uploadedAt }
        });
      }
      return deleted;
    });
  }

  function deactivateUser(userId) {
    return transaction(() => {
      const user = findUserById(userId);
      if (!user) return false;
      const deletedAt = now();
      db.prepare('UPDATE native_devices SET revoked_at = ? WHERE owner_id = ? AND revoked_at IS NULL').run(deletedAt, userId);
      db.prepare("UPDATE native_capture_claims SET status = 'released', updated_at = ? WHERE owner_id = ? AND status IN ('claimed','capturing','captured','uploaded')")
        .run(deletedAt, userId);
      appendAuditEvent({ entityType: 'user', entityId: userId, action: 'user.deactivated', actorUserId: userId,
        metadata: { safetyRecordsRetained: true, policy: 'pending_pilot_owner_approval' } });
      return db.prepare(`UPDATE users SET name = 'Deleted pilot user',
        email = ?, password_hash = ?, role = 'deleted', deleted_at = ?, deletion_reason = 'user_requested'
        WHERE id = ? AND deleted_at IS NULL`)
        .run(`deleted-${userId}@invalid.local`, 'ACCOUNT_DEACTIVATED', deletedAt, userId).changes === 1;
    });
  }

  function readinessCheck() {
    return db.prepare('SELECT 1 AS ready').get()?.ready === 1;
  }

  function mapAiAnalysis(row) {
    return row
      ? {
          analysisId: row.id,
          ownerId: row.owner_id,
          uploadId: row.upload_id,
          sessionId: row.session_id,
          entryType: row.entry_type,
          mode: row.mode,
          provider: row.provider,
          modelVersion: row.model_version,
          requestedAt: row.requested_at,
          completedAt: row.completed_at,
          suggestion: json(row.normalized_suggestion_json, {}),
          humanDecision: row.human_decision,
          editedSuggestion: json(row.edited_suggestion_json),
          reviewerUserId: row.reviewer_user_id,
          reviewer: row.reviewer_label,
          reviewedAt: row.reviewed_at
        }
      : null;
  }

  function createAiAnalysis(record, actorUserId) {
    return transaction(() => {
      db.prepare(`
        INSERT INTO ai_analyses(
          id, owner_id, upload_id, session_id, entry_type, mode, provider, model_version,
          requested_at, completed_at, normalized_suggestion_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.analysisId, record.ownerId, record.uploadId, record.sessionId ?? null, record.entryType,
        record.mode, record.provider, record.modelVersion ?? null, record.requestedAt, record.completedAt,
        stableStringify(record.suggestion)
      );
      appendAuditEvent({
        entityType: 'ai_analysis', entityId: record.analysisId, action: 'ai_analysis.generated', actorUserId,
        metadata: { uploadId: record.uploadId, mode: record.mode, provider: record.provider, modelVersion: record.modelVersion }
      });
      return getAiAnalysisForOwner(record.analysisId, record.ownerId);
    });
  }

  function getAiAnalysisForOwner(analysisId, ownerId) {
    return mapAiAnalysis(db.prepare('SELECT * FROM ai_analyses WHERE id = ? AND owner_id = ?').get(analysisId, ownerId));
  }

  function reviewAiAnalysis({ analysisId, ownerId, decision, editedSuggestion, reviewerUserId, reviewer }) {
    return transaction(() => {
      const reviewedAt = now();
      const result = db.prepare(`
        UPDATE ai_analyses
        SET human_decision = ?, edited_suggestion_json = ?, reviewer_user_id = ?, reviewer_label = ?, reviewed_at = ?
        WHERE id = ? AND owner_id = ?
      `).run(
        decision, decision === 'edited' ? stableStringify(editedSuggestion) : null,
        reviewerUserId, reviewer, reviewedAt, analysisId, ownerId
      );
      if (!result.changes) return null;
      appendAuditEvent({
        entityType: 'ai_analysis', entityId: analysisId, action: 'ai_analysis.reviewed', actorUserId: reviewerUserId,
        metadata: { decision, reviewer }
      });
      return getAiAnalysisForOwner(analysisId, ownerId);
    });
  }

  function getSessionOwner(sessionId) {
    return db.prepare('SELECT owner_id FROM tbm_sessions WHERE id = ?').get(sessionId)?.owner_id ?? null;
  }

  function saveSession(inputSession, actorUserId, { saveMode = 'draft', expectedRevision } = {}) {
    const session = normalizeSessionRecord(inputSession);
    return transaction(() => {
      const existing = db.prepare('SELECT * FROM tbm_sessions WHERE id = ?').get(session.sessionId);
      if (existing && existing.owner_id !== actorUserId) {
        const error = new Error('Resource not found.');
        error.code = 'NOT_FOUND';
        throw error;
      }
      const currentRevision = existing?.revision ?? 0;
      if (expectedRevision != null && Number(expectedRevision) !== currentRevision) {
        const error = new Error('Session changed on the server.');
        error.code = 'CONFLICT';
        error.serverRevision = currentRevision;
        throw error;
      }
      const serverTime = now();
      const nextRevision = currentRevision + 1;
      session.status = saveMode === 'finalize' ? getRecordStatus(session) : 'draft';
      session.finalizedAt = saveMode === 'finalize' ? existing?.finalized_at ?? serverTime : null;
      session.completedAt = session.status === 'completed' ? existing?.completed_at ?? serverTime : null;
      const ownerId = existing?.owner_id ?? actorUserId;
      const siteName = String(session.site?.siteName ?? 'Unknown site');
      const siteArea = String(session.site?.siteArea ?? '');
      let site = db
        .prepare('SELECT id FROM sites WHERE owner_id = ? AND site_name = ? AND site_area = ?')
        .get(ownerId, siteName, siteArea);
      if (!site) {
        site = { id: randomUUID() };
        db.prepare(`
          INSERT INTO sites(id, owner_id, site_name, site_area, gps_latitude, gps_longitude, gps_accuracy_meters, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          site.id,
          ownerId,
          siteName,
          siteArea,
          session.site?.gps?.latitude ?? null,
          session.site?.gps?.longitude ?? null,
          session.site?.gps?.accuracyMeters ?? null,
          serverTime
        );
      }

      db.prepare(`
        INSERT INTO tbm_sessions(
          id, owner_id, site_id, schema_version, session_type, status, task_name, work_type,
          planned_work_description, supervisor_name, supervisor_role, device_platform,
          device_app_version, device_input_mode, worker_feedback_json, created_at, saved_at,
          finalized_at, completed_at, client_observed_created_at, client_observed_started_at,
          client_observed_exported_at, revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          site_id = excluded.site_id,
          schema_version = excluded.schema_version,
          session_type = excluded.session_type,
          status = excluded.status,
          task_name = excluded.task_name,
          work_type = excluded.work_type,
          planned_work_description = excluded.planned_work_description,
          supervisor_name = excluded.supervisor_name,
          supervisor_role = excluded.supervisor_role,
          device_platform = excluded.device_platform,
          device_app_version = excluded.device_app_version,
          device_input_mode = excluded.device_input_mode,
          worker_feedback_json = excluded.worker_feedback_json,
          saved_at = excluded.saved_at,
          finalized_at = excluded.finalized_at,
          completed_at = excluded.completed_at,
          client_observed_created_at = excluded.client_observed_created_at,
          client_observed_started_at = excluded.client_observed_started_at,
          client_observed_exported_at = excluded.client_observed_exported_at,
          revision = excluded.revision
      `).run(
        session.sessionId,
        ownerId,
        site.id,
        session.schemaVersion ?? null,
        session.sessionType,
        session.status,
        session.work?.taskName ?? '',
        session.work?.workType ?? '',
        session.work?.plannedWorkDescription ?? '',
        session.supervisor?.name ?? '',
        session.supervisor?.role ?? '',
        session.device?.platform ?? null,
        session.device?.appVersion ?? null,
        session.device?.inputMode ?? null,
        stableStringify(session.workerFeedback ?? []),
        existing?.created_at ?? serverTime,
        serverTime,
        session.finalizedAt ?? null,
        session.completedAt ?? null,
        session.createdAt ?? null,
        session.startedAt ?? null,
        session.exportedAt ?? null,
        nextRevision
      );
      const attendanceSummary = session.attendanceSummary;
      db.prepare(`UPDATE tbm_sessions SET attendance_expected_count = ?, attendance_present_count = ?,
        attendance_capture_source = ?, attendance_device_observed_at = ? WHERE id = ?`).run(
        attendanceSummary?.expectedCount ?? null, attendanceSummary?.presentCount ?? null,
        attendanceSummary?.captureSource ?? null, attendanceSummary?.deviceObservedAt ?? null, session.sessionId
      );

      const existingHazards = new Map(
        db.prepare(`
          SELECT h.external_id, h.id, h.created_at, r.status AS review_status, r.reviewed_at,
                 c.verification_status, c.verified_at
          FROM hazards h
          LEFT JOIN hazard_reviews r ON r.hazard_id = h.id
          LEFT JOIN corrective_actions c ON c.hazard_id = h.id
          WHERE h.session_id = ?
        `).all(session.sessionId).map((row) => [row.external_id, row])
      );

      db.prepare('DELETE FROM session_participants WHERE session_id = ?').run(session.sessionId);
      db.prepare('DELETE FROM hazards WHERE session_id = ?').run(session.sessionId);
      db.prepare('DELETE FROM near_misses WHERE session_id = ?').run(session.sessionId);

      for (const [position, worker] of (session.workers ?? []).entries()) {
        const workerId = worker.id || deterministicId(ownerId, session.sessionId, 'worker', position, worker.name);
        const ownedWorker = db.prepare('SELECT owner_id FROM workers WHERE id = ?').get(workerId);
        if (ownedWorker && ownedWorker.owner_id !== ownerId) throw new Error('Worker ownership mismatch.');
        db.prepare(`
          INSERT INTO workers(id, owner_id, name, role, created_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET name = excluded.name, role = excluded.role
        `).run(workerId, ownerId, worker.name, worker.role ?? '', serverTime);
        db.prepare('INSERT INTO session_participants(session_id, worker_id, owner_id, position) VALUES (?, ?, ?, ?)')
          .run(session.sessionId, workerId, ownerId, position);
        db.prepare(`
          INSERT INTO attendance_records(session_id, worker_id, owner_id, present, recorded_by_user_id, recorded_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(session.sessionId, workerId, ownerId, worker.present ? 1 : 0, actorUserId, serverTime);

        const acknowledgment = worker.acknowledgment ?? {};
        if (acknowledgment.supervisorRecorded) {
          db.prepare(`
            INSERT INTO acknowledgment_records(
              id, session_id, worker_id, owner_id, acknowledgment_type, recorded_by_user_id,
              recorded_by_label, method, source, recorded_at, client_observed_at
            ) VALUES (?, ?, ?, ?, 'supervisor_recorded', ?, ?, ?, ?, ?, ?)
          `).run(
            randomUUID(),
            session.sessionId,
            workerId,
            ownerId,
            actorUserId,
            acknowledgment.supervisorRecordedBy ?? null,
            null,
            acknowledgment.source ?? 'supervisor_recorded',
            serverTime,
            acknowledgment.supervisorRecordedAt ?? null
          );
        }
        if (acknowledgment.independentlyVerified) {
          db.prepare(`
            INSERT INTO acknowledgment_records(
              id, session_id, worker_id, owner_id, acknowledgment_type, recorded_by_user_id,
              recorded_by_label, method, source, recorded_at, client_observed_at
            ) VALUES (?, ?, ?, ?, 'independently_verified', ?, ?, ?, ?, ?, ?)
          `).run(
            randomUUID(),
            session.sessionId,
            workerId,
            ownerId,
            actorUserId,
            acknowledgment.independentlyVerifiedBy ?? null,
            acknowledgment.independentVerificationMethod ?? null,
            'independent_verification',
            serverTime,
            acknowledgment.independentlyVerifiedAt ?? null
          );
        }
      }

      for (const [position, hazard] of (session.hazards ?? []).entries()) {
        const externalId = String(hazard.id ?? `hazard-${position}`);
        const previous = existingHazards.get(externalId);
        const hazardId = previous?.id ?? randomUUID();
        db.prepare(`
          INSERT INTO hazards(
            id, session_id, owner_id, external_id, position, source, title, category, location,
            risk_level, risk_description, recommended_action, memo, ai_suggestion_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          hazardId,
          session.sessionId,
          ownerId,
          externalId,
          position,
          hazard.source ?? null,
          hazard.title,
          hazard.category ?? null,
          hazard.location ?? null,
          hazard.riskLevel ?? null,
          hazard.riskDescription ?? null,
          hazard.recommendedAction ?? null,
          hazard.memo ?? null,
          hazard.aiSuggestion ? stableStringify(hazard.aiSuggestion) : null,
          previous?.created_at ?? serverTime
        );

        const review = hazard.humanReview ?? {};
        const statusChanged = previous?.review_status !== hazard.status;
        const reviewedAt = review.reviewed ? (statusChanged ? serverTime : previous?.reviewed_at ?? serverTime) : null;
        db.prepare(`
          INSERT INTO hazard_reviews(
            id, hazard_id, status, reviewed, reviewed_by_user_id, reviewed_by_label,
            reviewed_at, client_observed_reviewed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          hazardId,
          hazard.status,
          review.reviewed ? 1 : 0,
          review.reviewed ? actorUserId : null,
          review.reviewedBy ?? null,
          reviewedAt,
          review.reviewedAt ?? null
        );
        if (statusChanged) {
          appendAuditEvent({
            entityType: 'hazard',
            entityId: hazardId,
            action: 'hazard.reviewed',
            actorUserId,
            metadata: { sessionId: session.sessionId, status: hazard.status }
          });
        }

        const corrective = hazard.correctiveAction ?? {};
        const verificationChanged = previous?.verification_status !== corrective.verificationStatus;
        const verifiedAt = corrective.verificationStatus === 'verified'
          ? verificationChanged
            ? serverTime
            : previous?.verified_at ?? serverTime
          : null;
        db.prepare(`
          INSERT INTO corrective_actions(
            id, hazard_id, required, immediate_control, assigned_to, due_at, work_status,
            verification_status, verified_by_user_id, verified_by_label, verified_at,
            client_observed_verified_at, closure_evidence_json, updated_at,
            immediate_response_category, responsible_party, due_period
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          hazardId,
          corrective.required ? 1 : 0,
          corrective.immediateControl ?? null,
          corrective.assignedTo ?? null,
          corrective.dueAt || null,
          corrective.workStatus || null,
          corrective.verificationStatus ?? 'open',
          corrective.verificationStatus === 'verified' ? actorUserId : null,
          corrective.verifiedBy ?? null,
          verifiedAt,
          corrective.verifiedAt ?? null,
          stableStringify(corrective.closureEvidence ?? []),
          serverTime,
          corrective.immediateResponseCategory || null,
          corrective.responsibleParty || null,
          corrective.duePeriod || null
        );
        if (verificationChanged && corrective.verificationStatus === 'verified') {
          appendAuditEvent({
            entityType: 'corrective_action',
            entityId: hazardId,
            action: 'corrective_action.verified',
            actorUserId,
            metadata: { sessionId: session.sessionId, verifiedBy: corrective.verifiedBy ?? null }
          });
        }

        insertEvidenceLinks({ parentType: 'hazard', parentId: hazardId, ownerId, photos: hazard.evidencePhotos ?? [] });
      }

      for (const [position, nearMiss] of (session.nearMisses ?? []).entries()) {
        const nearMissId = String(nearMiss.id ?? randomUUID());
        db.prepare(`
          INSERT INTO near_misses(
            id, session_id, owner_id, position, source, title, category, location, risk_level,
            description, action_taken, reported_by, reported_at, ai_suggestion_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          nearMissId,
          session.sessionId,
          ownerId,
          position,
          nearMiss.source ?? null,
          nearMiss.title,
          nearMiss.category ?? null,
          nearMiss.location ?? null,
          nearMiss.riskLevel ?? null,
          nearMiss.description ?? null,
          nearMiss.actionTaken ?? null,
          nearMiss.reportedBy ?? null,
          nearMiss.reportedAt ?? null,
          nearMiss.aiSuggestion ? stableStringify(nearMiss.aiSuggestion) : null
        );
        insertEvidenceLinks({ parentType: 'near_miss', parentId: nearMissId, ownerId, photos: nearMiss.evidencePhotos ?? [] });
      }

      const latestSharing = db
        .prepare('SELECT * FROM sharing_events WHERE session_id = ? ORDER BY recorded_at DESC, rowid DESC LIMIT 1')
        .get(session.sessionId);
      const sharing = session.sharing ?? { status: 'not_recorded' };
      const sharingChanged =
        !latestSharing ||
        latestSharing.status !== sharing.status ||
        (latestSharing.method ?? '') !== (sharing.method ?? '') ||
        (latestSharing.recipients ?? '') !== (sharing.recipients ?? '') ||
        (latestSharing.acknowledgment_results ?? '') !== (sharing.acknowledgmentResults ?? '') ||
        (latestSharing.proof_type ?? '') !== (sharing.proofType ?? '');
      if (sharingChanged) {
        const sharedAt = sharing.status === 'shared' ? serverTime : null;
        const sharingId = randomUUID();
        db.prepare(`
          INSERT INTO sharing_events(
            id, session_id, owner_id, status, method, recipients, acknowledgment_results,
            actor_user_id, recorded_at, shared_at, client_observed_shared_at, proof_type
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          sharingId,
          session.sessionId,
          ownerId,
          sharing.status,
          sharing.method || null,
          sharing.recipients || null,
          sharing.acknowledgmentResults || null,
          actorUserId,
          serverTime,
          sharedAt,
          sharing.sharedAt ?? null,
          sharing.proofType || null
        );
        appendAuditEvent({
          entityType: 'sharing_event',
          entityId: sharingId,
          action: 'sharing.recorded',
          actorUserId,
          metadata: { sessionId: session.sessionId, status: sharing.status, method: sharing.method ?? null }
        });
      }

      appendAuditEvent({
        entityType: 'tbm_session',
        entityId: session.sessionId,
        action: existing ? (saveMode === 'finalize' ? 'tbm_session.finalized' : 'tbm_session.updated') : 'tbm_session.created',
        actorUserId,
        metadata: {
          status: session.status,
          hazardCount: session.hazards?.length ?? 0,
          participantCount: session.workers?.length ?? 0
        }
      });
      return getSessionForOwner(session.sessionId, ownerId);
    });
  }

  function insertEvidenceLinks({ parentType, parentId, ownerId, photos }) {
    let position = 0;
    for (const photo of photos) {
      if (photo?.source === 'browser_preview_mock' && String(photo.url ?? '').startsWith('data:image/svg+xml')) {
        db.prepare(`
          INSERT INTO mock_evidence(id, hazard_id, near_miss_id, position, original_name, data_url, observed_at, source_classification)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'browser_preview_mock')
        `).run(
          randomUUID(),
          parentType === 'hazard' ? parentId : null,
          parentType === 'near_miss' ? parentId : null,
          position,
          photo.originalName ?? null,
          photo.url,
          photo.uploadedAt ?? null
        );
      } else {
        const uploadId = String(photo?.uploadId ?? photo?.id ?? '');
        const upload = db.prepare('SELECT id FROM evidence_uploads WHERE id = ? AND owner_id = ?').get(uploadId, ownerId);
        if (!upload) {
          const error = new Error('Session contains inaccessible evidence.');
          error.code = 'INACCESSIBLE_EVIDENCE';
          throw error;
        }
        const table = parentType === 'hazard' ? 'hazard_evidence' : 'near_miss_evidence';
        const parentColumn = parentType === 'hazard' ? 'hazard_id' : 'near_miss_id';
        db.prepare(`INSERT INTO ${table}(${parentColumn}, upload_id, owner_id, position) VALUES (?, ?, ?, ?)`)
          .run(parentId, uploadId, ownerId, position);
      }
      position += 1;
    }
  }

  function listSessionsForOwner(ownerId) {
    return db.prepare('SELECT id FROM tbm_sessions WHERE owner_id = ? ORDER BY saved_at DESC').all(ownerId)
      .map((row) => getSessionForOwner(row.id, ownerId));
  }

  function getSessionForOwner(sessionId, ownerId) {
    const row = db.prepare(`
      SELECT s.*, site.site_name, site.site_area, site.gps_latitude, site.gps_longitude,
             site.gps_accuracy_meters, u.name AS creator_name, u.email AS creator_email, u.role AS creator_role
      FROM tbm_sessions s
      JOIN sites site ON site.id = s.site_id AND site.owner_id = s.owner_id
      JOIN users u ON u.id = s.owner_id
      WHERE s.id = ? AND s.owner_id = ?
    `).get(sessionId, ownerId);
    if (!row) return null;

    const workers = db.prepare(`
      SELECT w.*, p.position, a.present
      FROM session_participants p
      JOIN workers w ON w.id = p.worker_id AND w.owner_id = p.owner_id
      JOIN attendance_records a ON a.session_id = p.session_id AND a.worker_id = p.worker_id AND a.owner_id = p.owner_id
      WHERE p.session_id = ? ORDER BY p.position
    `).all(sessionId).map((worker) => {
      const acknowledgments = db.prepare(`
        SELECT * FROM acknowledgment_records WHERE session_id = ? AND worker_id = ?
      `).all(sessionId, worker.id);
      const supervisor = acknowledgments.find((item) => item.acknowledgment_type === 'supervisor_recorded');
      const independent = acknowledgments.find((item) => item.acknowledgment_type === 'independently_verified');
      return {
        id: worker.id,
        name: worker.name,
        role: worker.role,
        present: Boolean(worker.present),
        acknowledgment: {
          supervisorRecorded: Boolean(supervisor),
          supervisorRecordedBy: supervisor?.recorded_by_label ?? null,
          supervisorRecordedAt: supervisor?.recorded_at ?? null,
          independentlyVerified: Boolean(independent),
          independentlyVerifiedBy: independent?.recorded_by_label ?? null,
          independentlyVerifiedAt: independent?.recorded_at ?? null,
          independentVerificationMethod: independent?.method ?? null,
          source: supervisor?.source ?? null
        }
      };
    });

    const hazards = db.prepare('SELECT * FROM hazards WHERE session_id = ? ORDER BY position').all(sessionId)
      .map((hazard) => {
        const review = db.prepare('SELECT * FROM hazard_reviews WHERE hazard_id = ?').get(hazard.id);
        const corrective = db.prepare('SELECT * FROM corrective_actions WHERE hazard_id = ?').get(hazard.id);
        return {
          id: hazard.external_id,
          source: hazard.source,
          title: hazard.title,
          category: hazard.category,
          location: hazard.location,
          riskLevel: hazard.risk_level,
          riskDescription: hazard.risk_description,
          recommendedAction: hazard.recommended_action,
          memo: hazard.memo,
          aiSuggestion: json(hazard.ai_suggestion_json),
          status: review.status,
          humanReview: {
            reviewed: Boolean(review.reviewed),
            decision: review.status,
            reviewedBy: review.reviewed_by_label,
            reviewedAt: review.reviewed_at,
            clientObservedReviewedAt: review.client_observed_reviewed_at
          },
          correctiveAction: {
            required: Boolean(corrective.required),
            immediateControl: corrective.immediate_control ?? '',
            assignedTo: corrective.assigned_to ?? '',
            dueAt: corrective.due_at ?? '',
            workStatus: corrective.work_status ?? '',
            verificationStatus: corrective.verification_status,
            verifiedBy: corrective.verified_by_label,
            verifiedAt: corrective.verified_at,
            clientObservedVerifiedAt: corrective.client_observed_verified_at,
            closureEvidence: json(corrective.closure_evidence_json, []),
            immediateResponseCategory: corrective.immediate_response_category ?? '',
            responsibleParty: corrective.responsible_party ?? '',
            duePeriod: corrective.due_period ?? ''
          },
          evidencePhotos: readEvidence('hazard', hazard.id)
        };
      });

    const nearMisses = db.prepare('SELECT * FROM near_misses WHERE session_id = ? ORDER BY position').all(sessionId)
      .map((item) => ({
        id: item.id,
        source: item.source,
        title: item.title,
        category: item.category,
        location: item.location,
        riskLevel: item.risk_level,
        description: item.description,
        actionTaken: item.action_taken,
        reportedBy: item.reported_by,
        reportedAt: item.reported_at,
        aiSuggestion: json(item.ai_suggestion_json),
        evidencePhotos: readEvidence('near_miss', item.id)
      }));

    const sharing = db.prepare('SELECT * FROM sharing_events WHERE session_id = ? ORDER BY recorded_at DESC, rowid DESC LIMIT 1')
      .get(sessionId);
    return {
      schemaVersion: row.schema_version,
      sessionId: row.id,
      sessionType: row.session_type,
      ownerId: row.owner_id,
      status: row.status,
      revision: row.revision,
      createdAt: row.client_observed_created_at,
      startedAt: row.client_observed_started_at,
      exportedAt: row.client_observed_exported_at,
      savedAt: row.saved_at,
      finalizedAt: row.finalized_at,
      completedAt: row.completed_at,
      serverCreatedAt: row.created_at,
      authoritativeTimestamps: {
        createdAt: row.created_at,
        savedAt: row.saved_at,
        finalizedAt: row.finalized_at,
        completedAt: row.completed_at
      },
      clientObservedTimestamps: {
        createdAt: row.client_observed_created_at,
        startedAt: row.client_observed_started_at,
        exportedAt: row.client_observed_exported_at
      },
      site: {
        siteName: row.site_name,
        siteArea: row.site_area,
        gps: {
          latitude: row.gps_latitude,
          longitude: row.gps_longitude,
          accuracyMeters: row.gps_accuracy_meters
        }
      },
      work: {
        taskName: row.task_name,
        workType: row.work_type,
        plannedWorkDescription: row.planned_work_description
      },
      supervisor: { name: row.supervisor_name, role: row.supervisor_role },
      attendanceSummary: row.attendance_expected_count == null ? null : {
        expectedCount: row.attendance_expected_count, presentCount: row.attendance_present_count,
        captureSource: row.attendance_capture_source, deviceObservedAt: row.attendance_device_observed_at
      },
      workers,
      hazards,
      nearMisses,
      workerFeedback: json(row.worker_feedback_json, []),
      sharing: sharing
        ? {
            status: sharing.status,
            method: sharing.method ?? '',
            recipients: sharing.recipients ?? '',
            acknowledgmentResults: sharing.acknowledgment_results ?? '',
            sharedAt: sharing.shared_at,
            clientObservedSharedAt: sharing.client_observed_shared_at,
            proofType: sharing.proof_type ?? ''
          }
        : { status: 'not_recorded', method: '', recipients: '', acknowledgmentResults: '', sharedAt: null },
      device: {
        platform: row.device_platform,
        appVersion: row.device_app_version,
        inputMode: row.device_input_mode
      },
      createdBy: {
        id: row.owner_id,
        name: row.creator_name,
        email: row.creator_email,
        role: row.creator_role
      }
    };
  }

  function readEvidence(parentType, parentId) {
    const table = parentType === 'hazard' ? 'hazard_evidence' : 'near_miss_evidence';
    const parentColumn = parentType === 'hazard' ? 'hazard_id' : 'near_miss_id';
    const uploads = db.prepare(`
      SELECT e.*, link.position FROM ${table} link
      JOIN evidence_uploads e ON e.id = link.upload_id AND e.owner_id = link.owner_id
      WHERE link.${parentColumn} = ? ORDER BY link.position
    `).all(parentId).map((item) => ({
      id: item.id,
      uploadId: item.id,
      originalName: item.original_name,
      mimeType: item.mime_type,
      size: item.size_bytes,
      uploadedAt: item.uploaded_at,
      source: item.source_classification ?? 'unknown_legacy_source',
      url: `/api/uploads/${encodeURIComponent(item.id)}`,
      position: item.position
    }));
    const mocks = db.prepare(`
      SELECT * FROM mock_evidence WHERE ${parentColumn} = ? ORDER BY position
    `).all(parentId).map((item) => ({
      id: item.id,
      originalName: item.original_name,
      source: item.source_classification ?? 'unknown_legacy_source',
      url: item.data_url,
      uploadedAt: item.observed_at,
      position: item.position
    }));
    return [...uploads, ...mocks].sort((first, second) => first.position - second.position)
      .map(({ position, ...item }) => item);
  }

  function hasLegacyImport(sourceType, sourceId) {
    return Boolean(db.prepare('SELECT 1 FROM legacy_imports WHERE source_type = ? AND source_id = ?').get(sourceType, sourceId));
  }

  function recordLegacyImport({ sourceType, sourceId, entityType, entityId }) {
    db.prepare(`
      INSERT OR IGNORE INTO legacy_imports(source_type, source_id, imported_entity_type, imported_entity_id, imported_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(sourceType, sourceId, entityType, entityId, now());
  }

  function getClientOperation(ownerId, idempotencyKey) {
    const row = db.prepare(`
      SELECT * FROM client_operations WHERE owner_id = ? AND idempotency_key = ?
    `).get(ownerId, idempotencyKey);
    return row
      ? {
          operationType: row.operation_type,
          entityId: row.entity_id,
          responseStatus: row.response_status,
          response: json(row.response_json, {}),
          processedAt: row.processed_at
        }
      : null;
  }

  function recordClientOperation({ ownerId, idempotencyKey, operationType, entityId, responseStatus, response }) {
    db.prepare(`
      INSERT INTO client_operations(
        owner_id, idempotency_key, operation_type, entity_id, response_status, response_json, processed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      ownerId,
      idempotencyKey,
      operationType,
      entityId,
      responseStatus,
      stableStringify(response),
      now()
    );
    return getClientOperation(ownerId, idempotencyKey);
  }

  function pairingStatus(row, currentTime = now()) {
    if (row.cancelled_at) return 'cancelled';
    if (row.redeemed_at) {
      const glasses = row.restricted_session_id
        ? db.prepare('SELECT revoked_at, expires_at FROM glasses_sessions WHERE id = ?').get(row.restricted_session_id)
        : null;
      if (glasses?.revoked_at) return 'revoked';
      if (!glasses || glasses.expires_at <= currentTime) return 'expired';
      return 'paired';
    }
    if (row.expires_at <= currentTime || row.failed_attempts >= row.max_attempts) return 'expired';
    return 'pending';
  }

  function mapPairing(row) {
    if (!row) return null;
    return {
      id: row.id,
      supervisorUserId: row.supervisor_user_id,
      scopeType: row.scope_type,
      scopeSiteId: row.scope_site_id,
      scopeSessionId: row.scope_session_id,
      siteName: row.site_name,
      siteArea: row.site_area,
      taskName: row.task_name ?? null,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      redeemedAt: row.redeemed_at,
      cancelledAt: row.cancelled_at,
      failedAttempts: row.failed_attempts,
      maxAttempts: row.max_attempts,
      restrictedSessionId: row.restricted_session_id,
      status: pairingStatus(row)
    };
  }

  const pairingSelect = `
    SELECT p.*, site.site_name, site.site_area, session.task_name
    FROM glasses_pairings p
    JOIN sites site ON site.id = p.scope_site_id AND site.owner_id = p.supervisor_user_id
    LEFT JOIN tbm_sessions session ON session.id = p.scope_session_id AND session.owner_id = p.supervisor_user_id
  `;

  function listPairingScopes(ownerId) {
    const sites = db.prepare(`
      SELECT id, site_name, site_area FROM sites WHERE owner_id = ? ORDER BY site_name, site_area
    `).all(ownerId).map((row) => ({ type: 'site', id: row.id, siteName: row.site_name, siteArea: row.site_area }));
    const sessions = db.prepare(`
      SELECT s.id, s.site_id, s.task_name, s.status, s.saved_at, site.site_name, site.site_area
      FROM tbm_sessions s JOIN sites site ON site.id = s.site_id AND site.owner_id = s.owner_id
      WHERE s.owner_id = ? AND s.status != 'completed' ORDER BY s.saved_at DESC
    `).all(ownerId).map((row) => ({
      type: 'tbm_session', id: row.id, siteId: row.site_id, siteName: row.site_name,
      siteArea: row.site_area, taskName: row.task_name, status: row.status, savedAt: row.saved_at
    }));
    return { sites, sessions };
  }

  function createGlassesPairing(record) {
    return transaction(() => {
      const scope = record.scopeType === 'tbm_session'
        ? db.prepare('SELECT id, site_id FROM tbm_sessions WHERE id = ? AND owner_id = ?').get(record.scopeId, record.supervisorUserId)
        : db.prepare('SELECT id, id AS site_id FROM sites WHERE id = ? AND owner_id = ?').get(record.scopeId, record.supervisorUserId);
      if (!scope) return null;
      db.prepare(`
        INSERT INTO glasses_pairings(
          id, code_digest, supervisor_user_id, scope_type, scope_site_id, scope_session_id,
          created_at, expires_at, max_attempts
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.id, record.codeDigest, record.supervisorUserId, record.scopeType, scope.site_id,
        record.scopeType === 'tbm_session' ? scope.id : null, record.createdAt, record.expiresAt, record.maxAttempts
      );
      appendAuditEvent({
        entityType: 'glasses_pairing', entityId: record.id, action: 'glasses_pairing.created',
        actorUserId: record.supervisorUserId,
        metadata: { scopeType: record.scopeType, scopeSiteId: scope.site_id, scopeSessionId: record.scopeType === 'tbm_session' ? scope.id : null, expiresAt: record.expiresAt }
      });
      return mapPairing(db.prepare(`${pairingSelect} WHERE p.id = ?`).get(record.id));
    });
  }

  function getGlassesPairingForOwner(id, ownerId) {
    return mapPairing(db.prepare(`${pairingSelect} WHERE p.id = ? AND p.supervisor_user_id = ?`).get(id, ownerId));
  }

  function cancelGlassesPairing(id, ownerId) {
    return transaction(() => {
      const row = db.prepare('SELECT * FROM glasses_pairings WHERE id = ? AND supervisor_user_id = ?').get(id, ownerId);
      if (!row || pairingStatus(row) !== 'pending') return false;
      db.prepare('UPDATE glasses_pairings SET cancelled_at = ? WHERE id = ?').run(now(), id);
      appendAuditEvent({ entityType: 'glasses_pairing', entityId: id, action: 'glasses_pairing.cancelled', actorUserId: ownerId });
      return true;
    });
  }

  function redeemGlassesPairing({ codeDigest, restrictedSessionId, sessionExpiresAt }) {
    return transaction(() => {
      const row = db.prepare('SELECT * FROM glasses_pairings WHERE code_digest = ?').get(codeDigest);
      const currentTime = now();
      if (!row || pairingStatus(row, currentTime) !== 'pending') {
        if (row && !row.redeemed_at) {
          db.prepare('UPDATE glasses_pairings SET failed_attempts = failed_attempts + 1 WHERE id = ?').run(row.id);
          appendAuditEvent({
            entityType: 'glasses_pairing', entityId: row.id, action: 'glasses_pairing.exchange_failed',
            actorUserId: row.supervisor_user_id, metadata: { reason: 'not_redeemable' }
          });
        }
        return null;
      }
      const changed = db.prepare(`
        UPDATE glasses_pairings SET redeemed_at = ?, restricted_session_id = ?
        WHERE id = ? AND redeemed_at IS NULL AND cancelled_at IS NULL AND expires_at > ? AND failed_attempts < max_attempts
      `).run(currentTime, restrictedSessionId, row.id, currentTime);
      if (changed.changes !== 1) return null;
      db.prepare(`
        INSERT INTO glasses_sessions(
          id, pairing_id, supervisor_user_id, scope_type, scope_site_id, scope_session_id,
          created_at, expires_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        restrictedSessionId, row.id, row.supervisor_user_id, row.scope_type, row.scope_site_id,
        row.scope_session_id, currentTime, sessionExpiresAt, currentTime
      );
      appendAuditEvent({
        entityType: 'glasses_pairing', entityId: row.id, action: 'glasses_pairing.redeemed',
        actorUserId: row.supervisor_user_id,
        metadata: { restrictedSessionId, scopeType: row.scope_type, scopeSiteId: row.scope_site_id, scopeSessionId: row.scope_session_id }
      });
      return getGlassesSession(restrictedSessionId);
    });
  }

  function recordUnknownPairingFailure(clientKey = 'unknown') {
    appendAuditEvent({
      entityType: 'glasses_pairing_exchange', entityId: deterministicId(clientKey, now()),
      action: 'glasses_pairing.exchange_failed', metadata: { reason: 'invalid_or_unknown' }
    });
  }

  function getGlassesSession(id) {
    const row = db.prepare(`
      SELECT gs.*, site.site_name, site.site_area, session.task_name
      FROM glasses_sessions gs
      JOIN sites site ON site.id = gs.scope_site_id AND site.owner_id = gs.supervisor_user_id
      LEFT JOIN tbm_sessions session ON session.id = gs.scope_session_id AND session.owner_id = gs.supervisor_user_id
      WHERE gs.id = ?
    `).get(id);
    if (!row || row.revoked_at || row.expires_at <= now()) return null;
    return {
      id: row.id, pairingId: row.pairing_id, supervisorUserId: row.supervisor_user_id,
      scopeType: row.scope_type, scopeSiteId: row.scope_site_id, scopeSessionId: row.scope_session_id,
      siteName: row.site_name, siteArea: row.site_area, taskName: row.task_name ?? null,
      createdAt: row.created_at, expiresAt: row.expires_at
    };
  }

  function revokeGlassesSessionForPairing(pairingId, ownerId) {
    return transaction(() => {
      const pairing = db.prepare('SELECT restricted_session_id FROM glasses_pairings WHERE id = ? AND supervisor_user_id = ?').get(pairingId, ownerId);
      if (!pairing?.restricted_session_id) return false;
      const result = db.prepare('UPDATE glasses_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now(), pairing.restricted_session_id);
      if (result.changes !== 1) return false;
      appendAuditEvent({ entityType: 'glasses_session', entityId: pairing.restricted_session_id, action: 'glasses_session.revoked', actorUserId: ownerId, metadata: { pairingId } });
      return true;
    });
  }

  function cleanupExpiredGlassesPairings() {
    return transaction(() => {
      const currentTime = now();
      const rows = db.prepare(`
        SELECT * FROM glasses_pairings
        WHERE expires_at <= ? AND redeemed_at IS NULL
      `).all(currentTime);
      for (const row of rows) {
        if (!row.cancelled_at) {
          appendAuditEvent({ entityType: 'glasses_pairing', entityId: row.id, action: 'glasses_pairing.expired', actorUserId: row.supervisor_user_id });
        }
        db.prepare('DELETE FROM glasses_pairings WHERE id = ? AND redeemed_at IS NULL').run(row.id);
      }
      return rows.length;
    });
  }

  const evidenceRequestSelect = `
    SELECT r.*, h.title AS hazard_title, h.location AS hazard_location,
      s.task_name, site.site_name, site.site_area,
      e.mime_type AS upload_mime_type, e.size_bytes AS upload_size_bytes,
      e.uploaded_at AS upload_uploaded_at, e.source_classification AS upload_source
    FROM evidence_requests r
    JOIN hazards h ON h.id = r.hazard_id AND h.owner_id = r.owner_id AND h.session_id = r.session_id
    JOIN tbm_sessions s ON s.id = r.session_id AND s.owner_id = r.owner_id
    JOIN sites site ON site.id = s.site_id AND site.owner_id = r.owner_id
    LEFT JOIN evidence_uploads e ON e.id = r.upload_id AND e.owner_id = r.owner_id
  `;

  function mapEvidenceRequest(row) {
    if (!row) return null;
    return {
      id: row.id, ownerId: row.owner_id, restrictedSessionId: row.restricted_session_id,
      sessionId: row.session_id, hazardId: row.hazard_id, status: row.status,
      createdAt: row.created_at, expiresAt: row.expires_at, completedAt: row.completed_at,
      cancelledAt: row.cancelled_at, attachedAt: row.attached_at, uploadId: row.upload_id,
      sourceCategory: row.source_category, provider: row.provider,
      nativeReadyAt: row.native_ready_at, supersededAt: row.superseded_at,
      supersededByRequestId: row.superseded_by_request_id,
      hazardTitle: row.hazard_title, hazardLocation: row.hazard_location,
      taskName: row.task_name, siteName: row.site_name, siteArea: row.site_area,
      upload: row.upload_id ? { id: row.upload_id, mimeType: row.upload_mime_type, size: row.upload_size_bytes,
        uploadedAt: row.upload_uploaded_at, source: row.upload_source } : null
    };
  }

  function cleanupExpiredEvidenceRequests() {
    return transaction(() => {
      const currentTime = now();
      const rows = db.prepare("SELECT * FROM evidence_requests WHERE status = 'pending' AND expires_at <= ?").all(currentTime);
      for (const row of rows) {
        db.prepare("UPDATE evidence_requests SET status = 'expired' WHERE id = ? AND status = 'pending'").run(row.id);
        db.prepare("UPDATE native_capture_claims SET status = 'released', updated_at = ? WHERE request_id = ? AND status IN ('claimed','capturing','captured','uploaded')")
          .run(currentTime, row.id);
        appendAuditEvent({ entityType: 'evidence_request', entityId: row.id, action: 'evidence_request.expired',
          actorUserId: row.owner_id, metadata: { sessionId: row.session_id, hazardId: row.hazard_id } });
      }
      return rows.length;
    });
  }

  function createEvidenceRequest(record) {
    cleanupExpiredEvidenceRequests();
    return transaction(() => {
      const scoped = db.prepare(`SELECT h.id FROM hazards h
        JOIN tbm_sessions s ON s.id = h.session_id AND s.owner_id = h.owner_id
        JOIN glasses_sessions gs ON gs.id = ? AND gs.supervisor_user_id = h.owner_id
        WHERE h.id = ? AND h.session_id = ? AND h.owner_id = ? AND gs.revoked_at IS NULL AND gs.expires_at > ?
          AND ((gs.scope_type = 'tbm_session' AND gs.scope_session_id = h.session_id)
            OR (gs.scope_type = 'site' AND gs.scope_site_id = s.site_id))`)
        .get(record.restrictedSessionId, record.hazardId, record.sessionId, record.ownerId, now());
      if (!scoped) return null;
      const existing = db.prepare(`${evidenceRequestSelect} WHERE r.restricted_session_id = ? AND r.session_id = ? AND r.hazard_id = ? AND r.provider = ? AND r.status = 'pending' AND r.expires_at > ? ORDER BY r.created_at DESC LIMIT 1`)
        .get(record.restrictedSessionId, record.sessionId, record.hazardId, record.provider ?? null, now());
      if (existing) return { request: mapEvidenceRequest(existing), created: false };
      db.prepare(`INSERT INTO evidence_requests(id, owner_id, restricted_session_id, session_id, hazard_id, status, created_at, expires_at, provider)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`)
        .run(record.id, record.ownerId, record.restrictedSessionId, record.sessionId, record.hazardId, now(), record.expiresAt, record.provider ?? null);
      appendAuditEvent({ entityType: 'evidence_request', entityId: record.id, action: 'evidence_request.created',
        actorUserId: record.ownerId, metadata: { sessionId: record.sessionId, hazardId: record.hazardId, expiresAt: record.expiresAt } });
      return { request: mapEvidenceRequest(db.prepare(`${evidenceRequestSelect} WHERE r.id = ?`).get(record.id)), created: true };
    });
  }

  function getEvidenceRequestForGlasses(id, restrictedSessionId) {
    cleanupExpiredEvidenceRequests();
    return mapEvidenceRequest(db.prepare(`${evidenceRequestSelect} WHERE r.id = ? AND r.restricted_session_id = ?`).get(id, restrictedSessionId));
  }

  function listEvidenceRequestsForOwner(ownerId) {
    cleanupExpiredEvidenceRequests();
    return db.prepare(`${evidenceRequestSelect} WHERE r.owner_id = ? ORDER BY r.created_at DESC`).all(ownerId).map(mapEvidenceRequest);
  }

  function cancelEvidenceRequest(id, { ownerId = null, restrictedSessionId = null } = {}) {
    cleanupExpiredEvidenceRequests();
    return transaction(() => {
      const row = db.prepare(`SELECT * FROM evidence_requests WHERE id = ? AND ${restrictedSessionId ? 'restricted_session_id = ?' : 'owner_id = ?'}`)
        .get(id, restrictedSessionId ?? ownerId);
      if (!row) return null;
      if (row.status === 'cancelled') return { status: 'cancelled', idempotent: true };
      if (row.status !== 'pending') return { status: row.status, conflict: true };
      const cancelledAt = now();
      db.prepare("UPDATE evidence_requests SET status = 'cancelled', cancelled_at = ? WHERE id = ? AND status = 'pending'").run(cancelledAt, id);
      db.prepare("UPDATE native_capture_claims SET status = 'released', updated_at = ? WHERE request_id = ? AND status IN ('claimed','capturing','captured','uploaded')")
        .run(cancelledAt, id);
      appendAuditEvent({ entityType: 'evidence_request', entityId: id, action: 'evidence_request.cancelled',
        actorUserId: row.owner_id, metadata: { sessionId: row.session_id, hazardId: row.hazard_id } });
      return { status: 'cancelled', cancelledAt };
    });
  }

  function completeEvidenceRequest({ id, ownerId, uploadId, provider, sourceCategory }) {
    cleanupExpiredEvidenceRequests();
    return transaction(() => {
      const row = db.prepare('SELECT * FROM evidence_requests WHERE id = ? AND owner_id = ?').get(id, ownerId);
      if (!row) return null;
      if (row.status === 'completed') return row.upload_id === uploadId && row.provider === provider
        ? { request: mapEvidenceRequest(db.prepare(`${evidenceRequestSelect} WHERE r.id = ?`).get(id)), idempotent: true }
        : { conflict: true, status: row.status };
      if (row.status !== 'pending') return { conflict: true, status: row.status };
      const valid = db.prepare(`SELECT e.id FROM evidence_uploads e JOIN hazards h ON h.id = ? AND h.session_id = ? AND h.owner_id = ?
        WHERE e.id = ? AND e.owner_id = ?`).get(row.hazard_id, row.session_id, ownerId, uploadId, ownerId);
      if (!valid) return { inaccessible: true };
      const completedAt = now();
      db.prepare(`UPDATE evidence_requests SET status = 'completed', completed_at = ?, upload_id = ?, provider = ?, source_category = ? WHERE id = ? AND status = 'pending'`)
        .run(completedAt, uploadId, provider, sourceCategory, id);
      appendAuditEvent({ entityType: 'evidence_request', entityId: id, action: 'evidence_request.upload_completed', actorUserId: ownerId,
        metadata: { sessionId: row.session_id, hazardId: row.hazard_id, uploadId, provider } });
      return { request: mapEvidenceRequest(db.prepare(`${evidenceRequestSelect} WHERE r.id = ?`).get(id)), idempotent: false };
    });
  }

  function attachEvidenceRequest(id, restrictedSessionId) {
    cleanupExpiredEvidenceRequests();
    return transaction(() => {
      const row = db.prepare('SELECT * FROM evidence_requests WHERE id = ? AND restricted_session_id = ?').get(id, restrictedSessionId);
      if (!row) return null;
      if (row.status !== 'completed' || row.superseded_at) return { conflict: true, status: row.superseded_at ? 'superseded' : row.status };
      if (!row.attached_at) {
        const position = db.prepare('SELECT COALESCE(MAX(position) + 1, 0) AS position FROM hazard_evidence WHERE hazard_id = ?').get(row.hazard_id).position;
        db.prepare('INSERT OR IGNORE INTO hazard_evidence(hazard_id, upload_id, owner_id, position) VALUES (?, ?, ?, ?)').run(row.hazard_id, row.upload_id, row.owner_id, position);
        db.prepare('UPDATE evidence_requests SET attached_at = ? WHERE id = ? AND attached_at IS NULL').run(now(), id);
        appendAuditEvent({ entityType: 'evidence_request', entityId: id, action: 'evidence_request.evidence_attached', actorUserId: row.owner_id,
          metadata: { sessionId: row.session_id, hazardId: row.hazard_id, uploadId: row.upload_id } });
      }
      return { request: mapEvidenceRequest(db.prepare(`${evidenceRequestSelect} WHERE r.id = ?`).get(id)), idempotent: Boolean(row.attached_at) };
    });
  }

  function createNativeDeviceRegistration(record) {
    return transaction(() => {
      db.prepare(`INSERT INTO native_device_registrations(id, owner_id, device_name, code_digest, created_at, expires_at, max_attempts)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(record.id, record.ownerId, record.deviceName, record.codeDigest, now(), record.expiresAt, record.maxAttempts);
      appendAuditEvent({ entityType: 'native_device_registration', entityId: record.id, action: 'native_device.registration_created',
        actorUserId: record.ownerId, metadata: { expiresAt: record.expiresAt } });
      return { id: record.id, deviceName: record.deviceName, expiresAt: record.expiresAt, status: 'pending' };
    });
  }

  function redeemNativeDeviceRegistration({ codeDigest, deviceId, credentialDigest }) {
    return transaction(() => {
      const currentTime = now();
      const row = db.prepare('SELECT * FROM native_device_registrations WHERE code_digest = ?').get(codeDigest);
      if (!row || row.redeemed_at || row.expires_at <= currentTime || row.failed_attempts >= row.max_attempts) return null;
      const changed = db.prepare(`UPDATE native_device_registrations SET redeemed_at = ?
        WHERE id = ? AND redeemed_at IS NULL AND expires_at > ? AND failed_attempts < max_attempts`).run(currentTime, row.id, currentTime);
      if (changed.changes !== 1) return null;
      db.prepare(`INSERT INTO native_devices(id, owner_id, name, credential_digest, created_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(deviceId, row.owner_id, row.device_name, credentialDigest, currentTime, currentTime);
      appendAuditEvent({ entityType: 'native_device', entityId: deviceId, action: 'native_device.registered',
        actorUserId: row.owner_id, metadata: { registrationId: row.id } });
      return { id: deviceId, ownerId: row.owner_id, name: row.device_name, createdAt: currentTime, lastSeenAt: currentTime };
    });
  }

  function recordNativeRegistrationFailure(identifier, codeDigest = null) {
    if (codeDigest) db.prepare(`UPDATE native_device_registrations SET failed_attempts = failed_attempts + 1
      WHERE code_digest = ? AND redeemed_at IS NULL AND expires_at > ? AND failed_attempts < max_attempts`).run(codeDigest, now());
    appendAuditEvent({ entityType: 'native_device_registration', entityId: deterministicId(identifier, now()),
      action: 'native_device.registration_failed', metadata: { reason: 'invalid_or_expired' } });
  }

  function listNativeDevicesForOwner(ownerId) {
    return db.prepare('SELECT id, name, created_at, last_seen_at, revoked_at FROM native_devices WHERE owner_id = ? ORDER BY created_at DESC')
      .all(ownerId).map((row) => ({ id: row.id, name: row.name, createdAt: row.created_at, lastSeenAt: row.last_seen_at, revokedAt: row.revoked_at }));
  }

  function revokeNativeDevice(id, ownerId) {
    return transaction(() => {
      const revokedAt = now();
      const changed = db.prepare('UPDATE native_devices SET revoked_at = ? WHERE id = ? AND owner_id = ? AND revoked_at IS NULL').run(revokedAt, id, ownerId);
      if (changed.changes !== 1) return false;
      db.prepare("UPDATE native_capture_claims SET status = 'released', updated_at = ? WHERE device_id = ? AND status IN ('claimed','capturing','captured','uploaded')").run(revokedAt, id);
      appendAuditEvent({ entityType: 'native_device', entityId: id, action: 'native_device.revoked', actorUserId: ownerId });
      return true;
    });
  }

  function authenticateNativeDevice(id, credentialDigest) {
    return transaction(() => {
      const row = db.prepare('SELECT * FROM native_devices WHERE id = ? AND credential_digest = ? AND revoked_at IS NULL').get(id, credentialDigest);
      if (!row) return null;
      const seenAt = now();
      db.prepare('UPDATE native_devices SET last_seen_at = ? WHERE id = ?').run(seenAt, id);
      appendAuditEvent({ entityType: 'native_device', entityId: id, action: 'native_device.used', actorUserId: row.owner_id });
      return { id: row.id, ownerId: row.owner_id, name: row.name, createdAt: row.created_at, lastSeenAt: seenAt };
    });
  }

  function hasActiveNativeDevice(ownerId, seenAfter = null) {
    return Boolean(db.prepare(`SELECT 1 FROM native_devices WHERE owner_id = ? AND revoked_at IS NULL
      AND (? IS NULL OR last_seen_at >= ?) LIMIT 1`).get(ownerId, seenAfter, seenAfter));
  }

  function markNativeEvidenceRequestReady(id, restrictedSessionId, seenAfter = null) {
    cleanupExpiredEvidenceRequests();
    return transaction(() => {
      const row = db.prepare(`SELECT * FROM evidence_requests WHERE id = ? AND restricted_session_id = ?
        AND provider = 'native_dat_camera' AND status = 'pending' AND superseded_at IS NULL`).get(id, restrictedSessionId);
      if (!row) return null;
      if (!hasActiveNativeDevice(row.owner_id, seenAfter)) return { unavailable: true };
      const readyAt = row.native_ready_at ?? now();
      db.prepare('UPDATE evidence_requests SET native_ready_at = ? WHERE id = ? AND native_ready_at IS NULL').run(readyAt, id);
      appendAuditEvent({ entityType: 'evidence_request', entityId: id, action: 'evidence_request.native_capture_confirmed',
        actorUserId: row.owner_id, metadata: { sessionId: row.session_id, hazardId: row.hazard_id } });
      return mapEvidenceRequest(db.prepare(`${evidenceRequestSelect} WHERE r.id = ?`).get(id));
    });
  }

  function nextNativeCaptureRequest(device) {
    cleanupExpiredEvidenceRequests();
    const currentTime = now();
    return mapEvidenceRequest(db.prepare(`${evidenceRequestSelect}
      WHERE r.owner_id = ? AND r.provider = 'native_dat_camera' AND r.status = 'pending'
        AND r.native_ready_at IS NOT NULL AND r.superseded_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM native_capture_claims c WHERE c.request_id = r.id
          AND c.status IN ('claimed','capturing','captured','uploaded') AND c.lease_expires_at > ?)
      ORDER BY r.native_ready_at, r.created_at LIMIT 1`).get(device.ownerId, currentTime));
  }

  function claimNativeCaptureRequest({ requestId, device, leaseExpiresAt }) {
    cleanupExpiredEvidenceRequests();
    return transaction(() => {
      const currentTime = now();
      const requestRow = db.prepare(`SELECT * FROM evidence_requests WHERE id = ? AND owner_id = ?
        AND provider = 'native_dat_camera' AND status = 'pending' AND native_ready_at IS NOT NULL
        AND superseded_at IS NULL AND expires_at > ?`).get(requestId, device.ownerId, currentTime);
      if (!requestRow) return null;
      const existing = db.prepare('SELECT * FROM native_capture_claims WHERE request_id = ?').get(requestId);
      if (existing && existing.status !== 'released' && existing.status !== 'failed' && existing.lease_expires_at > currentTime) {
        return existing.device_id === device.id ? { claimed: true, idempotent: true } : { conflict: true };
      }
      db.prepare(`INSERT INTO native_capture_claims(request_id, owner_id, device_id, status, claimed_at, lease_expires_at, updated_at)
        VALUES (?, ?, ?, 'claimed', ?, ?, ?)
        ON CONFLICT(request_id) DO UPDATE SET owner_id=excluded.owner_id, device_id=excluded.device_id, status='claimed',
          claimed_at=excluded.claimed_at, lease_expires_at=excluded.lease_expires_at, updated_at=excluded.updated_at,
          failure_code=NULL, upload_id=NULL`)
        .run(requestId, device.ownerId, device.id, currentTime, leaseExpiresAt, currentTime);
      appendAuditEvent({ entityType: 'evidence_request', entityId: requestId, action: 'evidence_request.native_claimed',
        actorUserId: device.ownerId, metadata: { deviceId: device.id, leaseExpiresAt } });
      return { claimed: true, idempotent: false };
    });
  }

  function getNativeClaim(requestId, device) {
    const row = db.prepare(`SELECT c.*, r.status AS request_status, r.expires_at, r.superseded_at
      FROM native_capture_claims c JOIN evidence_requests r ON r.id = c.request_id AND r.owner_id = c.owner_id
      WHERE c.request_id = ? AND c.device_id = ? AND c.owner_id = ?`).get(requestId, device.id, device.ownerId);
    if (!row || row.request_status !== 'pending' || row.superseded_at || row.expires_at <= now() || row.lease_expires_at <= now()) return null;
    return row;
  }

  function updateNativeClaim(requestId, device, status, failureCode = null, leaseExpiresAt = null) {
    return transaction(() => {
      const row = getNativeClaim(requestId, device);
      if (!row) return null;
      const allowed = { claimed: ['capturing','failed','released'], capturing: ['captured','failed','released'], captured: ['uploaded','failed','released'], uploaded: ['failed','released'] };
      if (!allowed[row.status]?.includes(status)) return { conflict: true, status: row.status };
      db.prepare('UPDATE native_capture_claims SET status = ?, failure_code = ?, updated_at = ?, lease_expires_at = COALESCE(?, lease_expires_at) WHERE request_id = ?')
        .run(status, failureCode, now(), leaseExpiresAt, requestId);
      return { status };
    });
  }

  function setNativeClaimUpload(requestId, device, uploadId) {
    return transaction(() => {
      const row = getNativeClaim(requestId, device);
      if (!row || !['captured','uploaded'].includes(row.status)) return null;
      if (row.upload_id) return row.upload_id === uploadId ? { idempotent: true } : { conflict: true };
      const upload = db.prepare('SELECT id FROM evidence_uploads WHERE id = ? AND owner_id = ?').get(uploadId, device.ownerId);
      if (!upload) return null;
      db.prepare("UPDATE native_capture_claims SET status = 'uploaded', upload_id = ?, updated_at = ? WHERE request_id = ?").run(uploadId, now(), requestId);
      return { idempotent: false };
    });
  }

  function completeNativeCapture(requestId, device, uploadId) {
    return transaction(() => {
      const row = db.prepare('SELECT * FROM evidence_requests WHERE id = ? AND owner_id = ?').get(requestId, device.ownerId);
      if (!row) return null;
      const storedClaim = db.prepare('SELECT * FROM native_capture_claims WHERE request_id = ? AND device_id = ? AND owner_id = ?').get(requestId, device.id, device.ownerId);
      if (!storedClaim) return null;
      if (row.status === 'completed') return storedClaim?.upload_id === uploadId && row.upload_id === uploadId
        ? { request: mapEvidenceRequest(db.prepare(`${evidenceRequestSelect} WHERE r.id = ?`).get(requestId)), idempotent: true }
        : { conflict: true };
      const claim = getNativeClaim(requestId, device);
      if (!claim || claim.status !== 'uploaded' || claim.upload_id !== uploadId) return null;
      if (row.status !== 'pending' || row.superseded_at) return { conflict: true };
      const completedAt = now();
      db.prepare(`UPDATE evidence_requests SET status='completed', completed_at=?, upload_id=?, provider='native_dat_camera', source_category='future_native_glasses_camera'
        WHERE id=? AND status='pending'`).run(completedAt, uploadId, requestId);
      appendAuditEvent({ entityType: 'evidence_request', entityId: requestId, action: 'evidence_request.upload_completed', actorUserId: device.ownerId,
        metadata: { sessionId: row.session_id, hazardId: row.hazard_id, uploadId, provider: 'native_dat_camera', deviceId: device.id } });
      return { request: mapEvidenceRequest(db.prepare(`${evidenceRequestSelect} WHERE r.id = ?`).get(requestId)), idempotent: false };
    });
  }

  function supersedeNativeEvidenceRequest(id, restrictedSessionId, replacement) {
    return transaction(() => {
      const row = db.prepare(`SELECT * FROM evidence_requests WHERE id=? AND restricted_session_id=? AND provider='native_dat_camera'
        AND status='completed' AND attached_at IS NULL AND superseded_at IS NULL`).get(id, restrictedSessionId);
      if (!row || !hasActiveNativeDevice(row.owner_id)) return null;
      const currentTime = now();
      db.prepare(`INSERT INTO evidence_requests(id, owner_id, restricted_session_id, session_id, hazard_id, status, created_at, expires_at, provider)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, 'native_dat_camera')`)
        .run(replacement.id, row.owner_id, restrictedSessionId, row.session_id, row.hazard_id, currentTime, replacement.expiresAt);
      db.prepare('UPDATE evidence_requests SET superseded_at=?, superseded_by_request_id=? WHERE id=?').run(currentTime, replacement.id, id);
      appendAuditEvent({ entityType: 'evidence_request', entityId: id, action: 'evidence_request.superseded', actorUserId: row.owner_id,
        metadata: { replacementRequestId: replacement.id, sessionId: row.session_id, hazardId: row.hazard_id } });
      return mapEvidenceRequest(db.prepare(`${evidenceRequestSelect} WHERE r.id=?`).get(replacement.id));
    });
  }

  return {
    raw: db,
    close: () => db.close(),
    transaction,
    appendAuditEvent,
    verifyAuditIntegrity,
    createUser,
    findUserByEmail,
    findUserById,
    listUsers,
    createEvidenceUploads,
    getUploadForOwner,
    getUploadsForOwner,
    listAbandonedUploadsBefore,
    deleteAbandonedUpload,
    deactivateUser,
    readinessCheck,
    createAiAnalysis,
    getAiAnalysisForOwner,
    reviewAiAnalysis,
    getSessionOwner,
    saveSession,
    listSessionsForOwner,
    getSessionForOwner,
    getClientOperation,
    recordClientOperation,
    listPairingScopes,
    createGlassesPairing,
    getGlassesPairingForOwner,
    cancelGlassesPairing,
    redeemGlassesPairing,
    recordUnknownPairingFailure,
    getGlassesSession,
    revokeGlassesSessionForPairing,
    cleanupExpiredGlassesPairings,
    createEvidenceRequest,
    getEvidenceRequestForGlasses,
    listEvidenceRequestsForOwner,
    cancelEvidenceRequest,
    completeEvidenceRequest,
    attachEvidenceRequest,
    cleanupExpiredEvidenceRequests,
    createNativeDeviceRegistration,
    redeemNativeDeviceRegistration,
    recordNativeRegistrationFailure,
    listNativeDevicesForOwner,
    revokeNativeDevice,
    authenticateNativeDevice,
    hasActiveNativeDevice,
    markNativeEvidenceRequestReady,
    nextNativeCaptureRequest,
    claimNativeCaptureRequest,
    getNativeClaim,
    updateNativeClaim,
    setNativeClaimUpload,
    completeNativeCapture,
    supersedeNativeEvidenceRequest,
    hasLegacyImport,
    recordLegacyImport
  };
}
