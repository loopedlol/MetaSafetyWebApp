import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { afterEach, beforeEach, describe } from 'node:test';
import request from 'supertest';
import { createApp } from '../server.ts';
import { validateEnvironment } from '../server/config.ts';

const TUNNEL = 'https://pilot-device-test.trycloudflare.com';
const PASSWORD = 'correct-horse-battery-staple';
const KEY = 'development-registration-key';
let root;
let app;
let server;
let logs;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'safety-lens-tunnel-'));
  logs = [];
  app = createApp({
    dataDir: path.join(root, 'data'), uploadsDir: path.join(root, 'uploads'),
    registrationKey: KEY, sessionSecret: 'test-session-secret', nodeEnv: 'development',
    devTunnelOrigin: TUNNEL,
    logger: { info: (line) => logs.push(line), error: (line) => logs.push(line) }
  });
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
});

afterEach(async () => {
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  app?.locals.closeDatabase();
  await rm(root, { recursive: true, force: true });
});

function record(id = 'tunnel-tbm') {
  return {
    sessionId: id, sessionType: 'tbm', site: { siteName: 'Tunnel Site', siteArea: 'Area A' },
    work: { taskName: 'Physical glasses test' }, supervisor: { name: 'Supervisor', role: 'supervisor' },
    workers: [], hazards: [{ id: 'hazard-1', title: 'Hazard', status: 'not_checked' }], nearMisses: []
  };
}

describe('development tunnel configuration', () => {
  test('is disabled by default and normalizes one exact HTTPS tunnel origin', () => {
    const disabled = validateEnvironment({}, root);
    assert.equal(disabled.devTunnelMode, false);
    assert.equal(disabled.devTunnelOrigin, null);
    const enabled = validateEnvironment({ NODE_ENV: 'development', DEV_TUNNEL_MODE: 'true', DEV_TUNNEL_ORIGIN: `${TUNNEL}/` }, root);
    assert.equal(enabled.devTunnelMode, true);
    assert.equal(enabled.devTunnelOrigin, TUNNEL);
  });

  test('rejects unsafe, ambiguous, and non-Cloudflare origins', () => {
    const invalid = [
      'http://pilot-device-test.trycloudflare.com',
      'https://pilot-device-test.trycloudflare.com/path',
      'https://pilot-device-test.trycloudflare.com/?query=1',
      'https://pilot-device-test.trycloudflare.com/#fragment',
      'https://user:password@pilot-device-test.trycloudflare.com',
      'https://*.trycloudflare.com',
      'https://one.trycloudflare.com,https://two.trycloudflare.com',
      'https://pilot.trycloudflare.com.evil.example',
      'https://trycloudflare.com'
    ];
    for (const origin of invalid) {
      assert.throws(() => validateEnvironment({ NODE_ENV: 'development', DEV_TUNNEL_MODE: 'true', DEV_TUNNEL_ORIGIN: origin }, root), /DEV_TUNNEL_ORIGIN/);
    }
  });

  test('cannot be enabled in test or production', () => {
    for (const nodeEnv of ['test', 'production']) {
      assert.throws(() => validateEnvironment({ NODE_ENV: nodeEnv, DEV_TUNNEL_MODE: 'true', DEV_TUNNEL_ORIGIN: TUNNEL }, root), /only when NODE_ENV=development/);
    }
  });
});

describe('development tunnel mutation boundary', () => {
  test('allows exact-origin login and pairing while retaining local origin support and sanitized logs', async () => {
    const agent = request.agent(server);
    const registration = await agent.post('/api/auth/register').set('Origin', TUNNEL).send({
      name: 'Tunnel Supervisor', email: 'tunnel@example.test', password: PASSWORD,
      role: 'supervisor', registrationKey: KEY
    });
    assert.equal(registration.status, 201);
    assert.equal((await agent.post('/api/auth/logout').set('Origin', TUNNEL)).status, 200);
    assert.equal((await agent.post('/api/auth/login').set('Origin', TUNNEL).send({ email: 'tunnel@example.test', password: PASSWORD })).status, 200);
    assert.equal((await agent.post('/api/sessions').set('Origin', TUNNEL).send(record())).status, 201);
    const pairing = await agent.post('/api/glasses-pairings').set('Origin', TUNNEL)
      .send({ scopeType: 'tbm_session', scopeId: 'tunnel-tbm' });
    assert.equal(pairing.status, 201);

    const localOrigin = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await agent.post('/api/auth/login').set('Origin', localOrigin).send({ email: 'tunnel@example.test', password: PASSWORD })).status, 200);

    const combined = logs.join('\n');
    assert.doesNotMatch(combined, new RegExp(PASSWORD));
    assert.doesNotMatch(combined, new RegExp(KEY));
    assert.doesNotMatch(combined, new RegExp(pairing.body.code));
    assert.doesNotMatch(combined, /safety_lens_(session|glasses)|tunnel@example\.test/);
  });

  test('rejects every other origin and cross-site metadata without reflection', async () => {
    for (const origin of ['https://other.trycloudflare.com', 'https://pilot-device-test.trycloudflare.com.evil.example', 'https://evil.example']) {
      const response = await request(server).post('/api/auth/login').set('Origin', origin).send({ email: 'x@example.test', password: PASSWORD });
      assert.equal(response.status, 403);
      assert.equal(response.headers['access-control-allow-origin'], undefined);
    }
    const crossSite = await request(server).post('/api/auth/login').set('Origin', TUNNEL)
      .set('Sec-Fetch-Site', 'cross-site').send({ email: 'x@example.test', password: PASSWORD });
    assert.equal(crossSite.status, 403);
    assert.match(crossSite.body.error, /Cross-site/);
  });
});
