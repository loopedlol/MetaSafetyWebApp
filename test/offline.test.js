import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import vm from 'node:vm';
import { IDBFactory } from 'fake-indexeddb';
import { createQueuedOperation, openOfflineStore, replaceLocalEvidenceReferences, SYNC_STATUS } from '../src/storage/offline-store.ts';
import { createSyncEngine } from '../src/storage/sync-engine.ts';

function memoryStore(operation) {
  const operations = new Map([[operation.operationId, structuredClone(operation)]]);
  const drafts = new Map([[operation.sessionId, { id: operation.sessionId, session: { sessionId: operation.sessionId } }]]);
  return {
    operations,
    drafts,
    getDraft: async (id) => drafts.get(id),
    putDraft: async (draft) => drafts.set(draft.id, structuredClone(draft)),
    listPendingOperations: async () => [...operations.values()].filter((item) =>
      [SYNC_STATUS.QUEUED, SYNC_STATUS.FAILED, SYNC_STATUS.SYNCING].includes(item.status)),
    listOperations: async () => [...operations.values()],
    getOperation: async (id) => operations.get(id),
    updateOperation: async (id, changes) => {
      const next = { ...operations.get(id), ...changes };
      operations.set(id, next);
      return next;
    },
    updateSessionRevision: async (_ownerId, _id, revision) => {
      for (const [id, item] of operations) {
        if (item.status !== SYNC_STATUS.SYNCED) operations.set(id, { ...item, baseRevision: revision });
      }
    }
  };
}

