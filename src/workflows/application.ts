// @ts-nocheck
import '../styles.css';
import {
  HAZARD_STATUS,
  SHARING_STATUS,
  VERIFICATION_STATUS,
  WORK_STATUS,
  createEmptyAcknowledgment,
  getFinalizationBlockers,
  getRecordStatus,
  isCorrectiveActionClosed,
  markAllWorkersPresent,
  normalizeCorrectiveAction,
  normalizeHazard,
  normalizeHazardStatus,
  normalizeSessionRecord,
  normalizeSharing,
  normalizeWorker,
  setSupervisorRecordedAcknowledgment,
  setWorkerAttendance
} from '../domain/workflow.ts';
import { openOfflineStore, SYNC_STATUS } from '../storage/offline-store.ts';
import { createSyncEngine } from '../storage/sync-engine.ts';
import { createApplicationState } from '../state/application-state.ts';
import { escapeHtml, formatDateTime } from '../views/shared/format.ts';
import { apiRequest } from '../api/client.ts';
import { validatePublicUserBoundary, validateSessionBoundary } from '../domain/validation.ts';
import { DRAFT_STATUS_TEXT, syncStatusForLabel } from '../views/dashboard/sync-status.ts';
import { createMockGlassesEvidence, isGlassesPreview, normalBrowserUrl } from '../views/glasses/model.ts';

// ---------------------------------------------------------------------------
// Constants / config
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = '2.0.0';
const APP_VERSION = '0.1.0';

const stressMemo =
  'Long memo stress test: crew reported this needs barricades, signage, owner assignment, and follow-up before restart. This text should wrap and scroll inside the memo field without pushing buttons over other content.';

const isStressTest = new URLSearchParams(window.location.search).has('stress');
// Glasses HUD Mode is a browser preview for a future Meta Display / wearable app.
const isGlassesMode = isGlassesPreview(window.location.search);
const LOCAL_DRAFT_VERSION = 2;

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

const state = createApplicationState({ stressMemo: isStressTest ? stressMemo : '', appVersion: APP_VERSION });

const app = document.querySelector('#app');

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

async function apiFetch(url, options = {}) {
  const response = await apiRequest(url, options);
  if (response.status === 401) {
    state.currentUser = null;
    state.authMode = 'login';
    state.authFeedback = 'Please log in to continue.';
    state.phase = 'auth';
    render();
  }

  return response;
}

function getApiErrorMessage(error, fallback) {
  if (error instanceof TypeError) {
    return `${fallback} Make sure the backend server is running with npm run server.`;
  }

  return error.message || fallback;
}

// ---------------------------------------------------------------------------
// Icon helpers
// ---------------------------------------------------------------------------

const iconPaths = {
  info: '<circle cx="12" cy="12" r="9"></circle><path d="M12 11v5"></path><path d="M12 8h.01"></path>',
  login: '<path d="M10 17l5-5-5-5"></path><path d="M15 12H3"></path><path d="M15 4h3a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3h-3"></path>',
  register: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M19 8v6"></path><path d="M22 11h-6"></path>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle>',
  email: '<rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="m3 7 9 6 9-6"></path>',
  lock: '<rect x="4" y="11" width="16" height="9" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path>',
  key: '<circle cx="7.5" cy="15.5" r="3.5"></circle><path d="M10 13 21 2"></path><path d="m16 7 3 3"></path>',
  site: '<path d="M12 21s7-4.8 7-11a7 7 0 1 0-14 0c0 6.2 7 11 7 11Z"></path><circle cx="12" cy="10" r="2.5"></circle>',
  task: '<rect x="5" y="4" width="14" height="16" rx="2"></rect><path d="M9 8h6"></path><path d="M9 12h6"></path><path d="M9 16h4"></path>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"></rect><path d="M16 3v4"></path><path d="M8 3v4"></path><path d="M3 11h18"></path>',
  add: '<path d="M12 5v14"></path><path d="M5 12h14"></path>',
  photo: '<rect x="3" y="5" width="18" height="16" rx="2"></rect><circle cx="8.5" cy="10.5" r="1.5"></circle><path d="m21 15-5-5L5 21"></path>',
  location: '<path d="M12 21s6-5.3 6-11a6 6 0 1 0-12 0c0 5.7 6 11 6 11Z"></path><circle cx="12" cy="10" r="2"></circle>',
  risk: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"></path><path d="M12 9v4"></path><path d="M12 17h.01"></path>',
  category: '<path d="M4 4h7v7H4z"></path><path d="M13 4h7v7h-7z"></path><path d="M4 13h7v7H4z"></path><path d="M13 13h7v7h-7z"></path>',
  action: '<path d="M4 13l5 5L20 7"></path><path d="M14 7h6v6"></path>',
  status: '<circle cx="12" cy="12" r="9"></circle><path d="m9 12 2 2 4-4"></path>',
  report: '<path d="M6 3h9l3 3v15H6z"></path><path d="M14 3v4h4"></path><path d="M9 13h6"></path><path d="M9 17h6"></path>'
};

function v2Icon(name = 'info') {
  const path = iconPaths[name] ?? iconPaths.info;
  return `<span class="v2-icon-box" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false">${path}</svg></span>`;
}

function v2Logo() {
  return `
    <div class="v2-brand">
      <span class="v2-lens-mark" aria-hidden="true"></span>
      <span class="v2-brand-text">Safety <strong>Lens</strong></span>
      <span class="v2-version">V2</span>
    </div>
  `;
}

function v2Progress(current, total, label = '', type = 'workflow') {
  return `
    <div class="v2-progress is-${type}">
      <div class="v2-progress-text">
        <strong>${current}</strong><span>/ ${total}</span>
        ${label ? `<em>${escapeHtml(label)}</em>` : ''}
      </div>
      <div class="v2-progress-steps" aria-hidden="true">
        ${Array.from({ length: total })
          .map((_, index) => `<i class="${index < current ? 'is-active' : ''}"></i>`)
          .join('')}
      </div>
    </div>
  `;
}

function v2WorkflowProgress(step) {
  return v2Progress(step, 4, 'Workflow', 'workflow');
}

function v2ChecklistProgress() {
  return v2Progress(getCurrentHazardNumber(), state.hazards.length, 'Hazards', 'checklist');
}

function v2Header(title, progressHtml = '') {
  return `
    <header class="v2-header">
      ${v2Logo()}
      <div class="v2-header-title"><h1>${escapeHtml(title)}</h1></div>
      <div class="v2-header-right">
        ${progressHtml}
      </div>
    </header>
  `;
}

