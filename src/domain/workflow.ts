import type { CorrectiveActionRecord, HazardRecord, SharingRecord, TbmSessionRecord, WorkerRecord } from '../types/contracts.ts';

type LegacyRecord = Record<string, any>;

export const HAZARD_STATUS = Object.freeze({
  CONTROLLED: 'controlled',
  ACTION_REQUIRED: 'action_required',
  NOT_CHECKED: 'not_checked'
});

export const VERIFICATION_STATUS = Object.freeze({
  OPEN: 'open',
  VERIFIED: 'verified'
});

export const WORK_STATUS = Object.freeze({
  STOPPED: 'stopped',
  PERMITTED_WITH_CONTROLS: 'permitted_with_controls'
});

export const SHARING_STATUS = Object.freeze({
  NOT_RECORDED: 'not_recorded',
  NOT_SHARED: 'not_shared',
  SHARED: 'shared'
});

export const ATTENDANCE_CAPTURE_SOURCE = Object.freeze({ GLASSES_COUNT_SELECTOR: 'glasses_count_selector' });
export const EVIDENCE_SOURCE = Object.freeze({
  SDK_RAW_CAMERA: 'sdk_raw_camera', EXTERNAL_UPLOAD: 'external_upload', BROWSER_FILE_PICKER: 'browser_file_picker',
  BROWSER_PREVIEW_MOCK: 'browser_preview_mock', UNKNOWN_LEGACY_SOURCE: 'unknown_legacy_source'
});
export const IMMEDIATE_RESPONSE_CATEGORY = Object.freeze({
  STOP_WORK: 'stop_work', ISOLATE_AREA: 'isolate_area', INSTALL_BARRIER: 'install_barrier',
  REMOVE_OBSTRUCTION: 'remove_obstruction', REPLACE_EQUIPMENT: 'replace_equipment', ADD_PPE: 'add_ppe',
  REQUEST_SUPERVISOR_REVIEW: 'request_supervisor_review', OTHER_APPROVED_CONTROL: 'other_approved_control'
});
export const RESPONSIBLE_PARTY = Object.freeze({
  SUPERVISOR: 'supervisor', SITE_MANAGER: 'site_manager', SAFETY_OFFICER: 'safety_officer',
  EQUIPMENT_OPERATOR: 'equipment_operator', ASSIGNED_CREW: 'assigned_crew', EXTERNAL_CONTRACTOR: 'external_contractor'
});
export const DUE_PERIOD = Object.freeze({
  IMMEDIATE: 'immediate', BEFORE_WORK_RESUMES: 'before_work_resumes', WITHIN_ONE_HOUR: 'within_one_hour',
  SAME_SHIFT: 'same_shift', END_OF_DAY: 'end_of_day', SCHEDULED_FOLLOW_UP: 'scheduled_follow_up'
});
export const SHARING_METHOD = Object.freeze({ VERBAL_BRIEFING: 'verbal_briefing', TEAM_MEETING: 'team_meeting',
  DISPLAYED_NOTICE: 'displayed_notice', MOBILE_MESSAGE: 'mobile_message', PRINTED_HANDOUT: 'printed_handout',
  OTHER_APPROVED_METHOD: 'other_approved_method' });
export const SHARING_PROOF_TYPE = Object.freeze({ PHOTO_EVIDENCE: 'photo_evidence', UPLOADED_DOCUMENT: 'uploaded_document',
  ATTENDANCE_RECORD: 'attendance_record', SUPERVISOR_CONFIRMATION: 'supervisor_confirmation',
  WORKER_ACKNOWLEDGMENT_RECORD: 'worker_acknowledgment_record', NO_INDEPENDENT_PROOF: 'no_independent_proof' });

