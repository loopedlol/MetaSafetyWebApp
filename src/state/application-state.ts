import { SHARING_STATUS, createEmptyAcknowledgment } from '../domain/workflow.ts';

export function createApplicationState({ stressMemo = '', appVersion }: { stressMemo?: string; appVersion: string }) {
  return {
    phase: 'auth-check', authMode: 'login', authFeedback: '', isAuthSubmitting: false,
    currentUser: null, hazards: [], index: 0, memo: stressMemo,
    session: {
      sessionId: crypto.randomUUID(), createdAt: new Date().toISOString(),
      siteName: '서울 강동 스마트타워 신축공사', siteArea: 'Tower A / Level 3 / Grid B-12',
      gps: { latitude: null, longitude: null, accuracyMeters: null },
      taskName: '전기 배선 및 자재 반입 전 TBM', workType: 'Construction safety TBM',
      plannedWorkDescription: '전기 배선, 케이블 트레이 설치, 자재 반입 전 유해위험요인 확인.',
      supervisorName: '김지훈', supervisorRole: '현장 안전관리자', scheduledAt: new Date(),
      startedAt: null, finalizedAt: null, completedAt: null,
      sharing: { status: SHARING_STATUS.NOT_RECORDED, method: '', recipients: '', sharedAt: null, acknowledgmentResults: '' },
      attendanceSummary: null,
      device: { platform: 'browser_hud_prototype', appVersion, inputMode: 'keyboard_and_touch' }
    },
    workers: [
      { id: crypto.randomUUID(), name: '박민준', role: '전기공', present: false, acknowledgment: createEmptyAcknowledgment() },
      { id: crypto.randomUUID(), name: '이지수', role: '신호수', present: false, acknowledgment: createEmptyAcknowledgment() },
      { id: crypto.randomUUID(), name: '최하나', role: '자재 반입 담당', present: false, acknowledgment: createEmptyAcknowledgment() },
      { id: crypto.randomUUID(), name: '정도윤', role: '작업반장', present: false, acknowledgment: createEmptyAcknowledgment() }
    ],
    responses: [], nearMisses: [], savedSessions: [], savedSessionsStatus: 'idle', saveFeedback: '',
    pairingScopes: { sites: [], sessions: [] }, supervisorPairing: null, pairingFeedback: '',
    nativeDevices: [], nativeDevicesStatus: 'idle', nativeDeviceRegistration: null, nativeDeviceFeedback: '',
    evidenceRequests: [], evidenceRequestsStatus: 'idle', evidenceRequestFeedback: '', evidenceFulfillment: null,
    isSavingSession: false, manualEntryFeedback: '', manualAiSuggestion: null, manualAiDecision: null,
    manualUploadedEvidence: [],
    returnPhase: 'checklist', draftStatus: '', pendingDraft: null, offlineStore: null, syncEngine: null,
    serverRevision: 0, syncConflict: null, glassesStep: 'start', glassesReturnStep: 'hazard_decision',
    glassesAttendanceDigits: { expectedTens: 0, expectedOnes: 4, presentTens: 0, presentOnes: 0 },
    glassesProvisionalDecision: null, glassesContext: null,
    glassesEvidenceRequest: null, nativeDeviceAvailable: null,
    glassesSharingFeedback: '', glassesSubmissionStatus: '',
    glassesHelpOpen: false, glassesAnnouncement: '', glassesMemoFeedback: '', glassesPhotoFeedback: '', glassesReviewFeedback: '',
    glassesFocusId: '', glassesFocusView: '',
    glassesPairing: { stage: 'intro', digits: [0, 0, 0, 0, 0, 0], digitIndex: 0, focusId: 'pairing-enter', feedback: '', submitting: false, scope: null },
    deviceConnectionState: 'online'
  };
}

export type ApplicationState = ReturnType<typeof createApplicationState>;