function v2StatusChip(label, value, tone = 'neutral') {
  return `
    <div class="v2-status-chip is-${tone}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function buildUserBadge() {
  if (!state.currentUser) return '';

  return `
    <section class="v2-user-badge user-badge" aria-label="Logged in user">
      ${v2Icon('user')}
      <span>${escapeHtml(state.currentUser.name)}</span>
      <button class="focusable v2-user-logout" data-action="logout" aria-label="Logout">Logout</button>
    </section>
  `;
}

// ---------------------------------------------------------------------------
// Auth flow
// ---------------------------------------------------------------------------

async function checkAuth() {
  state.phase = 'auth-check';
  render();

  try {
    const response = await apiRequest('/api/auth/me', { cache: 'no-store' });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok || !validatePublicUserBoundary(payload.user)) {
      state.currentUser = null;
      state.phase = 'auth';
      render();
      return;
    }

    state.currentUser = payload.user;
    await state.offlineStore?.putProfile({ userId: payload.user.id, user: payload.user });
    await loadHazards();
  } catch (error) {
    const profiles = await state.offlineStore?.listProfiles().catch(() => []) ?? [];
    const cached = profiles[0];
    if (!navigator.onLine && cached?.user) {
      state.currentUser = cached.user;
      state.authFeedback = 'Offline mode — identity is cached on this device; server authentication will be rechecked online.';
      await loadHazards();
    } else {
      state.currentUser = null;
      state.authFeedback = getApiErrorMessage(error, 'Could not check login status.');
      state.phase = 'auth';
      render();
    }
  }
}

async function submitAuth(form) {
  if (state.isAuthSubmitting) return;

  const formData = new FormData(form);
  const isRegister = state.authMode === 'register';
  const payload = {
    email: String(formData.get('email') ?? '').trim(),
    password: String(formData.get('password') ?? '')
  };

  if (isRegister) {
    payload.name = String(formData.get('name') ?? '').trim();
    payload.role = String(formData.get('role') ?? 'supervisor').trim() || 'supervisor';
    payload.registrationKey = String(formData.get('registrationKey') ?? '');
  }

  state.isAuthSubmitting = true;
  state.authFeedback = isRegister ? 'Creating account...' : 'Logging in...';
  render();

  try {
    const response = await apiRequest(isRegister ? '/api/auth/register' : '/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(result.error ?? 'Authentication failed.');
    }

    if (!validatePublicUserBoundary(result.user)) throw new Error('Authentication response is invalid.');
    state.currentUser = result.user;
    await state.offlineStore?.putProfile({ userId: result.user.id, user: result.user });
    state.authFeedback = '';
    await loadHazards();
  } catch (error) {
    state.authFeedback = getApiErrorMessage(error, 'Authentication failed.');
    state.phase = 'auth';
    render();
  } finally {
    state.isAuthSubmitting = false;
  }
}

async function logout() {
  await apiRequest('/api/auth/logout', { method: 'POST' }).catch(() => {});
  state.currentUser = null;
  state.authMode = 'login';
  state.authFeedback = 'Logged out.';
  state.phase = 'auth';
  render();
}

// ---------------------------------------------------------------------------
// Offline-first device storage and synchronization helpers
// ---------------------------------------------------------------------------
// IndexedDB stores structured drafts, queued operations, and photo blobs. Auth
// cookies, passwords, registration keys, and login form values are never stored.

function buildLocalDraft() {
  return {
    id: state.session.sessionId,
    ownerId: state.currentUser?.id,
    version: LOCAL_DRAFT_VERSION,
    deviceObservedAt: new Date().toISOString(),
    syncStatus: statusToSyncValue(state.draftStatus),
    serverRevision: state.serverRevision,
    phase: state.phase,
    index: state.index,
    memo: state.memo,
    session: state.session,
    workers: state.workers,
    hazards: state.hazards,
    responses: state.responses,
    nearMisses: state.nearMisses,
    glassesStep: state.glassesStep,
    glassesMemoFeedback: state.glassesMemoFeedback,
    glassesPhotoFeedback: state.glassesPhotoFeedback,
    glassesReviewFeedback: state.glassesReviewFeedback,
    saveFeedback: state.saveFeedback
  };
}

function isValidLocalDraft(draft) {
  return Boolean(
    draft &&
      [1, LOCAL_DRAFT_VERSION].includes(draft.version) &&
      draft.session &&
      Array.isArray(draft.workers) &&
      Array.isArray(draft.responses) &&
      Array.isArray(draft.nearMisses)
  );
}

async function clearLocalDraft(updateStatus = true) {
  await state.offlineStore?.deleteDraft(state.session.sessionId).catch(() => {});
  if (updateStatus) state.draftStatus = DRAFT_STATUS_TEXT.CLEARED;
}

async function loadLocalDraft() {
  if (!state.offlineStore) return null;
  const drafts = await state.offlineStore.listDrafts();
  return drafts
    .filter((draft) => isValidLocalDraft(draft) && (!draft.ownerId || draft.ownerId === state.currentUser?.id))
    .sort((first, second) => String(second.deviceUpdatedAt).localeCompare(String(first.deviceUpdatedAt)))[0] ?? null;
}

function statusToSyncValue(label) {
  return syncStatusForLabel(label);
}

function saveLocalDraft(status = DRAFT_STATUS_TEXT.DEVICE_ONLY) {
  if (!state.currentUser || state.phase === 'draft-restore' || !state.hazards.length || !state.responses.length) {
    return;
  }
  state.draftStatus = status;
  void state.offlineStore?.putDraft(buildLocalDraft()).catch(() => {
    state.draftStatus = DRAFT_STATUS_TEXT.UNAVAILABLE;
    render();
  });
}

async function queueCurrentMutation(type = 'session_upsert', entityId = state.session.sessionId, saveMode = 'draft') {
  if (!state.offlineStore) return;
  saveLocalDraft(DRAFT_STATUS_TEXT.QUEUED);
  await state.offlineStore.queueSessionMutation({
    ownerId: state.currentUser.id,
    type,
    entityId,
    sessionId: state.session.sessionId,
    payload: { ...buildSessionLog(), saveMode },
    baseRevision: state.serverRevision
  });
  state.draftStatus = DRAFT_STATUS_TEXT.QUEUED;
  if (navigator.onLine) void synchronizeNow();
}

async function synchronizeNow() {
  if (!state.syncEngine) return;
  await state.syncEngine.syncAll();
  const draft = await state.offlineStore?.getDraft(state.session.sessionId);
  if (draft) {
    state.serverRevision = Number(draft.serverRevision) || state.serverRevision;
    state.syncConflict = draft.conflict ?? state.syncConflict;
    if (draft.serverSession) {
      state.session.sharing = normalizeSharing(draft.serverSession.sharing);
      state.session.finalizedAt = draft.serverSession.finalizedAt ?? null;
      state.session.completedAt = draft.serverSession.completedAt ?? null;
    }
  }
  render();
}

function restoreLocalDraft(draft) {
  if (!isValidLocalDraft(draft)) {
    clearLocalDraft();
    state.pendingDraft = null;
    state.phase = 'start';
    return;
  }

  const safePhase = ['start', 'participation', 'checklist', 'manual-entry', 'summary', 'saved-sessions'].includes(
    draft.phase
  )
    ? draft.phase
    : 'start';

  state.session = {
    ...state.session,
    ...draft.session,
    completedAt: null,
    sharing: normalizeSharing(draft.session.sharing)
  };
  state.workers = draft.workers.map(normalizeWorker);
  state.hazards = Array.isArray(draft.hazards) && draft.hazards.length ? draft.hazards : state.hazards;
  state.responses = draft.responses.map(normalizeHazard);
  state.nearMisses = draft.nearMisses;
  state.index = Math.max(0, Math.min(state.responses.length - 1, Number(draft.index) || 0));
  state.phase = safePhase;
  state.memo = draft.memo ?? currentResponse()?.memo ?? '';
  state.glassesStep = draft.glassesStep ?? (safePhase === 'checklist' ? 'hazard' : 'start');
  state.glassesMemoFeedback = draft.glassesMemoFeedback ?? '';
  state.glassesPhotoFeedback = draft.glassesPhotoFeedback ?? '';
  state.glassesReviewFeedback = draft.glassesReviewFeedback ?? '';
  state.saveFeedback = draft.saveFeedback ?? '';
  state.serverRevision = Number(draft.serverRevision) || 0;
  state.syncConflict = draft.conflict ?? null;
  state.pendingDraft = null;
  state.draftStatus = DRAFT_STATUS_TEXT.RESTORED;
}

function draftStatusHtml() {
  if (!state.draftStatus) return '';
  const retry = [DRAFT_STATUS_TEXT.FAILED, DRAFT_STATUS_TEXT.QUEUED].includes(state.draftStatus)
    ? '<button class="focusable v2-key-button v2-key-small" data-action="retry-sync">Retry sync</button>'
    : '';
  const resolve = state.draftStatus === DRAFT_STATUS_TEXT.CONFLICT
    ? '<button class="focusable v2-key-button v2-key-small" data-action="resolve-conflict-local">Review and keep local changes</button>'
    : '';
  return `<div class="draft-status"><span>${escapeHtml(state.draftStatus)}</span>${retry}${resolve}</div>`;
}

// ---------------------------------------------------------------------------
// Hazard / session helpers
// ---------------------------------------------------------------------------

function currentHazard() {
  return state.hazards[state.index];
}

function currentResponse() {
  return state.responses[state.index];
}

function createResponses(hazards) {
  return hazards.map((hazard) => normalizeHazard({
    id: hazard.id,
    source: hazard.source ?? 'preloaded_checklist',
    title: hazard.title ?? hazard.name,
    category: hazard.category ?? 'general',
    location: hazard.location,
    riskLevel: hazard.riskLevel ?? 'medium',
    riskDescription: hazard.risk,
    recommendedAction: hazard.recommendedAction ?? hazard.action,
    evidencePhotos: hazard.evidencePhotos ?? [],
    status: HAZARD_STATUS.NOT_CHECKED,
    memo: isStressTest ? stressMemo : '',
    updatedAt: null,
    humanReview: {
      reviewed: false,
      decision: HAZARD_STATUS.NOT_CHECKED,
      reviewedBy: null,
      reviewedAt: null
    },
    correctiveAction: normalizeCorrectiveAction({}, HAZARD_STATUS.NOT_CHECKED)
  }));
}

function createManualHazardResponse(entry) {
  return normalizeHazard({
    id: entry.id,
    source: 'manual_entry',
    title: entry.title,
    category: entry.category ?? 'manual_entry',
    location: entry.location,
    riskLevel: entry.riskLevel,
    riskDescription: entry.description,
    recommendedAction: entry.recommendedAction,
    evidencePhotos: entry.evidencePhotos ?? [],
    aiSuggestion: entry.aiSuggestion ?? null,
    status: HAZARD_STATUS.NOT_CHECKED,
    memo: '',
    updatedAt: null,
    humanReview: {
      reviewed: false,
      decision: HAZARD_STATUS.NOT_CHECKED,
      reviewedBy: null,
      reviewedAt: null
    },
    correctiveAction: normalizeCorrectiveAction({}, HAZARD_STATUS.NOT_CHECKED)
  });
}

async function loadHazards() {
  renderLoading();

  try {
    const response = await apiRequest('/hazards.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Could not load hazards.json (${response.status})`);

    const hazards = await response.json();
    state.hazards = isStressTest ? makeStressHazards(hazards) : hazards;
    state.responses = createResponses(state.hazards);
    const draft = await loadLocalDraft();
    if (draft) {
      state.pendingDraft = draft;
      state.draftStatus = DRAFT_STATUS_TEXT.FOUND;
      state.phase = 'draft-restore';
    } else {
      state.phase = 'start';
    }
  } catch (error) {
    state.phase = 'error';
    state.error = error.message || 'Could not load hazards.json. Check that the frontend server can serve public assets.';
  }

  render();
}

function makeStressHazards(hazards) {
  return [
    {
      id: 'open-floor-hole-stress',
      name: 'Open floor hole with unusually long inspection title that must wrap across multiple lines without colliding with the progress bar or action controls',
      location:
        'Level 3 east wing corridor beside the temporary hoist landing and material staging zone near gridline C-12',
      category: 'fall_prevention',
      riskLevel: 'high',
      risk:
        'Fall-through hazard near active work area with foot traffic moving around stored materials, ladders, and temporary lighting.',
      action:
        'Cover the opening with a rated panel, label it clearly, barricade the full perimeter, assign an owner, and prevent work from continuing in the exposed zone until the fix is confirmed by the supervisor.'
    },
    ...hazards.slice(1)
  ];
}

// ---------------------------------------------------------------------------
// Normal dashboard actions
// ---------------------------------------------------------------------------

function markRecordDirty() {
  state.session.finalizedAt = null;
  state.session.completedAt = null;
}

function saveStartField(name, value) {
  markRecordDirty();
  state.session[name] = value.trim();
  saveLocalDraft();
}

function startTbm() {
  markRecordDirty();
  state.session.startedAt = new Date().toISOString();
  state.phase = 'participation';
  saveLocalDraft(DRAFT_STATUS_TEXT.DEVICE_ONLY);
  render();
}

function addWorker(name) {
  const trimmed = name.trim();
  if (!trimmed) return;

  markRecordDirty();
  state.workers.push({
    id: crypto.randomUUID(),
    name: trimmed,
    role: 'Worker',
    present: true,
    acknowledgment: createEmptyAcknowledgment()
  });
  saveLocalDraft();
  render();
}

function removeWorker(id) {
  markRecordDirty();
  state.workers = state.workers.filter((worker) => worker.id !== id);
  saveLocalDraft();
  render();
}

function setWorkerPresent(id, present) {
  markRecordDirty();
  state.workers = setWorkerAttendance(state.workers, id, present);
  saveLocalDraft();
  void queueCurrentMutation('attendance_acknowledgment', id);
  render();
}

function setWorkerAcknowledgment(id, recorded) {
  markRecordDirty();
  state.workers = setSupervisorRecordedAcknowledgment(state.workers, id, recorded, {
    recordedBy: state.session.supervisorName,
    recordedAt: new Date().toISOString()
  });
  saveLocalDraft();
  void queueCurrentMutation('attendance_acknowledgment', id);
  render();
}

function markAllPresent() {
  markRecordDirty();
  state.workers = markAllWorkersPresent(state.workers);
  saveLocalDraft();
  void queueCurrentMutation('attendance_acknowledgment', state.session.sessionId);
  render();
}

function continueToChecklist() {
  state.phase = 'checklist';
  state.index = 0;
  state.memo = currentResponse()?.memo ?? '';
  saveLocalDraft();
  render();
}

function saveMemo(value) {
  markRecordDirty();
  state.memo = value;
  currentResponse().memo = value.trim();
  saveLocalDraft();
}

function updateCorrectiveAction(field, value) {
  const response = currentResponse();
  if (!response) return;

  markRecordDirty();
  const current = normalizeCorrectiveAction(response.correctiveAction, response.status);
  const nextValue = field === 'closureEvidence' ? (value.trim() ? [value.trim()] : []) : value;
  response.correctiveAction = normalizeCorrectiveAction({ ...current, [field]: nextValue }, response.status);
  saveLocalDraft();
  void queueCurrentMutation('corrective_action', response.id);
}

function updateSharing(field, value) {
  markRecordDirty();
  const next = { ...normalizeSharing(state.session.sharing), [field]: value };
  if (field === 'status' && value !== SHARING_STATUS.SHARED) {
    next.method = '';
    next.recipients = '';
    next.sharedAt = null;
  }
  state.session.sharing = normalizeSharing(next);
  saveLocalDraft();
  void queueCurrentMutation('sharing_event', state.session.sessionId);
}

function goTo(index) {
  if (state.phase !== 'checklist') return;

  if (
    index >= state.hazards.length &&
    state.responses.every((item) => normalizeHazardStatus(item.status) !== HAZARD_STATUS.NOT_CHECKED)
  ) {
    state.phase = 'summary';
    saveLocalDraft();
    render();
    return;
  }

  state.index = Math.max(0, Math.min(state.hazards.length - 1, index));
  state.memo = currentResponse().memo;
  saveLocalDraft();
  render();
}

function setStatus(status) {
  if (state.phase !== 'checklist') return;

  markRecordDirty();
  const response = currentResponse();
  const reviewedAt = new Date().toISOString();
  response.status = normalizeHazardStatus(status);
  response.memo = state.memo.trim();
  response.updatedAt = reviewedAt;
  response.humanReview = {
    reviewed: true,
    decision: response.status,
    reviewedBy: state.session.supervisorName,
    reviewedAt
  };

  response.correctiveAction = normalizeCorrectiveAction(response.correctiveAction, response.status);

  if (
    response.status === HAZARD_STATUS.CONTROLLED &&
    state.responses.every((item) => normalizeHazardStatus(item.status) !== HAZARD_STATUS.NOT_CHECKED)
  ) {
    state.phase = 'summary';
  } else if (response.status === HAZARD_STATUS.CONTROLLED && state.index < state.hazards.length - 1) {
    state.index += 1;
    state.memo = currentResponse().memo;
  }

  saveLocalDraft();
  void queueCurrentMutation('hazard_review', response.id);
  render();
}