export function normalizeAttendanceSummary(summary: LegacyRecord = {}) {
  if (!summary || typeof summary !== 'object') return null;
  const expectedCount = Number(summary.expectedCount);
  const presentCount = Number(summary.presentCount);
  if (!Number.isInteger(expectedCount) || !Number.isInteger(presentCount) || expectedCount < 0 || expectedCount > 99 || presentCount < 0 || presentCount > expectedCount) return null;
  return { expectedCount, presentCount, captureSource: summary.captureSource === ATTENDANCE_CAPTURE_SOURCE.GLASSES_COUNT_SELECTOR
    ? summary.captureSource : ATTENDANCE_CAPTURE_SOURCE.GLASSES_COUNT_SELECTOR, deviceObservedAt: summary.deviceObservedAt ?? null };
}

export function normalizeHazardStatus(value: unknown) {
  if (value === HAZARD_STATUS.CONTROLLED || value === 'Confirmed' || value === 'confirmed' || value === 'accepted') {
    return HAZARD_STATUS.CONTROLLED;
  }
  if (
    value === HAZARD_STATUS.ACTION_REQUIRED ||
    value === 'Fix Ordered' ||
    value === 'fix_ordered'
  ) {
    return HAZARD_STATUS.ACTION_REQUIRED;
  }
  return HAZARD_STATUS.NOT_CHECKED;
}

export function createEmptyAcknowledgment() {
  return {
    supervisorRecorded: false,
    supervisorRecordedBy: null,
    supervisorRecordedAt: null,
    independentlyVerified: false,
    independentlyVerifiedBy: null,
    independentlyVerifiedAt: null,
    independentVerificationMethod: null,
    source: null
  };
}

export function normalizeWorker(worker: LegacyRecord = {}): LegacyRecord {
  const existing = worker.acknowledgment ?? {};
  const legacySupervisorRecorded = worker.acknowledged === true;
  const independentlyVerified = Boolean(
    existing.independentlyVerified === true &&
      String(existing.independentlyVerifiedBy ?? '').trim() &&
      existing.independentlyVerifiedAt &&
      String(existing.independentVerificationMethod ?? '').trim()
  );

  return {
    ...worker,
    present: worker.present === true,
    acknowledgment: {
      ...createEmptyAcknowledgment(),
      ...existing,
      supervisorRecorded: existing.supervisorRecorded === true || legacySupervisorRecorded,
      supervisorRecordedBy: existing.supervisorRecordedBy ?? null,
      supervisorRecordedAt: existing.supervisorRecordedAt ?? null,
      independentlyVerified,
      independentlyVerifiedBy: independentlyVerified ? existing.independentlyVerifiedBy : null,
      independentlyVerifiedAt: independentlyVerified ? existing.independentlyVerifiedAt : null,
      independentVerificationMethod: independentlyVerified ? existing.independentVerificationMethod : null,
      source: existing.source ?? (legacySupervisorRecorded ? 'legacy_acknowledged_migration' : null)
    }
  };
}

export function setWorkerAttendance(workers: LegacyRecord[], workerId: string, present: boolean) {
  return workers.map((worker) =>
    worker.id === workerId ? { ...normalizeWorker(worker), present: present === true } : normalizeWorker(worker)
  );
}

export function markAllWorkersPresent(workers: LegacyRecord[]) {
  return workers.map((worker) => ({ ...normalizeWorker(worker), present: true }));
}

export function setSupervisorRecordedAcknowledgment(
  workers: LegacyRecord[], workerId: string, recorded: boolean,
  { recordedBy, recordedAt }: { recordedBy?: string; recordedAt?: string } = {}
) {
  return workers.map((worker) => {
    const normalized = normalizeWorker(worker);
    if (normalized.id !== workerId) return normalized;

    return {
      ...normalized,
      acknowledgment: {
        ...normalized.acknowledgment,
        supervisorRecorded: recorded === true,
        supervisorRecordedBy: recorded ? recordedBy ?? null : null,
        supervisorRecordedAt: recorded ? recordedAt ?? null : null,
        source: recorded ? 'supervisor_recorded' : null
      }
    };
  });
}

