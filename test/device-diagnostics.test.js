import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { indexedDB } from 'fake-indexeddb';
import {
  DIAGNOSTICS_DB_NAME,
  exitDiagnosticsUrl,
  isDeviceDiagnosticsEnabled,
  probeAuthentication,
  probeIndexedDb,
  recordDiagnosticKey,
  sanitizeRuntimeError,
  sanitizeUserAgent
} from '../src/device/diagnostics.ts';

describe('physical-device diagnostics contract', () => {
  test('requires the exact Meta Display diagnostics selection', () => {
    assert.equal(isDeviceDiagnosticsEnabled('?mode=glasses&adapter=meta-display'), false);
    assert.equal(isDeviceDiagnosticsEnabled('?mode=glasses&diagnostics=1'), false);
    assert.equal(isDeviceDiagnosticsEnabled('?mode=glasses&adapter=browser-preview&diagnostics=1'), false);
    assert.equal(isDeviceDiagnosticsEnabled('?mode=glasses&adapter=meta-display&diagnostics=true'), false);
    assert.equal(isDeviceDiagnosticsEnabled('?mode=glasses&adapter=meta-display&diagnostics=1'), true);
    assert.equal(new URL(exitDiagnosticsUrl('https://pilot.example/?mode=glasses&adapter=meta-display&diagnostics=1')).searchParams.has('diagnostics'), false);
  });

  test('records only documented D-pad keys and preserves keydown versus keyup', () => {
    for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Escape']) {
      assert.deepEqual(recordDiagnosticKey({ key, type: 'keydown' }), { key, eventType: 'keydown' });
      assert.deepEqual(recordDiagnosticKey({ key, type: 'keyup' }), { key, eventType: 'keyup' });
    }
    for (const key of ['1', '2', 'm', 'M', 'p', 'P']) assert.equal(recordDiagnosticKey({ key, type: 'keydown' }), null);
  });

  test('sanitizes browser and error text without retaining sensitive values or local paths', () => {
    const sensitive = 'secret.person@example.com token=super-secret Cookie=session-value Chrome/140.1';
    const userAgent = sanitizeUserAgent(`Mozilla/5.0 (${sensitive}) ${sensitive}`);
    const runtimeError = sanitizeRuntimeError(new Error('password=hunter2 /Users/private/project/file.ts secret.person@example.com'));
    for (const output of [userAgent, runtimeError]) {
      assert.doesNotMatch(output, /secret\.person@example\.com|super-secret|session-value|hunter2|\/Users\/private/);
    }
  });

  test('distinguishes authenticated, unauthenticated, network, and unexpected responses without reading bodies', async () => {
    let requestOptions;
    assert.equal(await probeAuthentication(async (_url, options) => {
      requestOptions = options;
      return new Response('private user data', { status: 200 });
    }), 'authenticated');
    assert.deepEqual(requestOptions, { method: 'GET', credentials: 'same-origin', headers: { Accept: 'application/json' } });
    assert.equal(await probeAuthentication(async () => new Response('', { status: 401 })), 'unauthenticated');
    assert.equal(await probeAuthentication(async () => new Response('', { status: 503 })), 'unexpected_response');
    assert.equal(await probeAuthentication(async () => { throw new TypeError('offline'); }), 'network_error');
  });

  test('writes and deletes only a disposable diagnostics record and removes its database', async () => {
    const result = await probeIndexedDb(indexedDB);
    assert.deepEqual(result, { status: 'passed', cleanup: 'complete' });
    if (typeof indexedDB.databases === 'function') {
      const databases = await indexedDB.databases();
      assert.equal(databases.some((database) => database.name === DIAGNOSTICS_DB_NAME), false);
    }
  });
});