// ---------------------------------------------------------------------------
// Glasses HUD actions
// ---------------------------------------------------------------------------
// Glasses mode shares the same session, response, draft, save, and report model
// as the normal dashboard; only the interaction layer is different.
// Future Meta Web Apps integration points:
// - Replace getMockEvidencePhoto/captureGlassesPhoto with camera/photo capture.
// - Replace captureGlassesMemo with voice memo or speech-to-text capture.
// - Add phone GPS / site-location APIs near session startup when available.
// - Add local offline storage around shared session state before backend sync.

function getMockEvidencePhoto() {
  return createMockGlassesEvidence(getCurrentHazardNumber());
}

function captureGlassesMemo() {
  if (!currentResponse()) return;

  markRecordDirty();
  // Future voice memo / speech-to-text hook: replace this fixed memo with transcript text.
  const memo = 'Voice memo captured: supervisor requested follow-up before restart.';
  state.memo = memo;
  currentResponse().memo = memo;
  state.glassesMemoFeedback = memo;
  state.glassesStep = 'memo';
  saveLocalDraft();
  render();
}

function captureGlassesPhoto() {
  const response = currentResponse();
  if (!response) return;

  markRecordDirty();
  // Future camera/photo hook: replace this mock placeholder with device capture metadata.
  response.evidencePhotos = [...(response.evidencePhotos ?? []), getMockEvidencePhoto()];
  response.updatedAt = new Date().toISOString();
  state.glassesPhotoFeedback = 'Mock photo evidence captured for this hazard.';
  state.glassesStep = 'photo';
  saveLocalDraft();
  render();
}

function startGlassesTbm() {
  // Future phone GPS / site location hook can update state.session.gps here.
  markRecordDirty();
  if (!state.session.startedAt) state.session.startedAt = new Date().toISOString();
  state.phase = 'participation';
  state.glassesStep = 'workers';
  saveLocalDraft(DRAFT_STATUS_TEXT.DEVICE_ONLY);
  render();
}

function continueGlassesFromWorkers() {
  markRecordDirty();
  state.workers = markAllWorkersPresent(state.workers);
  state.phase = 'checklist';
  state.index = 0;
  state.memo = currentResponse()?.memo ?? '';
  state.glassesStep = 'hazard';
  saveLocalDraft();
  void queueCurrentMutation('attendance_acknowledgment', state.session.sessionId);
  render();
}

function continueGlassesReview() {
  if (state.phase === 'summary' || state.glassesStep === 'summary') {
    state.glassesStep = 'summary';
    saveLocalDraft();
    render();
    return;
  }

  state.glassesStep = 'hazard';
  saveLocalDraft();
  render();
}

function exitGlassesMode() {
  window.location.href = normalBrowserUrl(window.location.href);
}

function handleGlassesAction(action) {
  // This action router is the portability seam for future Neural Band gestures.
  // Browser keyboard/buttons call it today; hardware input should call the same actions.
  if (action === 'exit') {
    exitGlassesMode();
    return;
  }

  if (action === 'start') {
    startGlassesTbm();
    return;
  }

  if (action === 'workers') {
    continueGlassesFromWorkers();
    return;
  }

  if (action === 'memo') {
    captureGlassesMemo();
    return;
  }

  if (action === 'photo') {
    captureGlassesPhoto();
    return;
  }

  if (action === 'controlled') {
    if (state.glassesStep !== 'hazard') return;
    if (state.phase !== 'checklist') state.phase = 'checklist';
    state.glassesStep = 'hazard';
    state.glassesReviewFeedback = `Recorded on device: Hazard ${getCurrentHazardNumber()} controlled — reviewed and safe to proceed.`;
    setStatus(HAZARD_STATUS.CONTROLLED);
    return;
  }

  if (action === 'action-required') {
    if (state.glassesStep !== 'hazard') return;
    if (state.phase !== 'checklist') state.phase = 'checklist';
    state.glassesStep = 'hazard';
    state.glassesReviewFeedback = `Hazard ${getCurrentHazardNumber()} requires action. Corrective-action details remain open.`;
    setStatus(HAZARD_STATUS.ACTION_REQUIRED);
    return;
  }

  if (action === 'save-session') {
    // Future offline-first sync hook: queue locally first, then call backend save.
    saveCurrentSession('draft');
    return;
  }

  if (action === 'finalize') {
    saveCurrentSession('finalize');
    return;
  }

  if (action === 'next') {
    if (state.glassesStep === 'start') startGlassesTbm();
    else if (state.glassesStep === 'workers') continueGlassesFromWorkers();
    else if (state.glassesStep === 'memo' || state.glassesStep === 'photo') continueGlassesReview();
    else if (state.phase === 'checklist') goTo(state.index + 1);
    else state.glassesStep = 'summary';
    return;
  }

  if (action === 'prev') {
    if (state.glassesStep === 'workers') state.glassesStep = 'start';
    else if (state.glassesStep === 'hazard' && state.index > 0) goTo(state.index - 1);
    else if (state.glassesStep === 'memo' || state.glassesStep === 'photo') state.glassesStep = 'hazard';
    else if (state.glassesStep === 'summary') {
      state.phase = 'checklist';
      state.glassesStep = 'hazard';
    }
    saveLocalDraft();
    render();
  }
}

// ---------------------------------------------------------------------------
// Session export and saved-session helpers
// ---------------------------------------------------------------------------

function getHazardStatusGroups(responses = state.responses) {
  return {
    controlled: responses.filter((item) => normalizeHazardStatus(item.status) === HAZARD_STATUS.CONTROLLED),
    actionRequired: responses.filter(
      (item) => normalizeHazardStatus(item.status) === HAZARD_STATUS.ACTION_REQUIRED
    ),
    unchecked: responses.filter((item) => normalizeHazardStatus(item.status) === HAZARD_STATUS.NOT_CHECKED)
  };
}

function getHazardReviewCounts(responses = state.responses) {
  const groups = getHazardStatusGroups(responses);

  return {
    controlled: groups.controlled.length,
    actionRequired: groups.actionRequired.length,
    unchecked: groups.unchecked.length
  };
}

function getChecklistStatusTone(status) {
  if (normalizeHazardStatus(status) === HAZARD_STATUS.CONTROLLED) return 'success';
  if (normalizeHazardStatus(status) === HAZARD_STATUS.ACTION_REQUIRED) return 'warning';
  return 'neutral';
}

function getCurrentHazardNumber() {
  return state.index + 1;
}

function getHazardProgressText() {
  return `Hazard ${getCurrentHazardNumber()} / ${state.hazards.length}`;
}

function getPotentialRecordStatus() {
  return getRecordStatus({ hazards: state.responses, sharing: state.session.sharing });
}

function getSessionStatus() {
  return state.session.finalizedAt ? getPotentialRecordStatus() : 'draft';
}

function getHumanReview(item) {
  const hazardStatus = normalizeHazardStatus(item.status);

  if (hazardStatus === HAZARD_STATUS.NOT_CHECKED) {
    return {
      reviewed: false,
      decision: HAZARD_STATUS.NOT_CHECKED,
      reviewedBy: null,
      reviewedAt: null
    };
  }

  return {
    reviewed: true,
    decision: hazardStatus,
    reviewedBy: state.session.supervisorName,
    reviewedAt: item.humanReview.reviewedAt
  };
}

function getCorrectiveAction(item) {
  return normalizeCorrectiveAction(item.correctiveAction, item.status);
}

// ---------------------------------------------------------------------------
// Manual entry and mock AI helpers
// ---------------------------------------------------------------------------

function openManualEntry() {
  state.returnPhase = state.phase === 'summary' ? 'summary' : 'checklist';
  state.manualEntryFeedback = '';
  state.manualAiSuggestion = null;
  state.manualAiDecision = null;
  state.phase = 'manual-entry';
  render();
}

function cancelManualEntry() {
  state.phase = state.returnPhase;
  render();
}

async function uploadEvidencePhotos(files) {
  if (!files.length) return [];
  if (!state.offlineStore) throw new Error('Offline photo storage is unavailable.');
  const records = [];
  for (const file of files) {
    const evidence = await state.offlineStore.putEvidence({
      ownerId: state.currentUser.id,
      sessionId: state.session.sessionId,
      blob: file,
      originalName: file.name,
      mimeType: file.type,
      size: file.size
    });
    await state.offlineStore.queueEvidenceUpload(evidence);
    records.push({
      localEvidenceId: evidence.id,
      originalName: evidence.originalName,
      mimeType: evidence.mimeType,
      size: evidence.size,
      deviceObservedAt: evidence.deviceObservedAt,
      source: 'device_evidence_pending_sync'
    });
  }
  state.draftStatus = DRAFT_STATUS_TEXT.QUEUED;
  return records;
}

function renderAiSuggestion() {
  const container = app.querySelector('#ai-suggestion-panel');
  if (!container) return;

  if (!state.manualAiSuggestion) {
    container.innerHTML = '';
    return;
  }

  const suggestion = state.manualAiSuggestion;
  const decisionText =
    state.manualAiDecision === 'accepted'
      ? 'Accepted'
      : state.manualAiDecision === 'rejected'
        ? 'Rejected'
        : 'Human review required';
  const confidencePercent = `${Math.round(suggestion.confidence * 100)}%`;

  container.innerHTML = `
    <section class="v2-card v2-ai-card ai-suggestion-card ${state.manualAiDecision ? `is-${state.manualAiDecision}` : ''}" aria-label="Mock AI Suggestion">
      <div class="v2-ai-header"><h3>AI Suggestion</h3><span>Beta</span></div>
      <div class="v2-ai-hero">
        <div class="v2-warning-tile">!</div>
        <div>
          <h2>${escapeHtml(suggestion.title)}</h2>
          <p>${escapeHtml(suggestion.description)}</p>
        </div>
      </div>
      <dl class="v2-ai-facts">
        <div><dt>Category</dt><dd>${escapeHtml(suggestion.category)}</dd></div>
        <div><dt>Risk Level</dt><dd>${escapeHtml(suggestion.riskLevel)}</dd></div>
        <div><dt>Confidence</dt><dd>${confidencePercent}</dd></div>
        <div><dt>Status</dt><dd>${decisionText}</dd></div>
      </dl>
      <p class="v2-ai-note">Human review required before this suggestion can affect the saved TBM record.</p>
      <p class="v2-ai-note">${escapeHtml(suggestion.recommendedAction)}</p>
      <section class="v2-ai-actions">
        <button class="focusable v2-key-button v2-key-primary v2-key-small" type="button" data-action="accept-ai">Accept Suggestion</button>
        <button class="focusable v2-key-button v2-key-small" type="button" data-action="reject-ai">Reject Suggestion</button>
      </section>
    </section>
  `;

  container.querySelector('button[data-action="accept-ai"]').addEventListener('click', () => {
    acceptManualAiSuggestion(app.querySelector('#manual-entry-form'));
  });
  container.querySelector('button[data-action="reject-ai"]').addEventListener('click', () => {
    rejectManualAiSuggestion();
  });
}

function getSelectedPhotoMetadata(files) {
  return files.map((file) => ({
    originalName: file.name,
    size: file.size,
    type: file.type
  }));
}

