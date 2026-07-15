import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { afterEach, beforeEach, describe } from 'node:test';
import { openDatabase } from '../server/repositories/database.ts';
import { importLegacyJson } from '../scripts/import-json.mjs';

const MIGRATIONS_DIR = path.resolve('db/migrations');
const SERVER_TIME = '2026-07-10T08:00:00.000Z';
let sandboxDir;
let databasePath;
let database;

function user(id, email) {
  return {
    id,
    name: id,
    email,
    role: 'supervisor',
    passwordHash: '$2b$12$legacy.hash.value',
    createdAt: '2025-01-01T00:00:00.000Z'
  };
}

function session(sessionId, workerId = `${sessionId}-worker`) {
  return {
    schemaVersion: '2.0.0',
    sessionId,
    sessionType: 'korean_tbm_risk_assessment',
    site: { siteName: 'Test Site', siteArea: 'Area A', gps: {} },
    work: { taskName: 'Task', workType: 'TBM', plannedWorkDescription: 'Plan' },
    supervisor: { name: 'Supervisor', role: 'supervisor' },
    workers: [{ id: workerId, name: 'Worker', role: 'worker', present: true }],
    hazards: [{ id: 'hazard-1', title: 'Hazard', status: 'not_checked', evidencePhotos: [] }],
    nearMisses: [],
    sharing: { status: 'not_recorded' },
    device: { platform: 'test', appVersion: '1', inputMode: 'test' }
  };
}

beforeEach(async () => {
  sandboxDir = await mkdtemp(path.join(tmpdir(), 'safety-lens-db-test-'));
  databasePath = path.join(sandboxDir, 'safety-lens.sqlite');
  database = openDatabase({ databasePath, migrationsDir: MIGRATIONS_DIR, now: () => SERVER_TIME });
});

afterEach(async () => {
  try {
    database?.close();
  } catch {
    // A test may close the database before running the importer.
  }
  await rm(sandboxDir, { recursive: true, force: true });
});

describe('SQLite schema and ownership', () => {
  test('runs migrations with foreign keys enabled', () => {
    assert.equal(database.raw.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.deepEqual(
      database.raw.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row) => row.version),
      ['001_initial.sql', '002_offline_sync.sql', '003_ai_analyses.sql', '004_glasses_structured_records.sql', '005_pilot_retention.sql']
    );
    assert.equal(database.raw.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'ai_analyses'").get().count, 1);
    assert.ok(database.raw.prepare("PRAGMA table_info(tbm_sessions)").all().some((column) => column.name === 'attendance_expected_count'));
    assert.ok(database.raw.prepare("PRAGMA table_info(evidence_uploads)").all().some((column) => column.name === 'source_classification'));
  });

  test('enforces owner relationships through composite foreign keys', () => {
    database.createUser(user('owner-a', 'a@example.com'));
    database.createUser(user('owner-b', 'b@example.com'));
    database.saveSession(session('session-a', 'worker-a'), 'owner-a');
    database.saveSession(session('session-b', 'worker-b'), 'owner-b');

    assert.throws(
      () =>
        database.raw
          .prepare('INSERT INTO session_participants(session_id, worker_id, owner_id, position) VALUES (?, ?, ?, ?)')
          .run('session-a', 'worker-b', 'owner-a', 99),
      /FOREIGN KEY constraint failed/
    );
    assert.throws(
      () => database.saveSession(session('session-a'), 'owner-b'),
      (error) => error.code === 'NOT_FOUND'
    );
  });

  test('keeps creation immutable and generates authoritative state timestamps server-side', () => {
    database.close();
    let authoritativeTime = '2026-07-10T08:00:00.000Z';
    database = openDatabase({ databasePath, migrationsDir: MIGRATIONS_DIR, now: () => authoritativeTime });
    database.createUser(user('owner-a', 'a@example.com'));
    const firstInput = session('authoritative-session');
    firstInput.createdAt = '1999-01-01T00:00:00.000Z';
    firstInput.hazards[0].status = 'controlled';
    firstInput.hazards[0].humanReview = {
      reviewed: true,
      reviewedBy: 'Client label',
      reviewedAt: '2000-01-01T00:00:00.000Z'
    };
    firstInput.sharing = { status: 'not_shared' };
    const first = database.saveSession(firstInput, 'owner-a', { saveMode: 'finalize' });

    authoritativeTime = '2026-07-11T09:30:00.000Z';
    firstInput.work.taskName = 'Updated task';
    firstInput.savedAt = '2001-01-01T00:00:00.000Z';
    const second = database.saveSession(firstInput, 'owner-a', { saveMode: 'finalize' });

    assert.equal(first.serverCreatedAt, '2026-07-10T08:00:00.000Z');
    assert.equal(second.serverCreatedAt, first.serverCreatedAt);
    assert.equal(first.savedAt, '2026-07-10T08:00:00.000Z');
    assert.equal(second.savedAt, '2026-07-11T09:30:00.000Z');
    assert.equal(first.hazards[0].humanReview.reviewedAt, '2026-07-10T08:00:00.000Z');
    assert.equal(first.hazards[0].humanReview.clientObservedReviewedAt, '2000-01-01T00:00:00.000Z');
    assert.equal(second.finalizedAt, first.finalizedAt);
  });
});

