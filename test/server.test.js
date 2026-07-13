import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { afterEach, beforeEach, describe } from 'node:test';
import request from 'supertest';
import { createApp, renderSessionReport } from '../server.ts';

const REGISTRATION_KEY = 'test-registration-key';
const SESSION_SECRET = 'test-session-secret';
const PASSWORD = 'correct-horse-battery-staple';
const SESSION_TTL_MS = 60_000;
const VALID_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nKsAAAAASUVORK5CYII=',
  'base64'
);

let sandboxDir;
let dataDir;
let uploadsDir;
let app;
let server;
let currentTime;

async function closeServer() {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  app?.locals?.closeDatabase?.();
}

beforeEach(async () => {
  sandboxDir = await mkdtemp(path.join(tmpdir(), 'safety-lens-test-'));
  dataDir = path.join(sandboxDir, 'data');
  uploadsDir = path.join(sandboxDir, 'uploads');
  currentTime = Date.parse('2026-07-10T00:00:00.000Z');
  app = createApp({
    dataDir,
    uploadsDir,
    registrationKey: REGISTRATION_KEY,
    sessionSecret: SESSION_SECRET,
    sessionTtlMs: SESSION_TTL_MS,
    now: () => currentTime,
    aiMode: 'mock'
  });
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
});

afterEach(async () => {
  await closeServer();
  await rm(sandboxDir, { recursive: true, force: true });
});

async function register(agent, email = 'supervisor@example.com') {
  return agent.post('/api/auth/register').send({
    name: 'Test Supervisor',
    email,
    password: PASSWORD,
    role: 'supervisor',
    registrationKey: REGISTRATION_KEY
  });
}

async function uploadPng(agent, filename = 'evidence.png') {
  return agent.post('/api/uploads').attach('photos', VALID_PNG, { filename, contentType: 'image/png' });
}

function validSession(sessionId = 'session-001') {
  return {
    sessionId,
    sessionType: 'tbm',
    site: { siteName: 'Test Site', siteArea: 'Test Area' },
    work: { taskName: 'Test Task' },
    supervisor: { name: 'Test Supervisor', role: 'supervisor' },
    workers: [{ id: 'worker-1', name: 'Worker One', present: true, acknowledged: false }],
    hazards: [{ id: 'hazard-1', title: 'Test Hazard', status: 'not_checked' }],
    nearMisses: []
  };
}

test('report rendering is independently callable without an HTTP request', () => {
  const html = renderSessionReport({
    ...validSession('direct-report'),
    sharing: { status: 'not_shared', method: '', recipients: '', acknowledgmentResults: '', sharedAt: null }
  });
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /Test Site/);
  assert.match(html, /direct-report/);
});