export function normalizeCorrectiveAction(action: LegacyRecord = {}, status: string = HAZARD_STATUS.NOT_CHECKED) {
  const required = normalizeHazardStatus(status) === HAZARD_STATUS.ACTION_REQUIRED;
  const requestedVerification = action.verificationStatus ?? (action.verified === true ? 'verified' : 'open');
  const verificationStatus = requestedVerification === VERIFICATION_STATUS.VERIFIED
    ? VERIFICATION_STATUS.VERIFIED
    : VERIFICATION_STATUS.OPEN;
  const closureEvidence = Array.isArray(action.closureEvidence)
    ? action.closureEvidence
    : action.closureEvidence
      ? [action.closureEvidence]
      : [];

  return {
    required,
    immediateControl: action.immediateControl ?? action.description ?? '',
    assignedTo: action.assignedTo ?? '',
    dueAt: action.dueAt ?? '',
    workStatus: Object.values(WORK_STATUS).includes(action.workStatus) ? action.workStatus : '',
    verificationStatus,
    verifiedBy: verificationStatus === VERIFICATION_STATUS.VERIFIED ? action.verifiedBy : null,
    verifiedAt: verificationStatus === VERIFICATION_STATUS.VERIFIED ? action.verifiedAt : null,
    closureEvidence,
    legacyCompletedAt: action.completedAt ?? null
    , immediateResponseCategory: Object.values(IMMEDIATE_RESPONSE_CATEGORY).includes(action.immediateResponseCategory) ? action.immediateResponseCategory : '',
    responsibleParty: Object.values(RESPONSIBLE_PARTY).includes(action.responsibleParty) ? action.responsibleParty : '',
    duePeriod: Object.values(DUE_PERIOD).includes(action.duePeriod) ? action.duePeriod : ''
  };
}

export function isCorrectiveActionClosed(action: LegacyRecord) {
  return Boolean(
    action?.verificationStatus === VERIFICATION_STATUS.VERIFIED &&
      String(action.verifiedBy ?? '').trim() &&
      action.verifiedAt
  );
}

export function normalizeHazard(hazard: LegacyRecord = {}) {
  const status = normalizeHazardStatus(hazard.status ?? hazard.humanReview?.decision);
  const reviewed = status !== HAZARD_STATUS.NOT_CHECKED;

  return {
    ...hazard,
    status,
    evidencePhotos: Array.isArray(hazard.evidencePhotos) ? hazard.evidencePhotos : [],
    humanReview: {
      reviewed,
      decision: status,
      reviewedBy: reviewed ? hazard.humanReview?.reviewedBy ?? null : null,
      reviewedAt: reviewed ? hazard.humanReview?.reviewedAt ?? hazard.updatedAt ?? null : null
    },
    correctiveAction: normalizeCorrectiveAction(hazard.correctiveAction, status)
  };
}

export function normalizeSharing(sharing: LegacyRecord = {}) {
  let status = Object.values(SHARING_STATUS).includes(sharing.status)
    ? sharing.status
    : SHARING_STATUS.NOT_RECORDED;

  // A legacy boolean alone is not sufficient evidence of who received what,
  // how it was shared, or when the server recorded the event.
  const legacyClaimedShared = sharing.sharedWithWorkers === true && !sharing.status;
  if (legacyClaimedShared) status = SHARING_STATUS.NOT_RECORDED;

  return {
    status,
    method: status === SHARING_STATUS.SHARED ? sharing.method ?? '' : '',
    recipients: status === SHARING_STATUS.SHARED ? sharing.recipients ?? sharing.sharedWith ?? '' : '',
    sharedAt: status === SHARING_STATUS.SHARED ? sharing.sharedAt ?? null : null,
    acknowledgmentResults: sharing.acknowledgmentResults ?? '',
    proofType: status === SHARING_STATUS.SHARED && Object.values(SHARING_PROOF_TYPE).includes(sharing.proofType) ? sharing.proofType : '',
    legacyClaimedShared
  };
}