async function analyzeManualPhoto(form) {
  const files = Array.from(form.elements.evidencePhotos?.files ?? []);
  if (!files.length) {
    state.manualEntryFeedback = 'Attach a photo before running mock analysis.';
    app.querySelector('#manual-entry-feedback').textContent = state.manualEntryFeedback;
    return;
  }

  const analyzeButton = app.querySelector('#analyze-photo-button');
  state.manualEntryFeedback = 'Requesting mock backend AI analysis...';
  app.querySelector('#manual-entry-feedback').textContent = state.manualEntryFeedback;
  analyzeButton.disabled = true;
  analyzeButton.textContent = 'Analyzing...';

  try {
    const response = await apiFetch('/api/ai/analyze-hazard', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        entryType: form.elements.type.value,
        photos: getSelectedPhotoMetadata(files)
      })
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(payload.error ?? `Mock AI analysis failed (${response.status})`);
    }

    state.manualAiSuggestion = payload;
    state.manualAiDecision = null;
    state.manualEntryFeedback = 'Mock backend AI suggestion generated. Human review required.';
    app.querySelector('#manual-entry-feedback').textContent = state.manualEntryFeedback;
    renderAiSuggestion();
  } catch (error) {
    state.manualAiSuggestion = null;
    state.manualAiDecision = null;
    state.manualEntryFeedback = getApiErrorMessage(error, 'Mock AI analysis failed.');
    app.querySelector('#manual-entry-feedback').textContent = state.manualEntryFeedback;
    renderAiSuggestion();
  } finally {
    analyzeButton.disabled = false;
    analyzeButton.textContent = 'Analyze Photo';
  }
}

function getManualAiMetadata() {
  if (!state.manualAiSuggestion || !state.manualAiDecision) return null;
  const accepted = state.manualAiDecision === 'accepted';

  // Mock AI metadata is saved only after an explicit human accept/reject step.
  return {
    source: state.manualAiSuggestion.source ?? 'mock_ai',
    accepted,
    rejected: !accepted,
    confidence: state.manualAiSuggestion.confidence,
    suggestedAt: state.manualAiSuggestion.suggestedAt,
    reviewedAt: new Date().toISOString()
  };
}

function acceptManualAiSuggestion(form) {
  if (!state.manualAiSuggestion) return;

  const suggestion = state.manualAiSuggestion;
  form.elements.title.value = suggestion.title;
  form.elements.category.value = suggestion.category;
  form.elements.riskLevel.value = suggestion.riskLevel;
  form.elements.description.value = suggestion.description;
  form.elements.actionText.value = suggestion.recommendedAction;
  state.manualAiDecision = 'accepted';
  state.manualEntryFeedback = 'Mock AI suggestion accepted. You can still edit before saving.';
  app.querySelector('#manual-entry-feedback').textContent = state.manualEntryFeedback;
  renderAiSuggestion();
}

function rejectManualAiSuggestion() {
  if (!state.manualAiSuggestion) return;

  state.manualAiDecision = 'rejected';
  state.manualEntryFeedback = 'Mock AI suggestion rejected. Manual inputs were kept.';
  app.querySelector('#manual-entry-feedback').textContent = state.manualEntryFeedback;
  renderAiSuggestion();
}

async function saveManualEntry(form) {
  const formData = new FormData(form);
  const type = formData.get('type');
  const now = new Date().toISOString();
  const title = String(formData.get('title') ?? '').trim();
  const category = String(formData.get('category') ?? 'manual_entry').trim() || 'manual_entry';
  const location = String(formData.get('location') ?? '').trim();
  const riskLevel = String(formData.get('riskLevel') ?? 'medium');
  const description = String(formData.get('description') ?? '').trim();
  const actionText = String(formData.get('actionText') ?? '').trim();
  const photoInput = form.elements.evidencePhotos;
  const evidencePhotoFiles = photoInput?.files ? Array.from(photoInput.files) : [];
  const aiSuggestion = getManualAiMetadata();

  if (!title || !location) return;

  markRecordDirty();

  let evidencePhotos = [];
  const feedback = app.querySelector('#manual-entry-feedback');
  const submitButton = app.querySelector('button[form="manual-entry-form"]');

  try {
    state.manualEntryFeedback = evidencePhotoFiles.length ? 'Recording photo evidence on this device...' : 'Recording entry on this device...';
    if (feedback) feedback.textContent = state.manualEntryFeedback;
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = 'Recording...';
    }
    evidencePhotos = await uploadEvidencePhotos(evidencePhotoFiles);
  } catch (error) {
    state.manualEntryFeedback = getApiErrorMessage(error, 'Photo upload failed.');
    if (feedback) feedback.textContent = state.manualEntryFeedback;
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = 'Save';
    }
    return;
  }

  if (type === 'near_miss') {
    state.nearMisses.push({
      id: crypto.randomUUID(),
      source: 'near_miss',
      title,
      category,
      location,
      riskLevel,
      description,
      actionTaken: actionText,
      evidencePhotos,
      aiSuggestion,
      reportedBy: state.session.supervisorName,
      reportedAt: now
    });
  } else {
    const hazard = {
      id: crypto.randomUUID(),
      name: title,
      source: 'manual_entry',
      category,
      location,
      riskLevel,
      risk: description,
      action: actionText,
      evidencePhotos,
      aiSuggestion
    };
    state.hazards.push(hazard);
    state.responses.push(
      createManualHazardResponse({
        id: hazard.id,
        title,
        category,
        location,
        riskLevel,
        description,
        recommendedAction: actionText,
        evidencePhotos,
        aiSuggestion
      })
    );
  }

  state.manualEntryFeedback = '';
  state.manualAiSuggestion = null;
  state.manualAiDecision = null;
  state.phase = state.returnPhase;
  saveLocalDraft();
  void queueCurrentMutation('session_upsert', state.session.sessionId);
  render();
}

function formatKoreanList(items, emptyText) {
  if (!items.length) return `<li>${escapeHtml(emptyText)}</li>`;

  return items.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
}

function formatReportPreviewItem(item, actionText = '') {
  const photos = item.evidencePhotos?.length ? ` / 사진 ${item.evidencePhotos.length}건` : '';
  const ai =
    item.aiSuggestion?.accepted === true
      ? ' / Mock AI 참고 의견 수락'
      : item.aiSuggestion?.rejected === true
        ? ' / Mock AI 참고 의견 거부'
        : '';
  const action = actionText ? ` - ${actionText}` : '';
  return `${item.title} (${item.location}, 위험도: ${item.riskLevel})${action}${photos}${ai}`;
}

function buildKoreanReportHtml() {
  const presentWorkers = state.workers.filter((worker) => worker.present);
  const supervisorAcknowledgedWorkers = state.workers.filter(
    (worker) => normalizeWorker(worker).acknowledgment.supervisorRecorded
  );
  const independentlyVerifiedWorkers = state.workers.filter(
    (worker) => normalizeWorker(worker).acknowledgment.independentlyVerified
  );
  const { controlled, actionRequired, unchecked } = getHazardStatusGroups();
  const openActions = actionRequired.filter((item) => !isCorrectiveActionClosed(getCorrectiveAction(item)));
  const closedActions = actionRequired.filter((item) => isCorrectiveActionClosed(getCorrectiveAction(item)));
  const sharing = normalizeSharing(state.session.sharing);
  const hazardLines = state.responses.map((item) => formatReportPreviewItem(item));
  const nearMissLines = state.nearMisses.map((item) =>
    formatReportPreviewItem(item, item.actionTaken || '조치 내용 미입력')
  );
  const manualHazardLines = state.responses
    .filter((item) => item.source === 'manual_entry')
    .map((item) => formatReportPreviewItem(item));

  return `
    <section class="report-preview" aria-label="Korean TBM report preview">
      <h2>작업 전 안전회의(TBM) 보고서 미리보기</h2>
      <dl class="report-meta">
        <div>
          <dt>현장명</dt>
          <dd>${escapeHtml(state.session.siteName)}</dd>
        </div>
        <div>
          <dt>작업구역</dt>
          <dd>${escapeHtml(state.session.siteArea)}</dd>
        </div>
        <div>
          <dt>작업명</dt>
          <dd>${escapeHtml(state.session.taskName)}</dd>
        </div>
        <div>
          <dt>TBM 실시자</dt>
          <dd>${escapeHtml(state.session.supervisorName)} / ${escapeHtml(state.session.supervisorRole)}</dd>
        </div>
        <div>
          <dt>기록 상태</dt>
          <dd>${escapeHtml(getSessionStatus())}</dd>
        </div>
      </dl>

      <section>
        <h3>참석 근로자</h3>
        <ul>${formatKoreanList(
          presentWorkers.map((worker) => `${worker.name} (${worker.role})`),
          '참석 근로자 없음'
        )}</ul>
      </section>

      <section><h3>감독자 기록 TBM 확인</h3><ul>${formatKoreanList(
        supervisorAcknowledgedWorkers.map((worker) => `${worker.name} — 감독자 기록, 근로자 독립 검증 아님`),
        '감독자 기록 확인 없음'
      )}</ul></section>

      <section><h3>독립적으로 검증된 근로자 확인</h3><ul>${formatKoreanList(
        independentlyVerifiedWorkers.map((worker) => worker.name),
        '독립 검증 확인 없음'
      )}</ul></section>

      <section>
        <h3>전체 유해위험요인</h3>
        <ul>${formatKoreanList(hazardLines, '등록된 유해위험요인 없음')}</ul>
      </section>

      <section>
        <h3>수기 입력 유해위험요인</h3>
        <ul>${formatKoreanList(manualHazardLines, '수기 입력 유해위험요인 없음')}</ul>
      </section>

      <section>
        <h3>아차사고 및 Near-miss 기록</h3>
        <ul>${formatKoreanList(nearMissLines, '아차사고 기록 없음')}</ul>
      </section>

      <section>
        <h3>통제 확인 항목(Controlled)</h3>
        <ul>${formatKoreanList(
          controlled.map((item) => item.title),
          '통제 확인 항목 없음'
        )}</ul>
      </section>

      <section>
        <h3>미종결 시정조치</h3>
        <ul>${formatKoreanList(
          openActions.map((item) => formatReportPreviewItem(item, getCorrectiveAction(item).immediateControl)),
          '미종결 시정조치 없음'
        )}</ul>
      </section>

      <section><h3>검증 완료 시정조치</h3><ul>${formatKoreanList(
        closedActions.map((item) => formatReportPreviewItem(item, `검증자: ${getCorrectiveAction(item).verifiedBy}`)),
        '검증 완료 시정조치 없음'
      )}</ul></section>

      <section>
        <h3>미확인 항목(Not Checked)</h3>
        <ul>${formatKoreanList(
          unchecked.map((item) => item.title),
          '미확인 항목 없음'
        )}</ul>
      </section>

      <section><h3>근로자 공유 증빙</h3><ul>${formatKoreanList(
        sharing.status === SHARING_STATUS.SHARED
          ? [`방법: ${sharing.method} / 수신: ${sharing.recipients} / 서버 기록: ${sharing.sharedAt ?? '저장 후 기록'}`]
          : sharing.status === SHARING_STATUS.NOT_SHARED
            ? ['공유하지 않음으로 기록']
            : [],
        '공유 여부 미기록'
      )}</ul></section>
    </section>
  `;
}

async function copySessionLog(button) {
  const payload = JSON.stringify(buildSessionLog(), null, 2);

  try {
    await navigator.clipboard.writeText(payload);
    button.textContent = 'Copied';
  } catch {
    button.textContent = 'Copy failed';
  }

  window.setTimeout(() => {
    button.textContent = 'Copy JSON';
  }, 1400);
}

function getSavedSessionDate(session) {
  return session.savedAt ?? session.exportedAt ?? session.completedAt ?? session.createdAt;
}

function getSavedSessionSiteName(session) {
  return session.site?.siteName ?? session.siteName ?? 'Unknown site';
}

function formatSavedSessionDate(session) {
  const savedDate = new Date(getSavedSessionDate(session) ?? 0);
  if (Number.isNaN(savedDate.getTime())) return 'Unknown date';
  return formatDateTime(savedDate);
}