describe('authentication', () => {
  test('rejects unauthenticated API access', async () => {
    const response = await request(server).get('/api/sessions');

    assert.equal(response.status, 401);
    assert.match(response.body.error, /log in/i);
  });

  test('registers with the configured registration key', async () => {
    const response = await register(request.agent(server));

    assert.equal(response.status, 201);
    assert.equal(response.body.user.email, 'supervisor@example.com');
    assert.equal(response.body.user.passwordHash, undefined);

    const users = app.locals.database.listUsers();
    assert.equal(users.length, 1);
    assert.notEqual(users[0].passwordHash, PASSWORD);
  });

  test('logs in with the correct password and rejects an incorrect password', async () => {
    await register(request.agent(server));

    const successfulLogin = await request.agent(server).post('/api/auth/login').send({
      email: 'supervisor@example.com',
      password: PASSWORD
    });
    const rejectedLogin = await request.agent(server).post('/api/auth/login').send({
      email: 'supervisor@example.com',
      password: 'incorrect-password'
    });

    assert.equal(successfulLogin.status, 200);
    assert.equal(successfulLogin.body.user.email, 'supervisor@example.com');
    assert.equal(rejectedLogin.status, 401);
    assert.match(rejectedLogin.body.error, /invalid email or password/i);
  });

  test('uses the same login error for unknown accounts and incorrect passwords', async () => {
    await register(request.agent(server));

    const unknownAccount = await request.agent(server).post('/api/auth/login').send({
      email: 'missing@example.com',
      password: 'incorrect-password'
    });
    const incorrectPassword = await request.agent(server).post('/api/auth/login').send({
      email: 'supervisor@example.com',
      password: 'incorrect-password'
    });

    assert.equal(unknownAccount.status, 401);
    assert.equal(incorrectPassword.status, 401);
    assert.deepEqual(unknownAccount.body, incorrectPassword.body);
  });

  test('rejects expired authentication cookies server-side', async () => {
    const agent = request.agent(server);
    assert.equal((await register(agent)).status, 201);
    assert.equal((await agent.get('/api/auth/me')).status, 200);

    currentTime += SESSION_TTL_MS + 1;

    assert.equal((await agent.get('/api/auth/me')).status, 401);
    assert.equal((await agent.get('/api/sessions')).status, 401);
  });

  test('rate limits repeated login attempts', async () => {
    const agent = request.agent(server);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal(
        (await agent.post('/api/auth/login').send({ email: 'missing@example.com', password: PASSWORD })).status,
        401
      );
    }

    const limited = await agent.post('/api/auth/login').send({ email: 'missing@example.com', password: PASSWORD });

    assert.equal(limited.status, 429);
    assert.match(limited.body.error, /too many authentication attempts/i);
    assert.ok(limited.headers['retry-after']);
  });

  test('rate limits repeated registration attempts', async () => {
    const agent = request.agent(server);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await agent.post('/api/auth/register').send({
        email: `attempt-${attempt}@example.com`,
        password: PASSWORD,
        registrationKey: 'wrong-key'
      });
      assert.equal(response.status, 403);
    }

    const limited = await agent.post('/api/auth/register').send({
      email: 'limited@example.com',
      password: PASSWORD,
      registrationKey: REGISTRATION_KEY
    });

    assert.equal(limited.status, 429);
  });

  test('requires a strong non-default session secret in production', () => {
    assert.throws(
      () =>
        createApp({
          dataDir,
          uploadsDir,
          registrationKey: REGISTRATION_KEY,
          sessionSecret: 'change-me-session-secret',
          nodeEnv: 'production'
        }),
      /SESSION_SECRET/
    );
  });

  test('sets Secure, HttpOnly, and SameSite cookies in production', async () => {
    await closeServer();
    app = createApp({
      dataDir,
      uploadsDir,
      registrationKey: REGISTRATION_KEY,
      sessionSecret: 'production-session-secret-with-more-than-32-characters',
      nodeEnv: 'production',
      now: () => currentTime
    });
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const response = await register(request.agent(server), 'secure-cookie@example.com');
    const cookie = response.headers['set-cookie'][0];

    assert.equal(response.status, 201);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Secure/);
  });
});

