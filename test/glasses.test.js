import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { GLASSES_STEP, attendanceValue, createMockGlassesEvidence, evidenceSourceLabel,
  isAttendanceSummaryValid, normalizeGlassesStep, splitAttendanceValue, transitionGlassesStep } from '../src/views/glasses/model.ts';
import { HAZARD_STATUS, getFinalizationBlockers, normalizeAttendanceSummary, normalizeWorker } from '../src/domain/workflow.ts';

describe('structured glasses workflow', () => {
  test('uses the explicit forward and safe-back state map', () => {
    assert.equal(transitionGlassesStep(GLASSES_STEP.START, 'start'), GLASSES_STEP.CONTEXT_CONFIRMATION);
    assert.equal(transitionGlassesStep(GLASSES_STEP.CONTEXT_CONFIRMATION, 'confirm'), GLASSES_STEP.ATTENDANCE);
    assert.equal(transitionGlassesStep(GLASSES_STEP.CONTEXT_CONFIRMATION, 'reject'), GLASSES_STEP.START);
    assert.equal(transitionGlassesStep(GLASSES_STEP.ATTENDANCE, 'continue'), GLASSES_STEP.HAZARD_DECISION);
    assert.equal(transitionGlassesStep(GLASSES_STEP.HAZARD_DECISION, 'controlled'), GLASSES_STEP.PHOTO_EVIDENCE);
    assert.equal(transitionGlassesStep(GLASSES_STEP.HAZARD_DECISION, 'action_required'), GLASSES_STEP.CORRECTIVE_ACTION);
    assert.equal(transitionGlassesStep(GLASSES_STEP.CORRECTIVE_ACTION, 'continue'), GLASSES_STEP.PHOTO_EVIDENCE);
    assert.equal(transitionGlassesStep(GLASSES_STEP.PHOTO_EVIDENCE, 'continue'), GLASSES_STEP.HAZARD_CONFIRMATION);
    assert.equal(transitionGlassesStep(GLASSES_STEP.HAZARD_CONFIRMATION, 'summary'), GLASSES_STEP.HAZARD_SUMMARY);
  });

  test('supports 00–99 attendance and rejects present greater than expected', () => {
    assert.equal(attendanceValue(0, 0), 0); assert.equal(attendanceValue(9, 9), 99);
    assert.deepEqual(splitAttendanceValue(99), [9, 9]);
    assert.equal(isAttendanceSummaryValid({ expectedCount: 12, presentCount: 12 }), true);
    assert.equal(isAttendanceSummaryValid({ expectedCount: 12, presentCount: 13 }), false);
  });

  test('count-only attendance neither fabricates named attendance nor acknowledgment', () => {
    const summary = normalizeAttendanceSummary({ expectedCount: 8, presentCount: 6, captureSource: 'glasses_count_selector' });
    const worker = normalizeWorker({ id: 'w1', name: 'Worker', present: false });
    assert.deepEqual([summary.expectedCount, summary.presentCount], [8, 6]);
    assert.equal(worker.present, false); assert.equal(worker.acknowledgment.supervisorRecorded, false);
  });

  test('Not Controlled preserves action_required semantics and structured blockers', () => {
    assert.equal(HAZARD_STATUS.ACTION_REQUIRED, 'action_required');
    const blockers = getFinalizationBlockers({ hazards: [{ title: 'Opening', status: 'action_required', correctiveAction: {} }], sharing: { status: 'not_shared' } });
    assert.ok(blockers.some((item) => item.includes('immediate control')));
  });

  test('preview mock provenance can never claim raw SDK camera', () => {
    const evidence = createMockGlassesEvidence(1);
    assert.equal(evidence.source, 'browser_preview_mock');
    assert.equal(evidenceSourceLabel(evidence.source), 'Browser preview mock');
    assert.notEqual(evidence.source, 'sdk_raw_camera');
  });

  test('legacy drafts restore to safe new states', () => {
    assert.equal(normalizeGlassesStep('intro'), GLASSES_STEP.START);
    assert.equal(normalizeGlassesStep('action_details'), GLASSES_STEP.CORRECTIVE_ACTION);
    assert.equal(normalizeGlassesStep('summary', { phase: 'summary' }), GLASSES_STEP.HAZARD_SUMMARY);
  });
});