async function saveCurrentSession(saveMode = 'draft') {
  if (state.isSavingSession) return;

  const sessionLog = buildSessionLog();
  const blockers = saveMode === 'finalize' ? getFinalizationBlockers(sessionLog) : [];
  if (blockers.length) {
    state.saveFeedback = `Cannot finalize: ${blockers.join(' ')}`;
    render();
    return;
  }

  state.isSavingSession = true;
  state.saveFeedback = 'Recording on this device and queuing synchronization...';
  render();

  try {
    await queueCurrentMutation('session_upsert', state.session.sessionId, saveMode);
    if (navigator.onLine) await synchronizeNow();
    state.saveFeedback = state.draftStatus === DRAFT_STATUS_TEXT.SYNCED
      ? 'Synchronized to server. No completion is claimed unless finalization requirements were met.'
      : 'Recorded on this device and queued for synchronization.';
  } catch (error) {
    state.saveFeedback = `${getApiErrorMessage(error, 'Synchronization failed.')} The local record was retained.`;
  } finally {
    state.isSavingSession = false;
    render();
  }
}

async function loadSavedSessions({ silent = false } = {}) {
  state.savedSessionsStatus = silent ? state.savedSessionsStatus : 'loading';
  if (!silent) render();

  try {
    const response = await apiFetch('/api/sessions', { cache: 'no-store' });
    const payload = await response.json().catch(() => []);

    if (!response.ok) {
      throw new Error(payload.error ?? `Could not load saved sessions (${response.status})`);
    }

    state.savedSessions = Array.isArray(payload)
      ? payload.filter(validateSessionBoundary).map(normalizeSessionRecord)
      : [];
    state.savedSessionsStatus = 'ready';
  } catch (error) {
    state.savedSessionsStatus = 'error';
    state.savedSessionsError = getApiErrorMessage(error, 'Could not load saved sessions.');
  }
}

async function openSavedSessions() {
  state.phase = 'saved-sessions';
  await loadSavedSessions();
  render();
}

function closeSavedSessions() {
  state.phase = state.responses.length ? 'summary' : 'start';
  render();
}

function openSessionReport(sessionId) {
  if (!sessionId) return;
  window.open(`/api/sessions/${encodeURIComponent(sessionId)}/report`, '_blank', 'noopener');
}

function buildSessionLog() {
  const exportedAt = new Date().toISOString();

  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId: state.session.sessionId,
    sessionType: 'korean_tbm_risk_assessment',
    status: getSessionStatus(),
    createdAt: state.session.createdAt,
    startedAt: state.session.startedAt,
    finalizedAt: state.session.finalizedAt ?? null,
    completedAt: state.session.completedAt ?? null,
    exportedAt,
    site: {
      siteName: state.session.siteName,
      siteArea: state.session.siteArea,
      gps: state.session.gps
    },
    work: {
      taskName: state.session.taskName,
      workType: state.session.workType,
      plannedWorkDescription: state.session.plannedWorkDescription
    },
    supervisor: {
      name: state.session.supervisorName,
      role: state.session.supervisorRole
    },
    workers: state.workers.map(normalizeWorker).map((worker) => ({
      id: worker.id,
      name: worker.name,
      role: worker.role,
      present: worker.present,
      acknowledgment: worker.acknowledgment
    })),
    hazards: state.responses.map((item) => ({
      id: item.id,
      source: item.source,
      title: item.title,
      category: item.category,
      location: item.location,
      riskLevel: item.riskLevel,
      recommendedAction: item.recommendedAction,
      evidencePhotos: item.evidencePhotos ?? [],
      aiSuggestion: item.aiSuggestion ?? null,
      status: normalizeHazardStatus(item.status),
      memo: item.memo,
      humanReview: getHumanReview(item),
      correctiveAction: getCorrectiveAction(item)
    })),
    nearMisses: state.nearMisses.map((item) => ({
      ...item,
      evidencePhotos: item.evidencePhotos ?? []
    })),
    workerFeedback: [],
    sharing: normalizeSharing(state.session.sharing),
    device: state.session.device
  };
}

// ---------------------------------------------------------------------------
// Render functions
// ---------------------------------------------------------------------------

function renderAuthChecking() {
  app.innerHTML = `
    <section class="v2-screen is-auth auth-shell">
      <div class="auth-brand-large">
        ${v2Logo()}
        <p>Worksite Awareness. Safer Outcomes.</p>
      </div>
      <section class="v2-card v2-loading-card">
        ${v2Icon('info')}
        <h2>Checking Login</h2>
        <p>Preparing protected local access...</p>
      </section>
    </section>
  `;
}

function renderAuth() {
  const isRegister = state.authMode === 'register';
  const submitText = state.isAuthSubmitting ? 'Please wait...' : isRegister ? 'Register' : 'Login';

  app.innerHTML = `
    <section class="v2-screen is-auth auth-shell">
      <div class="auth-brand-large">
        ${v2Logo()}
        <p>Worksite Awareness. Safer Outcomes.</p>
      </div>

      <section class="auth-tabs" aria-label="Authentication mode">
        <button class="focusable ${!isRegister ? 'is-active' : ''}" data-action="auth-login" type="button">${v2Icon('login')} Login</button>
        <button class="focusable ${isRegister ? 'is-active' : ''}" data-action="auth-register" type="button">${v2Icon('register')} Register</button>
      </section>

      <form class="v2-card auth-form" id="auth-form">
        ${
          isRegister
            ? `
              <div class="auth-field">
                ${v2Icon('user')}
                <label>
                  <span>Name</span>
                  <input class="focusable" name="name" autocomplete="name" placeholder="Your name" />
                </label>
              </div>
            `
            : ''
        }
        <div class="auth-field">
          ${v2Icon('email')}
          <label>
            <span>Email</span>
            <input class="focusable" name="email" type="email" autocomplete="email" placeholder="name@company.com" required />
          </label>
        </div>
        <div class="auth-field">
          ${v2Icon('lock')}
          <label>
            <span>Password</span>
            <input class="focusable" name="password" type="password" autocomplete="${
              isRegister ? 'new-password' : 'current-password'
            }" placeholder="Enter your password" minlength="8" required />
          </label>
        </div>
        ${
          isRegister
            ? `
              <div class="auth-field">
                ${v2Icon('user')}
                <label>
                  <span>Role</span>
                  <input class="focusable" name="role" value="supervisor" />
                </label>
              </div>
              <div class="auth-field">
                ${v2Icon('key')}
                <label>
                  <span>Registration key</span>
                  <input class="focusable" name="registrationKey" type="password" required />
                </label>
              </div>
            `
            : ''
        }
        <p class="save-feedback">${escapeHtml(state.authFeedback)}</p>
        <button class="focusable v2-key-button v2-key-primary v2-full-button" type="submit" ${
          state.isAuthSubmitting ? 'disabled' : ''
        }>${submitText}</button>
      </form>

      <footer class="auth-footer"><span>Your safety data is protected.</span><span>Need help? <strong>Contact support</strong></span></footer>
    </section>
  `;

  app.querySelector('#auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    await submitAuth(event.currentTarget);
  });
  bindButtons();
}

function renderLoading() {
  app.innerHTML = `
    <section class="v2-screen is-auth auth-shell">
      <div class="auth-brand-large">
        ${v2Logo()}
        <p>Worksite Awareness. Safer Outcomes.</p>
      </div>
      <section class="v2-card v2-loading-card">
        ${v2Icon('info')}
        <h2>Loading TBM</h2>
        <p>Loading hazard controls...</p>
      </section>
    </section>
  `;
}

function renderError() {
  app.innerHTML = `
    <section class="v2-screen is-auth auth-shell">
      <div class="auth-brand-large">
        ${v2Logo()}
        <p>Worksite Awareness. Safer Outcomes.</p>
      </div>
      <section class="v2-card v2-loading-card">
        <div class="v2-warning-tile">!</div>
        <h2>Hazards unavailable</h2>
        <p>${escapeHtml(state.error)}</p>
        <button class="focusable v2-key-button v2-key-primary" data-action="retry">Retry</button>
      </section>
    </section>
  `;
  bindButtons();
}

function renderDraftRestore() {
  const draft = state.pendingDraft;
  const savedAt = draft?.deviceUpdatedAt || draft?.deviceObservedAt
    ? formatDateTime(new Date(draft.deviceUpdatedAt ?? draft.deviceObservedAt))
    : 'Recently';
  const siteName = draft?.session?.siteName ?? state.session.siteName;
  const phaseLabel = draft?.phase ? draft.phase.replace('-', ' ') : 'in-progress TBM';

  app.innerHTML = `
    <section class="v2-screen">
      ${v2Header('Local Draft')}
      <section class="v2-card v2-draft-card" aria-label="Local draft found">
        <div class="v2-screen-intro">
          <div class="v2-warning-tile">↻</div>
          <div>
            <h2>Local draft found</h2>
            <p>A device-local draft is available for this active TBM session.</p>
          </div>
        </div>
        <dl class="v2-draft-meta">
          <div>
            <dt>Site</dt>
            <dd>${escapeHtml(siteName)}</dd>
          </div>
          <div>
            <dt>Last recorded on device</dt>
            <dd>${escapeHtml(savedAt)}</dd>
          </div>
          <div>
            <dt>Screen</dt>
            <dd>${escapeHtml(phaseLabel)}</dd>
          </div>
        </dl>
        ${draftStatusHtml()}
      </section>
      <section class="v2-action-row">
        <button class="focusable v2-key-button" data-action="discard-draft">Start New</button>
        <button class="focusable v2-key-button v2-key-primary" data-action="restore-draft">Restore Draft</button>
      </section>
    </section>
  `;

  bindButtons();
}

function renderStart() {
  app.innerHTML = `
    <section class="v2-screen">
      ${v2Header('Start TBM', v2WorkflowProgress(1))}
      <section class="v2-card v2-form-card" aria-label="TBM session details">
        <div class="v2-screen-intro">
          <div class="v2-warning-tile">▶</div>
          <div>
            <h2>Start TBM</h2>
            <p>Kick off a Toolbox Meeting to promote safety and alignment.</p>
          </div>
        </div>
        ${buildUserBadge()}
        ${draftStatusHtml()}
        <div class="v2-form-grid">
          <label class="v2-field-row">
            ${v2Icon('site')}
            <span>Site name</span>
            <input class="focusable" name="siteName" value="${escapeHtml(state.session.siteName)}" />
          </label>
          <label class="v2-field-row">
            ${v2Icon('task')}
            <span>Task name</span>
            <input class="focusable" name="taskName" value="${escapeHtml(state.session.taskName)}" />
          </label>
          <label class="v2-field-row">
            ${v2Icon('user')}
            <span>Supervisor</span>
            <input class="focusable" name="supervisorName" value="${escapeHtml(state.session.supervisorName)}" />
          </label>
          <div class="v2-field-row">
            ${v2Icon('calendar')}
            <span>Date / time</span>
            <strong>${escapeHtml(formatDateTime(state.session.scheduledAt))}</strong>
          </div>
        </div>
        <section class="v2-action-row">
          <button class="focusable v2-key-button v2-key-primary" data-action="start">▶ Start TBM</button>
          <button class="focusable v2-key-button" data-action="save-draft">Save Draft</button>
        </section>
      </section>
    </section>
  `;

  app.querySelectorAll('input[name]').forEach((input) => {
    input.addEventListener('input', (event) => saveStartField(input.name, event.target.value));
  });
  bindButtons();
}