describe('authenticated API', () => {
  test('replays duplicate session idempotency keys without duplicate writes', async () => {
    const agent = request.agent(server);
    await register(agent, 'offline-once@example.com');
    const payload = { ...validSession('offline-once'), operationType: 'session_upsert', baseRevision: 0 };
    const first = await agent.post('/api/sessions').set('Idempotency-Key', 'operation-once').send(payload);
    const duplicate = await agent.post('/api/sessions').set('Idempotency-Key', 'operation-once').send(payload);

    assert.equal(first.status, 201);
    assert.equal(duplicate.status, 201);
    assert.equal(first.body.revision, 1);
    assert.equal(duplicate.body.revision, 1);
    assert.equal(duplicate.headers['idempotent-replay'], 'true');
    assert.equal(app.locals.database.raw.prepare('SELECT COUNT(*) AS count FROM tbm_sessions WHERE id = ?').get('offline-once').count, 1);
    assert.equal(app.locals.database.raw.prepare('SELECT COUNT(*) AS count FROM client_operations').get().count, 1);
  });

  test('rejects a stale offline revision instead of silently overwriting newer server data', async () => {
    const agent = request.agent(server);
    await register(agent, 'offline-conflict@example.com');
    const original = validSession('offline-conflict');
    const created = await agent.post('/api/sessions').set('Idempotency-Key', 'conflict-create').send({
      ...original, operationType: 'session_upsert', baseRevision: 0
    });
    assert.equal(created.body.revision, 1);

    const serverUpdate = structuredClone(original);
    serverUpdate.work.taskName = 'Newer server task';
    const updated = await agent.post('/api/sessions').send(serverUpdate);
    assert.equal(updated.body.revision, 2);

    const stale = structuredClone(original);
    stale.work.taskName = 'Stale offline task';
    const conflict = await agent.post('/api/sessions').set('Idempotency-Key', 'conflict-stale').send({
      ...stale, operationType: 'hazard_review', baseRevision: 1
    });
    const read = await agent.get('/api/sessions/offline-conflict');
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.conflict.serverRevision, 2);
    assert.equal(read.body.work.taskName, 'Newer server task');
  });

  test('replays duplicate evidence idempotency keys without duplicate uploads', async () => {
    const agent = request.agent(server);
    await register(agent, 'offline-photo@example.com');
    const first = await agent.post('/api/uploads').set('Idempotency-Key', 'photo-once')
      .attach('photos', VALID_PNG, { filename: 'once.png', contentType: 'image/png' });
    const duplicate = await agent.post('/api/uploads').set('Idempotency-Key', 'photo-once')
      .attach('photos', VALID_PNG, { filename: 'once.png', contentType: 'image/png' });
    assert.equal(first.status, 201);
    assert.equal(duplicate.status, 201);
    assert.equal(duplicate.headers['idempotent-replay'], 'true');
    assert.equal(duplicate.body[0].id, first.body[0].id);
    assert.equal(app.locals.database.raw.prepare('SELECT COUNT(*) AS count FROM evidence_uploads').get().count, 1);
    assert.equal((await readdir(uploadsDir)).length, 1);
  });

  test('saves and retrieves a valid authenticated session', async () => {
    const agent = request.agent(server);
    assert.equal((await register(agent)).status, 201);

    const session = validSession();
    const saved = await agent.post('/api/sessions').send(session);
    const retrieved = await agent.get(`/api/sessions/${session.sessionId}`);

    assert.equal(saved.status, 201);
    assert.equal(saved.body.sessionId, session.sessionId);
    assert.equal(saved.body.createdBy.email, 'supervisor@example.com');
    assert.equal(retrieved.status, 200);
    assert.equal(retrieved.body.sessionId, session.sessionId);
    assert.equal(retrieved.body.workers[0].present, true);
    assert.equal(retrieved.body.workers[0].acknowledgment.supervisorRecorded, false);
  });

  test('concurrent saves do not lose independently created sessions', async () => {
    const agent = request.agent(server);
    await register(agent, 'concurrent@example.com');
    const sessionIds = Array.from({ length: 8 }, (_, index) => `concurrent-session-${index}`);

    const responses = await Promise.all(
      sessionIds.map((sessionId) => agent.post('/api/sessions').send(validSession(sessionId)))
    );
    const listed = await agent.get('/api/sessions');

    assert.ok(responses.every((response) => response.status === 201));
    assert.deepEqual(
      listed.body.map((session) => session.sessionId).sort(),
      sessionIds.sort()
    );
  });

  test('rejects invalid session payloads', async () => {
    const agent = request.agent(server);
    await register(agent);

    const response = await agent.post('/api/sessions').send({ sessionId: 'incomplete' });

    assert.equal(response.status, 400);
    assert.match(response.body.error, /missing required field/i);
  });

  test('rejects unsupported upload types without writing a file', async () => {
    const agent = request.agent(server);
    await register(agent);

    const response = await agent
      .post('/api/uploads')
      .attach('photos', Buffer.from('not an image'), { filename: 'evidence.txt', contentType: 'text/plain' });

    assert.equal(response.status, 400);
    assert.match(response.body.error, /only jpeg, png, and webp/i);
    assert.deepEqual(await readdir(uploadsDir), []);
  });

  test('rejects invalid image bytes even when the MIME type claims PNG', async () => {
    const agent = request.agent(server);
    await register(agent);

    const response = await agent
      .post('/api/uploads')
      .attach('photos', Buffer.from('not really a png'), { filename: 'fake.png', contentType: 'image/png' });

    assert.equal(response.status, 400);
    assert.match(response.body.error, /not a valid JPEG, PNG, or WebP/i);
    assert.deepEqual(await readdir(uploadsDir), []);
  });

  test('does not leave partially saved files when one upload in a batch is invalid', async () => {
    const agent = request.agent(server);
    await register(agent);

    const response = await agent
      .post('/api/uploads')
      .attach('photos', VALID_PNG, { filename: 'valid.png', contentType: 'image/png' })
      .attach('photos', Buffer.from('fake png'), { filename: 'invalid.png', contentType: 'image/png' });

    assert.equal(response.status, 400);
    assert.deepEqual(await readdir(uploadsDir), []);
  });

  test('rejects metadata without a valid owned upload ID', async () => {
    const agent = request.agent(server);
    await register(agent);

    const response = await agent.post('/api/ai/analyze-hazard').send({
      entryType: 'new_hazard',
      photos: [{ originalName: 'evidence.jpg', type: 'image/jpeg' }]
    });

    assert.equal(response.status, 400);
    assert.match(response.body.error, /uploadId/);
  });

  test('rejects an upload ID owned by another user', async () => {
    const owner = request.agent(server);
    const other = request.agent(server);
    await register(owner, 'analysis-owner@example.com');
    await register(other, 'analysis-other@example.com');
    const upload = (await uploadPng(owner)).body[0];
    const analysis = (await owner.post('/api/ai/analyze-hazard').send({ entryType: 'new_hazard', uploadId: upload.id })).body;

    const response = await other.post('/api/ai/analyze-hazard').send({ entryType: 'new_hazard', uploadId: upload.id });
    const review = await other.patch(`/api/ai/analyses/${analysis.analysisId}/review`).send({ decision: 'accepted' });

    assert.equal(response.status, 404);
    assert.deepEqual(response.body, { error: 'Resource not found.' });
    assert.equal(review.status, 404);
  });

  test('uses an owned validated upload for deterministic visibly simulated mock output', async () => {
    const agent = request.agent(server);
    await register(agent);
    const upload = (await uploadPng(agent)).body[0];
    const first = await agent.post('/api/ai/analyze-hazard').send({ entryType: 'new_hazard', uploadId: upload.id });
    const second = await agent.post('/api/ai/analyze-hazard').send({ entryType: 'new_hazard', uploadId: upload.id });

    assert.equal(first.status, 200);
    assert.deepEqual(first.body.suggestion, second.body.suggestion);
    assert.equal(first.body.mode, 'mock');
    assert.equal(first.body.provider, 'deterministic_fixture');
    assert.equal(first.body.modelVersion, 'fixture-v1');
    assert.equal(first.body.simulated, true);
    assert.equal(first.body.pixelInterpretation, false);
    assert.match(first.body.disclaimer, /pixels were not interpreted/i);
    assert.equal(first.body.requiresHumanReview, true);
    assert.equal(first.body.humanDecision, 'pending');
    assert.equal(first.body.uploadId, upload.id);
    assert.match(first.body.uploadHash, /^sha256:/);
    assert.equal(first.body.ownerId, undefined);
    assert.equal(first.body.filename, undefined);
    const stored = app.locals.database.raw.prepare('SELECT * FROM ai_analyses WHERE id = ?').get(first.body.analysisId);
    assert.equal(stored.upload_id, upload.id);
    assert.equal(stored.mode, 'mock');
    assert.equal(stored.provider, 'deterministic_fixture');
    assert.equal(stored.model_version, 'fixture-v1');
    assert.equal(stored.requested_at, '2026-07-10T00:00:00.000Z');
    assert.equal(stored.completed_at, '2026-07-10T00:00:00.000Z');
    assert.deepEqual(JSON.parse(stored.normalized_suggestion_json), first.body.suggestion);
  });

  test('records accepted, edited, and rejected human outcomes accurately', async () => {
    const agent = request.agent(server);
    await register(agent);
    const upload = (await uploadPng(agent)).body[0];
    const analyses = [];
    for (const entryType of ['new_hazard', 'new_hazard', 'near_miss']) {
      analyses.push((await agent.post('/api/ai/analyze-hazard').send({ entryType, uploadId: upload.id })).body);
    }
    const accepted = await agent.patch(`/api/ai/analyses/${analyses[0].analysisId}/review`).send({ decision: 'accepted' });
    const editedSuggestion = {
      title: 'Human-edited hazard', category: 'human_review', riskLevel: 'high',
      description: 'A person changed the normalized suggestion.', recommendedAction: 'Use the human-selected control.'
    };
    const edited = await agent.patch(`/api/ai/analyses/${analyses[1].analysisId}/review`)
      .send({ decision: 'edited', editedSuggestion });
    const rejected = await agent.patch(`/api/ai/analyses/${analyses[2].analysisId}/review`).send({ decision: 'rejected' });

    assert.equal(accepted.body.humanDecision, 'accepted');
    assert.equal(edited.body.humanDecision, 'edited');
    assert.deepEqual({ ...edited.body.editedSuggestion, confidence: undefined }, { ...editedSuggestion, confidence: undefined });
    assert.equal(rejected.body.humanDecision, 'rejected');
    for (const result of [accepted.body, edited.body, rejected.body]) {
      assert.equal(result.reviewer, 'Test Supervisor');
      assert.equal(result.reviewedAt, '2026-07-10T00:00:00.000Z');
    }
  });

  test('AI output cannot bypass hazard review or finalization rules', async () => {
    const agent = request.agent(server);
    await register(agent);
    const upload = (await uploadPng(agent)).body[0];
    const analysis = (await agent.post('/api/ai/analyze-hazard').send({ entryType: 'new_hazard', uploadId: upload.id })).body;
    const session = validSession('ai-cannot-finalize');
    session.hazards[0].aiSuggestion = analysis;
    session.hazards[0].evidencePhotos = [upload];

    const response = await agent.post('/api/sessions').send({ ...session, saveMode: 'finalize' });

    assert.equal(response.status, 400);
    assert.ok(response.body.blockers.some((blocker) => blocker.includes('has not been reviewed')));
    assert.equal(analysis.suggestion.status, undefined);
  });

  test('reports AI origin separately from the final human decision', async () => {
    const agent = request.agent(server);
    await register(agent);
    const upload = (await uploadPng(agent)).body[0];
    const analysis = (await agent.post('/api/ai/analyze-hazard').send({ entryType: 'new_hazard', uploadId: upload.id })).body;
    const editedSuggestion = {
      title: 'Human report title', category: 'human_review', riskLevel: 'medium',
      description: 'Human reviewed description', recommendedAction: 'Human reviewed action'
    };
    const review = (await agent.patch(`/api/ai/analyses/${analysis.analysisId}/review`)
      .send({ decision: 'edited', editedSuggestion })).body;
    const session = validSession('ai-report-separation');
    session.hazards[0].aiSuggestion = { ...analysis, ...review, edited: true };
    assert.equal((await agent.post('/api/sessions').send(session)).status, 201);

    const report = await agent.get('/api/sessions/ai-report-separation/report?lang=ko');

    assert.equal(report.status, 200);
    assert.match(report.text, /시뮬레이션된 모의 제안/);
    assert.match(report.text, /이미지 픽셀을 해석하지 않음/);
    assert.match(report.text, /최종 사람 결정/);
    assert.match(report.text, /수정 후 사용/);
    assert.match(report.text, /제안 원문 항목명/);
    assert.match(report.text, /사람이 확정한 항목명/);
  });

  test('provider failures retain the original evidence and draft', async () => {
    await closeServer();
    app = createApp({
      dataDir, uploadsDir, registrationKey: REGISTRATION_KEY, sessionSecret: SESSION_SECRET,
      now: () => currentTime,
      analysisProvider: { async analyze() { throw new Error('provider unavailable'); } }
    });
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const agent = request.agent(server);
    await register(agent);
    assert.equal((await agent.post('/api/sessions').send(validSession('provider-failure-draft'))).status, 201);
    const upload = (await uploadPng(agent, 'provider-failure.png')).body[0];

    const response = await agent.post('/api/ai/analyze-hazard').send({ entryType: 'new_hazard', uploadId: upload.id });

    assert.equal(response.status, 502);
    assert.match(response.body.error, /evidence was retained/i);
    assert.equal((await agent.get(`/api/uploads/${upload.id}`)).status, 200);
    assert.equal((await agent.get('/api/sessions/provider-failure-draft')).status, 200);
    assert.equal((await readdir(uploadsDir)).length, 1);
  });

  test('rejects finalization when hazards are unchecked and sharing is not recorded', async () => {
    const agent = request.agent(server);
    await register(agent);

    const response = await agent.post('/api/sessions').send({ ...validSession(), saveMode: 'finalize' });

    assert.equal(response.status, 400);
    assert.equal(response.body.error, 'Session cannot be finalized.');
    assert.ok(response.body.blockers.some((blocker) => blocker.includes('has not been reviewed')));
    assert.ok(response.body.blockers.some((blocker) => blocker.includes('whether TBM results were shared')));
  });

  test('rejects finalization when an action-required hazard lacks required corrective-action fields', async () => {
    const agent = request.agent(server);
    await register(agent);
    const session = validSession();
    session.hazards[0].status = 'action_required';
    session.sharing = { status: 'not_shared' };

    const response = await agent.post('/api/sessions').send({ ...session, saveMode: 'finalize' });

    assert.equal(response.status, 400);
    assert.ok(response.body.blockers.some((blocker) => blocker.includes('immediate control')));
    assert.ok(response.body.blockers.some((blocker) => blocker.includes('assigned person')));
  });

  test('rejects finalization when sharing evidence omits method or recipients', async () => {
    const agent = request.agent(server);
    await register(agent);
    const session = validSession();
    session.hazards[0].status = 'controlled';
    session.sharing = { status: 'shared' };

    const response = await agent.post('/api/sessions').send({ ...session, saveMode: 'finalize' });

    assert.equal(response.status, 400);
    assert.ok(response.body.blockers.some((blocker) => blocker.includes('Sharing method')));
    assert.ok(response.body.blockers.some((blocker) => blocker.includes('Sharing recipients')));
  });

  test('rejects finalization when verification is claimed without verifier evidence', async () => {
    const agent = request.agent(server);
    await register(agent);
    const session = validSession();
    session.hazards[0] = {
      ...session.hazards[0],
      status: 'action_required',
      correctiveAction: {
        immediateControl: 'Barricaded',
        assignedTo: 'Kim',
        dueAt: '2026-07-11T09:00',
        workStatus: 'stopped',
        verificationStatus: 'verified'
      }
    };
    session.sharing = { status: 'not_shared' };

    const response = await agent.post('/api/sessions').send({ ...session, saveMode: 'finalize' });

    assert.equal(response.status, 400);
    assert.ok(response.body.blockers.some((blocker) => blocker.includes('verifiedBy')));
    assert.ok(response.body.blockers.some((blocker) => blocker.includes('verifiedAt')));
  });

  test('records sharing time on the server and finalizes a fully controlled TBM', async () => {
    const agent = request.agent(server);
    await register(agent);
    const session = validSession();
    session.hazards[0].status = 'controlled';
    session.sharing = {
      status: 'shared',
      method: 'In-person briefing',
      recipients: 'Electrical crew',
      sharedAt: '2000-01-01T00:00:00.000Z',
      acknowledgmentResults: 'Two questions recorded'
    };

    const response = await agent.post('/api/sessions').send({ ...session, saveMode: 'finalize' });

    assert.equal(response.status, 201);
    assert.equal(response.body.status, 'completed');
    assert.ok(response.body.finalizedAt);
    assert.ok(response.body.completedAt);
    assert.notEqual(response.body.sharing.sharedAt, '2000-01-01T00:00:00.000Z');
    assert.equal(response.body.sharing.recipients, 'Electrical crew');
  });

  test('finalizes as actions_open without claiming completion when verification is open', async () => {
    const agent = request.agent(server);
    await register(agent);
    const session = validSession();
    session.hazards[0] = {
      ...session.hazards[0],
      status: 'action_required',
      correctiveAction: {
        immediateControl: 'Barricaded the opening',
        assignedTo: 'Kim',
        dueAt: '2026-07-11T09:00',
        workStatus: 'stopped',
        verificationStatus: 'open',
        closureEvidence: []
      }
    };
    session.sharing = { status: 'not_shared' };

    const response = await agent.post('/api/sessions').send({ ...session, saveMode: 'finalize' });

    assert.equal(response.status, 201);
    assert.equal(response.body.status, 'actions_open');
    assert.ok(response.body.finalizedAt);
    assert.equal(response.body.completedAt, null);
    assert.equal(response.body.hazards[0].correctiveAction.verificationStatus, 'open');
  });

  test('renders separate attendance, acknowledgment, corrective-action, and sharing report sections', async () => {
    const agent = request.agent(server);
    await register(agent);
    const session = validSession('report-session');
    session.workers[0] = {
      ...session.workers[0],
      acknowledgment: {
        supervisorRecorded: true,
        supervisorRecordedBy: 'Test Supervisor',
        supervisorRecordedAt: '2026-07-10T01:00:00.000Z',
        independentlyVerified: false,
        source: 'supervisor_recorded'
      }
    };
    session.hazards = [
      { id: 'controlled', title: 'Controlled access', status: 'controlled' },
      {
        id: 'open-action',
        title: 'Open action',
        status: 'action_required',
        correctiveAction: {
          immediateControl: 'Barricaded',
          assignedTo: 'Kim',
          dueAt: '2026-07-11T09:00',
          workStatus: 'stopped',
          verificationStatus: 'open'
        }
      }
    ];
    session.sharing = { status: 'not_shared' };
    assert.equal((await agent.post('/api/sessions').send({ ...session, saveMode: 'finalize' })).status, 201);

    const report = await agent.get('/api/sessions/report-session/report');

    assert.equal(report.status, 200);
    assert.match(report.text, /참석 근로자/);
    assert.match(report.text, /감독자 기록 TBM 확인/);
    assert.match(report.text, /독립적으로 검증된 근로자 확인/);
    assert.match(report.text, /통제 확인 항목/);
    assert.match(report.text, /미종결 시정조치/);
    assert.match(report.text, /검증 완료 시정조치/);
    assert.match(report.text, /미확인 항목/);
    assert.match(report.text, /근로자 공유 증빙/);
    assert.doesNotMatch(report.text, /Confirmed Hazards|Fix Ordered/);
  });

  test('prevents listing, reading, reporting, or overwriting another user\'s session', async () => {
    const firstUser = request.agent(server);
    const secondUser = request.agent(server);
    await register(firstUser, 'first@example.com');
    await register(secondUser, 'second@example.com');
    const secondUserSession = validSession('second-user-session');
    secondUserSession.work.taskName = 'Second user private task';
    assert.equal((await secondUser.post('/api/sessions').send(secondUserSession)).status, 201);

    const listResponse = await firstUser.get('/api/sessions');
    const detailResponse = await firstUser.get('/api/sessions/second-user-session');
    const reportResponse = await firstUser.get('/api/sessions/second-user-session/report');
    const overwriteResponse = await firstUser
      .post('/api/sessions')
      .send({ ...validSession('second-user-session'), createdBy: { id: 'forged' }, ownerId: 'forged' });
    const ownerRead = await secondUser.get('/api/sessions/second-user-session');

    assert.equal(listResponse.status, 200);
    assert.deepEqual(listResponse.body, []);
    assert.equal(detailResponse.status, 404);
    assert.deepEqual(detailResponse.body, { error: 'Resource not found.' });
    assert.equal(reportResponse.status, 404);
    assert.equal(overwriteResponse.status, 404);
    assert.deepEqual(overwriteResponse.body, { error: 'Resource not found.' });
    assert.equal(ownerRead.status, 200);
    assert.equal(ownerRead.body.work.taskName, 'Second user private task');
    assert.notEqual(ownerRead.body.ownerId, 'forged');
  });

  test('keeps uploaded evidence private and rejects foreign session references', async () => {
    const firstUser = request.agent(server);
    const secondUser = request.agent(server);
    await register(firstUser, 'first-photo@example.com');
    const secondRegistration = await register(secondUser, 'second-photo@example.com');

    const uploaded = await uploadPng(secondUser, 'private-evidence.png');
    assert.equal(uploaded.status, 201);
    const evidence = uploaded.body[0];
    assert.equal(evidence.url, `/api/uploads/${evidence.id}`);
    assert.equal(evidence.filename, undefined);

    const unauthenticatedRead = await request(server).get(evidence.url);
    const foreignRead = await firstUser.get(evidence.url);
    const ownerRead = await secondUser.get(evidence.url);
    const foreignSession = validSession('foreign-evidence-reference');
    foreignSession.hazards[0].evidencePhotos = [evidence];
    const foreignReference = await firstUser.post('/api/sessions').send(foreignSession);

    assert.equal(unauthenticatedRead.status, 401);
    assert.equal(foreignRead.status, 404);
    assert.deepEqual(foreignRead.body, { error: 'Resource not found.' });
    assert.equal(ownerRead.status, 200);
    assert.equal(ownerRead.headers['content-type'], 'image/png');
    assert.deepEqual(ownerRead.body, VALID_PNG);
    assert.equal(foreignReference.status, 400);
    assert.deepEqual(foreignReference.body, { error: 'Session contains inaccessible evidence.' });

    const uploadRecords = app.locals.database.raw.prepare('SELECT * FROM evidence_uploads').all();
    const oldPublicPathRead = await request(server).get(`/uploads/${uploadRecords[0].internal_filename}`);
    assert.equal(uploadRecords[0].owner_id, secondRegistration.body.user.id);
    assert.equal(uploadRecords[0].mime_type, 'image/png');
    assert.equal(uploadRecords[0].size_bytes, VALID_PNG.length);
    assert.match(uploadRecords[0].sha256_hash, /^sha256:[a-f0-9]{64}$/);
    assert.notEqual(uploadRecords[0].internal_filename, evidence.id);
    assert.equal(uploadRecords[0].internal_filename.includes('private-evidence.png'), false);
    assert.equal(oldPublicPathRead.status, 404);
  });

  test('allows an owner to save, list, read, update, report, and view owned evidence', async () => {
    const owner = request.agent(server);
    const registration = await register(owner, 'evidence-owner@example.com');
    assert.equal(registration.status, 201);
    const ownerId = registration.body.user.id;
    const uploaded = await uploadPng(owner);
    assert.equal(uploaded.status, 201);
    const evidence = uploaded.body[0];
    const session = validSession('owner-full-flow');
    session.hazards[0].evidencePhotos = [{ ...evidence, source: 'sdk_raw_camera' }];

    const saved = await owner.post('/api/sessions').send({ ...session, ownerId: 'client-forgery', createdBy: null });
    const listed = await owner.get('/api/sessions');
    const read = await owner.get('/api/sessions/owner-full-flow');
    session.work.taskName = 'Updated owner task';
    session.hazards[0].evidencePhotos = [evidence];
    const updated = await owner.post('/api/sessions').send({ ...session, ownerId: 'different-forgery' });
    const report = await owner.get('/api/sessions/owner-full-flow/report');
    const viewedEvidence = await owner.get(evidence.url);

    assert.equal(saved.status, 201);
    assert.equal(saved.body.ownerId, ownerId);
    assert.equal(saved.body.createdBy.id, ownerId);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.length, 1);
    assert.equal(read.status, 200);
    assert.equal(read.body.hazards[0].evidencePhotos[0].url, evidence.url);
    assert.equal(read.body.hazards[0].evidencePhotos[0].source, 'browser_file_picker');
    assert.equal(updated.status, 200);
    assert.equal(updated.body.ownerId, ownerId);
    assert.equal(updated.body.work.taskName, 'Updated owner task');
    assert.equal(report.status, 200);
    assert.match(report.text, new RegExp(`/api/uploads/${evidence.id}`));
    assert.equal(viewedEvidence.status, 200);
  });
});
