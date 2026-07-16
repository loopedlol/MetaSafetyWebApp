import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { afterEach, beforeEach, describe } from 'node:test';
import request from 'supertest';
import { createApp } from '../server.ts';

const REGISTRATION_KEY = 'test-registration-key';
const SESSION_SECRET = 'test-session-secret';
const PASSWORD = 'correct-horse-battery-staple';
const VALID_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nKsAAAAASUVORK5CYII=', 'base64');

let root;
let app;
let server;
let currentTime;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'safety-lens-pairing-'));
  currentTime = Date.parse('2026-07-15T00:00:00.000Z');
  app = createApp({
    dataDir: path.join(root, 'data'), uploadsDir: path.join(root, 'uploads'),
    registrationKey: REGISTRATION_KEY, sessionSecret: SESSION_SECRET, now: () => currentTime,
    glassesPairingTtlMs: 300_000, glassesSessionTtlMs: 900_000,
    glassesPairingMaxAttempts: 3, glassesExchangeRateLimit: { windowMs: 60_000, max: 20 }
  });
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
});

afterEach(async () => {
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  app?.locals.closeDatabase();
  await rm(root, { recursive: true, force: true });
});

function session(id, siteName = 'Pilot Site') {
  return {
    sessionId: id, sessionType: 'tbm', site: { siteName, siteArea: 'Area A' },
    work: { taskName: `Task ${id}` }, supervisor: { name: 'Supervisor', role: 'supervisor' },
    workers: [], hazards: [{ id: `${id}-hazard`, title: 'Hazard', status: 'not_checked' }], nearMisses: []
  };
}

async function supervisorWithSession(id = 'tbm-1', email = 'supervisor@example.com') {
  const agent = request.agent(server);
  assert.equal((await agent.post('/api/auth/register').send({
    name: 'Supervisor', email, password: PASSWORD, role: 'supervisor', registrationKey: REGISTRATION_KEY
  })).status, 201);
  assert.equal((await agent.post('/api/sessions').send(session(id))).status, 201);
  return agent;
}

async function createPairing(agent, sessionId = 'tbm-1') {
  const result = await agent.post('/api/glasses-pairings').send({ scopeType: 'tbm_session', scopeId: sessionId });
  assert.equal(result.status, 201);
  return result.body;
}

async function registerNativeDevice(supervisor, name = 'Pilot Android') {
  const registration = await supervisor.post('/api/native-devices/registrations').send({ name });
  assert.equal(registration.status, 201);
  const exchange = await request(server).post('/api/native-devices/register').send({ code: registration.body.code });
  assert.equal(exchange.status, 200);
  return exchange.body;
}