function renderParticipation() {
  const presentCount = state.workers.filter((worker) => worker.present).length;
  const supervisorAcknowledgedCount = state.workers.filter(
    (worker) => normalizeWorker(worker).acknowledgment.supervisorRecorded
  ).length;

  app.innerHTML = `
    <section class="v2-screen">
      ${v2Header('Worker Participation', v2WorkflowProgress(2))}
      <section class="v2-card v2-participation-card">
        <div class="v2-section-heading">
          <h2>Worker Attendance</h2>
          <p>Record attendance and supervisor-recorded acknowledgment as separate facts.</p>
        </div>
        ${draftStatusHtml()}

        <form class="v2-add-worker" id="add-worker-form">
          <div class="v2-input-with-icon">
            ${v2Icon('add')}
            <input class="focusable" id="worker-name" autocomplete="off" placeholder="Add worker name..." />
          </div>
          <button class="focusable v2-key-button" type="submit">Add</button>
        </form>

        <section class="v2-worker-list" aria-label="Attendance list">
          ${state.workers
            .map((worker) => {
              const initials = worker.name
                .split(' ')
                .map((part) => part[0])
                .join('')
                .slice(0, 2)
                .toUpperCase();

              return `
                <div class="v2-worker-row">
                  <div class="v2-worker-check">
                    <span class="v2-avatar">${escapeHtml(initials)}</span>
                    <strong>${escapeHtml(worker.name)}</strong>
                    <em>${escapeHtml(worker.role)}</em>
                    <label class="v2-worker-fact">
                    <input class="focusable" type="checkbox" data-attendance-worker="${escapeHtml(worker.id)}" ${
                      worker.present ? 'checked' : ''
                    } />
                    <span>Present</span>
                    </label>
                    <label class="v2-worker-fact">
                    <input class="focusable" type="checkbox" data-ack-worker="${escapeHtml(worker.id)}" ${
                      normalizeWorker(worker).acknowledgment.supervisorRecorded ? 'checked' : ''
                    } />
                    <span>TBM acknowledgment — supervisor recorded</span>
                    </label>
                  </div>
                  <button class="focusable v2-key-button v2-key-small" data-action="remove-worker" data-worker="${escapeHtml(
                    worker.id
                  )}">Remove</button>
                </div>
              `;
            })
            .join('')}
        </section>

        <p class="v2-attendance-count"><strong>${presentCount}</strong> present · <strong>${supervisorAcknowledgedCount}</strong> acknowledgments recorded by supervisor · 0 independently verified by this prototype</p>
      </section>

      <section class="v2-action-row">
        <button class="focusable v2-key-button" data-action="mark-all">Mark All Present</button>
        <button class="focusable v2-key-button" data-action="save-draft">Record Draft</button>
        <button class="focusable v2-key-button v2-key-primary" data-action="continue">Continue →</button>
      </section>
    </section>
  `;

  app.querySelector('#add-worker-form').addEventListener('submit', (event) => {
    event.preventDefault();
    addWorker(app.querySelector('#worker-name').value);
  });

  app.querySelectorAll('input[data-attendance-worker]').forEach((checkbox) => {
    checkbox.addEventListener('change', () =>
      setWorkerPresent(checkbox.dataset.attendanceWorker, checkbox.checked)
    );
  });

  app.querySelectorAll('input[data-ack-worker]').forEach((checkbox) => {
    checkbox.addEventListener('change', () =>
      setWorkerAcknowledgment(checkbox.dataset.ackWorker, checkbox.checked)
    );
  });

  bindButtons();
}

function renderManualEntry() {
  app.innerHTML = `
    <section class="v2-screen">
      ${v2Header('Log New Hazard')}

      <form class="v2-manual-layout manual-entry-form" id="manual-entry-form">
        <section class="v2-card v2-manual-main">
          <div class="v2-two-col">
            <label class="v2-field-block">
              <span>Type *</span>
              <select class="focusable" name="type">
                <option value="new_hazard">new_hazard</option>
                <option value="near_miss">near_miss</option>
              </select>
            </label>

            <label class="v2-field-block">
              <span>Category *</span>
              <input class="focusable" name="category" maxlength="80" value="manual_entry" />
            </label>
          </div>

          <label class="v2-field-block">
            <span>Title *</span>
            <input class="focusable" name="title" maxlength="120" placeholder="Example: Temporary ladder blocked" required />
          </label>

          <label class="v2-field-block">
            <span>Location *</span>
            <input class="focusable" name="location" maxlength="120" placeholder="Example: Level 2 west stair" required />
          </label>

          <label class="v2-field-block">
            <span>Risk level *</span>
            <select class="focusable" name="riskLevel">
              <option value="low">low</option>
              <option value="medium" selected>medium</option>
              <option value="high">high</option>
            </select>
          </label>

          <label class="v2-field-block">
            <span>Description *</span>
            <textarea class="v2-textarea focusable flexible-memo" name="description" maxlength="260" placeholder="Describe what was observed"></textarea>
          </label>

          <label class="v2-field-block">
            <span>Action Taken / Recommended Action *</span>
            <textarea class="v2-textarea focusable flexible-memo" name="actionText" maxlength="260" placeholder="Action taken or recommended action"></textarea>
          </label>
        </section>

        <aside class="v2-manual-side">
          <section class="v2-card v2-upload-card">
            <h3>Attach Photo</h3>
            <label class="v2-upload-zone">
              ${v2Icon('photo')}
              <span id="photo-preview">No photo selected</span>
              <input class="focusable" name="evidencePhotos" type="file" accept="image/jpeg,image/png,image/webp" multiple />
            </label>
            <p class="photo-preview">JPG, PNG, WEBP evidence photos</p>
            <button class="focusable v2-key-button v2-key-primary" id="analyze-photo-button" data-action="analyze-photo" type="button" hidden disabled>
              Analyze Photo
            </button>
          </section>
          <div id="ai-suggestion-panel"></div>
          <p class="save-feedback" id="manual-entry-feedback">${escapeHtml(state.manualEntryFeedback)}</p>
        </aside>
      </form>

      <section class="v2-action-row">
        <button class="focusable v2-key-button" data-action="cancel-manual">← Cancel</button>
        <button class="focusable v2-key-button v2-key-primary" form="manual-entry-form" type="submit">Save</button>
      </section>
    </section>
  `;

  app.querySelector('input[name="evidencePhotos"]').addEventListener('change', (event) => {
    const files = Array.from(event.target.files ?? []);
    const preview = app.querySelector('#photo-preview');
    const analyzeButton = app.querySelector('#analyze-photo-button');
    preview.textContent = files.length
      ? files.map((file) => `${file.name} (${Math.ceil(file.size / 1024)} KB)`).join(', ')
      : 'No photo selected';
    analyzeButton.hidden = files.length === 0;
    analyzeButton.disabled = files.length === 0;
    state.manualAiSuggestion = null;
    state.manualAiDecision = null;
    state.manualEntryFeedback = files.length ? 'Photo changed. Run mock analysis again if needed.' : '';
    app.querySelector('#manual-entry-feedback').textContent = state.manualEntryFeedback;
    renderAiSuggestion();
  });

  app.querySelector('select[name="type"]').addEventListener('change', () => {
    state.manualAiSuggestion = null;
    state.manualAiDecision = null;
    state.manualEntryFeedback = '';
    app.querySelector('#manual-entry-feedback').textContent = '';
    renderAiSuggestion();
  });

  app.querySelector('#manual-entry-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    await saveManualEntry(event.currentTarget);
  });
  renderAiSuggestion();
  bindButtons();
}

// ---------------------------------------------------------------------------
// Glasses HUD Mode rendering
// ---------------------------------------------------------------------------
// Keep this path plain HTML/CSS/JS and one-card-at-a-time so it remains easy
// to port to Meta Web Apps or another wearable runtime later.

function renderGlassesActions(actions) {
  return `
    <section class="glasses-actions">
      ${actions
        .map(
          (action) => `
            <button class="focusable v2-key-button ${action.primary ? 'v2-key-primary' : ''}" data-glasses-action="${escapeHtml(
              action.action
            )}">${escapeHtml(action.label)}</button>
          `
        )
        .join('')}
    </section>
  `;
}

function bindGlassesButtons() {
  app.querySelectorAll('button[data-glasses-action]').forEach((button) => {
    button.addEventListener('click', () => handleGlassesAction(button.dataset.glassesAction));
  });
}

function renderGlasses() {
  if (state.phase === 'summary') state.glassesStep = 'summary';

  const presentCount = state.workers.filter((worker) => worker.present).length;
  const supervisorAcknowledgedCount = state.workers.filter(
    (worker) => normalizeWorker(worker).acknowledgment.supervisorRecorded
  ).length;
  const { controlled, actionRequired, unchecked } = getHazardReviewCounts();
  const hazard = currentHazard();
  const response = currentResponse();

  let body = '';
  let actions = [];

  if (state.glassesStep === 'start') {
    body = `
      <p class="glasses-kicker">Glasses HUD Mode</p>
      <h1>Start TBM</h1>
      <p class="glasses-large">${escapeHtml(state.session.siteName)}</p>
      <p class="glasses-muted">${escapeHtml(state.session.taskName)}</p>
      <div class="glasses-hint">Enter or ArrowRight to begin</div>
    `;
    actions = [
      { action: 'start', label: 'Start', primary: true },
      { action: 'exit', label: 'Exit' }
    ];
  } else if (state.glassesStep === 'workers') {
    body = `
      <p class="glasses-kicker">Worker Attendance</p>
      <h1>${presentCount} / ${state.workers.length} present</h1>
      <p class="glasses-large">Mark all demo workers present?</p>
      <p class="glasses-muted">${state.workers.map((worker) => escapeHtml(worker.name)).join(' · ')}</p>
      <p class="glasses-muted">${supervisorAcknowledgedCount} supervisor-recorded acknowledgments. This shortcut records attendance only.</p>
      <div class="glasses-hint">Enter marks present; it does not acknowledge</div>
    `;
    actions = [
      { action: 'workers', label: 'Mark Present', primary: true },
      { action: 'prev', label: 'Back' }
    ];
  } else if (state.glassesStep === 'memo') {
    body = `
      <p class="glasses-kicker">Voice Memo Mock</p>
      <h1>Memo Captured</h1>
      <p class="glasses-large">${escapeHtml(state.glassesMemoFeedback)}</p>
      <p class="glasses-muted">Recorded on this device for Hazard ${getCurrentHazardNumber()}.</p>
    `;
    actions = [
      { action: 'next', label: 'Continue', primary: true },
      { action: 'photo', label: 'Photo' }
    ];
  } else if (state.glassesStep === 'photo') {
    body = `
      <p class="glasses-kicker">Photo Evidence Mock</p>
      <h1>Photo Captured</h1>
      <p class="glasses-large">${escapeHtml(state.glassesPhotoFeedback)}</p>
      <p class="glasses-muted">${response?.evidencePhotos?.length ?? 0} evidence item${
        (response?.evidencePhotos?.length ?? 0) === 1 ? '' : 's'
      } on this hazard.</p>
    `;
    actions = [
      { action: 'next', label: 'Continue', primary: true },
      { action: 'memo', label: 'Memo' }
    ];
  } else if (state.glassesStep === 'summary') {
    const blockers = getFinalizationBlockers(buildSessionLog());
    const glassesTitle = blockers.length
      ? 'TBM Draft'
      : getPotentialRecordStatus() === 'actions_open'
        ? state.session.finalizedAt
          ? 'TBM recorded — actions open'
          : 'Ready to record — actions open'
        : 'Ready to finalize';
    body = `
      <p class="glasses-kicker">TBM Record</p>
      <h1>${escapeHtml(glassesTitle)}</h1>
      ${state.glassesReviewFeedback ? `<p class="glasses-toast">${escapeHtml(state.glassesReviewFeedback)}</p>` : ''}
      <section class="glasses-stats" aria-label="Glasses summary counts">
        <div><strong>${controlled}</strong><span>Controlled</span></div>
        <div><strong>${actionRequired}</strong><span>Action Required</span></div>
        <div><strong>${unchecked}</strong><span>Not Checked</span></div>
      </section>
      <p class="glasses-muted">${escapeHtml(
        blockers.length ? blockers.join(' ') : state.saveFeedback || 'Ready to record without fabricating closure.'
      )}</p>
    `;
    actions = [
      { action: 'save-session', label: state.isSavingSession ? 'Queuing...' : 'Record Draft', primary: true },
      ...(blockers.length ? [] : [{ action: 'finalize', label: 'Finalize' }]),
      { action: 'exit', label: 'Exit' }
    ];
  } else {
    const status = response?.status ?? 'Not Marked';
    body = `
      <p class="glasses-kicker">${escapeHtml(getHazardProgressText())}</p>
      <h1>${escapeHtml(hazard?.name ?? 'No hazard')}</h1>
      ${state.glassesReviewFeedback ? `<p class="glasses-toast">${escapeHtml(state.glassesReviewFeedback)}</p>` : ''}
      <dl class="glasses-hazard-facts">
        <div><dt>Location</dt><dd>${escapeHtml(hazard?.location ?? '')}</dd></div>
        <div><dt>Risk</dt><dd>${escapeHtml(hazard?.riskLevel ?? 'medium')}</dd></div>
        <div><dt>Status</dt><dd>${escapeHtml(status)}</dd></div>
      </dl>
      <p class="glasses-muted">${escapeHtml(hazard?.action ?? '')}</p>
      <div class="glasses-hint">1 Controlled · 2 Action Required · M Memo · P Photo</div>
    `;
    actions = [
      { action: 'controlled', label: 'Controlled', primary: true },
      { action: 'action-required', label: 'Action Required' },
      { action: 'memo', label: 'Memo' }
    ];
  }

  app.innerHTML = `
    <section class="glasses-screen">
      <header class="glasses-topline">
        ${v2Logo()}
        <button class="focusable glasses-exit" data-glasses-action="exit">Exit</button>
      </header>
      <main class="glasses-card" aria-live="polite">
        ${body}
      </main>
      ${renderGlassesActions(actions)}
      <footer class="glasses-shortcuts">
        ${draftStatusHtml()}
        ${
          state.glassesStep === 'summary'
            ? ''
            : '<button class="focusable glasses-exit" data-glasses-action="save-session">Save Draft</button>'
        }
        <span>←/→ Navigate · Enter Continue · Esc Exit</span>
      </footer>
    </section>
  `;

  app.querySelectorAll('button[data-action]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (button.dataset.action === 'save-session') saveCurrentSession();
    });
  });
  bindGlassesButtons();
}

