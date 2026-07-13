// @ts-nocheck
import { parseJsonBoundary, validateOfflineDraftBoundary, validateQueuedOperationBoundary } from '../domain/validation.ts';
import type { OfflineDraftRecord, QueuedOperation, SyncOperationType, SyncStatus } from '../types/contracts.ts';

export const OFFLINE_DB_NAME = 'safety-lens-offline-v1';
export const OFFLINE_DB_VERSION = 1;
export const LEGACY_DRAFT_KEY = 'safety-lens-active-draft-v1';

export const SYNC_STATUS = Object.freeze({
  DEVICE_ONLY: 'device_only',
  QUEUED: 'queued',
  SYNCING: 'syncing',
  SYNCED: 'synced',
  FAILED: 'failed',
  CONFLICT: 'conflict'
});

const OPERATION_PRIORITY = {
  evidence_upload: 0,
  session_upsert: 1,
  attendance_acknowledgment: 2,
  hazard_review: 3,
  corrective_action: 4,
  sharing_event: 5
};

function requestPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionPromise(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted.'));
  });
}

export function createQueuedOperation({
  operationId = crypto.randomUUID(),
  ownerId,
  type,
  entityId,
  sessionId,
  payload,
  baseRevision = 0,
  deviceObservedAt = new Date().toISOString(),
  dependsOnEvidenceIds = []
}) {
  return {
    operationId,
    ownerId,
    type,
    entityId,
    sessionId,
    payload,
    baseRevision,
    deviceObservedAt,
    retryCount: 0,
    lastError: null,
    status: SYNC_STATUS.QUEUED,
    dependsOnEvidenceIds,
    createdAt: deviceObservedAt,
    updatedAt: deviceObservedAt
  };
}

export function replaceLocalEvidenceReferences(value, localEvidenceId, serverEvidence) {
  if (Array.isArray(value)) {
    return value.map((item) => replaceLocalEvidenceReferences(item, localEvidenceId, serverEvidence));
  }
  if (!value || typeof value !== 'object') return value;
  if (value.localEvidenceId === localEvidenceId) return { ...serverEvidence };
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      replaceLocalEvidenceReferences(item, localEvidenceId, serverEvidence)
    ])
  );
}

