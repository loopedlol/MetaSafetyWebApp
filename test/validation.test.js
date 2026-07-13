import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  validateOfflineDraftBoundary,
  validateQueuedOperationBoundary,
  validateSessionBoundary
} from '../src/domain/validation.ts';
import { validateSessionPayload } from '../server/validation/session.ts';

describe('runtime TypeScript boundaries', () => {
  test('accepts the preserved API session shape and rejects missing fields', () => {
    const session = {
      sessionId: 'typed-session', sessionType: 'tbm', site: {}, work: {}, supervisor: {},
      workers: [], hazards: [], nearMisses: []
    };
    assert.equal(validateSessionBoundary(session), true);
    assert.equal(validateSessionPayload(session), null);
    assert.match(validateSessionPayload({ sessionId: 'incomplete' }), /Missing required field/);
  });

  test('rejects malformed offline drafts and queue records at storage boundaries', () => {
    assert.equal(validateOfflineDraftBoundary({
      version: 2, session: { sessionId: 'draft-1' }, workers: [], responses: [], nearMisses: [], syncStatus: 'queued'
    }), true);
    assert.equal(validateOfflineDraftBoundary({ version: 2, session: {}, workers: [] }), false);
    assert.equal(validateQueuedOperationBoundary({
      operationId: 'op-1', type: 'hazard_review', entityId: 'hazard-1', sessionId: 'session-1',
      payload: {}, deviceObservedAt: new Date().toISOString(), retryCount: 0, status: 'queued'
    }), true);
    assert.equal(validateQueuedOperationBoundary({ operationId: 'op-2', type: 'unknown' }), false);
  });
});
