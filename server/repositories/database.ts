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

  function createEvidenceUploads(records, actorUserId) {
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
          'browser_file_picker'
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
        AND NOT EXISTS (SELECT 1 FROM ai_analyses WHERE upload_id = ?)`)
        .run(uploadId, uploadId, uploadId, uploadId).changes === 1;
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
    hasLegacyImport,
    recordLegacyImport
  };
}