export async function openOfflineStore({
  indexedDBImpl = globalThis.indexedDB,
  localStorageImpl = globalThis.localStorage
} = {}) {
  if (!indexedDBImpl) throw new Error('IndexedDB is unavailable.');
  const openRequest = indexedDBImpl.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
  openRequest.onupgradeneeded = () => {
    const database = openRequest.result;
    if (!database.objectStoreNames.contains('drafts')) database.createObjectStore('drafts', { keyPath: 'id' });
    if (!database.objectStoreNames.contains('evidence')) database.createObjectStore('evidence', { keyPath: 'id' });
    if (!database.objectStoreNames.contains('profiles')) database.createObjectStore('profiles', { keyPath: 'userId' });
    if (!database.objectStoreNames.contains('operations')) {
      const operations = database.createObjectStore('operations', { keyPath: 'operationId' });
      operations.createIndex('sessionId', 'sessionId');
      operations.createIndex('status', 'status');
      operations.createIndex('createdAt', 'createdAt');
    }
  };
  const database = await requestPromise(openRequest);

  function store(name, mode = 'readonly') {
    const transaction = database.transaction(name, mode);
    return { transaction, objectStore: transaction.objectStore(name) };
  }

  async function put(name, value) {
    const { transaction, objectStore } = store(name, 'readwrite');
    objectStore.put(value);
    await transactionPromise(transaction);
    return value;
  }

  async function get(name, key) {
    return requestPromise(store(name).objectStore.get(key));
  }

  async function getAll(name) {
    return requestPromise(store(name).objectStore.getAll());
  }

  async function remove(name, key) {
    const { transaction, objectStore } = store(name, 'readwrite');
    objectStore.delete(key);
    await transactionPromise(transaction);
  }

  async function putDraft(draft) {
    const savedAt = new Date().toISOString();
    return put('drafts', {
      ...draft,
      id: draft.id ?? draft.session?.sessionId,
      deviceUpdatedAt: savedAt,
      syncStatus: draft.syncStatus ?? SYNC_STATUS.DEVICE_ONLY
    });
  }

  async function queueSessionMutation({ ownerId, type, entityId, sessionId, payload, baseRevision = 0 }) {
    const operations = (await getAll('operations')).filter(validateQueuedOperationBoundary);
    const now = new Date().toISOString();
    const replaceable = operations.find(
      (operation) =>
        operation.type === type &&
        operation.entityId === entityId &&
        operation.ownerId === ownerId &&
        [SYNC_STATUS.QUEUED, SYNC_STATUS.FAILED].includes(operation.status)
    );
    const operation = replaceable
      ? {
          ...replaceable,
          payload,
          baseRevision,
          status: SYNC_STATUS.QUEUED,
          lastError: null,
          updatedAt: now
        }
      : createQueuedOperation({ ownerId, type, entityId, sessionId, payload, baseRevision, deviceObservedAt: now });

    const { transaction, objectStore } = store('operations', 'readwrite');
    for (const queued of operations) {
      if (
        queued.sessionId === sessionId &&
        queued.ownerId === ownerId &&
        queued.type !== 'evidence_upload' &&
        [SYNC_STATUS.QUEUED, SYNC_STATUS.FAILED].includes(queued.status)
      ) {
        objectStore.put({ ...queued, payload, updatedAt: now });
      }
    }
    objectStore.put(operation);
    await transactionPromise(transaction);
    return operation;
  }

  async function putEvidence({ id = crypto.randomUUID(), ownerId, sessionId, blob, originalName, mimeType, size }) {
    const record = {
      id,
      ownerId,
      sessionId,
      blob,
      originalName,
      mimeType,
      size,
      status: SYNC_STATUS.DEVICE_ONLY,
      serverEvidence: null,
      deviceObservedAt: new Date().toISOString()
    };
    await put('evidence', record);
    return record;
  }

  async function queueEvidenceUpload(evidence) {
    const operation = createQueuedOperation({
      type: 'evidence_upload',
      ownerId: evidence.ownerId,
      entityId: evidence.id,
      sessionId: evidence.sessionId,
      payload: {
        localEvidenceId: evidence.id,
        originalName: evidence.originalName,
        mimeType: evidence.mimeType,
        size: evidence.size
      }
    });
    await put('operations', operation);
    await put('evidence', { ...evidence, status: SYNC_STATUS.QUEUED });
    return operation;
  }

  async function listPendingOperations(ownerId) {
    const operations = (await getAll('operations')).filter(validateQueuedOperationBoundary);
    return operations
      .filter((operation) =>
        (!ownerId || operation.ownerId === ownerId) &&
        [SYNC_STATUS.QUEUED, SYNC_STATUS.FAILED, SYNC_STATUS.SYNCING].includes(operation.status))
      .sort(
        (first, second) =>
          (OPERATION_PRIORITY[first.type] ?? 99) - (OPERATION_PRIORITY[second.type] ?? 99) ||
          first.createdAt.localeCompare(second.createdAt)
      );
  }

  async function updateOperation(operationId, changes) {
    const operation = await get('operations', operationId);
    if (!operation) return null;
    return put('operations', { ...operation, ...changes, updatedAt: new Date().toISOString() });
  }

  async function applyEvidenceUpload(ownerId, localEvidenceId, serverEvidence) {
    const evidence = await get('evidence', localEvidenceId);
    if (evidence?.ownerId === ownerId) {
      await put('evidence', { ...evidence, status: SYNC_STATUS.SYNCED, serverEvidence });
    }
    const drafts = await getAll('drafts');
    const operations = await getAll('operations');
    const { transaction, objectStore } = store('drafts', 'readwrite');
    drafts.filter((draft) => draft.ownerId === ownerId)
      .forEach((draft) => objectStore.put(replaceLocalEvidenceReferences(draft, localEvidenceId, serverEvidence)));
    await transactionPromise(transaction);
    const operationStore = store('operations', 'readwrite');
    operations.filter((operation) => operation.ownerId === ownerId).forEach((operation) =>
      operationStore.objectStore.put(replaceLocalEvidenceReferences(operation, localEvidenceId, serverEvidence))
    );
    await transactionPromise(operationStore.transaction);
  }

  async function updateSessionRevision(ownerId, sessionId, revision) {
    const operations = await getAll('operations');
    const { transaction, objectStore } = store('operations', 'readwrite');
    operations
      .filter(
        (operation) =>
          operation.sessionId === sessionId &&
          operation.ownerId === ownerId &&
          operation.type !== 'evidence_upload' &&
          [SYNC_STATUS.QUEUED, SYNC_STATUS.FAILED].includes(operation.status)
      )
      .forEach((operation) => objectStore.put({ ...operation, baseRevision: revision }));
    await transactionPromise(transaction);
  }

  async function resolveConflictKeepingLocal(ownerId, sessionId, payload, serverRevision) {
    const operations = await getAll('operations');
    const transactionRecord = store('operations', 'readwrite');
    operations
      .filter((operation) => operation.ownerId === ownerId && operation.sessionId === sessionId && operation.status === SYNC_STATUS.CONFLICT)
      .forEach((operation) => transactionRecord.objectStore.put({
        ...operation,
        status: SYNC_STATUS.SYNCED,
        resolution: 'superseded_after_explicit_local_review',
        updatedAt: new Date().toISOString()
      }));
    await transactionPromise(transactionRecord.transaction);
    return queueSessionMutation({
      type: 'session_upsert',
      ownerId,
      entityId: sessionId,
      sessionId,
      payload,
      baseRevision: serverRevision
    });
  }

  async function migrateLegacyDraft() {
    let raw;
    try {
      raw = localStorageImpl?.getItem(LEGACY_DRAFT_KEY);
    } catch {
      return null;
    }
    if (!raw) return null;
    let legacy;
    try {
      legacy = parseJsonBoundary(raw);
    } catch {
      localStorageImpl.removeItem(LEGACY_DRAFT_KEY);
      return null;
    }
    if (!validateOfflineDraftBoundary(legacy)) {
      localStorageImpl.removeItem(LEGACY_DRAFT_KEY);
      return null;
    }
    const profiles = await getAll('profiles');
    const migrated = await putDraft({
      ...legacy,
      id: legacy.session.sessionId,
      ownerId: legacy.ownerId ?? profiles[0]?.userId ?? null,
      migratedFromLocalStorage: true,
      syncStatus: SYNC_STATUS.DEVICE_ONLY
    });
    localStorageImpl.removeItem(LEGACY_DRAFT_KEY);
    return migrated;
  }

  return {
    close: () => database.close(),
    putDraft,
    getDraft: async (id) => {
      const draft = await get('drafts', id);
      return validateOfflineDraftBoundary(draft) ? draft : null;
    },
    listDrafts: async () => (await getAll('drafts')).filter(validateOfflineDraftBoundary),
    deleteDraft: (id) => remove('drafts', id),
    putEvidence,
    getEvidence: (id) => get('evidence', id),
    listEvidence: () => getAll('evidence'),
    queueEvidenceUpload,
    queueSessionMutation,
    listPendingOperations,
    listOperations: async () => (await getAll('operations')).filter(validateQueuedOperationBoundary),
    getOperation: async (id) => {
      const operation = await get('operations', id);
      return validateQueuedOperationBoundary(operation) ? operation : null;
    },
    updateOperation,
    applyEvidenceUpload,
    updateSessionRevision,
    resolveConflictKeepingLocal,
    putProfile: (profile) => put('profiles', profile),
    getProfile: (userId) => get('profiles', userId),
    listProfiles: () => getAll('profiles'),
    migrateLegacyDraft
  };
}