describe('tamper-evident audit chain', () => {
  test('valid chains pass integrity verification and metadata excludes secrets', () => {
    database.createUser({ ...user('owner-a', 'a@example.com'), password: 'must-not-appear' });
    database.appendAuditEvent({
      entityType: 'test',
      entityId: 'entity-1',
      action: 'test.changed',
      actorUserId: 'owner-a',
      metadata: { password: 'secret', registrationKey: 'secret', safe: 'visible' }
    });

    const result = database.verifyAuditIntegrity();
    const metadata = database.raw.prepare('SELECT metadata_json FROM audit_events WHERE action = ?').get('test.changed');

    assert.equal(result.valid, true);
    assert.equal(result.checkedEvents, 2);
    assert.deepEqual(JSON.parse(metadata.metadata_json), { safe: 'visible' });
  });

  test('ordinary audit updates are forbidden and forced tampering breaks verification', () => {
    database.createUser(user('owner-a', 'a@example.com'));
    assert.throws(
      () => database.raw.prepare('UPDATE audit_events SET action = ?').run('tampered'),
      /audit events are append-only/
    );

    database.raw.exec('DROP TRIGGER audit_events_no_update');
    database.raw.prepare('UPDATE audit_events SET metadata_json = ? WHERE sequence = 1').run('{"tampered":true}');

    const result = database.verifyAuditIntegrity();
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'current hash mismatch');
  });
});

describe('legacy JSON importer', () => {
  test('backs up source JSON and can run twice without duplication', async () => {
    database.close();
    database = null;
    const dataDir = path.join(sandboxDir, 'legacy-data');
    await mkdir(dataDir, { recursive: true });
    const legacyUser = user('legacy-owner', 'legacy@example.com');
    const legacySession = { ...session('legacy-session'), createdBy: { id: legacyUser.id } };
    await writeFile(path.join(dataDir, 'users.json'), `${JSON.stringify([legacyUser], null, 2)}\n`);
    await writeFile(path.join(dataDir, 'sessions.json'), `${JSON.stringify([legacySession], null, 2)}\n`);

    const options = {
      databasePath,
      dataDir,
      migrationsDir: MIGRATIONS_DIR,
      now: () => SERVER_TIME
    };
    const first = await importLegacyJson(options);
    const second = await importLegacyJson(options);
    database = openDatabase({ databasePath, migrationsDir: MIGRATIONS_DIR, now: () => SERVER_TIME });

    assert.equal(first.users, 1);
    assert.equal(first.sessions, 1);
    assert.equal(second.users, 0);
    assert.equal(second.sessions, 0);
    assert.equal(database.listUsers().length, 1);
    assert.equal(database.listSessionsForOwner(legacyUser.id).length, 1);
    assert.equal(database.raw.prepare('SELECT COUNT(*) AS count FROM legacy_imports').get().count, 2);
    assert.deepEqual(JSON.parse(await readFile(path.join(first.backupDir, 'users.json'), 'utf8')), [legacyUser]);
  });
});
