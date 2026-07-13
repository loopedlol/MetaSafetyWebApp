import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  HAZARD_STATUS,
  SHARING_STATUS,
  getFinalizationBlockers,
  getRecordStatus,
  markAllWorkersPresent,
  normalizeHazard,
  normalizeSessionRecord,
  normalizeSharing,
  normalizeWorker,
  setSupervisorRecordedAcknowledgment,
  setWorkerAttendance
} from '../src/domain/workflow.ts';

function finalizableSession(hazards) {
  return {
    hazards,
    sharing: {
      status: SHARING_STATUS.NOT_SHARED
    }
  };
}

describe('attendance and acknowledgment transitions', () => {
  test('marking attendance does not record acknowledgment', () => {
    const workers = [{ id: 'worker-1', name: 'Worker', present: false }];
    const updated = setWorkerAttendance(workers, 'worker-1', true);

    assert.equal(updated[0].present, true);
    assert.equal(updated[0].acknowledgment.supervisorRecorded, false);
    assert.equal(updated[0].acknowledgment.independentlyVerified, false);
  });

  test('supervisor-recorded acknowledgment is independent of attendance', () => {
    const workers = [{ id: 'worker-1', name: 'Worker', present: false }];
    const updated = setSupervisorRecordedAcknowledgment(workers, 'worker-1', true, {
      recordedBy: 'Supervisor',
      recordedAt: '2026-07-10T01:00:00.000Z'
    });

    assert.equal(updated[0].present, false);
    assert.equal(updated[0].acknowledgment.supervisorRecorded, true);
    assert.equal(updated[0].acknowledgment.supervisorRecordedBy, 'Supervisor');
    assert.equal(updated[0].acknowledgment.independentlyVerified, false);
  });

  test('mark-all attendance, including the glasses shortcut, leaves acknowledgments unchanged', () => {
    const workers = [
      { id: 'one', present: false, acknowledgment: { supervisorRecorded: false } },
      { id: 'two', present: false, acknowledgment: { supervisorRecorded: true, source: 'supervisor_recorded' } }
    ];
    const updated = markAllWorkersPresent(workers);

    assert.deepEqual(updated.map((worker) => worker.present), [true, true]);
    assert.deepEqual(
      updated.map((worker) => worker.acknowledgment.supervisorRecorded),
      [false, true]
    );
  });

  test('migrates legacy acknowledged without claiming independent verification', () => {
    const worker = normalizeWorker({ present: true, acknowledged: true });

    assert.equal(worker.acknowledgment.supervisorRecorded, true);
    assert.equal(worker.acknowledgment.independentlyVerified, false);
    assert.equal(worker.acknowledgment.source, 'legacy_acknowledged_migration');
  });
});

describe('legacy workflow migration', () => {
  test('maps old hazard status values to explicit states', () => {
    assert.equal(normalizeHazard({ status: 'Confirmed' }).status, HAZARD_STATUS.CONTROLLED);
    assert.equal(normalizeHazard({ status: 'confirmed' }).status, HAZARD_STATUS.CONTROLLED);
    assert.equal(normalizeHazard({ status: 'accepted' }).status, HAZARD_STATUS.CONTROLLED);
    assert.equal(normalizeHazard({ status: 'Fix Ordered' }).status, HAZARD_STATUS.ACTION_REQUIRED);
    assert.equal(normalizeHazard({ status: 'fix_ordered' }).status, HAZARD_STATUS.ACTION_REQUIRED);
    assert.equal(normalizeHazard({ status: null }).status, HAZARD_STATUS.NOT_CHECKED);
  });

  test('does not treat a legacy sharing boolean as worker-sharing evidence', () => {
    const sharing = normalizeSharing({ sharedWithWorkers: true, method: 'unknown' });

    assert.equal(sharing.status, SHARING_STATUS.NOT_RECORDED);
    assert.equal(sharing.sharedAt, null);
    assert.equal(sharing.legacyClaimedShared, true);
  });

  test('downgrades an old completed record when evidence is incomplete', () => {
    const migrated = normalizeSessionRecord({
      status: 'completed',
      completedAt: '2026-07-10T01:00:00.000Z',
      workers: [],
      hazards: [{ title: 'Unchecked', status: 'not_checked' }],
      sharing: { sharedWithWorkers: true }
    });

    assert.equal(migrated.status, 'draft');
    assert.equal(migrated.completedAt, null);
    assert.equal(migrated.legacyCompletedAt, '2026-07-10T01:00:00.000Z');
  });
});

