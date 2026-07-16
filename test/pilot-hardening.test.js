import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { afterEach, beforeEach, describe } from 'node:test';
import request from 'supertest';
import { createApp, startServer } from '../server.ts';
import { validateEnvironment } from '../server/config.ts';

const NOW = Date.parse('2026-07-13T00:00:00.000Z');
const PASSWORD = 'correct-horse-battery-staple';
const KEY = 'pilot-test-registration-key';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nKsAAAAASUVORK5CYII=', 'base64');
let root;
let uploadsDir;
let app;
let server;
let logs;

function session(id = 'pilot-session') {
  return { sessionId: id, sessionType: 'tbm', site: { siteName: 'Pilot site', siteArea: '' },
    work: { taskName: 'Pilot task' }, supervisor: { name: 'Supervisor', role: 'supervisor' },
    workers: [], hazards: [{ id: 'h-1', title: 'Hazard', status: 'not_checked' }], nearMisses: [] };
}

async function register(agent, email = 'pilot@example.com') {
  return agent.post('/api/auth/register').send({ name: 'Pilot Supervisor', email, password: PASSWORD, role: 'supervisor', registrationKey: KEY });
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'safety-lens-hardening-'));
  uploadsDir = path.join(root, 'uploads');
  logs = [];
  const logger = { info: (line) => logs.push(line), error: (line) => logs.push(line) };
  app = createApp({ dataDir: path.join(root, 'data'), uploadsDir, registrationKey: KEY,
    sessionSecret: 'test-session-secret', nodeEnv: 'test', now: () => NOW, logger });
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
});

afterEach(async () => {
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  app?.locals.closeDatabase();
  await rm(root, { recursive: true, force: true });
});