describe('restricted glasses pairing', () => {
  test('requires supervisor authentication and offers only owned scopes', async () => {
    assert.equal((await request(server).post('/api/glasses-pairings').send({ scopeType: 'site', scopeId: 'x' })).status, 401);
    const supervisor = await supervisorWithSession();
    const scopes = await supervisor.get('/api/glasses-pairings/scopes');
    assert.equal(scopes.status, 200);
    assert.equal(scopes.body.sessions.length, 1);
    assert.equal(scopes.body.sessions[0].id, 'tbm-1');
  });

  test('stores no plaintext code, redeems once, and keeps code out of audit metadata', async () => {
    const supervisor = await supervisorWithSession();
    const created = await createPairing(supervisor);
    assert.match(created.code, /^\d{6}$/);
    assert.match(created.groupedCode, /^\d{3} \d{3}$/);

    const persisted = app.locals.database.raw.prepare('SELECT * FROM glasses_pairings WHERE id = ?').get(created.pairing.id);
    assert.notEqual(persisted.code_digest, created.code);
    assert.equal(JSON.stringify(persisted).includes(created.code), false);

    const glasses = request.agent(server);
    const exchange = await glasses.post('/api/glasses/pair').send({ code: created.code });
    assert.equal(exchange.status, 200);
    assert.match(exchange.headers['set-cookie'][0], /safety_lens_glasses=/);
    assert.match(exchange.headers['set-cookie'][0], /HttpOnly/);
    assert.match(exchange.headers['set-cookie'][0], /SameSite=Lax/);
    assert.equal((await request(server).post('/api/glasses/pair').send({ code: created.code })).status, 401);
    assert.equal((await glasses.get('/api/glasses/session')).status, 200);

    const audit = app.locals.database.raw.prepare('SELECT metadata_json FROM audit_events').all();
    assert.equal(JSON.stringify(audit).includes(created.code), false);
  });

  test('enforces TBM scope and blocks supervisor-only operations', async () => {
    const supervisor = await supervisorWithSession();
    assert.equal((await supervisor.post('/api/sessions').send(session('tbm-2', 'Other Site'))).status, 201);
    const created = await createPairing(supervisor);
    const glasses = request.agent(server);
    assert.equal((await glasses.post('/api/glasses/pair').send({ code: created.code })).status, 200);

    const list = await glasses.get('/api/sessions');
    assert.deepEqual(list.body.map((item) => item.sessionId), ['tbm-1']);
    assert.equal((await glasses.get('/api/sessions/tbm-2')).status, 404);
    assert.equal((await glasses.get('/api/sessions/tbm-2/report')).status, 404);
    assert.equal((await glasses.post('/api/glasses-pairings').send({ scopeType: 'tbm_session', scopeId: 'tbm-1' })).status, 401);
    assert.equal((await glasses.delete('/api/account').send({ password: PASSWORD })).status, 401);
    assert.equal((await glasses.post('/api/uploads')).status, 401);
  });

  test('a valid restricted cookie takes precedence on session routes when both cookie types exist', async () => {
    const bothCookies = await supervisorWithSession();
    assert.equal((await bothCookies.post('/api/sessions').send(session('tbm-2', 'Other Site'))).status, 201);
    const created = await createPairing(bothCookies);
    assert.equal((await bothCookies.post('/api/glasses/pair').send({ code: created.code })).status, 200);
    const list = await bothCookies.get('/api/sessions');
    assert.deepEqual(list.body.map((item) => item.sessionId), ['tbm-1']);
  });

  test('expired and cancelled codes fail generically and revocation is immediate', async () => {
    const supervisor = await supervisorWithSession();
    const expired = await createPairing(supervisor);
    currentTime += 300_001;
    const cleanup = await app.locals.runRetentionCleanup({ cutoff: new Date(currentTime - 24 * 60 * 60 * 1000).toISOString() });
    assert.equal(cleanup.expiredPairings, 1);
    assert.equal(app.locals.database.raw.prepare('SELECT 1 FROM glasses_pairings WHERE id = ?').get(expired.pairing.id), undefined);
    assert.equal(app.locals.database.raw.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'glasses_pairing.expired'").get().count, 1);
    const expiredResponse = await request(server).post('/api/glasses/pair').send({ code: expired.code });
    assert.equal(expiredResponse.status, 401);

    currentTime += 1;
    const cancelled = await createPairing(supervisor);
    assert.equal((await supervisor.delete(`/api/glasses-pairings/${cancelled.pairing.id}`)).status, 204);
    const cancelledResponse = await request(server).post('/api/glasses/pair').send({ code: cancelled.code });
    assert.equal(cancelledResponse.status, 401);
    assert.deepEqual(cancelledResponse.body, expiredResponse.body);

    const active = await createPairing(supervisor);
    const glasses = request.agent(server);
    assert.equal((await glasses.post('/api/glasses/pair').send({ code: active.code })).status, 200);
    assert.equal((await supervisor.post(`/api/glasses-pairings/${active.pairing.id}/revoke`)).status, 204);
    assert.equal((await glasses.get('/api/glasses/session')).status, 401);
    assert.equal((await glasses.get('/api/sessions')).status, 401);
  });

  test('a concurrent redemption has at most one success', async () => {
    const supervisor = await supervisorWithSession();
    const created = await createPairing(supervisor);
    const results = await Promise.all(Array.from({ length: 5 }, () => request(server).post('/api/glasses/pair').send({ code: created.code })));
    assert.equal(results.filter((result) => result.status === 200).length, 1);
    assert.equal(results.filter((result) => result.status !== 200).length, 4);
  });

  test('globally rate limits exchange attempts', async () => {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    app.locals.closeDatabase();
    app = createApp({
      dataDir: path.join(root, 'limited-data'), uploadsDir: path.join(root, 'limited-uploads'),
      registrationKey: REGISTRATION_KEY, sessionSecret: SESSION_SECRET, now: () => currentTime,
      glassesExchangeRateLimit: { windowMs: 60_000, max: 2 }
    });
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    assert.equal((await request(server).post('/api/glasses/pair').send({ code: '000001' })).status, 401);
    assert.equal((await request(server).post('/api/glasses/pair').send({ code: '000002' })).status, 401);
    const limited = await request(server).post('/api/glasses/pair').send({ code: '000003' });
    assert.equal(limited.status, 429);
    assert.ok(limited.headers['retry-after']);
  });

  test('rate limits repeated attempts for the same submitted code', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.equal((await request(server).post('/api/glasses/pair').send({ code: '111111' })).status, 401);
    }
    assert.equal((await request(server).post('/api/glasses/pair').send({ code: '111111' })).status, 429);
  });

  test('sets the restricted cookie Secure with the configured short expiry', async () => {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    app.locals.closeDatabase();
    app = createApp({
      dataDir: path.join(root, 'secure-data'), uploadsDir: path.join(root, 'secure-uploads'),
      registrationKey: REGISTRATION_KEY, sessionSecret: SESSION_SECRET, now: () => currentTime,
      secureCookies: true, glassesSessionTtlMs: 900_000
    });
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const registration = await request(server).post('/api/auth/register').send({
      name: 'Supervisor', email: 'secure@example.com', password: PASSWORD, role: 'supervisor', registrationKey: REGISTRATION_KEY
    });
    const supervisorCookie = registration.headers['set-cookie'][0].split(';')[0];
    assert.equal((await request(server).post('/api/sessions').set('Cookie', supervisorCookie).send(session('secure-tbm'))).status, 201);
    const created = await request(server).post('/api/glasses-pairings').set('Cookie', supervisorCookie)
      .send({ scopeType: 'tbm_session', scopeId: 'secure-tbm' });
    const exchange = await request(server).post('/api/glasses/pair').send({ code: created.body.code });
    const cookie = exchange.headers['set-cookie'][0];
    assert.match(cookie, /Secure/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Max-Age=900/);
  });

  test('scopes evidence requests and completes and attaches owned uploads idempotently', async () => {
    const supervisor = await supervisorWithSession();
    await supervisor.post('/api/sessions').send(session('tbm-2', 'Other Site'));
    const pairing = await createPairing(supervisor);
    const glasses = request.agent(server);
    await glasses.post('/api/glasses/pair').send({ code: pairing.code });
    const hazardId = app.locals.database.raw.prepare('SELECT id FROM hazards WHERE session_id = ?').get('tbm-1').id;
    const otherHazardId = app.locals.database.raw.prepare('SELECT id FROM hazards WHERE session_id = ?').get('tbm-2').id;

    assert.equal((await glasses.post('/api/glasses/evidence-requests').send({ sessionId: 'tbm-2', hazardId: otherHazardId })).status, 404);
    const created = await glasses.post('/api/glasses/evidence-requests').send({ sessionId: 'tbm-1', hazardId });
    assert.equal(created.status, 201);
    assert.equal(created.body.status, 'pending');
    assert.equal((await glasses.get(`/api/glasses/evidence-requests/${created.body.id}`)).status, 200);
    assert.equal((await glasses.get('/api/glasses/evidence-requests/not-owned')).status, 404);

    const uploaded = await supervisor.post('/api/uploads').attach('photos', VALID_PNG, { filename: 'private.png', contentType: 'image/png' });
    const completion = await supervisor.post(`/api/evidence-requests/${created.body.id}/complete`)
      .send({ uploadId: uploaded.body[0].uploadId, provider: 'phone_browser_camera' });
    assert.equal(completion.status, 200);
    assert.equal(completion.body.sourceCategory, 'phone_camera');
    assert.equal((await supervisor.post(`/api/evidence-requests/${created.body.id}/complete`)
      .send({ uploadId: uploaded.body[0].uploadId, provider: 'phone_browser_camera' })).status, 200);
    const replacement = await supervisor.post('/api/uploads').attach('photos', VALID_PNG, { filename: 'replacement.png', contentType: 'image/png' });
    assert.equal((await supervisor.post(`/api/evidence-requests/${created.body.id}/complete`)
      .send({ uploadId: replacement.body[0].uploadId, provider: 'phone_browser_gallery' })).status, 409);

    const attached = await glasses.post(`/api/glasses/evidence-requests/${created.body.id}/attach`);
    assert.equal(attached.status, 200);
    assert.equal(attached.body.evidence.uploadId, uploaded.body[0].uploadId);
    assert.equal((await glasses.post(`/api/glasses/evidence-requests/${created.body.id}/attach`)).status, 200);
    assert.equal(app.locals.database.raw.prepare('SELECT COUNT(*) count FROM hazard_evidence WHERE hazard_id = ?').get(hazardId).count, 1);
    const auditMetadata = JSON.stringify(app.locals.database.raw.prepare("SELECT metadata_json FROM audit_events WHERE entity_type IN ('evidence_request', 'evidence_upload')").all());
    assert.equal(auditMetadata.includes('private.png'), false);
    assert.equal(auditMetadata.includes('replacement.png'), false);
  });

  test('isolates supervisors and rejects cancelled, expired, foreign-upload, and future-provider completion', async () => {
    const owner = await supervisorWithSession('tbm-owner', 'owner@example.com');
    const pairing = await createPairing(owner, 'tbm-owner');
    const glasses = request.agent(server); await glasses.post('/api/glasses/pair').send({ code: pairing.code });
    const hazardId = app.locals.database.raw.prepare('SELECT id FROM hazards WHERE session_id = ?').get('tbm-owner').id;
    const first = await glasses.post('/api/glasses/evidence-requests').send({ sessionId: 'tbm-owner', hazardId });
    const other = await supervisorWithSession('tbm-other', 'other@example.com');
    assert.deepEqual((await other.get('/api/evidence-requests')).body.requests, []);
    const otherUpload = await other.post('/api/uploads').attach('photos', VALID_PNG, { filename: 'other.png', contentType: 'image/png' });
    assert.equal((await owner.post(`/api/evidence-requests/${first.body.id}/complete`).send({ uploadId: otherUpload.body[0].uploadId, provider: 'phone_browser_gallery' })).status, 404);
    assert.equal((await other.post(`/api/evidence-requests/${first.body.id}/complete`).send({ uploadId: otherUpload.body[0].uploadId, provider: 'phone_browser_gallery' })).status, 404);
    assert.equal((await owner.post(`/api/evidence-requests/${first.body.id}/complete`).send({ uploadId: otherUpload.body[0].uploadId, provider: 'native_dat_camera' })).status, 400);
    assert.equal((await glasses.delete(`/api/glasses/evidence-requests/${first.body.id}`)).status, 204);
    const ownerUpload = await owner.post('/api/uploads').attach('photos', VALID_PNG, { filename: 'owner.png', contentType: 'image/png' });
    assert.equal((await owner.post(`/api/evidence-requests/${first.body.id}/complete`).send({ uploadId: ownerUpload.body[0].uploadId, provider: 'phone_browser_camera' })).status, 409);

    const second = await glasses.post('/api/glasses/evidence-requests').send({ sessionId: 'tbm-owner', hazardId });
    currentTime += 600_001;
    assert.equal((await owner.post(`/api/evidence-requests/${second.body.id}/complete`).send({ uploadId: ownerUpload.body[0].uploadId, provider: 'phone_browser_camera' })).status, 409);
  });

  test('registers native devices without plaintext credentials and atomically completes one confirmed DAT capture', async () => {
    assert.equal((await request(server).post('/api/native-devices/registrations').send({ name: 'Unauthorized' })).status, 401);
    const worker = request.agent(server);
    assert.equal((await worker.post('/api/auth/register').send({ name: 'Worker', email: 'worker@example.com', password: PASSWORD, role: 'worker', registrationKey: REGISTRATION_KEY })).status, 201);
    assert.equal((await worker.post('/api/native-devices/registrations').send({ name: 'Worker phone' })).status, 403);
    const supervisor = await supervisorWithSession('tbm-native', 'native@example.com');
    const firstDevice = await registerNativeDevice(supervisor, 'Field phone A');
    const secondDevice = await registerNativeDevice(supervisor, 'Field phone B');
    const persisted = app.locals.database.raw.prepare('SELECT * FROM native_devices WHERE id = ?').get(firstDevice.device.id);
    assert.notEqual(persisted.credential_digest, firstDevice.credential);
    assert.equal(JSON.stringify(app.locals.database.raw.prepare('SELECT * FROM native_devices').all()).includes(firstDevice.credential), false);

    const pairing = await createPairing(supervisor, 'tbm-native');
    const glasses = request.agent(server); await glasses.post('/api/glasses/pair').send({ code: pairing.code });
    assert.deepEqual((await glasses.get('/api/glasses/native-device-availability')).body, { available: true });
    const hazardId = app.locals.database.raw.prepare('SELECT id FROM hazards WHERE session_id = ?').get('tbm-native').id;
    const created = await glasses.post('/api/glasses/evidence-requests').send({ sessionId: 'tbm-native', hazardId, provider: 'native_dat_camera' });
    assert.equal(created.status, 201);
    assert.equal(created.body.nativeReadyAt, null);
    assert.equal((await request(server).get('/api/native/capture-requests/next').set('Authorization', `Device ${firstDevice.credential}`)).body.request, null);
    assert.equal((await glasses.post(`/api/glasses/evidence-requests/${created.body.id}/ready`)).status, 200);
    const foreignSupervisor = await supervisorWithSession('tbm-foreign-native', 'foreign-native@example.com');
    const foreignDevice = await registerNativeDevice(foreignSupervisor, 'Foreign phone');
    assert.equal((await request(server).get('/api/native/capture-requests/next').set('Authorization', `Device ${foreignDevice.credential}`)).body.request, null);

    const authA = { Authorization: `Device ${firstDevice.credential}` };
    const authB = { Authorization: `Device ${secondDevice.credential}` };
    assert.equal((await request(server).get('/api/native/capture-requests/next').set(authA)).body.request.id, created.body.id);
    const claims = await Promise.all([
      request(server).post(`/api/native/capture-requests/${created.body.id}/claim`).set(authA),
      request(server).post(`/api/native/capture-requests/${created.body.id}/claim`).set(authB)
    ]);
    assert.deepEqual(claims.map((item) => item.status).sort(), [200, 409]);
    const winning = claims[0].status === 200 ? authA : authB;
    const losing = claims[0].status === 200 ? authB : authA;
    assert.equal((await request(server).patch(`/api/native/capture-requests/${created.body.id}/status`).set(winning).send({ status: 'capturing' })).status, 200);
    assert.equal((await request(server).patch(`/api/native/capture-requests/${created.body.id}/status`).set(winning).send({ status: 'captured' })).status, 200);
    const uploaded = await request(server).post(`/api/native/capture-requests/${created.body.id}/upload`).set(winning)
      .attach('photo', VALID_PNG, { filename: 'android-private-path.png', contentType: 'image/png' });
    assert.equal(uploaded.status, 201);
    const retriedUpload = await request(server).post(`/api/native/capture-requests/${created.body.id}/upload`).set(winning)
      .attach('photo', VALID_PNG, { filename: 'retry-must-not-replace.png', contentType: 'image/png' });
    assert.equal(retriedUpload.status, 200);
    assert.equal(retriedUpload.body.uploadId, uploaded.body.uploadId);
    assert.equal((await request(server).post(`/api/native/capture-requests/${created.body.id}/complete`).set(winning).send({ uploadId: '00000000-0000-4000-8000-000000000000' })).status, 404);
    const completed = await request(server).post(`/api/native/capture-requests/${created.body.id}/complete`).set(winning).send({ uploadId: uploaded.body.uploadId });
    assert.equal(completed.status, 200);
    assert.equal(completed.body.provider, 'native_dat_camera');
    assert.equal(completed.body.sourceCategory, 'native_glasses_camera');
    assert.equal((await request(server).post(`/api/native/capture-requests/${created.body.id}/complete`).set(winning).send({ uploadId: uploaded.body.uploadId })).status, 200);
    assert.equal((await request(server).post(`/api/native/capture-requests/${created.body.id}/complete`).set(losing).send({ uploadId: uploaded.body.uploadId })).status, 404);
    assert.equal((await request(server).get('/api/sessions').set(winning)).status, 401);
    assert.equal((await request(server).get(`/api/uploads/${uploaded.body.uploadId}`).set(winning)).status, 401);

    const expiring = await glasses.post('/api/glasses/evidence-requests').send({ sessionId: 'tbm-native', hazardId, provider: 'native_dat_camera' });
    await glasses.post(`/api/glasses/evidence-requests/${expiring.body.id}/ready`);
    assert.equal((await request(server).post(`/api/native/capture-requests/${expiring.body.id}/claim`).set(authA)).status, 200);
    assert.equal((await request(server).patch(`/api/native/capture-requests/${expiring.body.id}/status`).set(authA).send({ status: 'capturing' })).status, 200);
    assert.equal((await request(server).patch(`/api/native/capture-requests/${expiring.body.id}/status`).set(authA).send({ status: 'captured' })).status, 200);
    const expiringUpload = await request(server).post(`/api/native/capture-requests/${expiring.body.id}/upload`).set(authA)
      .attach('photo', VALID_PNG, { filename: 'expires.png', contentType: 'image/png' });
    currentTime += 600_001;
    assert.equal((await request(server).post(`/api/native/capture-requests/${expiring.body.id}/complete`).set(authA).send({ uploadId: expiringUpload.body.uploadId })).status, 404);
    const audit = JSON.stringify(app.locals.database.raw.prepare('SELECT metadata_json FROM audit_events').all());
    assert.equal(audit.includes(firstDevice.credential), false);
    assert.equal(audit.includes('android-private-path.png'), false);
  });

  test('revocation and cancellation immediately stop native request use', async () => {
    const supervisor = await supervisorWithSession('tbm-revoke', 'revoke@example.com');
    const native = await registerNativeDevice(supervisor);
    const pairing = await createPairing(supervisor, 'tbm-revoke');
    const glasses = request.agent(server); await glasses.post('/api/glasses/pair').send({ code: pairing.code });
    const hazardId = app.locals.database.raw.prepare('SELECT id FROM hazards WHERE session_id = ?').get('tbm-revoke').id;
    const created = await glasses.post('/api/glasses/evidence-requests').send({ sessionId: 'tbm-revoke', hazardId, provider: 'native_dat_camera' });
    await glasses.post(`/api/glasses/evidence-requests/${created.body.id}/ready`);
    const authorization = { Authorization: `Device ${native.credential}` };
    assert.equal((await request(server).post(`/api/native/capture-requests/${created.body.id}/claim`).set(authorization)).status, 200);
    assert.equal((await glasses.delete(`/api/glasses/evidence-requests/${created.body.id}`)).status, 204);
    assert.equal((await request(server).patch(`/api/native/capture-requests/${created.body.id}/status`).set(authorization).send({ status: 'capturing' })).status, 404);
    assert.equal((await request(server).post(`/api/native/capture-requests/${created.body.id}/complete`).set(authorization).send({ uploadId: '00000000-0000-4000-8000-000000000000' })).status, 404);
    assert.equal((await supervisor.delete(`/api/native-devices/${native.device.id}`)).status, 204);
    assert.equal((await request(server).get('/api/native/device').set(authorization)).status, 401);
    assert.equal((await glasses.get('/api/glasses/native-device-availability')).body.available, false);
  });
});