describe('offline operation model', () => {
  test('records the required retry and device-observed metadata', () => {
    const operation = createQueuedOperation({
      operationId: 'operation-1', type: 'hazard_review', entityId: 'hazard-1', sessionId: 'session-1', payload: {}
    });
    assert.equal(operation.operationId, 'operation-1');
    assert.equal(operation.entityId, 'hazard-1');
    assert.equal(operation.retryCount, 0);
    assert.equal(operation.lastError, null);
    assert.equal(operation.status, SYNC_STATUS.QUEUED);
    assert.match(operation.deviceObservedAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  test('replaces local evidence references without losing surrounding draft data', () => {
    const draft = { hazard: { title: 'Opening', evidencePhotos: [{ localEvidenceId: 'local-1' }] } };
    const replaced = replaceLocalEvidenceReferences(draft, 'local-1', { uploadId: 'server-1', url: '/api/uploads/server-1' });
    assert.equal(replaced.hazard.title, 'Opening');
    assert.equal(replaced.hazard.evidencePhotos[0].uploadId, 'server-1');
  });

  test('migrates the old localStorage draft once into IndexedDB', async () => {
    const indexedDBImpl = new IDBFactory();
    const values = new Map([['safety-lens-active-draft-v1', JSON.stringify({
      version: 1,
      session: { sessionId: 'legacy-draft' },
      workers: [], responses: [], nearMisses: []
    })]]);
    const localStorageImpl = {
      getItem: (key) => values.get(key) ?? null,
      removeItem: (key) => values.delete(key)
    };
    const store = await openOfflineStore({ indexedDBImpl, localStorageImpl });
    const first = await store.migrateLegacyDraft();
    const second = await store.migrateLegacyDraft();
    assert.equal(first.id, 'legacy-draft');
    assert.equal(first.migratedFromLocalStorage, true);
    assert.equal(second, null);
    assert.equal(values.has('safety-lens-active-draft-v1'), false);
    assert.equal((await store.listDrafts()).length, 1);
    store.close();
  });

  test('retains a photo Blob and complete typed queue across a database restart', async () => {
    const indexedDBImpl = new IDBFactory();
    const first = await openOfflineStore({ indexedDBImpl, localStorageImpl: null });
    const ownerId = 'owner-offline';
    const sessionId = 'whole-offline-draft';
    await first.putDraft({
      id: sessionId, ownerId, version: 2, session: { sessionId }, workers: [], responses: [], nearMisses: [], syncStatus: SYNC_STATUS.DEVICE_ONLY
    });
    const evidence = await first.putEvidence({
      ownerId, sessionId, blob: new Blob(['offline-photo'], { type: 'image/png' }), originalName: 'offline.png', mimeType: 'image/png', size: 13
    });
    await first.queueEvidenceUpload(evidence);
    for (const type of ['session_upsert', 'attendance_acknowledgment', 'hazard_review', 'corrective_action', 'sharing_event']) {
      await first.queueSessionMutation({ ownerId, type, entityId: `${type}-entity`, sessionId, payload: { sessionId } });
    }
    first.close();

    const reopened = await openOfflineStore({ indexedDBImpl, localStorageImpl: null });
    const restoredBlob = (await reopened.getEvidence(evidence.id)).blob;
    assert.equal(await restoredBlob.text(), 'offline-photo');
    assert.deepEqual(
      new Set((await reopened.listOperations()).map((operation) => operation.type)),
      new Set(['evidence_upload', 'session_upsert', 'attendance_acknowledgment', 'hazard_review', 'corrective_action', 'sharing_event'])
    );
    assert.equal((await reopened.getDraft(sessionId)).session.sessionId, sessionId);
    reopened.close();
  });
});

describe('offline synchronization', () => {
  test('synchronizes a queued mutation exactly once across repeated retries', async () => {
    const operation = createQueuedOperation({
      operationId: 'once-1', ownerId: 'owner-1', type: 'session_upsert', entityId: 'session-1', sessionId: 'session-1', payload: { sessionId: 'session-1' }
    });
    const store = memoryStore(operation);
    let calls = 0;
    const engine = createSyncEngine({ store, getOwnerId: () => 'owner-1', fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ sessionId: 'session-1', revision: 1 }), { status: 201 });
    } });
    await engine.syncAll();
    await engine.syncAll();
    assert.equal(calls, 1);
    assert.equal(store.operations.get('once-1').status, SYNC_STATUS.SYNCED);
    assert.equal(store.drafts.get('session-1').syncStatus, SYNC_STATUS.SYNCED);
  });

  test('retains failed work and surfaces conflicts without retrying them automatically', async () => {
    const failedOperation = createQueuedOperation({
      operationId: 'failed-1', type: 'session_upsert', entityId: 'session-1', sessionId: 'session-1', payload: { sessionId: 'session-1' }
    });
    failedOperation.ownerId = 'owner-1';
    const failedStore = memoryStore(failedOperation);
    await createSyncEngine({ store: failedStore, getOwnerId: () => 'owner-1', fetchImpl: async () => { throw new TypeError('offline'); } }).syncAll();
    assert.equal(failedStore.operations.get('failed-1').status, SYNC_STATUS.FAILED);
    assert.deepEqual(failedStore.operations.get('failed-1').payload, { sessionId: 'session-1' });
    assert.equal(failedStore.drafts.get('session-1').session.sessionId, 'session-1');

    const conflictOperation = createQueuedOperation({
      operationId: 'conflict-1', type: 'hazard_review', entityId: 'hazard-1', sessionId: 'session-1', payload: { sessionId: 'session-1' }
    });
    conflictOperation.ownerId = 'owner-1';
    const conflictStore = memoryStore(conflictOperation);
    let calls = 0;
    const conflictEngine = createSyncEngine({ store: conflictStore, getOwnerId: () => 'owner-1', fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: 'Conflict requires review.', conflict: { serverRevision: 3 } }), { status: 409 });
    } });
    await conflictEngine.syncAll();
    await conflictEngine.syncAll();
    assert.equal(calls, 1);
    assert.equal(conflictStore.operations.get('conflict-1').status, SYNC_STATUS.CONFLICT);
    assert.equal(conflictStore.drafts.get('session-1').syncStatus, SYNC_STATUS.CONFLICT);
  });
});

describe('service worker application shell', () => {
  test('serves the cached shell and static hazards when the network is offline', async () => {
    const listeners = {};
    const cached = new Map();
    const cache = {
      addAll: async (paths) => paths.forEach((item) => cached.set(item, { cachedPath: item })),
      match: async (request) => cached.get(typeof request === 'string' ? request : new URL(request.url).pathname),
      put: async (request, response) => cached.set(new URL(request.url).pathname, response)
    };
    const context = {
      URL,
      Promise,
      caches: {
        open: async () => cache,
        keys: async () => ['safety-lens-shell-v1'],
        delete: async () => true
      },
      fetch: async () => { throw new TypeError('offline'); },
      self: {
        location: { origin: 'http://localhost:5173' },
        addEventListener: (name, handler) => { listeners[name] = handler; },
        skipWaiting: () => {},
        clients: { claim: () => {} }
      }
    };
    vm.runInNewContext(await readFile(new URL('../public/sw.js', import.meta.url), 'utf8'), context);
    let installation;
    listeners.install({ waitUntil: (promise) => { installation = promise; } });
    await installation;
    assert.equal(cached.has('/hazards.json'), true);

    let offlineResponse;
    listeners.fetch({
      request: { method: 'GET', url: 'http://localhost:5173/checklist', mode: 'navigate' },
      respondWith: (promise) => { offlineResponse = promise; }
    });
    assert.deepEqual(await offlineResponse, { cachedPath: '/' });
  });
});