function renderCorrectiveActionEditor(response) {
  if (normalizeHazardStatus(response.status) !== HAZARD_STATUS.ACTION_REQUIRED) return '';
  const action = normalizeCorrectiveAction(response.correctiveAction, response.status);
  const closureEvidence = action.closureEvidence.join(', ');

  return `
    <section class="v2-card v2-corrective-card" aria-label="Corrective action details">
      <div class="v2-section-heading">
        <h2>Corrective Action Required</h2>
        <p>This action remains open until verification, verifiedBy, and verifiedAt are explicitly recorded.</p>
      </div>
      <div class="v2-two-col">
        <label class="v2-field-block"><span>Immediate control taken *</span><input data-corrective-field="immediateControl" value="${escapeHtml(action.immediateControl)}" /></label>
        <label class="v2-field-block"><span>Assigned person *</span><input data-corrective-field="assignedTo" value="${escapeHtml(action.assignedTo)}" /></label>
        <label class="v2-field-block"><span>Due date/time *</span><input type="datetime-local" data-corrective-field="dueAt" value="${escapeHtml(action.dueAt)}" /></label>
        <label class="v2-field-block"><span>Work status *</span><select data-corrective-field="workStatus">
          <option value="">Select status</option>
          <option value="${WORK_STATUS.STOPPED}" ${action.workStatus === WORK_STATUS.STOPPED ? 'selected' : ''}>Work stopped</option>
          <option value="${WORK_STATUS.PERMITTED_WITH_CONTROLS}" ${action.workStatus === WORK_STATUS.PERMITTED_WITH_CONTROLS ? 'selected' : ''}>Permitted with controls</option>
        </select></label>
        <label class="v2-field-block"><span>Verification status *</span><select data-corrective-field="verificationStatus">
          <option value="${VERIFICATION_STATUS.OPEN}" ${action.verificationStatus === VERIFICATION_STATUS.OPEN ? 'selected' : ''}>Open — not verified</option>
          <option value="${VERIFICATION_STATUS.VERIFIED}" ${action.verificationStatus === VERIFICATION_STATUS.VERIFIED ? 'selected' : ''}>Verified</option>
        </select></label>
        <label class="v2-field-block"><span>Optional closure evidence reference</span><input data-corrective-field="closureEvidence" value="${escapeHtml(closureEvidence)}" placeholder="Photo ID, note, or evidence reference" /></label>
        ${
          action.verificationStatus === VERIFICATION_STATUS.VERIFIED
            ? `<label class="v2-field-block"><span>Verified by *</span><input data-corrective-field="verifiedBy" value="${escapeHtml(action.verifiedBy ?? '')}" /></label>
               <label class="v2-field-block"><span>Verified at *</span><input type="datetime-local" data-corrective-field="verifiedAt" value="${escapeHtml(action.verifiedAt ?? '')}" /></label>`
            : ''
        }
      </div>
    </section>
  `;
}

function renderChecklist() {
  const hazard = currentHazard();
  const response = currentResponse();
  const statusTone = getChecklistStatusTone(response.status);

  app.innerHTML = `
    <section class="v2-screen ${normalizeHazardStatus(response.status) === HAZARD_STATUS.ACTION_REQUIRED ? 'is-corrective' : ''}">
      ${v2Header('TBM Checklist', v2ChecklistProgress())}
      <section class="v2-card v2-hazard-card" aria-label="Current hazard">
        <div class="v2-hazard-hero">
          <div class="v2-warning-tile">!</div>
          <div class="v2-hazard-title">
            <p class="v2-kicker">Hazard</p>
            <h2>${escapeHtml(hazard.name)}</h2>
          </div>
          ${v2StatusChip('Status', response.status ?? 'Not Marked', statusTone)}
        </div>

        <div class="v2-detail-list">
          <div class="v2-detail-row">${v2Icon('location')}<p>Location</p><strong>${escapeHtml(hazard.location)}</strong></div>
          <div class="v2-detail-row">${v2Icon('status')}<p>Risk Level</p><strong>${escapeHtml(hazard.riskLevel ?? response.riskLevel ?? 'medium')}</strong></div>
          <div class="v2-detail-row">${v2Icon('category')}<p>Category</p><strong>${escapeHtml(hazard.category ?? response.category ?? 'general')}</strong></div>
          <div class="v2-detail-row">${v2Icon('risk')}<p>Risk</p><strong>${escapeHtml(hazard.risk)}</strong></div>
          <div class="v2-detail-row">${v2Icon('action')}<p>Recommended Action</p><strong>${escapeHtml(hazard.action)}</strong></div>
        </div>
      </section>

      <section class="v2-card v2-memo-card">
        <label for="memo">Memo <span>Optional</span></label>
        <textarea id="memo" class="v2-textarea focusable" rows="2" maxlength="220" placeholder="Add notes, details, or follow-up actions...">${escapeHtml(
        state.memo
      )}</textarea>
        ${draftStatusHtml()}
      </section>

      ${renderCorrectiveActionEditor(response)}

      <section class="v2-action-row" aria-label="Checklist actions">
        <button class="focusable v2-key-button v2-key-primary" data-action="controlled">✓ Controlled — safe to proceed</button>
        <button class="focusable v2-key-button" data-action="action-required">Action Required</button>
      </section>

      <section class="v2-action-row v2-action-row-nav" aria-label="Navigation">
        <button class="focusable v2-key-button" data-action="prev">← Previous</button>
        <button class="focusable v2-key-button" data-action="log-new">＋ Log New Hazard</button>
        <button class="focusable v2-key-button" data-action="save-draft">Save Draft</button>
        <button class="focusable v2-key-button" data-action="next">Next →</button>
      </section>
    </section>
  `;

  app.querySelector('#memo').addEventListener('input', (event) => saveMemo(event.target.value));
  app.querySelectorAll('[data-corrective-field]').forEach((field) => {
    const eventName = field.tagName === 'SELECT' ? 'change' : 'input';
    field.addEventListener(eventName, () => {
      updateCorrectiveAction(field.dataset.correctiveField, field.value);
      if (field.dataset.correctiveField === 'verificationStatus') render();
    });
  });
  bindButtons();
}

function renderSharingEditor() {
  const sharing = normalizeSharing(state.session.sharing);
  return `
    <section class="v2-card v2-sharing-card" aria-label="Worker sharing evidence">
      <div class="v2-section-heading">
        <h2>Worker Sharing Evidence</h2>
        <p>Reaching this screen does not mean results were shared. Record the actual outcome.</p>
      </div>
      <div class="v2-two-col">
        <label class="v2-field-block"><span>Were results shared? *</span><select data-sharing-field="status">
          <option value="${SHARING_STATUS.NOT_RECORDED}" ${sharing.status === SHARING_STATUS.NOT_RECORDED ? 'selected' : ''}>Not recorded yet</option>
          <option value="${SHARING_STATUS.NOT_SHARED}" ${sharing.status === SHARING_STATUS.NOT_SHARED ? 'selected' : ''}>No — not shared</option>
          <option value="${SHARING_STATUS.SHARED}" ${sharing.status === SHARING_STATUS.SHARED ? 'selected' : ''}>Supervisor reports shared</option>
        </select></label>
        ${
          sharing.status === SHARING_STATUS.SHARED
            ? `<label class="v2-field-block"><span>Sharing method *</span><input data-sharing-field="method" value="${escapeHtml(sharing.method)}" placeholder="Briefing, message, posted notice..." /></label>
               <label class="v2-field-block"><span>Recipients or group *</span><input data-sharing-field="recipients" value="${escapeHtml(sharing.recipients)}" placeholder="Electrical crew, all attendees..." /></label>`
            : ''
        }
        <label class="v2-field-block"><span>Optional acknowledgment results</span><textarea class="v2-textarea" data-sharing-field="acknowledgmentResults" placeholder="Record actual responses only">${escapeHtml(sharing.acknowledgmentResults)}</textarea></label>
      </div>
      <p class="draft-status">Offline selection records only the supervisor's device-observed claim. Server shared-at proves recording time, not delivery; acknowledgment results must reflect real responses.</p>
    </section>
  `;
}