describe('finalization rules', () => {
  test('lists unchecked hazard and sharing decision blockers', () => {
    const blockers = getFinalizationBlockers({
      hazards: [{ title: 'Opening', status: 'not_checked' }],
      sharing: { status: 'not_recorded' }
    });

    assert.ok(blockers.some((blocker) => blocker.includes('has not been reviewed')));
    assert.ok(blockers.some((blocker) => blocker.includes('whether TBM results were shared')));
  });

  test('requires method and recipients for a claimed sharing event', () => {
    const blockers = getFinalizationBlockers({
      hazards: [{ title: 'Access', status: 'controlled' }],
      sharing: { status: 'shared' }
    });

    assert.ok(blockers.some((blocker) => blocker.includes('Sharing method')));
    assert.ok(blockers.some((blocker) => blocker.includes('Sharing recipients')));
  });

  test('requires corrective-action ownership, controls, due time, and work status', () => {
    const blockers = getFinalizationBlockers(
      finalizableSession([{ title: 'Opening', status: 'action_required', correctiveAction: {} }])
    );

    assert.ok(blockers.some((blocker) => blocker.includes('immediate control')));
    assert.ok(blockers.some((blocker) => blocker.includes('assigned person')));
    assert.ok(blockers.some((blocker) => blocker.includes('due date/time')));
    assert.ok(blockers.some((blocker) => blocker.includes('work status')));
  });

  test('rejects a claimed closure without verifier evidence', () => {
    const blockers = getFinalizationBlockers(
      finalizableSession([
        {
          title: 'Opening',
          status: 'action_required',
          correctiveAction: {
            immediateControl: 'Barricaded',
            assignedTo: 'Kim',
            dueAt: '2026-07-11T09:00',
            workStatus: 'stopped',
            verificationStatus: 'verified'
          }
        }
      ])
    );

    assert.ok(blockers.some((blocker) => blocker.includes('verifiedBy')));
    assert.ok(blockers.some((blocker) => blocker.includes('verifiedAt')));
  });

  test('rejects invalid corrective-action dates', () => {
    const blockers = getFinalizationBlockers(
      finalizableSession([
        {
          title: 'Opening',
          status: 'action_required',
          correctiveAction: {
            immediateControl: 'Barricaded',
            assignedTo: 'Kim',
            dueAt: 'not-a-date',
            workStatus: 'stopped',
            verificationStatus: 'open'
          }
        }
      ])
    );

    assert.ok(blockers.some((blocker) => blocker.includes('due date/time is invalid')));
  });

  test('finalizes an accurate actions-open record when action fields are complete but verification is open', () => {
    const session = finalizableSession([
      {
        title: 'Opening',
        status: 'action_required',
        correctiveAction: {
          immediateControl: 'Barricaded',
          assignedTo: 'Kim',
          dueAt: '2026-07-11T09:00',
          workStatus: 'stopped',
          verificationStatus: 'open'
        }
      }
    ]);

    assert.deepEqual(getFinalizationBlockers(session), []);
    assert.equal(getRecordStatus(session), 'actions_open');
  });

  test('reports completed only when all reviewed actions are explicitly verified', () => {
    const session = finalizableSession([
      { title: 'Access', status: 'controlled' },
      {
        title: 'Opening',
        status: 'action_required',
        correctiveAction: {
          immediateControl: 'Barricaded',
          assignedTo: 'Kim',
          dueAt: '2026-07-11T09:00',
          workStatus: 'stopped',
          verificationStatus: 'verified',
          verifiedBy: 'Lee',
          verifiedAt: '2026-07-10T02:00:00.000Z'
        }
      }
    ]);

    assert.deepEqual(getFinalizationBlockers(session), []);
    assert.equal(getRecordStatus(session), 'completed');
  });
});