export function getFinalizationBlockers(session: LegacyRecord) {
  const blockers: string[] = [];
  const hazards: LegacyRecord[] = (session.hazards ?? []).map(normalizeHazard);
  const sharing = normalizeSharing(session.sharing);

  if (!hazards.length) blockers.push('At least one hazard must be recorded.');

  hazards.forEach((hazard: LegacyRecord, index: number) => {
    const label = `Hazard ${index + 1}${hazard.title ? ` (${hazard.title})` : ''}`;
    if (hazard.status === HAZARD_STATUS.NOT_CHECKED) {
      blockers.push(`${label} has not been reviewed.`);
      return;
    }

    if (hazard.status === HAZARD_STATUS.ACTION_REQUIRED) {
      const action = hazard.correctiveAction;
      if (!String(action.immediateControl ?? '').trim()) blockers.push(`${label}: immediate control taken is required.`);
      if (!String(action.assignedTo ?? '').trim()) blockers.push(`${label}: assigned person is required.`);
      if (!action.dueAt) blockers.push(`${label}: corrective-action due date/time is required.`);
      else if (Number.isNaN(new Date(action.dueAt).getTime())) {
        blockers.push(`${label}: corrective-action due date/time is invalid.`);
      }
      if (!Object.values(WORK_STATUS).includes(action.workStatus)) {
        blockers.push(`${label}: work status must be stopped or permitted with controls.`);
      }
      if (action.verificationStatus === VERIFICATION_STATUS.VERIFIED) {
        if (!String(action.verifiedBy ?? '').trim()) blockers.push(`${label}: verifiedBy is required for closure.`);
        if (!action.verifiedAt) blockers.push(`${label}: verifiedAt is required for closure.`);
        else if (Number.isNaN(new Date(action.verifiedAt).getTime())) {
          blockers.push(`${label}: verifiedAt must be a valid date/time.`);
        }
      }
    }
  });

  if (sharing.status === SHARING_STATUS.NOT_RECORDED) {
    blockers.push('Record whether TBM results were shared with workers.');
  }
  if (sharing.status === SHARING_STATUS.SHARED) {
    if (!String(sharing.method ?? '').trim()) blockers.push('Sharing method is required when results were shared.');
    if (!String(sharing.recipients ?? '').trim()) blockers.push('Sharing recipients are required when results were shared.');
  }

  return blockers;
}

export function getRecordStatus(session: LegacyRecord) {
  if (getFinalizationBlockers(session).length) return 'draft';
  const hasOpenActions = (session.hazards ?? [])
    .map(normalizeHazard)
    .some(
      (hazard: LegacyRecord) =>
        hazard.status === HAZARD_STATUS.ACTION_REQUIRED && !isCorrectiveActionClosed(hazard.correctiveAction)
    );
  return hasOpenActions ? 'actions_open' : 'completed';
}

export function normalizeSessionRecord(session: LegacyRecord = {}) {
  const normalized = {
    ...session,
    workers: (session.workers ?? []).map(normalizeWorker),
    hazards: (session.hazards ?? []).map(normalizeHazard),
    nearMisses: Array.isArray(session.nearMisses) ? session.nearMisses : [],
    sharing: normalizeSharing(session.sharing)
    , attendanceSummary: normalizeAttendanceSummary(session.attendanceSummary)
  };
  const canPreserveFinalizedRecord = Boolean(session.finalizedAt || session.completedAt) && !getFinalizationBlockers(normalized).length;
  const status = canPreserveFinalizedRecord ? getRecordStatus(normalized) : 'draft';

  return {
    ...normalized,
    status,
    finalizedAt: canPreserveFinalizedRecord ? session.finalizedAt ?? session.completedAt : null,
    completedAt: status === 'completed' ? session.completedAt ?? session.finalizedAt ?? null : null,
    legacyCompletedAt: status === 'draft' ? session.completedAt ?? null : session.legacyCompletedAt ?? null
  };
}