function renderSummary() {
  const { controlled, actionRequired, unchecked } = getHazardReviewCounts();
  const blockers = getFinalizationBlockers(buildSessionLog());
  const proposedStatus = blockers.length ? 'draft' : getPotentialRecordStatus();
  const isRecorded = Boolean(state.session.finalizedAt);
  const title =
    state.session.completedAt
      ? 'TBM Complete — all actions verified'
      : isRecorded && proposedStatus === 'actions_open'
        ? 'TBM recorded — actions open'
        : blockers.length
          ? 'TBM Draft — finalization blocked'
          : proposedStatus === 'actions_open'
            ? 'Ready to record — actions open'
            : 'Ready to finalize';
  const explanation = blockers.length
    ? 'This draft can be recorded without claiming completion. Resolve every blocking reason before finalizing.'
    : proposedStatus === 'actions_open'
      ? 'All hazards are reviewed and required action fields are recorded, but one or more actions still await verification.'
      : 'All hazards are reviewed, required fields are recorded, and corrective actions are verified.';

  app.innerHTML = `
    <section class="v2-screen">
      ${v2Header('TBM Record', v2WorkflowProgress(4))}
      <section class="v2-card v2-summary-card">
        <div class="v2-summary-hero">
          <div class="${blockers.length ? 'v2-warning-tile' : 'v2-success-tile'}">${blockers.length ? '!' : '✓'}</div>
          <div>
            <h2>${escapeHtml(title)}</h2>
            <p>${escapeHtml(explanation)}</p>
          </div>
          ${v2StatusChip('Status', proposedStatus, blockers.length ? 'warning' : 'success')}
        </div>

        <div class="v2-summary-stats">
          <div class="v2-stat-card">
            <div class="v2-warning-tile">✓</div>
            <p>Controlled</p>
            <strong>${controlled}</strong>
            <span>Safe to proceed</span>
          </div>
          <div class="v2-stat-card">
            <div class="v2-warning-tile">□</div>
            <p>Action Required</p>
            <strong>${actionRequired}</strong>
            <span>Corrective actions</span>
          </div>
          <div class="v2-stat-card"><p>Not Checked</p><strong>${unchecked}</strong><span>Finalization blockers</span></div>
        </div>

        ${renderSharingEditor()}

        <section class="v2-report-preview">
          <h3>Finalization blockers</h3>
          ${
            blockers.length
              ? `<ul>${blockers.map((blocker) => `<li>${escapeHtml(blocker)}</li>`).join('')}</ul>`
              : '<p>No finalization blockers.</p>'
          }
        </section>

        <section class="v2-report-preview">
          <h3>Report Preview</h3>
          ${buildKoreanReportHtml()}
        </section>
      </section>
      ${state.saveFeedback ? `<p class="save-feedback">${escapeHtml(state.saveFeedback)}</p>` : ''}
      ${draftStatusHtml()}
      <div class="v2-action-grid">
        <button class="focusable v2-key-button v2-key-primary" data-action="review">Review</button>
        <button class="focusable v2-key-button" data-action="log-new">＋ Log New Hazard</button>
        <button class="focusable v2-key-button" data-action="save-draft" ${
          state.isSavingSession ? 'disabled' : ''
        }>${state.isSavingSession ? 'Queuing...' : 'Record Draft'}</button>
        <button class="focusable v2-key-button" data-action="finalize" ${
          state.isSavingSession || blockers.length ? 'disabled' : ''
        }>Finalize</button>
        <button class="focusable v2-key-button" data-action="saved-sessions">Saved Sessions</button>
        <button class="focusable v2-key-button" data-action="copy">Copy JSON</button>
      </div>
    </section>
  `;

  app.querySelectorAll('[data-sharing-field]').forEach((field) => {
    const eventName = field.tagName === 'SELECT' ? 'change' : 'input';
    field.addEventListener(eventName, () => {
      updateSharing(field.dataset.sharingField, field.value);
      if (field.dataset.sharingField === 'status') render();
    });
  });
  bindButtons();
}

function renderSavedSessions() {
  const sortedSessions = [...state.savedSessions].sort(
    (first, second) => new Date(getSavedSessionDate(second) ?? 0) - new Date(getSavedSessionDate(first) ?? 0)
  );
  const sessionsHtml = sortedSessions.length
    ? sortedSessions
        .map(
          (session) => `
            <li class="v2-session-row">
              ${v2Icon('calendar')}
              <div class="v2-session-date">
                <strong>${escapeHtml(formatSavedSessionDate(session))}</strong>
                <span>${escapeHtml(session.status ?? 'unknown')}</span>
              </div>
              <div class="v2-session-site">
                ${v2Icon('site')}
                <div>
                  <strong>${escapeHtml(getSavedSessionSiteName(session))}</strong>
                  <span>${escapeHtml(session.site?.siteArea ?? session.siteArea ?? 'Saved TBM session')}</span>
                </div>
              </div>
              <div class="v2-session-status">
                <span>Status</span>
                <strong>${escapeHtml(session.status ?? 'unknown')}</strong>
              </div>
              <button class="focusable v2-key-button v2-key-small" data-action="open-report" data-session="${escapeHtml(
                session.sessionId
              )}">Open Report</button>
            </li>
          `
        )
        .join('')
    : '';

  app.innerHTML = `
    <section class="v2-screen">
      ${v2Header('Saved Sessions')}
      <section class="v2-card v2-saved-card" aria-label="Saved TBM sessions">
        <div class="v2-section-heading v2-section-heading-row">
          <div>
            <h2>Saved Sessions</h2>
            <p>You have ${state.savedSessions.length} saved session${state.savedSessions.length === 1 ? '' : 's'}.</p>
          </div>
          <button class="focusable v2-key-button v2-key-small" data-action="refresh-saved">Refresh</button>
        </div>
        <section class="v2-saved-panel">
        ${
          state.savedSessionsStatus === 'loading'
            ? '<div class="v2-empty-state">Loading saved sessions...</div>'
            : state.savedSessionsStatus === 'error'
              ? `<div class="v2-empty-state">${escapeHtml(state.savedSessionsError)}</div>`
              : sortedSessions.length
                ? `<ul class="saved-session-list">${sessionsHtml}</ul>`
                : '<div class="v2-empty-state">No saved sessions. Start by saving a completed TBM.</div>'
        }
        </section>
      </section>

      <section class="v2-action-row">
        <button class="focusable v2-key-button" data-action="back-from-saved">← Back</button>
        <button class="focusable v2-key-button" data-action="refresh-saved">Refresh</button>
      </section>
    </section>
  `;

  bindButtons();
}

// ---------------------------------------------------------------------------
// Event binding
// ---------------------------------------------------------------------------

function bindButtons() {
  app.querySelectorAll('button[data-action]').forEach((button) => {
    button.addEventListener('click', async () => {
      const action = button.dataset.action;

      if (action === 'auth-login') {
        state.authMode = 'login';
        state.authFeedback = '';
        render();
      }
      if (action === 'auth-register') {
        state.authMode = 'register';
        state.authFeedback = '';
        render();
      }
      if (action === 'restore-draft') {
        restoreLocalDraft(state.pendingDraft || await loadLocalDraft());
        render();
      }
      if (action === 'discard-draft') {
        clearLocalDraft();
        state.pendingDraft = null;
        state.phase = 'start';
        render();
      }
      if (action === 'logout') logout();
      if (action === 'retry') loadHazards();
      if (action === 'retry-sync') synchronizeNow();
      if (action === 'resolve-conflict-local' && state.syncConflict?.serverRevision != null) {
        await state.offlineStore.resolveConflictKeepingLocal(
          state.currentUser.id,
          state.session.sessionId,
          { ...buildSessionLog(), saveMode: 'draft' },
          state.syncConflict.serverRevision
        );
        state.serverRevision = state.syncConflict.serverRevision;
        state.syncConflict = null;
        state.draftStatus = DRAFT_STATUS_TEXT.QUEUED;
        await synchronizeNow();
      }
      if (action === 'start') startTbm();
      if (action === 'remove-worker') removeWorker(button.dataset.worker);
      if (action === 'mark-all') markAllPresent();
      if (action === 'continue') continueToChecklist();
      if (action === 'log-new') openManualEntry();
      if (action === 'cancel-manual') cancelManualEntry();
      if (action === 'prev') goTo(state.index - 1);
      if (action === 'next') goTo(state.index + 1);
      if (action === 'controlled') setStatus(HAZARD_STATUS.CONTROLLED);
      if (action === 'action-required') setStatus(HAZARD_STATUS.ACTION_REQUIRED);
      if (action === 'review') continueToChecklist();
      if (action === 'copy') copySessionLog(button);
      if (action === 'save-session' || action === 'save-draft') saveCurrentSession('draft');
      if (action === 'finalize') saveCurrentSession('finalize');
      if (action === 'saved-sessions') openSavedSessions();
      if (action === 'back-from-saved') closeSavedSessions();
      if (action === 'refresh-saved') loadSavedSessions().then(render);
      if (action === 'open-report') openSessionReport(button.dataset.session);
      if (action === 'analyze-photo') analyzeManualPhoto(app.querySelector('#manual-entry-form'));
    });
  });
}

// ---------------------------------------------------------------------------
// Render dispatcher
// ---------------------------------------------------------------------------

function render() {
  if (state.phase === 'auth-check') renderAuthChecking();
  if (state.phase === 'auth') renderAuth();
  if (state.phase === 'loading') renderLoading();
  if (state.phase === 'error') renderError();
  if (state.phase === 'draft-restore') renderDraftRestore();
  // Glasses mode reuses auth/loading/error screens, then swaps only the authenticated TBM workflow.
  if (
    isGlassesMode &&
    state.currentUser &&
    state.hazards.length &&
    !['auth-check', 'auth', 'loading', 'error', 'draft-restore'].includes(state.phase)
  ) {
    renderGlasses();
    return;
  }
  if (state.phase === 'start') renderStart();
  if (state.phase === 'participation') renderParticipation();
  if (state.phase === 'manual-entry') renderManualEntry();
  if (state.phase === 'checklist') renderChecklist();
  if (state.phase === 'summary') renderSummary();
  if (state.phase === 'saved-sessions') renderSavedSessions();
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------

window.addEventListener('keydown', (event) => {
  if (event.target.matches('input, textarea')) return;
  if (isGlassesMode && state.currentUser && state.hazards.length) {
    // Browser keyboard mapping for future wearable gestures:
    // ArrowRight / Enter -> next, select, or pinch confirm
    // ArrowLeft -> previous or back gesture
    // 1 -> controlled after review
    // 2 -> action required (closure is never implied)
    // M -> voice memo
    // P -> photo capture
    // Escape -> exit glasses mode
    if (event.key === 'ArrowRight') handleGlassesAction('next');
    if (event.key === 'ArrowLeft') handleGlassesAction('prev');
    if (event.key === '1') handleGlassesAction('controlled');
    if (event.key === '2') handleGlassesAction('action-required');
    if (event.key.toLowerCase() === 'm') handleGlassesAction('memo');
    if (event.key.toLowerCase() === 'p') handleGlassesAction('photo');
    if (event.key === 'Enter') handleGlassesAction('next');
    if (event.key === 'Escape') handleGlassesAction('exit');
    return;
  }
  if (state.phase !== 'checklist') return;

  if (event.key === 'ArrowRight') goTo(state.index + 1);
  if (event.key === 'ArrowLeft') goTo(state.index - 1);
  if (event.key === '1') setStatus(HAZARD_STATUS.CONTROLLED);
  if (event.key === '2') setStatus(HAZARD_STATUS.ACTION_REQUIRED);
});

// ---------------------------------------------------------------------------
// App startup
// ---------------------------------------------------------------------------

async function initializeOfflineFirstApp() {
  try {
    state.offlineStore = await openOfflineStore();
    await state.offlineStore.migrateLegacyDraft();
    state.syncEngine = createSyncEngine({
      store: state.offlineStore,
      getOwnerId: () => state.currentUser?.id,
      onStatus: ({ status, conflict, lastError }) => {
        const labelByStatus = {
          [SYNC_STATUS.DEVICE_ONLY]: DRAFT_STATUS_TEXT.DEVICE_ONLY,
          [SYNC_STATUS.QUEUED]: DRAFT_STATUS_TEXT.QUEUED,
          [SYNC_STATUS.SYNCING]: DRAFT_STATUS_TEXT.SYNCING,
          [SYNC_STATUS.SYNCED]: DRAFT_STATUS_TEXT.SYNCED,
          [SYNC_STATUS.FAILED]: DRAFT_STATUS_TEXT.FAILED,
          [SYNC_STATUS.CONFLICT]: DRAFT_STATUS_TEXT.CONFLICT
        };
        state.draftStatus = labelByStatus[status] ?? state.draftStatus;
        state.syncConflict = conflict ?? (status === SYNC_STATUS.CONFLICT ? state.syncConflict : null);
        if (lastError && status === SYNC_STATUS.FAILED) state.saveFeedback = `${lastError} Local data was retained.`;
        render();
      }
    });
  } catch {
    state.draftStatus = DRAFT_STATUS_TEXT.UNAVAILABLE;
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  window.addEventListener('online', () => void synchronizeNow());
  window.addEventListener('offline', () => {
    if (state.currentUser) {
      state.saveFeedback = 'Offline — new work will be recorded on this device and queued.';
      render();
    }
  });
  await checkAuth();
  if (navigator.onLine) void synchronizeNow();
}

void initializeOfflineFirstApp();