describe('pilot HTTP boundary', () => {
  test('sets security headers, request IDs, and separate health/readiness responses', async () => {
    const health = await request(server).get('/healthz');
    const ready = await request(server).get('/readyz');
    assert.equal(health.status, 200);
    assert.equal(ready.status, 200);
    assert.match(health.headers['x-request-id'], /^[0-9a-f-]{36}$/);
    assert.match(health.headers['content-security-policy'], /default-src 'self'/);
    assert.match(health.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.match(health.headers['content-security-policy'], /script-src-attr 'none'/);
    assert.equal(health.headers['x-content-type-options'], 'nosniff');
    assert.equal(health.headers['x-frame-options'], 'DENY');
    assert.equal(health.headers['x-powered-by'], undefined);
    app.locals.isShuttingDown = true;
    assert.equal((await request(server).get('/readyz')).status, 503);
  });

  test('rejects cross-site state changes but allows same-origin browser requests', async () => {
    const rejected = await request(server).post('/api/auth/login').set('Origin', 'https://evil.example').send({ email: 'x@example.com', password: PASSWORD });
    const allowed = await request(server).post('/api/auth/login').set('Origin', `http://127.0.0.1:${server.address().port}`).send({ email: 'x@example.com', password: PASSWORD });
    assert.equal(rejected.status, 403);
    assert.equal(allowed.status, 401);
  });

  test('logs only bounded request metadata and never credential bodies', async () => {
    const agent = request.agent(server);
    await register(agent);
    await agent.get('/api/sessions/private-person-name-and-site');
    const combined = logs.join('\n');
    assert.match(combined, /"event":"http_request"/);
    assert.doesNotMatch(combined, new RegExp(PASSWORD));
    assert.doesNotMatch(combined, new RegExp(KEY));
    assert.doesNotMatch(combined, /safety_lens_session/);
    assert.doesNotMatch(combined, /pilot@example\.com/);
    assert.doesNotMatch(combined, /private-person-name-and-site/);
    assert.match(combined, /\/api\/sessions\/:sessionId/);
  });

  test('returns sanitized parser and internal errors with correlation IDs', async () => {
    const response = await request(server).post('/api/auth/login').set('Content-Type', 'application/json').send('{bad json');
    assert.equal(response.status, 400);
    assert.equal(response.body.error, 'Malformed JSON request.');
    assert.equal(response.body.requestId, response.headers['x-request-id']);
    assert.doesNotMatch(JSON.stringify(response.body), /server\/app|node_modules|\.ts:\d|at /);

    app.locals.closeDatabase();
    assert.equal((await request(server).get('/readyz')).status, 503);
    const internal = await register(request.agent(server), 'database-closed@example.com');
    assert.equal(internal.status, 500);
    assert.equal(internal.body.error, 'Internal server error.');
    assert.equal(internal.body.requestId, internal.headers['x-request-id']);
    assert.doesNotMatch(JSON.stringify(internal.body), /server\/app|node_modules|\.ts:\d|at |MetaSafetyWebApp/);
  });
});

describe('bounded schemas and retention', () => {
  test('rejects oversized arrays, strings, and deeply nested values', async () => {
    const agent = request.agent(server);
    await register(agent);
    const tooMany = session('too-many');
    tooMany.hazards = Array.from({ length: 201 }, (_, index) => ({ id: `h-${index}`, title: 'x', status: 'not_checked' }));
    const long = session('long');
    long.hazards[0].title = 'x'.repeat(501);
    const nested = session('nested');
    let cursor = nested.work;
    for (let index = 0; index < 12; index += 1) cursor = cursor.child = {};
    assert.match((await agent.post('/api/sessions').send(tooMany)).body.error, /maximum of 200/);
    assert.match((await agent.post('/api/sessions').send(long)).body.error, /maximum length/);
    assert.match((await agent.post('/api/sessions').send(nested)).body.error, /nesting exceeds/);
    assert.equal((await agent.post('/api/sessions').set('Idempotency-Key', 'x'.repeat(129)).send(session('key'))).status, 400);
    assert.equal((await agent.get(`/api/sessions/${'x'.repeat(201)}`)).status, 400);
  });

  test('deletes abandoned uploads while retaining referenced safety evidence', async () => {
    const agent = request.agent(server);
    await register(agent);
    const first = (await agent.post('/api/uploads').attach('photos', PNG, { filename: 'abandoned.png', contentType: 'image/png' })).body[0];
    const second = (await agent.post('/api/uploads').attach('photos', PNG, { filename: 'retained.png', contentType: 'image/png' })).body[0];
    const record = session('with-evidence');
    record.hazards[0].evidencePhotos = [second];
    assert.equal((await agent.post('/api/sessions').send(record)).status, 201);
    const result = await app.locals.runRetentionCleanup({ cutoff: new Date(NOW + 1).toISOString() });
    assert.equal(result.deleted, 1);
    assert.equal(app.locals.database.getUploadForOwner(first.id, (await app.locals.database.listUsers())[0].id), null);
    assert.ok(app.locals.database.raw.prepare('SELECT 1 FROM evidence_uploads WHERE id = ?').get(second.id));
    assert.equal((await readdir(uploadsDir)).length, 1);
  });

  test('rejects overlong upload filenames without persisting evidence', async () => {
    const agent = request.agent(server);
    await register(agent);
    const response = await agent.post('/api/uploads').attach('photos', PNG, {
      filename: `${'x'.repeat(256)}.png`, contentType: 'image/png'
    });
    assert.equal(response.status, 400);
    assert.equal(app.locals.database.raw.prepare('SELECT COUNT(*) count FROM evidence_uploads').get().count, 0);
    assert.equal((await readdir(uploadsDir)).length, 0);
  });

  test('deactivates and pseudonymizes an account but retains safety records pending policy approval', async () => {
    const agent = request.agent(server);
    const registered = await register(agent, 'delete-me@example.com');
    await agent.post('/api/sessions').send(session('retained-after-account-deletion'));
    const deleted = await agent.delete('/api/account').send({ password: PASSWORD });
    assert.equal(deleted.status, 204);
    assert.equal((await agent.get('/api/sessions')).status, 401);
    assert.equal(app.locals.database.findUserByEmail('delete-me@example.com'), null);
    const raw = app.locals.database.raw.prepare('SELECT email, name, deleted_at FROM users WHERE id = ?').get(registered.body.user.id);
    assert.match(raw.email, /^deleted-/);
    assert.equal(raw.name, 'Deleted pilot user');
    assert.ok(raw.deleted_at);
    assert.equal(app.locals.database.raw.prepare('SELECT COUNT(*) count FROM tbm_sessions WHERE owner_id = ?').get(registered.body.user.id).count, 1);
  });
});

test('validates every pilot application environment setting', () => {
  assert.throws(() => validateEnvironment({ NODE_ENV: 'staging' }, root), /NODE_ENV/);
  assert.throws(() => validateEnvironment({ PORT: 'zero' }, root), /PORT/);
  assert.throws(() => validateEnvironment({ HOST: 'bad host' }, root), /HOST/);
  assert.throws(() => validateEnvironment({ TRUST_PROXY: 'true' }, root), /TRUST_PROXY/);
  assert.throws(() => validateEnvironment({ SESSION_TTL_MS: '10' }, root), /SESSION_TTL_MS/);
  assert.throws(() => validateEnvironment({ GLASSES_PAIRING_TTL_MS: '10' }, root), /GLASSES_PAIRING_TTL_MS/);
  assert.throws(() => validateEnvironment({ GLASSES_SESSION_TTL_MS: '10' }, root), /GLASSES_SESSION_TTL_MS/);
  assert.throws(() => validateEnvironment({ GLASSES_PAIRING_MAX_ATTEMPTS: '11' }, root), /GLASSES_PAIRING_MAX_ATTEMPTS/);
  assert.throws(() => validateEnvironment({ SHUTDOWN_TIMEOUT_MS: '999' }, root), /SHUTDOWN_TIMEOUT_MS/);
  assert.throws(() => validateEnvironment({ ABANDONED_UPLOAD_TTL_HOURS: '0' }, root), /ABANDONED_UPLOAD_TTL_HOURS/);
  assert.throws(() => validateEnvironment({ RETENTION_CLEANUP_INTERVAL_MINUTES: '0' }, root), /RETENTION_CLEANUP_INTERVAL_MINUTES/);
  assert.throws(() => validateEnvironment({ AI_MODE: 'live' }, root), /AI_MODE/);
  assert.throws(() => validateEnvironment({ AI_MODE: 'mock', AI_API_KEY: 'secret' }, root), /AI_API_KEY/);
  assert.throws(() => validateEnvironment({ NODE_ENV: 'production', REGISTRATION_KEY: 'short', SESSION_SECRET: 'short' }, root), /REGISTRATION_KEY/);
  const production = validateEnvironment({ NODE_ENV: 'production', REGISTRATION_KEY: 'production-pilot-key',
    SESSION_SECRET: 'production-session-secret-at-least-32-characters', DATABASE_PATH: './pilot.sqlite',
    UPLOADS_DIR: './pilot-uploads' }, root);
  assert.equal(production.trustProxy, false);
  assert.equal(production.databasePath, path.join(root, 'pilot.sqlite'));
  assert.equal(production.uploadsDir, path.join(root, 'pilot-uploads'));
});

test('gracefully stops accepting requests and closes its HTTP lifecycle', async () => {
  const lifecycleLogs = [];
  const pilotServer = startServer({
    port: 0,
    host: '127.0.0.1',
    databasePath: path.join(root, 'shutdown.sqlite'),
    uploadsDir: path.join(root, 'shutdown-uploads'),
    environment: { NODE_ENV: 'test', AI_MODE: 'mock' },
    logger: { info: (line) => lifecycleLogs.push(line), error: (line) => lifecycleLogs.push(line) }
  });
  await once(pilotServer, 'listening');
  pilotServer.shutdown('test');
  await once(pilotServer, 'close');
  assert.match(lifecycleLogs.join('\n'), /"event":"server_shutdown_started"/);
  assert.equal(pilotServer.listening, false);
});
