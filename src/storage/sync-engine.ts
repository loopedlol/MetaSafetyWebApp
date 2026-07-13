import { SYNC_STATUS } from './offline-store.ts';
import type { QueuedOperation, SyncStatus } from '../types/contracts.ts';

interface SyncError extends Error {
  conflict?: Record<string, unknown>;
  response?: Response;
}

interface SyncStore {
  getDraft(id: string): Promise<any>;
  putDraft(value: any): Promise<any>;
  getEvidence(id: string): Promise<any>;
  applyEvidenceUpload(ownerId: string | undefined, id: string, evidence: any): Promise<void>;
  updateOperation(id: string, changes: Record<string, unknown>): Promise<any>;
  updateSessionRevision(ownerId: string | undefined, sessionId: string, revision: number): Promise<void>;
  listPendingOperations(ownerId: string): Promise<QueuedOperation[]>;
  getOperation(id: string): Promise<QueuedOperation | null>;
  listOperations(): Promise<QueuedOperation[]>;
}

interface SyncEngineOptions {
  store: SyncStore;
  fetchImpl?: typeof fetch;
  getOwnerId?: () => string | null | undefined;
  onStatus?: (event: Record<string, unknown> & { sessionId: string; status: SyncStatus }) => void;
}

export function createSyncEngine({ store, fetchImpl = globalThis.fetch, getOwnerId = () => null, onStatus = () => {} }: SyncEngineOptions) {
  let running = false;

  async function setDraftStatus(sessionId: string, status: SyncStatus, details: Record<string, unknown> = {}) {
    const draft = await store.getDraft(sessionId);
    if (draft) await store.putDraft({ ...draft, syncStatus: status, ...details });
    onStatus({ sessionId, status, ...details });
  }

  async function syncEvidence(operation: QueuedOperation) {
    const evidence = await store.getEvidence(operation.entityId);
    if (!evidence?.blob) throw new Error('Local evidence blob is unavailable.');
    const formData = new FormData();
    formData.append('photos', evidence.blob, evidence.originalName);
    const response = await fetchImpl('/api/uploads', {
      method: 'POST',
      headers: { 'Idempotency-Key': operation.operationId },
      body: formData
    });
    const payload: any = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(payload.error ?? `Evidence sync failed (${response.status})`), { response, payload });
    const serverEvidence = Array.isArray(payload) ? payload[0] : null;
    if (!serverEvidence?.id) throw new Error('Evidence sync returned no upload record.');
    await store.applyEvidenceUpload(operation.ownerId, operation.entityId, serverEvidence);
    return serverEvidence;
  }

  async function syncSessionMutation(operation: QueuedOperation) {
    const response = await fetchImpl('/api/sessions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': operation.operationId
      },
      body: JSON.stringify({
        ...operation.payload,
        operationType: operation.type,
        baseRevision: operation.baseRevision
      })
    });
    const payload: any = await response.json().catch(() => ({}));
    if (response.status === 409) {
      const error = new Error(payload.error ?? 'Conflict requires review.') as SyncError;
      error.conflict = payload.conflict;
      error.response = response;
      throw error;
    }
    if (!response.ok) throw Object.assign(new Error(payload.error ?? `Session sync failed (${response.status})`), { response, payload });
    return payload;
  }

  async function syncOperation(operation: QueuedOperation) {
    await store.updateOperation(operation.operationId, { status: SYNC_STATUS.SYNCING, lastError: null });
    await setDraftStatus(operation.sessionId, SYNC_STATUS.SYNCING);
    try {
      const result: any = operation.type === 'evidence_upload'
        ? await syncEvidence(operation)
        : await syncSessionMutation(operation);
      await store.updateOperation(operation.operationId, { status: SYNC_STATUS.SYNCED, result, lastError: null });
      if (operation.type !== 'evidence_upload' && Number.isFinite(result.revision)) {
        await store.updateSessionRevision(operation.ownerId, operation.sessionId, result.revision);
        const draft = await store.getDraft(operation.sessionId);
        if (draft) await store.putDraft({ ...draft, serverRevision: result.revision, serverSession: result });
      }
      return { ok: true, result };
    } catch (unknownError) {
      const error = unknownError as SyncError;
      const conflict = Boolean(error.conflict);
      await store.updateOperation(operation.operationId, {
        status: conflict ? SYNC_STATUS.CONFLICT : SYNC_STATUS.FAILED,
        retryCount: (operation.retryCount ?? 0) + 1,
        lastError: error.message,
        conflict: error.conflict ?? null
      });
      await setDraftStatus(operation.sessionId, conflict ? SYNC_STATUS.CONFLICT : SYNC_STATUS.FAILED, {
        lastError: error.message,
        conflict: error.conflict ?? null
      });
      return { ok: false, conflict, error };
    }
  }

  async function syncAll() {
    if (running) return { running: true };
    running = true;
    try {
      const ownerId = getOwnerId();
      if (!ownerId) return { running: false, remaining: 0 };
      const operations = await store.listPendingOperations(ownerId);
      const affectedSessions = new Set<string>();
      for (const operation of operations) {
        affectedSessions.add(operation.sessionId);
        const currentOperation = await store.getOperation(operation.operationId);
        if (!currentOperation || currentOperation.status === SYNC_STATUS.SYNCED) continue;
        const outcome = await syncOperation(currentOperation);
        if (!outcome.ok && outcome.conflict) continue;
        if (!outcome.ok) break;
      }
      const remaining = await store.listPendingOperations(ownerId);
      for (const sessionId of affectedSessions) {
        const hasRemaining = remaining.some((operation) => operation.sessionId === sessionId);
        const allOperations = (await store.listOperations()).filter((operation) => operation.ownerId === ownerId);
        const hasConflict = allOperations.some(
          (operation) => operation.sessionId === sessionId && operation.status === SYNC_STATUS.CONFLICT
        );
        if (hasConflict) await setDraftStatus(sessionId, SYNC_STATUS.CONFLICT);
        else if (hasRemaining) await setDraftStatus(sessionId, SYNC_STATUS.QUEUED);
        else await setDraftStatus(sessionId, SYNC_STATUS.SYNCED, { lastError: null });
      }
      return { running: false, remaining: remaining.length };
    } finally {
      running = false;
    }
  }

  return { syncAll, syncOperation, isRunning: () => running };
}
