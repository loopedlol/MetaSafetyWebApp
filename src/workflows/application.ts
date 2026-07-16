// @ts-nocheck
import '../styles.css';
import {
  HAZARD_STATUS,
  ATTENDANCE_CAPTURE_SOURCE, DUE_PERIOD, IMMEDIATE_RESPONSE_CATEGORY, RESPONSIBLE_PARTY,
  SHARING_METHOD, SHARING_PROOF_TYPE,
  SHARING_STATUS,
  VERIFICATION_STATUS,
  WORK_STATUS,
  createEmptyAcknowledgment,
  getFinalizationBlockers,
  getRecordStatus,
  isCorrectiveActionClosed,
  markAllWorkersPresent,
  normalizeCorrectiveAction,
  normalizeAttendanceSummary,
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
import { escapeHtml, formatDateTime as formatDateTimeValue } from '../views/shared/format.ts';
import { conciseAnnouncement, hasUnsavedManualEntry, statusSymbol, viewFocusSelector } from '../views/shared/accessibility.ts';
import { apiRequest } from '../api/client.ts';
import { validatePublicUserBoundary, validateSessionBoundary } from '../domain/validation.ts';
import { DRAFT_STATUS_TEXT, draftStatusLabel, syncStatusForLabel } from '../views/dashboard/sync-status.ts';
import {
  GLASSES_STEP,
  buildPrimaryHazardModel,
  createMockGlassesEvidence,
  attendanceValue,
  evidenceSourceLabel,
  duePeriodToDueAt,
  getSharingScreenErrors,
  glassesSyncState,
  isAttendanceSummaryValid,
  isSharingScreenComplete,
  isGlassesPreview,
  normalizeGlassesStep,
  normalBrowserUrl,
} from '../views/glasses/model.ts';
import { createTranslator } from '../i18n/index.ts';
import { persistLanguage, restoreLanguage, updateDocumentLanguage } from '../i18n/preference.ts';
import { localizeFinalizationBlocker } from '../i18n/workflow.ts';
import { DEVICE_ACTION, DEVICE_RUNTIME, createDeviceAdapter, resolveDeviceRuntime } from '../device/device-adapter.ts';
import { EVIDENCE_PROVIDER } from '../domain/evidence-acquisition.ts';
import {
  createDiagnosticsSnapshot,
  exitDiagnosticsUrl,
  isDeviceDiagnosticsEnabled,
  probeAuthentication,
  probeIndexedDb,
  probeServiceWorker,
  recordDiagnosticKey,
  sanitizeRuntimeError,
  summarizeFocus
} from '../device/diagnostics.ts';

// ---------------------------------------------------------------------------
// Constants / config
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = '2.0.0';
const APP_VERSION = '0.1.0';

const stressMemo =
  'Long memo stress test: crew reported this needs barricades, signage, owner assignment, and follow-up before restart. This text should wrap and scroll inside the memo field without pushing buttons over other content.';

const isStressTest = new URLSearchParams(window.location.search).has('stress');
const isGlassesMode = isGlassesPreview(window.location.search);
const deviceRuntime = resolveDeviceRuntime(window.location.search);
const isMetaDisplayRuntime = isGlassesMode && deviceRuntime === DEVICE_RUNTIME.META_DISPLAY_WEB;
const isInvalidGlassesRuntime = isGlassesMode && deviceRuntime === DEVICE_RUNTIME.INVALID;
const isDeviceDiagnosticsMode = isDeviceDiagnosticsEnabled(window.location.search);
document.documentElement.classList.toggle('is-glasses-mode', isGlassesMode);
document.documentElement.classList.toggle('is-normal-mode', !isGlassesMode);
document.documentElement.classList.toggle('is-meta-display-runtime', isMetaDisplayRuntime);
if (isMetaDisplayRuntime) {
  document.querySelector('meta[name="viewport"]')?.setAttribute('content', 'width=600,height=600,initial-scale=1');
}
const LOCAL_DRAFT_VERSION = 2;
let locale = restoreLanguage();
let t = createTranslator(locale);
updateDocumentLanguage(locale);
let lastNormalViewKey = '';
let lastNormalAnnouncement = '';
let lastNormalDraftStatus = '';
let pendingFocusSelector = '';
let pairingCountdownTimer = 0;

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

const state = createApplicationState({ stressMemo: isStressTest ? stressMemo : '', appVersion: APP_VERSION });
state.session.device = isMetaDisplayRuntime
  ? { platform: 'meta_ray_ban_display_web_app', appVersion: APP_VERSION, inputMode: 'documented_dpad_key_events' }
  : state.session.device;

const deviceAdapter = createDeviceAdapter(deviceRuntime, {
  createPreviewMemo: () => t('glasses.mockMemoText'),
  createPreviewEvidence: (hazardNumber) => createMockGlassesEvidence(hazardNumber)
});

const app = document.querySelector('#app');
const diagnosticsState = isDeviceDiagnosticsMode
  ? createDiagnosticsSnapshot({ runtime: deviceRuntime, capabilities: deviceAdapter.capabilities })
  : null;

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

async function apiFetch(url, options = {}) {
  const response = await apiRequest(url, options);
  if (response.status === 401) {
    state.currentUser = null;
    if (isMetaDisplayRuntime) {
      state.phase = 'glasses-pairing';
      state.glassesPairing = { ...state.glassesPairing, stage: 'intro', focusId: 'pairing-enter', feedback: '안경 연결이 만료되었거나 해제되었습니다.' };
    } else {
      state.authMode = 'login';
      state.authFeedback = t('auth.loginRequired');
      state.phase = 'auth';
    }
    render();
  }

  return response;
}

function formatDateTime(value) {
  return formatDateTimeValue(value, locale);
}

function selectLanguage(value) {
  locale = value === 'en' ? 'en' : 'ko';
  t = createTranslator(locale);
  persistLanguage(locale);
  updateDocumentLanguage(locale);
  pendingFocusSelector = '[data-language-selector]';
  render();
}

function diagnosticsStatus(key) {
  return t(`diagnostics.status.${key}`);
}

function renderDeviceDiagnostics() {
  if (!diagnosticsState) return;
  diagnosticsState.viewport = { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio };
  diagnosticsState.focus = summarizeFocus(document.activeElement);
  diagnosticsState.visibility = document.visibilityState;
  diagnosticsState.network = navigator.onLine ? 'online' : 'offline';
  const capabilityRows = Object.entries(diagnosticsState.capabilities)
    .map(([capability, support]) => `<tr><th>${t(`diagnostics.capability.${capability}`)}</th><td>${diagnosticsStatus(support)}</td></tr>`)
    .join('');
  const latestKey = diagnosticsState.latestKey
    ? `${diagnosticsState.latestKey.key} · ${diagnosticsState.latestKey.eventType}`
    : t('diagnostics.noKey');

  app.innerHTML = `<section class="diagnostics-screen" data-device-diagnostics>
    <header><div><p class="glasses-kicker">${t('diagnostics.nonProduction')}</p><h1>${t('diagnostics.title')}</h1></div>
      <button class="focusable diagnostics-language" data-diagnostics-action="language">${locale === 'ko' ? 'English' : '한국어'}</button></header>
    <main class="diagnostics-grid">
      <section><h2>${t('diagnostics.runtime')}</h2><dl>
        <div><dt>${t('diagnostics.viewport')}</dt><dd data-diagnostic="viewport">${diagnosticsState.viewport.width}×${diagnosticsState.viewport.height}</dd></div>
        <div><dt>DPR</dt><dd data-diagnostic="dpr">${diagnosticsState.viewport.devicePixelRatio}</dd></div>
        <div><dt>${t('diagnostics.userAgent')}</dt><dd data-diagnostic="user-agent">${escapeHtml(diagnosticsState.userAgent)}</dd></div>
        <div><dt>${t('diagnostics.adapter')}</dt><dd data-diagnostic="adapter">${escapeHtml(diagnosticsState.runtime)} / ${escapeHtml(diagnosticsState.adapter)}</dd></div>
        <div><dt>${t('diagnostics.latestKey')}</dt><dd data-diagnostic="latest-key">${escapeHtml(latestKey)}</dd></div>
        <div><dt>${t('diagnostics.document')}</dt><dd data-diagnostic="document">${escapeHtml(diagnosticsState.focus)} · ${escapeHtml(diagnosticsState.visibility)}</dd></div>
      </dl></section>
      <section><h2>${t('diagnostics.capabilities')}</h2><table><tbody>${capabilityRows}</tbody></table></section>
      <section><h2>${t('diagnostics.localProbes')}</h2><dl>
        <div><dt>${t('diagnostics.network')}</dt><dd data-diagnostic="network">${diagnosticsState.network === 'online' ? t('diagnostics.browserOnline') : t('diagnostics.browserOffline')}</dd></div>
        <div><dt>${t('diagnostics.serviceWorker')}</dt><dd data-diagnostic="service-worker">${diagnosticsStatus(diagnosticsState.serviceWorker.support)} · ${t('diagnostics.registered')}: ${diagnosticsStatus(diagnosticsState.serviceWorker.registered ? 'yes' : 'no')} · ${t('diagnostics.controlling')}: ${diagnosticsStatus(diagnosticsState.serviceWorker.controlling ? 'yes' : 'no')}</dd></div>
        <div><dt>IndexedDB</dt><dd data-diagnostic="indexed-db">${diagnosticsStatus(diagnosticsState.indexedDb.status)} · ${t('diagnostics.cleanup')}: ${diagnosticsStatus(diagnosticsState.indexedDb.cleanup)}</dd></div>
        <div><dt>${t('diagnostics.authentication')}</dt><dd data-diagnostic="authentication" class="is-${diagnosticsState.authentication}">${diagnosticsStatus(diagnosticsState.authentication)}</dd></div>
        <div><dt>${t('diagnostics.latestError')}</dt><dd data-diagnostic="runtime-error">${escapeHtml(diagnosticsState.runtimeError === 'none' ? t('diagnostics.none') : diagnosticsState.runtimeError)}</dd></div>
      </dl></section>
    </main>
    <p class="diagnostics-warning">${t('diagnostics.honestyWarning')}</p>
    <button class="focusable v2-key-button v2-key-primary diagnostics-exit" data-diagnostics-action="exit" data-primary-action>${t('diagnostics.exit')}</button>
  </section>`;
  app.querySelector('[data-diagnostics-action="exit"]')?.addEventListener('click', () => {
    window.location.href = exitDiagnosticsUrl(window.location.href);
  });
  app.querySelector('[data-diagnostics-action="language"]')?.addEventListener('click', () => selectLanguage(locale === 'ko' ? 'en' : 'ko'));
  requestAnimationFrame(() => app.querySelector('[data-primary-action]')?.focus());
}

function renderInvalidDeviceRuntime() {
  app.innerHTML = `<section class="diagnostics-screen diagnostics-invalid-runtime">
    <p class="glasses-kicker">${t('diagnostics.invalidRuntime')}</p><h1>${t('diagnostics.invalidRuntimeTitle')}</h1>
    <p>${t('diagnostics.invalidRuntimeBody')}</p>
    <button class="focusable v2-key-button v2-key-primary" data-invalid-runtime-exit>${t('glasses.reviewInBrowser')}</button>
  </section>`;
  app.querySelector('[data-invalid-runtime-exit]')?.addEventListener('click', exitGlassesMode);
  requestAnimationFrame(() => app.querySelector('[data-invalid-runtime-exit]')?.focus());
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
  return v2Progress(step, 4, t('workflow.label'), 'workflow');
}

function v2ChecklistProgress() {
  return v2Progress(getCurrentHazardNumber(), state.hazards.length, t('hazards.label'), 'checklist');
}

function languageControl() {
  return `<label class="language-control"><span class="sr-only">${t('language.label')}</span><select data-language-selector aria-label="${t('language.label')}">
    <option value="ko" ${locale === 'ko' ? 'selected' : ''}>${t('language.korean')}</option>
    <option value="en" ${locale === 'en' ? 'selected' : ''}>${t('language.english')}</option>
  </select></label>`;
}

function v2Header(title, progressHtml = '') {
  return `
    <header class="v2-header">
      ${v2Logo()}
      <div class="v2-header-title"><h1 tabindex="-1" data-view-heading>${escapeHtml(title)}</h1></div>
      <div class="v2-header-right">
        ${languageControl()}
        ${progressHtml}
      </div>
    </header>
  `;
}

function v2StatusChip(label, value, tone = 'neutral') {
  return `
    <div class="v2-status-chip is-${tone}" role="group" aria-label="${escapeHtml(`${label}: ${value}`)}">
      <span>${escapeHtml(label)}</span>
      <strong><b aria-hidden="true">${statusSymbol(tone)}</b> ${escapeHtml(value)}</strong>
    </div>
  `;
}

function buildUserBadge() {
  if (!state.currentUser) return '';

  return `
    <section class="v2-user-badge user-badge" aria-label="${t('common.login')}">
      ${v2Icon('user')}
      <span>${escapeHtml(state.currentUser.name)}</span>
      <button class="focusable v2-user-logout" data-action="logout" aria-label="${t('common.logout')}">${t('common.logout')}</button>
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
    const response = await apiRequest(isMetaDisplayRuntime ? '/api/glasses/session' : '/api/auth/me', { cache: 'no-store' });
    const payload = await response.json().catch(() => ({}));

    if (isMetaDisplayRuntime) {
      if (!response.ok || !payload.scope) {
        state.currentUser = null;
        state.phase = 'glasses-pairing';
        render();
        return;
      }
      await establishGlassesScope(payload.scope);
      return;
    }

    if (!response.ok || !validatePublicUserBoundary(payload.user)) {
      state.currentUser = null;
      state.phase = isMetaDisplayRuntime ? 'glasses-pairing' : 'auth';
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
      state.authFeedback = t('auth.offlineIdentity');
      await loadHazards();
    } else {
      state.currentUser = null;
      state.authFeedback = getApiErrorMessage(error, t('auth.checkFailed'));
      state.phase = 'auth';
      render();
    }
  }
}

async function establishGlassesScope(scope) {
  state.glassesPairing.scope = scope;
  state.currentUser = { id: `glasses:${scope.siteId}`, name: '연결된 감독자', email: '', role: 'restricted_glasses' };
  state.session.siteName = scope.siteName;
  state.session.siteArea = scope.siteArea;
  if (scope.taskName) state.session.taskName = scope.taskName;
  await loadHazards();
  if (scope.type === 'tbm_session' && scope.sessionId) {
    const response = await apiRequest(`/api/sessions/${encodeURIComponent(scope.sessionId)}`, { cache: 'no-store' });
    const session = await response.json().catch(() => null);
    if (response.ok && session?.sessionId) {
      state.session = {
        ...state.session, sessionId: session.sessionId, createdAt: session.createdAt,
        siteName: session.site?.siteName ?? state.session.siteName, siteArea: session.site?.siteArea ?? state.session.siteArea,
        gps: session.site?.gps ?? state.session.gps, taskName: session.work?.taskName ?? state.session.taskName,
        workType: session.work?.workType ?? state.session.workType,
        plannedWorkDescription: session.work?.plannedWorkDescription ?? state.session.plannedWorkDescription,
        supervisorName: session.supervisor?.name ?? state.session.supervisorName,
        supervisorRole: session.supervisor?.role ?? state.session.supervisorRole,
        attendanceSummary: normalizeAttendanceSummary(session.attendanceSummary),
        sharing: normalizeSharing(session.sharing)
      };
      state.workers = (session.workers ?? []).map(normalizeWorker);
      state.responses = (session.hazards ?? []).map(normalizeHazard);
      state.hazards = state.responses.map((item) => ({
        id: item.id, name: item.title, category: item.category, location: item.location,
        riskLevel: item.riskLevel, risk: item.riskDescription, action: item.recommendedAction,
        evidencePhotos: item.evidencePhotos
      }));
      state.nearMisses = session.nearMisses ?? [];
      state.serverRevision = Number(session.revision) || 0;
      state.phase = 'start';
      state.glassesStep = GLASSES_STEP.START;
    }
  }
  if (isMetaDisplayRuntime) {
    const availability = await apiRequest('/api/glasses/native-device-availability', { cache: 'no-store' }).catch(() => null);
    const payload = availability ? await availability.json().catch(() => ({})) : {};
    state.nativeDeviceAvailable = Boolean(availability?.ok && payload.available);
  }
  render();
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
  state.authFeedback = isRegister ? t('auth.creating') : t('auth.loggingIn');
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

    if (!validatePublicUserBoundary(result.user)) throw new Error(t('auth.invalidResponse'));
    state.currentUser = result.user;
    await state.offlineStore?.putProfile({ userId: result.user.id, user: result.user });
    state.authFeedback = '';
    await loadHazards();
  } catch (error) {
    state.authFeedback = getApiErrorMessage(error, t('auth.failed'));
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
  state.authFeedback = t('auth.loggedOut');
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
    glassesReturnStep: state.glassesReturnStep,
    glassesMemoFeedback: state.glassesMemoFeedback,
    glassesPhotoFeedback: state.glassesPhotoFeedback,
    glassesReviewFeedback: state.glassesReviewFeedback,
    glassesAttendanceDigits: state.glassesAttendanceDigits,
    glassesProvisionalDecision: state.glassesProvisionalDecision,
    glassesContext: state.glassesContext,
    glassesSharingFeedback: state.glassesSharingFeedback,
    glassesSubmissionStatus: state.glassesSubmissionStatus,
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
    refreshNonStructuralUi();
  });
}

async function persistLocalDraft(status = DRAFT_STATUS_TEXT.DEVICE_ONLY) {
  if (!state.currentUser || !state.offlineStore) return false;
  state.draftStatus = status;
  try {
    await state.offlineStore.putDraft(buildLocalDraft());
    return true;
  } catch {
    state.draftStatus = DRAFT_STATUS_TEXT.UNAVAILABLE;
    return false;
  }
}

async function queueCurrentMutation(type = 'session_upsert', entityId = state.session.sessionId, saveMode = 'draft', synchronize = true) {
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
  if (navigator.onLine && synchronize) void synchronizeNow();
}

async function synchronizeNow() {
  if (!state.syncEngine) return;
  await state.syncEngine.syncAll();
  const draft = await state.offlineStore?.getDraft(state.session.sessionId);
  if (draft) {
    state.serverRevision = Number(draft.serverRevision) || state.serverRevision;
    state.syncConflict = draft.conflict ?? state.syncConflict;
    if (draft.serverSession) {
      const localSharing = normalizeSharing(state.session.sharing);
      const serverSharing = normalizeSharing(draft.serverSession.sharing);
      state.session.sharing = normalizeSharing({
        ...serverSharing,
        status: localSharing.status,
        method: localSharing.method,
        recipients: localSharing.recipients,
        proofType: localSharing.proofType,
        acknowledgmentResults: localSharing.acknowledgmentResults,
        sharedAt: serverSharing.sharedAt ?? localSharing.sharedAt
      });
      state.session.finalizedAt = draft.serverSession.finalizedAt ?? null;
      state.session.completedAt = draft.serverSession.completedAt ?? null;
    }
  }
  if (isGlassesMode && state.phase === 'summary') render();
  else refreshNonStructuralUi();
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
    sharing: normalizeSharing(draft.session.sharing),
    attendanceSummary: normalizeAttendanceSummary(draft.session.attendanceSummary)
  };
  state.workers = draft.workers.map(normalizeWorker);
  state.hazards = Array.isArray(draft.hazards) && draft.hazards.length ? draft.hazards : state.hazards;
  state.responses = draft.responses.map(normalizeHazard);
  state.responses.forEach((response) => {
    const action = response.correctiveAction;
    if (action?.duePeriod && Number.isNaN(new Date(action.dueAt).getTime())) {
      action.dueAt = duePeriodToDueAt(action.duePeriod, response.updatedAt ?? draft.deviceObservedAt);
    }
  });
  state.nearMisses = draft.nearMisses;
  state.index = Math.max(0, Math.min(state.responses.length - 1, Number(draft.index) || 0));
  state.phase = safePhase;
  state.memo = draft.memo ?? currentResponse()?.memo ?? '';
  state.glassesStep = normalizeGlassesStep(draft.glassesStep, {
    phase: safePhase,
    blockerCount: getFinalizationBlockers({ hazards: state.responses, sharing: state.session.sharing }).length,
    syncStatus: draft.syncStatus,
    completedAt: state.session.completedAt
  });
  state.glassesReturnStep = draft.glassesReturnStep ?? GLASSES_STEP.HAZARD_DECISION;
  state.glassesMemoFeedback = draft.glassesMemoFeedback ?? '';
  state.glassesPhotoFeedback = draft.glassesPhotoFeedback ?? '';
  state.glassesReviewFeedback = draft.glassesReviewFeedback ?? '';
  state.glassesAttendanceDigits = draft.glassesAttendanceDigits ?? state.glassesAttendanceDigits;
  state.glassesProvisionalDecision = draft.glassesProvisionalDecision ?? null;
  state.glassesContext = draft.glassesContext ?? null;
  state.glassesSharingFeedback = draft.glassesSharingFeedback ?? '';
  state.glassesSubmissionStatus = draft.glassesSubmissionStatus ?? '';
  state.saveFeedback = draft.saveFeedback ?? '';
  state.serverRevision = Number(draft.serverRevision) || 0;
  state.syncConflict = draft.conflict ?? null;
  state.pendingDraft = null;
  state.draftStatus = DRAFT_STATUS_TEXT.RESTORED;
}

function draftStatusHtml() {
  if (!state.draftStatus) return '';
  const retryHidden = [DRAFT_STATUS_TEXT.FAILED, DRAFT_STATUS_TEXT.QUEUED].includes(state.draftStatus) ? '' : 'hidden';
  const resolveHidden = state.draftStatus === DRAFT_STATUS_TEXT.CONFLICT ? '' : 'hidden';
  return `<div class="draft-status" data-sync-presentation><span>${escapeHtml(draftStatusLabel(state.draftStatus, t))}</span>
    <button class="focusable v2-key-button v2-key-small" data-action="retry-sync" ${retryHidden}>${t('sync.retry')}</button>
    <button class="focusable v2-key-button v2-key-small" data-action="resolve-conflict-local" ${resolveHidden}>${t('sync.reviewLocal')}</button>
  </div>`;
}

function bindCompositionSafeInput(element, callback) {
  let composing = false;
  element.addEventListener('compositionstart', () => { composing = true; });
  element.addEventListener('compositionend', (event) => {
    composing = false;
    callback(event.currentTarget.value);
  });
  element.addEventListener('input', (event) => {
    if (composing || event.isComposing) return;
    callback(event.currentTarget.value);
  });
}

function updateApplicationAnnouncement() {
  const statusLabel = state.draftStatus ? draftStatusLabel(state.draftStatus, t) : '';
  const statusChanged = state.draftStatus !== lastNormalDraftStatus;
  const urgent = state.draftStatus === DRAFT_STATUS_TEXT.FAILED || state.draftStatus === DRAFT_STATUS_TEXT.CONFLICT;
  const announcement = conciseAnnouncement({
    feedback: statusChanged || urgent ? '' : state.saveFeedback || state.authFeedback,
    status: state.draftStatus,
    statusLabel
  });
  let liveRegion = document.querySelector('#application-live-region');
  if (!liveRegion) {
    liveRegion = document.createElement('p');
    liveRegion.id = 'application-live-region';
    liveRegion.className = 'sr-only';
    document.body.append(liveRegion);
  }
  liveRegion.setAttribute('role', urgent ? 'alert' : 'status');
  liveRegion.setAttribute('aria-live', urgent ? 'assertive' : 'polite');
  liveRegion.setAttribute('aria-atomic', 'true');
  if (announcement !== lastNormalAnnouncement) liveRegion.textContent = announcement;
  lastNormalAnnouncement = announcement;
  lastNormalDraftStatus = state.draftStatus;
}

function refreshNonStructuralUi() {
  app.querySelectorAll('[data-sync-presentation]').forEach((presentation) => {
    const label = presentation.querySelector('span');
    if (label) label.textContent = draftStatusLabel(state.draftStatus, t);
    const retry = presentation.querySelector('[data-action="retry-sync"]');
    const resolve = presentation.querySelector('[data-action="resolve-conflict-local"]');
    if (retry) retry.hidden = ![DRAFT_STATUS_TEXT.FAILED, DRAFT_STATUS_TEXT.QUEUED].includes(state.draftStatus);
    if (resolve) resolve.hidden = state.draftStatus !== DRAFT_STATUS_TEXT.CONFLICT;
  });
  const saveFeedback = app.querySelector('[data-save-feedback]');
  if (saveFeedback) saveFeedback.textContent = state.saveFeedback;
  const glassesSync = app.querySelector('.glasses-sync');
  if (glassesSync) {
    const presentation = glassesSyncState(state.draftStatus);
    glassesSync.className = `glasses-sync is-${presentation.tone}`;
    glassesSync.textContent = t(presentation.key);
  }
  updateApplicationAnnouncement();
}

function getSummaryPresentation(blockers) {
  const proposedStatus = blockers.length ? 'draft' : getPotentialRecordStatus();
  const isRecorded = Boolean(state.session.finalizedAt);
  const title = state.session.completedAt
    ? t('summary.complete')
    : isRecorded && proposedStatus === 'actions_open'
      ? t('summary.actionsOpen')
      : blockers.length
        ? t('summary.blocked')
        : proposedStatus === 'actions_open'
          ? t('summary.readyActions')
          : t('summary.readyFinalize');
  const explanation = blockers.length
    ? t('summary.blockedExplanation')
    : proposedStatus === 'actions_open'
      ? t('summary.actionsOpenExplanation')
      : t('summary.completeExplanation');
  return { proposedStatus, title, explanation };
}

function refreshSummaryDerivedUi() {
  if (state.phase !== 'summary') return;
  const blockers = getFinalizationBlockers(buildSessionLog());
  const presentation = getSummaryPresentation(blockers);
  const blockerPanel = app.querySelector('[data-finalization-blockers]');
  if (blockerPanel) {
    blockerPanel.innerHTML = blockers.length
      ? `<ul>${blockers.map((blocker) => `<li>${escapeHtml(localizeFinalizationBlocker(blocker, t))}</li>`).join('')}</ul>`
      : `<p>${t('summary.noBlockers')}</p>`;
  }
  const title = app.querySelector('[data-summary-title]');
  const explanation = app.querySelector('[data-summary-explanation]');
  if (title) title.textContent = presentation.title;
  if (explanation) explanation.textContent = presentation.explanation;
  const status = app.querySelector('.v2-summary-hero .v2-status-chip');
  if (status) {
    status.className = `v2-status-chip is-${blockers.length ? 'warning' : 'success'}`;
    status.setAttribute('aria-label', `${t('common.status')}: ${presentation.proposedStatus}`);
    const value = status.querySelector('strong');
    if (value) value.innerHTML = `<b aria-hidden="true">${statusSymbol(blockers.length ? 'warning' : 'success')}</b> ${escapeHtml(presentation.proposedStatus)}`;
  }
  const finalize = app.querySelector('[data-action="finalize"]');
  if (finalize) finalize.disabled = state.isSavingSession || blockers.length > 0;
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
  if (!isGlassesMode && state.currentUser && navigator.onLine) {
    void loadEvidenceRequests();
    void loadNativeDevices();
  }
}

function makeStressHazards(hazards) {
  return [
    {
      id: 'open-floor-hole-stress',
      name: '지하 3층 동측 자재 반입구 인근 임시 개구부 주변 추락 위험 방지 시설과 접근 통제 상태를 확인하는 매우 긴 점검 항목',
      location:
        '지하 3층 동측 임시 호이스트 승강장 옆 자재 적치 구역과 C-12 그리드 사이의 매우 긴 작업 위치',
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

async function loadEvidenceRequests() {
  state.evidenceRequestsStatus = 'loading';
  try {
    const response = await apiFetch('/api/evidence-requests?status=pending', { cache: 'no-store' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Could not load evidence requests.');
    state.evidenceRequests = payload.requests ?? [];
    state.evidenceRequestsStatus = 'ready';
  } catch (error) {
    state.evidenceRequestsStatus = 'error';
    state.evidenceRequestFeedback = navigator.onLine ? getApiErrorMessage(error, 'Could not load evidence requests.') : 'Offline: requests cannot be refreshed.';
  }
  if (state.phase === 'start') render();
}

async function loadNativeDevices() {
  state.nativeDevicesStatus = 'loading';
  try {
    const response = await apiFetch('/api/native-devices', { cache: 'no-store' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Could not load native devices.');
    state.nativeDevices = payload.devices ?? [];
    state.nativeDevicesStatus = 'ready';
    state.nativeDeviceFeedback = '';
  } catch (error) {
    state.nativeDevicesStatus = 'error';
    state.nativeDeviceFeedback = navigator.onLine ? getApiErrorMessage(error, 'Could not load native devices.') : 'Offline: native devices cannot be managed.';
  }
  if (state.phase === 'start') render();
}

async function createNativeDeviceRegistration(form) {
  const name = String(new FormData(form).get('nativeDeviceName') ?? '').trim();
  const response = await apiFetch('/api/native-devices/registrations', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) state.nativeDeviceFeedback = payload.error ?? 'Device registration failed.';
  else {
    state.nativeDeviceRegistration = payload;
    state.nativeDeviceFeedback = 'Enter this one-time code in the Android companion app.';
  }
  render();
}

async function revokeNativeDevice(deviceId) {
  const response = await apiFetch(`/api/native-devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE' });
  if (!response.ok) state.nativeDeviceFeedback = (await response.json().catch(() => ({}))).error ?? 'Device revocation failed.';
  else {
    state.nativeDeviceRegistration = null;
    state.nativeDeviceFeedback = 'Native device revoked.';
    await loadNativeDevices();
  }
  render();
}

function clearEvidenceSelection() {
  if (state.evidenceFulfillment?.previewUrl) URL.revokeObjectURL(state.evidenceFulfillment.previewUrl);
  state.evidenceFulfillment = null;
}

function selectEvidenceFile(requestId, file, provider) {
  clearEvidenceSelection();
  const allowed = ['image/jpeg', 'image/png', 'image/webp'];
  if (!file || !allowed.includes(file.type) || file.size > 5 * 1024 * 1024) {
    state.evidenceRequestFeedback = 'Choose a JPEG, PNG, or WebP image no larger than 5 MB.';
  } else {
    state.evidenceFulfillment = { requestId, file, provider, previewUrl: URL.createObjectURL(file), uploaded: null, submitting: false };
    state.evidenceRequestFeedback = '';
  }
  render();
}

async function fulfillEvidenceRequest() {
  const selected = state.evidenceFulfillment;
  if (!selected || selected.submitting) return;
  selected.submitting = true; state.evidenceRequestFeedback = 'Uploading privately…'; render();
  try {
    if (!selected.uploaded) {
      const form = new FormData(); form.append('photos', selected.file);
      const uploadResponse = await apiFetch('/api/uploads', { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: form });
      const uploads = await uploadResponse.json();
      if (!uploadResponse.ok) throw new Error(uploads.error || 'Private upload failed.');
      selected.uploaded = uploads[0];
    }
    const completeResponse = await apiFetch(`/api/evidence-requests/${encodeURIComponent(selected.requestId)}/complete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId: selected.uploaded.uploadId ?? selected.uploaded.id, provider: selected.provider })
    });
    const payload = await completeResponse.json();
    if (!completeResponse.ok) throw new Error(payload.error || 'Request completion failed.');
    clearEvidenceSelection(); state.evidenceRequestFeedback = 'Photo uploaded. The glasses must check and explicitly attach it.';
    await loadEvidenceRequests();
  } catch (error) {
    selected.submitting = false;
    state.evidenceRequestFeedback = navigator.onLine ? getApiErrorMessage(error, 'Upload failed. Try again.') : 'Offline: no upload or completion was reported.';
    render();
  }
}

async function cancelSupervisorEvidenceRequest(requestId) {
  const response = await apiFetch(`/api/evidence-requests/${encodeURIComponent(requestId)}`, { method: 'DELETE' });
  if (!response.ok && response.status !== 204) state.evidenceRequestFeedback = (await response.json()).error || 'Cancellation failed.';
  clearEvidenceSelection(); await loadEvidenceRequests();
}

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
  refreshSummaryDerivedUi();
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
  if (response.status === HAZARD_STATUS.ACTION_REQUIRED && !isGlassesMode) {
    pendingFocusSelector = '[data-corrective-field="immediateControl"]';
  }

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
// Capture behavior is supplied by the adapter; only the preview adapter returns mocks.

async function captureGlassesPhoto() {
  const response = currentResponse();
  if (!response) return;

  const result = await deviceAdapter.captureEvidence({ hazardNumber: getCurrentHazardNumber() });
  if (result.status !== 'captured') {
    state.glassesPhotoFeedback = result.status === 'unsupported' ? t('glasses.metaCameraUnsupported') : t('glasses.captureFailed');
    state.glassesAnnouncement = state.glassesPhotoFeedback;
    render();
    return;
  }

  markRecordDirty();
  response.evidencePhotos = [...(response.evidencePhotos ?? []), result.value];
  response.updatedAt = new Date().toISOString();
  state.glassesPhotoFeedback = t('glasses.mockPhotoRecorded');
  state.glassesStep = GLASSES_STEP.PHOTO_EVIDENCE;
  state.glassesAnnouncement = t('glasses.photoCaptured');
  saveLocalDraft();
  render();
}

async function createPhoneEvidenceRequest() {
  const response = currentResponse();
  if (!response) return;
  state.glassesPhotoFeedback = '';
  try {
    const result = await apiFetch('/api/glasses/evidence-requests', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: state.session.sessionId, hazardId: response.id })
    });
    const payload = await result.json();
    if (!result.ok) throw new Error(payload.error || 'Evidence request failed.');
    state.glassesEvidenceRequest = payload;
    state.glassesStep = GLASSES_STEP.EVIDENCE_HANDOFF;
  } catch (error) {
    state.glassesPhotoFeedback = navigator.onLine ? getApiErrorMessage(error, 'Phone request failed.') : 'Offline: the phone request was not created.';
  }
  render();
}

async function createNativeEvidenceRequest() {
  const response = currentResponse();
  if (!response || !state.nativeDeviceAvailable) return;
  try {
    const result = await apiFetch('/api/glasses/evidence-requests', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: state.session.sessionId, hazardId: response.id, provider: EVIDENCE_PROVIDER.NATIVE_DAT_CAMERA }) });
    const payload = await result.json();
    if (!result.ok) throw new Error(payload.error || 'Native capture request failed.');
    state.glassesEvidenceRequest = payload;
    state.glassesStep = GLASSES_STEP.NATIVE_CAPTURE_PREPARE;
    state.glassesPhotoFeedback = '';
  } catch (error) { state.glassesPhotoFeedback = navigator.onLine ? getApiErrorMessage(error, 'Native capture request failed.') : 'Offline: no camera request was created.'; }
  render();
}

async function confirmNativeCapture() {
  const item = state.glassesEvidenceRequest;
  if (!item?.id) return;
  try {
    const result = await apiFetch(`/api/glasses/evidence-requests/${encodeURIComponent(item.id)}/ready`, { method: 'POST' });
    const payload = await result.json();
    if (!result.ok) throw new Error(payload.error || 'Capture confirmation failed.');
    state.glassesEvidenceRequest = payload;
    state.glassesStep = GLASSES_STEP.EVIDENCE_HANDOFF;
    state.glassesPhotoFeedback = '';
  } catch (error) { state.glassesPhotoFeedback = navigator.onLine ? getApiErrorMessage(error, 'Capture confirmation failed.') : 'Offline: capture was not confirmed.'; }
  render();
}

async function retakeNativeEvidence() {
  const item = state.glassesEvidenceRequest;
  if (!item?.id || item.attachedAt) return;
  try {
    const result = await apiFetch(`/api/glasses/evidence-requests/${encodeURIComponent(item.id)}/retake`, { method: 'POST' });
    const payload = await result.json();
    if (!result.ok) throw new Error(payload.error || 'Retake failed.');
    state.glassesEvidenceRequest = payload;
    state.glassesStep = GLASSES_STEP.NATIVE_CAPTURE_PREPARE;
    state.glassesPhotoFeedback = '';
  } catch (error) { state.glassesPhotoFeedback = getApiErrorMessage(error, 'Retake failed.'); }
  render();
}

async function refreshPhoneEvidenceRequest() {
  if (!state.glassesEvidenceRequest?.id) return;
  try {
    const result = await apiFetch(`/api/glasses/evidence-requests/${encodeURIComponent(state.glassesEvidenceRequest.id)}`);
    const payload = await result.json();
    if (!result.ok) throw new Error(payload.error || 'Status check failed.');
    state.glassesEvidenceRequest = payload;
    state.glassesPhotoFeedback = '';
  } catch (error) {
    state.glassesPhotoFeedback = navigator.onLine ? getApiErrorMessage(error, 'Status check failed.') : 'Offline: completion could not be checked.';
  }
  render();
}

async function cancelPhoneEvidenceRequest() {
  if (!state.glassesEvidenceRequest?.id) return;
  try {
    const result = await apiFetch(`/api/glasses/evidence-requests/${encodeURIComponent(state.glassesEvidenceRequest.id)}`, { method: 'DELETE' });
    if (!result.ok && result.status !== 204) throw new Error((await result.json()).error || 'Cancellation failed.');
    state.glassesEvidenceRequest = null;
    state.glassesStep = GLASSES_STEP.PHOTO_EVIDENCE;
  } catch (error) { state.glassesPhotoFeedback = getApiErrorMessage(error, 'Cancellation failed.'); }
  render();
}

async function attachPhoneEvidenceRequest() {
  const requestItem = state.glassesEvidenceRequest;
  const response = currentResponse();
  if (!requestItem?.id || !response) return;
  try {
    const result = await apiFetch(`/api/glasses/evidence-requests/${encodeURIComponent(requestItem.id)}/attach`, { method: 'POST' });
    const payload = await result.json();
    if (!result.ok) throw new Error(payload.error || 'Attachment failed.');
    const evidence = payload.evidence;
    if (evidence && !(response.evidencePhotos ?? []).some((item) => item.uploadId === evidence.uploadId)) {
      response.evidencePhotos = [...(response.evidencePhotos ?? []), evidence];
    }
    state.glassesEvidenceRequest = payload;
    state.glassesStep = GLASSES_STEP.HAZARD_CONFIRMATION;
    saveLocalDraft();
  } catch (error) { state.glassesPhotoFeedback = getApiErrorMessage(error, 'Attachment failed.'); }
  render();
}

async function captureGlassesMemo() {
  const result = await deviceAdapter.captureMemo();
  if (result.status !== 'captured') {
    state.glassesMemoFeedback = result.status === 'unsupported' ? t('glasses.metaVoiceUnsupported') : t('glasses.captureFailed');
    state.glassesAnnouncement = state.glassesMemoFeedback;
    render();
    return;
  }
  markRecordDirty();
  state.memo = result.value;
  const response = currentResponse();
  if (response) response.memo = result.value;
  state.glassesMemoFeedback = t('glasses.memoCaptured');
  state.glassesAnnouncement = state.glassesMemoFeedback;
  saveLocalDraft();
  render();
}

function startGlassesTbm() {
  markRecordDirty();
  if (!state.session.startedAt) state.session.startedAt = new Date().toISOString();
  state.glassesContext = {
    observedAt: new Date().toISOString(), timeSource: 'device_time',
    locationSource: state.session.gps?.latitude != null ? 'session_coordinates' : 'session_site'
  };
  state.glassesStep = GLASSES_STEP.CONTEXT_CONFIRMATION;
  state.glassesAnnouncement = t('glasses.contextTitle');
  saveLocalDraft(DRAFT_STATUS_TEXT.DEVICE_ONLY);
  render();
}

function continueGlassesFromWorkers() {
  const digits = state.glassesAttendanceDigits;
  const summary = normalizeAttendanceSummary({ expectedCount: attendanceValue(digits.expectedTens, digits.expectedOnes),
    presentCount: attendanceValue(digits.presentTens, digits.presentOnes), captureSource: ATTENDANCE_CAPTURE_SOURCE.GLASSES_COUNT_SELECTOR,
    deviceObservedAt: new Date().toISOString() });
  if (!summary) return;
  markRecordDirty();
  state.session.attendanceSummary = summary;
  state.phase = 'checklist';
  state.index = 0;
  state.memo = currentResponse()?.memo ?? '';
  state.glassesStep = GLASSES_STEP.HAZARD_DECISION;
  state.glassesAnnouncement = t('hazard.checklist');
  saveLocalDraft();
  void queueCurrentMutation('attendance_acknowledgment', state.session.sessionId);
  render();
}

function exitGlassesMode() {
  window.location.href = normalBrowserUrl(window.location.href);
}

async function handleGlassesAction(action) {
  if (action === 'toggle-help') {
    state.glassesHelpOpen = !state.glassesHelpOpen;
    render();
    return;
  }
  if (action === 'exit') {
    exitGlassesMode();
    return;
  }

  if (action === 'start') {
    startGlassesTbm();
    return;
  }
  if (action === 'context-confirm') {
    state.phase = 'participation'; state.glassesStep = GLASSES_STEP.ATTENDANCE; saveLocalDraft(); render(); return;
  }
  if (action === 'context-reject') {
    state.glassesStep = GLASSES_STEP.START; saveLocalDraft(); render(); return;
  }
  if (action.startsWith('attendance-cycle-')) {
    const key = action.slice('attendance-cycle-'.length);
    if (key in state.glassesAttendanceDigits) state.glassesAttendanceDigits[key] = (state.glassesAttendanceDigits[key] + 1) % 10;
    saveLocalDraft(); render(); return;
  }
  if (action.startsWith('corrective-cycle-')) {
    const field = action.slice('corrective-cycle-'.length);
    const values = {
      immediateResponseCategory: Object.values(IMMEDIATE_RESPONSE_CATEGORY),
      responsibleParty: Object.values(RESPONSIBLE_PARTY),
      workStatus: [WORK_STATUS.STOPPED, WORK_STATUS.PERMITTED_WITH_CONTROLS],
      duePeriod: Object.values(DUE_PERIOD)
    }[field] ?? [];
    const current = normalizeCorrectiveAction(currentResponse()?.correctiveAction, HAZARD_STATUS.ACTION_REQUIRED)[field];
    const value = values[(values.indexOf(current) + 1) % values.length];
    updateCorrectiveAction(field, value);
    if (field === 'immediateResponseCategory') updateCorrectiveAction('immediateControl', value);
    if (field === 'responsibleParty') updateCorrectiveAction('assignedTo', value);
    if (field === 'duePeriod') updateCorrectiveAction('dueAt', duePeriodToDueAt(value));
    saveLocalDraft(); render(); return;
  }
  if (action === 'sharing-toggle') {
    const sharing = normalizeSharing(state.session.sharing);
    state.session.sharing = { ...sharing, status: sharing.status === SHARING_STATUS.SHARED ? SHARING_STATUS.NOT_RECORDED : SHARING_STATUS.SHARED, recipients: sharing.status === SHARING_STATUS.SHARED ? '' : 'All expected workers' };
    saveLocalDraft(); render(); return;
  }
  if (action === 'sharing-cycle-method' || action === 'sharing-cycle-proof') {
    const key = action === 'sharing-cycle-method' ? 'method' : 'proofType';
    const values = action === 'sharing-cycle-method' ? Object.values(SHARING_METHOD) : Object.values(SHARING_PROOF_TYPE);
    const sharing = normalizeSharing(state.session.sharing);
    updateSharing(key, values[(values.indexOf(sharing[key]) + 1) % values.length]);
    saveLocalDraft(); render(); return;
  }
  if (action === 'attendance-continue') {
    continueGlassesFromWorkers();
    return;
  }
  if (action === 'mock-photo') {
    if (state.phase !== 'checklist') return;
    await captureGlassesPhoto();
    return;
  }
  if (action === 'evidence-continue') {
    state.glassesStep = GLASSES_STEP.HAZARD_CONFIRMATION; saveLocalDraft(); render(); return;
  }
  if (action === 'phone-evidence-start') { await createPhoneEvidenceRequest(); return; }
  if (action === 'native-evidence-start') { await createNativeEvidenceRequest(); return; }
  if (action === 'native-capture-confirm') { await confirmNativeCapture(); return; }
  if (action === 'native-evidence-retake') { await retakeNativeEvidence(); return; }
  if (action === 'phone-evidence-check') { await refreshPhoneEvidenceRequest(); return; }
  if (action === 'phone-evidence-cancel') { await cancelPhoneEvidenceRequest(); return; }
  if (action === 'phone-evidence-attach') { await attachPhoneEvidenceRequest(); return; }

  if (action === 'controlled') {
    if (state.glassesStep !== GLASSES_STEP.HAZARD_DECISION) return;
    if (state.phase !== 'checklist') state.phase = 'checklist';
    state.glassesProvisionalDecision = HAZARD_STATUS.CONTROLLED;
    state.glassesStep = GLASSES_STEP.PHOTO_EVIDENCE;
    state.glassesReviewFeedback = t('glasses.controlledFeedback', { number: getCurrentHazardNumber() });
    saveLocalDraft(); render();
    return;
  }

  if (action === 'action-required') {
    if (state.glassesStep !== GLASSES_STEP.HAZARD_DECISION) return;
    if (state.phase !== 'checklist') state.phase = 'checklist';
    state.glassesProvisionalDecision = HAZARD_STATUS.ACTION_REQUIRED;
    state.glassesStep = GLASSES_STEP.CORRECTIVE_ACTION;
    state.glassesReviewFeedback = t('glasses.actionFeedback', { number: getCurrentHazardNumber() });
    const response = currentResponse(); response.status = HAZARD_STATUS.ACTION_REQUIRED;
    response.correctiveAction = normalizeCorrectiveAction(response.correctiveAction, response.status);
    saveLocalDraft(); render();
    return;
  }
  if (action === 'corrective-continue') { state.glassesStep = GLASSES_STEP.PHOTO_EVIDENCE; saveLocalDraft(); render(); return; }
  if (action === 'hazard-confirm') {
    const response = currentResponse(); const reviewedAt = new Date().toISOString();
    response.status = state.glassesProvisionalDecision; response.updatedAt = reviewedAt;
    response.humanReview = { reviewed: true, decision: response.status, reviewedBy: state.session.supervisorName, reviewedAt };
    response.correctiveAction = normalizeCorrectiveAction(response.correctiveAction, response.status);
    state.glassesProvisionalDecision = null;
    if (state.index < state.hazards.length - 1) { state.index += 1; state.glassesStep = GLASSES_STEP.HAZARD_DECISION; }
    else { state.phase = 'summary'; state.glassesStep = GLASSES_STEP.HAZARD_SUMMARY; }
    saveLocalDraft(); void queueCurrentMutation('hazard_review', response.id); render(); return;
  }
  if (action === 'summary-continue') { state.glassesStep = GLASSES_STEP.SHARING_RECORD; saveLocalDraft(); render(); return; }
  if (action === 'record-continue') {
    const sharing = normalizeSharing(state.session.sharing);
    const errors = getSharingScreenErrors(sharing);
    if (errors.length) { state.glassesSharingFeedback = t('glasses.sharingMissing'); render(); return; }
    state.glassesSharingFeedback = '';
    if (!(await persistLocalDraft())) { state.glassesSharingFeedback = t('glasses.localDraftFailed'); render(); return; }
    await queueCurrentMutation('sharing_event', state.session.sessionId);
    state.glassesStep = GLASSES_STEP.REPORT_REVIEW;
    if (!(await persistLocalDraft(state.draftStatus))) { state.glassesStep = GLASSES_STEP.SHARING_RECORD; state.glassesSharingFeedback = t('glasses.localDraftFailed'); }
    render(); return;
  }
  if (action === 'submit-report') {
    const blockers = getFinalizationBlockers(buildSessionLog());
    if (blockers.length || state.isSavingSession) return;
    state.glassesStep = GLASSES_STEP.SUBMITTING_REPORT; state.glassesSubmissionStatus = 'submitting';
    await persistLocalDraft(state.draftStatus); render();
    const result = await saveCurrentSession('finalize');
    if (result?.status === DRAFT_STATUS_TEXT.CONFLICT) { state.glassesStep = GLASSES_STEP.CONFLICT; state.glassesSubmissionStatus = 'conflict'; }
    else if (result?.ok && result.status === DRAFT_STATUS_TEXT.SYNCED) { state.glassesStep = GLASSES_STEP.COMPLETE; state.glassesSubmissionStatus = 'submitted'; }
    else if (result?.ok && result.status === DRAFT_STATUS_TEXT.QUEUED) { state.glassesStep = GLASSES_STEP.COMPLETE; state.glassesSubmissionStatus = 'queued'; }
    else { state.glassesStep = GLASSES_STEP.REPORT_REVIEW; state.glassesSubmissionStatus = 'failed'; }
    await persistLocalDraft(state.draftStatus); render(); return;
  }
  if (action === 'done') { state.glassesStep = GLASSES_STEP.START; state.phase = 'start'; saveLocalDraft(); render(); return; }

  if (action === 'prev') {
    if (state.glassesStep === GLASSES_STEP.CONTEXT_CONFIRMATION) state.glassesStep = GLASSES_STEP.START;
    else if (state.glassesStep === GLASSES_STEP.ATTENDANCE) state.glassesStep = GLASSES_STEP.CONTEXT_CONFIRMATION;
    else if (state.glassesStep === GLASSES_STEP.HAZARD_DECISION && state.index > 0) goTo(state.index - 1);
    else if (state.glassesStep === GLASSES_STEP.HAZARD_DECISION) {
      state.phase = 'participation';
      state.glassesStep = GLASSES_STEP.ATTENDANCE;
    } else if (state.glassesStep === GLASSES_STEP.CORRECTIVE_ACTION) state.glassesStep = GLASSES_STEP.HAZARD_DECISION;
    else if (state.glassesStep === GLASSES_STEP.PHOTO_EVIDENCE) state.glassesStep = state.glassesProvisionalDecision === HAZARD_STATUS.ACTION_REQUIRED ? GLASSES_STEP.CORRECTIVE_ACTION : GLASSES_STEP.HAZARD_DECISION;
    else if (state.glassesStep === GLASSES_STEP.NATIVE_CAPTURE_PREPARE) state.glassesStep = GLASSES_STEP.PHOTO_EVIDENCE;
    else if (state.glassesStep === GLASSES_STEP.EVIDENCE_HANDOFF) state.glassesStep = GLASSES_STEP.PHOTO_EVIDENCE;
    else if (state.glassesStep === GLASSES_STEP.HAZARD_CONFIRMATION) state.glassesStep = GLASSES_STEP.PHOTO_EVIDENCE;
    else if (state.glassesStep === GLASSES_STEP.HAZARD_SUMMARY) { state.phase = 'checklist'; state.index = Math.max(0, state.responses.length - 1); state.glassesStep = GLASSES_STEP.HAZARD_CONFIRMATION; state.glassesProvisionalDecision = currentResponse().status; }
    else if (state.glassesStep === GLASSES_STEP.SHARING_RECORD) state.glassesStep = GLASSES_STEP.HAZARD_SUMMARY;
    else if (state.glassesStep === GLASSES_STEP.REPORT_REVIEW) state.glassesStep = GLASSES_STEP.SHARING_RECORD;
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
  return t('hazard.progress', { current: getCurrentHazardNumber(), total: state.hazards.length });
}

function getPotentialRecordStatus() {
  return getRecordStatus({ hazards: state.responses, sharing: state.session.sharing });
}

function getSessionStatus() {
  return state.session.finalizedAt ? getPotentialRecordStatus() : 'draft';
}

function recordStatusLabel(status) {
  return t(`status.${status}`);
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
  state.manualUploadedEvidence = [];
  state.phase = 'manual-entry';
  render();
}

function cancelManualEntry() {
  state.phase = state.returnPhase;
  render();
}

function manualEntryHasUnsavedValues() {
  const form = app.querySelector('#manual-entry-form');
  if (!form) return false;
  return hasUnsavedManualEntry({
    title: form.elements.title?.value,
    location: form.elements.location?.value,
    description: form.elements.description?.value,
    actionText: form.elements.actionText?.value,
    evidencePhotos: Array.from(form.elements.evidencePhotos?.files ?? [])
  });
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

  const analysis = state.manualAiSuggestion;
  const suggestion = analysis.suggestion ?? analysis;
  const decisionText =
    state.manualAiDecision === 'accepted'
      ? t('ai.accepted')
      : state.manualAiDecision === 'edited'
        ? t('ai.edited')
      : state.manualAiDecision === 'rejected'
        ? t('ai.rejected')
        : t('ai.reviewRequired');
  const confidencePercent = `${Math.round(suggestion.confidence * 100)}%`;

  container.innerHTML = `
    <section class="v2-card v2-ai-card ai-suggestion-card ${state.manualAiDecision ? `is-${state.manualAiDecision}` : ''}" aria-label="${t('ai.simulatedSuggestion')}">
      <div class="v2-ai-header"><h3>${t('ai.simulatedSuggestion')}</h3><span>${t('ai.simulated')}</span></div>
      <div class="v2-ai-hero">
        <div class="v2-warning-tile">!</div>
        <div>
          <h2>${escapeHtml(suggestion.title)}</h2>
          <p>${escapeHtml(suggestion.description)}</p>
        </div>
      </div>
      <dl class="v2-ai-facts">
        <div><dt>${t('ai.category')}</dt><dd>${escapeHtml(suggestion.category)}</dd></div>
        <div><dt>${t('ai.riskLevel')}</dt><dd>${escapeHtml(suggestion.riskLevel)}</dd></div>
        <div><dt>${t('ai.confidence')}</dt><dd>${confidencePercent}</dd></div>
        <div><dt>${t('common.status')}</dt><dd>${decisionText}</dd></div>
      </dl>
      <p class="v2-ai-note"><strong>${t('ai.mockPixelsNotRead')}</strong></p>
      <p class="v2-ai-note">${t('ai.reviewNote')}</p>
      <p class="v2-ai-note">${escapeHtml(suggestion.recommendedAction)}</p>
      <section class="v2-ai-actions">
        <button class="focusable v2-key-button v2-key-primary v2-key-small" type="button" data-action="accept-ai">${t('ai.accept')}</button>
        <button class="focusable v2-key-button v2-key-small" type="button" data-action="edit-ai">${t('ai.edit')}</button>
        <button class="focusable v2-key-button v2-key-small" type="button" data-action="reject-ai">${t('ai.reject')}</button>
      </section>
    </section>
  `;

  container.querySelector('button[data-action="accept-ai"]').addEventListener('click', async () => {
    await acceptManualAiSuggestion(app.querySelector('#manual-entry-form'));
  });
  container.querySelector('button[data-action="edit-ai"]').addEventListener('click', async () => {
    await editManualAiSuggestion(app.querySelector('#manual-entry-form'));
  });
  container.querySelector('button[data-action="reject-ai"]').addEventListener('click', async () => {
    await rejectManualAiSuggestion();
  });
}

async function uploadEvidenceForAnalysis(file) {
  const existing = state.manualUploadedEvidence.find((item) => item.originalName === file.name && item.size === file.size);
  if (existing) return existing;
  const formData = new FormData();
  formData.append('photos', file, file.name);
  const response = await apiFetch('/api/uploads', { method: 'POST', body: formData });
  const payload = await response.json().catch(() => ([]));
  if (!response.ok || !Array.isArray(payload) || !payload[0]?.uploadId) {
    throw new Error(payload.error ?? `Evidence upload failed (${response.status})`);
  }
  state.manualUploadedEvidence = [...state.manualUploadedEvidence, payload[0]];
  return payload[0];
}

async function analyzeManualPhoto(form) {
  const files = Array.from(form.elements.evidencePhotos?.files ?? []);
  if (!files.length) {
    state.manualEntryFeedback = t('feedback.photoRequired');
    app.querySelector('#manual-entry-feedback').textContent = state.manualEntryFeedback;
    return;
  }

  const analyzeButton = app.querySelector('#analyze-photo-button');
  state.manualEntryFeedback = t('feedback.aiRequest');
  app.querySelector('#manual-entry-feedback').textContent = state.manualEntryFeedback;
  analyzeButton.disabled = true;
  analyzeButton.textContent = t('feedback.analyzing');

  try {
    const uploadedEvidence = await uploadEvidenceForAnalysis(files[0]);
    const response = await apiFetch('/api/ai/analyze-hazard', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        entryType: form.elements.type.value,
        uploadId: uploadedEvidence.uploadId,
        sessionId: state.session.sessionId
      })
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(payload.error ?? `Mock AI analysis failed (${response.status})`);
    }

    state.manualAiSuggestion = payload;
    state.manualAiDecision = null;
    state.manualEntryFeedback = t('feedback.aiGenerated');
    app.querySelector('#manual-entry-feedback').textContent = state.manualEntryFeedback;
    renderAiSuggestion();
  } catch (error) {
    state.manualAiSuggestion = null;
    state.manualAiDecision = null;
    state.manualEntryFeedback = getApiErrorMessage(error, t('feedback.aiFailed'));
    app.querySelector('#manual-entry-feedback').textContent = state.manualEntryFeedback;
    renderAiSuggestion();
  } finally {
    analyzeButton.disabled = false;
    analyzeButton.textContent = t('hazard.generateMockSuggestion');
  }
}

function currentManualSuggestion(form) {
  return {
    title: form.elements.title.value.trim(), category: form.elements.category.value.trim(),
    riskLevel: form.elements.riskLevel.value, description: form.elements.description.value.trim(),
    recommendedAction: form.elements.actionText.value.trim()
  };
}

function suggestionMatchesForm(form) {
  const original = state.manualAiSuggestion?.suggestion;
  if (!original) return false;
  const current = currentManualSuggestion(form);
  return ['title', 'category', 'riskLevel', 'description', 'recommendedAction']
    .every((key) => current[key] === original[key]);
}

async function persistManualAiDecision(form, decision = state.manualAiDecision) {
  if (!state.manualAiSuggestion?.analysisId || !decision) return null;
  const response = await apiFetch(`/api/ai/analyses/${encodeURIComponent(state.manualAiSuggestion.analysisId)}/review`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision, ...(decision === 'edited' ? { editedSuggestion: currentManualSuggestion(form) } : {}) })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `Suggestion review failed (${response.status})`);
  state.manualAiSuggestion = { ...state.manualAiSuggestion, ...payload };
  return payload;
}

function getManualAiMetadata(form) {
  if (!state.manualAiSuggestion || !state.manualAiDecision) return null;
  const accepted = state.manualAiDecision === 'accepted';
  return {
    analysisId: state.manualAiSuggestion.analysisId,
    uploadId: state.manualAiSuggestion.uploadId,
    uploadHash: state.manualAiSuggestion.uploadHash,
    source: state.manualAiSuggestion.mode === 'mock' ? 'mock_ai' : 'ai_provider',
    mode: state.manualAiSuggestion.mode,
    provider: state.manualAiSuggestion.provider,
    modelVersion: state.manualAiSuggestion.modelVersion,
    simulated: state.manualAiSuggestion.simulated,
    pixelInterpretation: state.manualAiSuggestion.pixelInterpretation,
    disclaimer: state.manualAiSuggestion.disclaimer,
    requestedAt: state.manualAiSuggestion.requestedAt,
    completedAt: state.manualAiSuggestion.completedAt,
    rawSuggestion: state.manualAiSuggestion.suggestion,
    humanDecision: state.manualAiDecision,
    accepted,
    edited: state.manualAiDecision === 'edited',
    rejected: state.manualAiDecision === 'rejected',
    reviewer: state.manualAiSuggestion.reviewer,
    confidence: state.manualAiSuggestion.suggestion?.confidence,
    reviewedAt: state.manualAiSuggestion.reviewedAt,
    finalHumanSuggestion: state.manualAiDecision === 'rejected' ? null : currentManualSuggestion(form)
  };
}

async function acceptManualAiSuggestion(form) {
  if (!state.manualAiSuggestion) return;

  const suggestion = state.manualAiSuggestion.suggestion ?? state.manualAiSuggestion;
  form.elements.title.value = suggestion.title;
  form.elements.category.value = suggestion.category;
  form.elements.riskLevel.value = suggestion.riskLevel;
  form.elements.description.value = suggestion.description;
  form.elements.actionText.value = suggestion.recommendedAction;
  state.manualAiDecision = 'accepted';
  try {
    await persistManualAiDecision(form, 'accepted');
    state.manualEntryFeedback = t('feedback.aiAccepted');
  } catch (error) {
    state.manualEntryFeedback = getApiErrorMessage(error, t('feedback.aiReviewFailed'));
  }
  app.querySelector('#manual-entry-feedback').textContent = state.manualEntryFeedback;
  renderAiSuggestion();
}

async function editManualAiSuggestion(form) {
  if (!state.manualAiSuggestion) return;
  const suggestion = state.manualAiSuggestion.suggestion ?? state.manualAiSuggestion;
  form.elements.title.value = suggestion.title;
  form.elements.category.value = suggestion.category;
  form.elements.riskLevel.value = suggestion.riskLevel;
  form.elements.description.value = suggestion.description;
  form.elements.actionText.value = suggestion.recommendedAction;
  state.manualAiDecision = 'edited';
  state.manualEntryFeedback = t('feedback.aiEditing');
  app.querySelector('#manual-entry-feedback').textContent = state.manualEntryFeedback;
  renderAiSuggestion();
}

async function rejectManualAiSuggestion() {
  if (!state.manualAiSuggestion) return;

  state.manualAiDecision = 'rejected';
  try {
    await persistManualAiDecision(app.querySelector('#manual-entry-form'), 'rejected');
    state.manualEntryFeedback = t('feedback.aiRejected');
  } catch (error) {
    state.manualEntryFeedback = getApiErrorMessage(error, t('feedback.aiReviewFailed'));
  }
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
  if (state.manualAiDecision === 'accepted' && !suggestionMatchesForm(form)) state.manualAiDecision = 'edited';
  try {
    if (state.manualAiDecision && state.manualAiSuggestion?.humanDecision !== state.manualAiDecision) {
      await persistManualAiDecision(form, state.manualAiDecision);
    } else if (state.manualAiDecision === 'edited') {
      await persistManualAiDecision(form, 'edited');
    }
  } catch (error) {
    state.manualEntryFeedback = getApiErrorMessage(error, t('feedback.aiReviewFailed'));
    app.querySelector('#manual-entry-feedback').textContent = state.manualEntryFeedback;
    return;
  }
  const aiSuggestion = getManualAiMetadata(form);

  if (!title || !location) return;

  markRecordDirty();

  let evidencePhotos = [];
  const feedback = app.querySelector('#manual-entry-feedback');
  const submitButton = app.querySelector('button[form="manual-entry-form"]');

  try {
    state.manualEntryFeedback = evidencePhotoFiles.length ? t('feedback.recordingPhoto') : t('feedback.recordingEntry');
    if (feedback) feedback.textContent = state.manualEntryFeedback;
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = t('feedback.recording');
    }
    const uploadedKeys = new Set(state.manualUploadedEvidence.map((item) => `${item.originalName}\u0000${item.size}`));
    const remainingFiles = evidencePhotoFiles.filter((file) => !uploadedKeys.has(`${file.name}\u0000${file.size}`));
    evidencePhotos = [...state.manualUploadedEvidence, ...(await uploadEvidencePhotos(remainingFiles))];
  } catch (error) {
    state.manualEntryFeedback = getApiErrorMessage(error, t('feedback.photoFailed'));
    if (feedback) feedback.textContent = state.manualEntryFeedback;
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = t('common.save');
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
  state.manualUploadedEvidence = [];
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
  const photos = item.evidencePhotos?.length ? t('report.photoCount', { count: item.evidencePhotos.length }) : '';
  const ai =
    item.aiSuggestion
      ? ` / ${item.aiSuggestion.simulated ? t('report.aiMockOrigin', { provider: item.aiSuggestion.provider ?? 'deterministic_fixture' }) : t('report.aiProviderOrigin', { provider: item.aiSuggestion.provider ?? 'unknown' })} / ${item.aiSuggestion.edited ? t('report.aiEdited') : item.aiSuggestion.accepted ? t('report.aiAccepted') : item.aiSuggestion.rejected ? t('report.aiRejected') : t('report.aiPending')}`
      : '';
  const action = actionText ? ` - ${actionText}` : '';
  return `${t('report.riskSummary', { title: item.title, location: item.location, risk: item.riskLevel })}${action}${photos}${ai}`;
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
    formatReportPreviewItem(item, item.actionTaken || t('report.actionMissing'))
  );
  const manualHazardLines = state.responses
    .filter((item) => item.source === 'manual_entry')
    .map((item) => formatReportPreviewItem(item));

  return `
    <section class="report-preview" aria-label="${t('report.preview')}">
      <h2>${t('report.preview')}</h2>
      <dl class="report-meta">
        <div>
          <dt>${t('report.siteName')}</dt>
          <dd>${escapeHtml(state.session.siteName)}</dd>
        </div>
        <div>
          <dt>${t('report.siteArea')}</dt>
          <dd>${escapeHtml(state.session.siteArea)}</dd>
        </div>
        <div>
          <dt>${t('report.taskName')}</dt>
          <dd>${escapeHtml(state.session.taskName)}</dd>
        </div>
        <div>
          <dt>${t('report.conductor')}</dt>
          <dd>${escapeHtml(state.session.supervisorName)} / ${escapeHtml(state.session.supervisorRole)}</dd>
        </div>
        <div>
          <dt>${t('report.recordStatus')}</dt>
          <dd>${escapeHtml(recordStatusLabel(getSessionStatus()))}</dd>
        </div>
      </dl>

      <section>
        <h3>${t('report.attendance')}</h3>
        <ul>${formatKoreanList(
          presentWorkers.map((worker) => `${worker.name} (${worker.role})`),
          t('report.noneAttendance')
        )}</ul>
      </section>

      <section><h3>${t('report.supervisorAcknowledgment')}</h3><ul>${formatKoreanList(
        supervisorAcknowledgedWorkers.map((worker) => t('report.supervisorNotIndependent', { name: worker.name })),
        t('report.noneSupervisorAck')
      )}</ul></section>

      <section><h3>${t('report.independentAcknowledgment')}</h3><ul>${formatKoreanList(
        independentlyVerifiedWorkers.map((worker) => worker.name),
        t('report.noneIndependentAck')
      )}</ul></section>

      <section>
        <h3>${t('report.allHazards')}</h3>
        <ul>${formatKoreanList(hazardLines, t('report.noneHazards'))}</ul>
      </section>

      <section>
        <h3>${t('report.manualHazards')}</h3>
        <ul>${formatKoreanList(manualHazardLines, t('report.noneManualHazards'))}</ul>
      </section>

      <section>
        <h3>${t('report.nearMisses')}</h3>
        <ul>${formatKoreanList(nearMissLines, t('report.noneNearMiss'))}</ul>
      </section>

      <section>
        <h3>${t('report.controlled')}</h3>
        <ul>${formatKoreanList(
          controlled.map((item) => item.title),
          t('report.noneControlled')
        )}</ul>
      </section>

      <section>
        <h3>${t('report.openActions')}</h3>
        <ul>${formatKoreanList(
          openActions.map((item) => formatReportPreviewItem(item, getCorrectiveAction(item).immediateControl)),
          t('report.noneOpenActions')
        )}</ul>
      </section>

      <section><h3>${t('report.closedActions')}</h3><ul>${formatKoreanList(
        closedActions.map((item) => formatReportPreviewItem(item, t('report.verifierSummary', { name: getCorrectiveAction(item).verifiedBy }))),
        t('report.noneClosedActions')
      )}</ul></section>

      <section>
        <h3>${t('report.unchecked')}</h3>
        <ul>${formatKoreanList(
          unchecked.map((item) => item.title),
          t('report.noneUnchecked')
        )}</ul>
      </section>

      <section><h3>${t('report.sharing')}</h3><ul>${formatKoreanList(
        sharing.status === SHARING_STATUS.SHARED
          ? [t('report.sharingSummary', { method: sharing.method, recipients: sharing.recipients, recordedAt: sharing.sharedAt ?? t('report.afterSave') })]
          : sharing.status === SHARING_STATUS.NOT_SHARED
            ? [t('report.notShared')]
            : [],
        t('report.sharingNotRecorded')
      )}</ul></section>
    </section>
  `;
}

async function copySessionLog(button) {
  const payload = JSON.stringify(buildSessionLog(), null, 2);

  try {
    await navigator.clipboard.writeText(payload);
    button.textContent = t('common.copied');
  } catch {
    button.textContent = t('common.copyFailed');
  }

  window.setTimeout(() => {
    button.textContent = t('common.copyJson');
  }, 1400);
}

function getSavedSessionDate(session) {
  return session.savedAt ?? session.exportedAt ?? session.completedAt ?? session.createdAt;
}

function getSavedSessionSiteName(session) {
  return session.site?.siteName ?? session.siteName ?? t('sessions.unknownSite');
}

function formatSavedSessionDate(session) {
  const savedDate = new Date(getSavedSessionDate(session) ?? 0);
  if (Number.isNaN(savedDate.getTime())) return t('sessions.unknownDate');
  return formatDateTime(savedDate);
}

async function saveCurrentSession(saveMode = 'draft') {
  if (state.isSavingSession) return { ok: false, status: state.draftStatus, reason: 'already_saving' };

  const sessionLog = buildSessionLog();
  const blockers = saveMode === 'finalize' ? getFinalizationBlockers(sessionLog) : [];
  if (blockers.length) {
    state.saveFeedback = t('feedback.cannotFinalize', { reasons: blockers.map((blocker) => localizeFinalizationBlocker(blocker, t)).join(' ') });
    render();
    return { ok: false, status: state.draftStatus, blockers };
  }

  state.isSavingSession = true;
  state.saveFeedback = t('feedback.queueing');
  render();

  try {
    await queueCurrentMutation('session_upsert', state.session.sessionId, saveMode, false);
    if (navigator.onLine) await synchronizeNow();
    state.saveFeedback = state.draftStatus === DRAFT_STATUS_TEXT.SYNCED
      ? t('feedback.synced')
      : t('feedback.queued');
    return { ok: ![DRAFT_STATUS_TEXT.CONFLICT, DRAFT_STATUS_TEXT.UNAVAILABLE, DRAFT_STATUS_TEXT.FAILED].includes(state.draftStatus), status: state.draftStatus };
  } catch (error) {
    state.saveFeedback = `${getApiErrorMessage(error, t('feedback.syncFailed'))} ${t('feedback.localRetained')}`;
    return { ok: false, status: state.draftStatus, error };
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
    state.savedSessionsError = getApiErrorMessage(error, t('sessions.loadFailed'));
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

async function openPairGlasses() {
  state.phase = 'pair-glasses';
  state.pairingFeedback = '';
  render();
  try {
    const response = await apiFetch('/api/glasses-pairings/scopes', { cache: 'no-store' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error ?? 'Pairing scopes could not be loaded.');
    state.pairingScopes = payload;
  } catch (error) {
    state.pairingFeedback = getApiErrorMessage(error, 'Pairing scopes could not be loaded.');
  }
  render();
}

async function createSupervisorPairing(form) {
  const [scopeType, scopeId] = String(new FormData(form).get('scope') ?? '').split(':');
  const response = await apiFetch('/api/glasses-pairings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scopeType, scopeId })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) state.pairingFeedback = payload.error ?? 'Pairing code creation failed.';
  else { state.supervisorPairing = { ...payload.pairing, code: payload.code, groupedCode: payload.groupedCode }; state.pairingFeedback = ''; }
  render();
}

async function refreshSupervisorPairing() {
  if (!state.supervisorPairing?.id) return;
  const response = await apiFetch(`/api/glasses-pairings/${encodeURIComponent(state.supervisorPairing.id)}`, { cache: 'no-store' });
  const payload = await response.json().catch(() => ({}));
  if (response.ok) {
    state.supervisorPairing = { ...state.supervisorPairing, ...payload.pairing };
    if (payload.pairing.status !== 'pending') {
      delete state.supervisorPairing.code;
      delete state.supervisorPairing.groupedCode;
    }
  }
  render();
}

async function endSupervisorPairing(revoke = false) {
  if (!state.supervisorPairing?.id) return;
  const suffix = revoke ? '/revoke' : '';
  const response = await apiFetch(`/api/glasses-pairings/${encodeURIComponent(state.supervisorPairing.id)}${suffix}`, { method: revoke ? 'POST' : 'DELETE' });
  if (response.ok) await refreshSupervisorPairing();
  else state.pairingFeedback = (await response.json().catch(() => ({}))).error ?? 'Pairing update failed.';
  render();
}

function openSessionReport(sessionId) {
  if (!sessionId) return;
  window.open(`/api/sessions/${encodeURIComponent(sessionId)}/report?lang=${locale}`, '_blank', 'noopener');
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
    attendanceSummary: normalizeAttendanceSummary(state.session.attendanceSummary),
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
    <section class="v2-screen is-auth auth-shell" role="main"><h1 class="sr-only" tabindex="-1" data-view-heading>${t('auth.checking')}</h1>
      <div class="auth-brand-large">
        ${v2Logo()}
        <p>${t('brand.tagline')}</p>${languageControl()}
      </div>
      <section class="v2-card v2-loading-card">
        ${v2Icon('info')}
        <h2>${t('auth.checking')}</h2>
        <p>${t('auth.preparing')}</p>
      </section>
    </section>
  `;
}

function renderAuth() {
  const isRegister = state.authMode === 'register';
  const submitText = state.isAuthSubmitting ? t('auth.wait') : isRegister ? t('common.register') : t('common.login');

  app.innerHTML = `
    <section class="v2-screen is-auth auth-shell" role="main"><h1 class="sr-only" tabindex="-1" data-view-heading>${t('auth.mode')}</h1>
      <div class="auth-brand-large">
        ${v2Logo()}
        <p>${t('brand.tagline')}</p>${languageControl()}
      </div>

      <section class="auth-tabs" role="tablist" aria-label="${t('auth.mode')}">
        <button class="focusable ${!isRegister ? 'is-active' : ''}" data-auth-tab role="tab" aria-selected="${!isRegister}" aria-controls="auth-form" data-action="auth-login" type="button">${v2Icon('login')} ${t('common.login')}</button>
        <button class="focusable ${isRegister ? 'is-active' : ''}" data-auth-tab role="tab" aria-selected="${isRegister}" aria-controls="auth-form" data-action="auth-register" type="button">${v2Icon('register')} ${t('common.register')}</button>
      </section>

      <form class="v2-card auth-form" id="auth-form">
        ${
          isRegister
            ? `
              <div class="auth-field">
                ${v2Icon('user')}
                <label>
                  <span>${t('auth.name')}</span>
                  <input class="focusable" name="name" autocomplete="name" placeholder="${t('auth.namePlaceholder')}" />
                </label>
              </div>
            `
            : ''
        }
        <div class="auth-field">
          ${v2Icon('email')}
          <label>
            <span>${t('auth.email')}</span>
            <input class="focusable" name="email" type="email" autocomplete="email" placeholder="name@company.com" required />
          </label>
        </div>
        <div class="auth-field">
          ${v2Icon('lock')}
          <label>
            <span>${t('auth.password')}</span>
            <input class="focusable" name="password" type="password" autocomplete="${
              isRegister ? 'new-password' : 'current-password'
            }" placeholder="${t('auth.passwordPlaceholder')}" minlength="8" required />
          </label>
        </div>
        ${
          isRegister
            ? `
              <div class="auth-field">
                ${v2Icon('user')}
                <label>
                  <span>${t('auth.role')}</span>
                  <input class="focusable" name="role" value="supervisor" />
                </label>
              </div>
              <div class="auth-field">
                ${v2Icon('key')}
                <label>
                  <span>${t('auth.registrationKey')}</span>
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

      <footer class="auth-footer"><span>${t('auth.protected')}</span><span>${t('auth.help')} <strong>${t('auth.contact')}</strong></span></footer>
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
    <section class="v2-screen is-auth auth-shell" role="main"><h1 class="sr-only" tabindex="-1" data-view-heading>${t('loading.tbm')}</h1>
      <div class="auth-brand-large">
        ${v2Logo()}
        <p>${t('brand.tagline')}</p>${languageControl()}
      </div>
      <section class="v2-card v2-loading-card">
        ${v2Icon('info')}
        <h2>${t('loading.tbm')}</h2>
        <p>${t('loading.hazards')}</p>
      </section>
    </section>
  `;
}

function renderError() {
  app.innerHTML = `
    <section class="v2-screen is-auth auth-shell" role="main"><h1 class="sr-only" tabindex="-1" data-view-heading>${t('error.hazardsUnavailable')}</h1>
      <div class="auth-brand-large">
        ${v2Logo()}
        <p>${t('brand.tagline')}</p>${languageControl()}
      </div>
      <section class="v2-card v2-loading-card">
        <div class="v2-warning-tile">!</div>
        <h2>${t('error.hazardsUnavailable')}</h2>
        <p>${escapeHtml(state.error)}</p>
        <button class="focusable v2-key-button v2-key-primary" data-action="retry">${t('common.retry')}</button>
      </section>
    </section>
  `;
  bindButtons();
}

function renderDraftRestore() {
  const draft = state.pendingDraft;
  const savedAt = draft?.deviceUpdatedAt || draft?.deviceObservedAt
    ? formatDateTime(new Date(draft.deviceUpdatedAt ?? draft.deviceObservedAt))
    : t('common.recently');
  const siteName = draft?.session?.siteName ?? state.session.siteName;
  const phaseLabel = draft?.phase ? draft.phase.replace('-', ' ') : 'in-progress TBM';

  app.innerHTML = `
    <section class="v2-screen" role="main">
      ${v2Header(t('draft.local'))}
      <section class="v2-card v2-draft-card" aria-label="${t('draft.found')}">
        <div class="v2-screen-intro">
          <div class="v2-warning-tile">↻</div>
          <div>
            <h2>${t('draft.found')}</h2>
            <p>${t('draft.available')}</p>
          </div>
        </div>
        <dl class="v2-draft-meta">
          <div>
            <dt>${t('draft.site')}</dt>
            <dd>${escapeHtml(siteName)}</dd>
          </div>
          <div>
            <dt>${t('draft.lastDevice')}</dt>
            <dd>${escapeHtml(savedAt)}</dd>
          </div>
          <div>
            <dt>${t('draft.screen')}</dt>
            <dd>${escapeHtml(phaseLabel)}</dd>
          </div>
        </dl>
        ${draftStatusHtml()}
      </section>
      <section class="v2-action-row" aria-label="${t('common.actions')}">
        <button class="focusable v2-key-button" data-action="discard-draft">${t('draft.startNew')}</button>
        <button class="focusable v2-key-button v2-key-primary" data-action="restore-draft">${t('draft.restore')}</button>
      </section>
    </section>
  `;

  bindButtons();
}

function renderEvidenceRequestPanel() {
  const selected = state.evidenceFulfillment;
  const rows = state.evidenceRequests.map((item) => `<article class="v2-card evidence-request-row" data-evidence-request="${escapeHtml(item.id)}">
    <div><strong>${escapeHtml(item.hazard?.title ?? '')}</strong><p>${escapeHtml(item.hazard?.location ?? '')} · ${escapeHtml(item.tbm?.siteName ?? '')} / ${escapeHtml(item.tbm?.taskName ?? '')}</p><small>Expires ${escapeHtml(formatDateTime(new Date(item.expiresAt)))}</small></div>
    ${selected?.requestId === item.id ? `<div class="evidence-request-preview"><img src="${escapeHtml(selected.previewUrl)}" alt="Local evidence preview" /><p>${escapeHtml(selected.file.type)} · ${Math.ceil(selected.file.size / 1024)} KB</p>
      <button class="focusable v2-key-button v2-key-primary" data-action="confirm-evidence-upload" ${selected.submitting ? 'disabled' : ''}>Confirm private upload</button>
      <button class="focusable v2-key-button" data-action="replace-evidence-camera" data-request="${escapeHtml(item.id)}">Replace</button>
      <button class="focusable v2-key-button" data-action="clear-evidence-selection">Cancel selection</button></div>` : `<div class="v2-action-row">
      <button class="focusable v2-key-button" data-action="select-evidence-camera" data-request="${escapeHtml(item.id)}">Take photo</button>
      <button class="focusable v2-key-button" data-action="select-evidence-gallery" data-request="${escapeHtml(item.id)}">Choose from gallery</button>
      <button class="focusable v2-key-button" data-action="cancel-evidence-request" data-request="${escapeHtml(item.id)}">Cancel request</button></div>`}
    <input class="sr-only" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" data-evidence-camera="${escapeHtml(item.id)}" />
    <input class="sr-only" type="file" accept="image/jpeg,image/png,image/webp" data-evidence-gallery="${escapeHtml(item.id)}" />
  </article>`).join('');
  return `<section class="v2-card evidence-requests-panel" aria-label="Glasses evidence requests"><div class="v2-section-heading v2-section-heading-row"><div><h2>Glasses evidence requests</h2><p>Phone selection stays local until you confirm the private upload.</p></div><button class="focusable v2-key-button v2-key-small" data-action="refresh-evidence-requests">${t('common.refresh')}</button></div>
    ${state.evidenceRequestsStatus === 'loading' ? '<p>Checking…</p>' : rows || '<p>No pending requests.</p>'}
    ${state.evidenceRequestFeedback ? `<p role="status">${escapeHtml(state.evidenceRequestFeedback)}</p>` : ''}</section>`;
}

function renderNativeDevicePanel() {
  const registration = state.nativeDeviceRegistration;
  const devices = state.nativeDevices.map((device) => `<article class="v2-card evidence-request-row">
    <div><strong>${escapeHtml(device.name)}</strong><p>Last seen ${escapeHtml(formatDateTime(new Date(device.lastSeenAt)))}</p><small>${device.revokedAt ? 'Revoked' : 'Authorized for private native capture'}</small></div>
    ${device.revokedAt ? '' : `<button class="focusable v2-key-button" data-action="revoke-native-device" data-device="${escapeHtml(device.id)}">Revoke</button>`}
  </article>`).join('');
  return `<section class="v2-card evidence-requests-panel" aria-label="Native camera devices">
    <div class="v2-section-heading v2-section-heading-row"><div><h2>Native camera devices</h2><p>Registration authorizes the Android DAT companion for this account. Codes expire and work once.</p></div><button class="focusable v2-key-button v2-key-small" data-action="refresh-native-devices">${t('common.refresh')}</button></div>
    ${registration ? `<p class="supervisor-pairing-code" aria-label="native device registration code">${escapeHtml(registration.groupedCode ?? registration.code)}</p><p>Expires ${escapeHtml(formatDateTime(new Date(registration.registration.expiresAt)))}</p>` : `<form id="native-device-form"><label class="v2-field-block"><span>Device name</span><input name="nativeDeviceName" maxlength="80" required value="Pilot Android companion" /></label><button class="focusable v2-key-button" type="submit">Create one-time device code</button></form>`}
    ${state.nativeDevicesStatus === 'loading' ? '<p>Checking…</p>' : devices || '<p>No registered native camera devices.</p>'}
    ${state.nativeDeviceFeedback ? `<p role="status">${escapeHtml(state.nativeDeviceFeedback)}</p>` : ''}
  </section>`;
}

function renderStart() {
  app.innerHTML = `
    <section class="v2-screen" role="main">
      ${v2Header(t('tbm.start'), v2WorkflowProgress(1))}
      <section class="v2-card v2-form-card" aria-label="${t('tbm.start')}">
        <div class="v2-screen-intro">
          <div class="v2-warning-tile">▶</div>
          <div>
            <h2>${t('tbm.start')}</h2>
            <p>${t('tbm.startDescription')}</p>
          </div>
        </div>
        ${buildUserBadge()}
        ${draftStatusHtml()}
        <div class="v2-form-grid">
          <label class="v2-field-row">
            ${v2Icon('site')}
            <span>${t('tbm.siteName')}</span>
            <input class="focusable" name="siteName" value="${escapeHtml(state.session.siteName)}" />
          </label>
          <label class="v2-field-row">
            ${v2Icon('task')}
            <span>${t('tbm.taskName')}</span>
            <input class="focusable" name="taskName" value="${escapeHtml(state.session.taskName)}" />
          </label>
          <label class="v2-field-row">
            ${v2Icon('user')}
            <span>${t('tbm.supervisor')}</span>
            <input class="focusable" name="supervisorName" value="${escapeHtml(state.session.supervisorName)}" />
          </label>
          <div class="v2-field-row">
            ${v2Icon('calendar')}
            <span>${t('tbm.dateTime')}</span>
            <strong>${escapeHtml(formatDateTime(state.session.scheduledAt))}</strong>
          </div>
        </div>
        <section class="v2-action-row" aria-label="${t('common.actions')}">
          <button class="focusable v2-key-button v2-key-primary" data-action="start">▶ ${t('tbm.start')}</button>
          <button class="focusable v2-key-button" data-action="save-draft">${t('draft.record')}</button>
          <button class="focusable v2-key-button" data-action="pair-glasses">${locale === 'ko' ? '안경 페어링' : 'Pair glasses'}</button>
        </section>
      </section>
      ${renderNativeDevicePanel()}
      ${renderEvidenceRequestPanel()}
    </section>
  `;

  app.querySelectorAll('input[name]').forEach((input) => {
    bindCompositionSafeInput(input, (value) => saveStartField(input.name, value));
  });
  app.querySelectorAll('[data-evidence-camera]').forEach((input) => input.addEventListener('change', () => selectEvidenceFile(input.dataset.evidenceCamera, input.files?.[0], EVIDENCE_PROVIDER.PHONE_BROWSER_CAMERA)));
  app.querySelectorAll('[data-evidence-gallery]').forEach((input) => input.addEventListener('change', () => selectEvidenceFile(input.dataset.evidenceGallery, input.files?.[0], EVIDENCE_PROVIDER.PHONE_BROWSER_GALLERY)));
  app.querySelector('#native-device-form')?.addEventListener('submit', (event) => { event.preventDefault(); void createNativeDeviceRegistration(event.currentTarget); });
  bindButtons();
}

function renderPairGlasses() {
  window.clearTimeout(pairingCountdownTimer);
  const scopes = [
    ...(state.pairingScopes.sessions ?? []).map((item) => ({ value: `tbm_session:${item.id}`, label: `${item.siteName} — ${item.taskName}` })),
    ...(state.pairingScopes.sites ?? []).map((item) => ({ value: `site:${item.id}`, label: `${item.siteName}${item.siteArea ? ` — ${item.siteArea}` : ''}` }))
  ];
  const pairing = state.supervisorPairing;
  const remaining = pairing ? Math.max(0, Math.ceil((new Date(pairing.expiresAt).getTime() - Date.now()) / 1000)) : 0;
  app.innerHTML = `${v2Header(locale === 'ko' ? '안경 페어링' : 'Pair glasses')}
    <main class="v2-main"><section class="v2-card"><h2>${locale === 'ko' ? '제한된 사이트 또는 TBM 선택' : 'Choose a restricted site or TBM'}</h2>
    ${pairing ? `${pairing.groupedCode ? `<p class="supervisor-pairing-code" aria-label="pairing code">${escapeHtml(pairing.groupedCode)}</p>` : ''}
      <dl><dt>${locale === 'ko' ? '상태' : 'Status'}</dt><dd>${escapeHtml(pairing.status)}</dd><dt>${locale === 'ko' ? '남은 시간' : 'Expires in'}</dt><dd>${remaining}s</dd><dt>${locale === 'ko' ? '범위' : 'Scope'}</dt><dd>${escapeHtml(`${pairing.siteName}${pairing.taskName ? ` — ${pairing.taskName}` : ''}`)}</dd></dl>
      <div class="v2-actions"><button class="focusable v2-key-button" data-action="refresh-pairing">${t('common.refresh')}</button>${pairing.status === 'pending' ? `<button class="focusable v2-key-button" data-action="cancel-pairing">${t('common.cancel')}</button>` : ''}${pairing.status === 'paired' ? `<button class="focusable v2-key-button" data-action="revoke-pairing">${locale === 'ko' ? '연결 해제' : 'Revoke'}</button>` : ''}</div>` : `<form id="pair-glasses-form"><label class="v2-field-block"><span>${locale === 'ko' ? '허용 범위' : 'Allowed scope'}</span><select name="scope" required>${scopes.map((scope) => `<option value="${escapeHtml(scope.value)}">${escapeHtml(scope.label)}</option>`).join('')}</select></label><button class="focusable v2-key-button v2-key-primary" type="submit" ${scopes.length ? '' : 'disabled'}>${locale === 'ko' ? '일회용 코드 만들기' : 'Create one-time code'}</button></form>`}
    ${state.pairingFeedback ? `<p role="alert">${escapeHtml(state.pairingFeedback)}</p>` : ''}</section>
    <button class="focusable v2-key-button" data-action="close-pairing">${t('common.back')}</button></main>`;
  app.querySelector('#pair-glasses-form')?.addEventListener('submit', (event) => { event.preventDefault(); void createSupervisorPairing(event.currentTarget); });
  bindButtons();
  if (pairing?.status === 'pending') {
    pairingCountdownTimer = window.setTimeout(() => {
      if (state.phase !== 'pair-glasses') return;
      if (Date.now() >= new Date(pairing.expiresAt).getTime()) void refreshSupervisorPairing();
      else renderPairGlasses();
    }, 1000);
  }
}

function renderParticipation() {
  const presentCount = state.workers.filter((worker) => worker.present).length;
  const supervisorAcknowledgedCount = state.workers.filter(
    (worker) => normalizeWorker(worker).acknowledgment.supervisorRecorded
  ).length;

  app.innerHTML = `
    <section class="v2-screen" role="main">
      ${v2Header(t('attendance.participation'), v2WorkflowProgress(2))}
      <section class="v2-card v2-participation-card">
        <div class="v2-section-heading">
          <h2>${t('attendance.title')}</h2>
          <p>${t('attendance.separateFacts')}</p>
        </div>
        ${draftStatusHtml()}

        <form class="v2-add-worker" id="add-worker-form">
          <div class="v2-input-with-icon">
            ${v2Icon('add')}
            <input class="focusable" id="worker-name" autocomplete="off" aria-label="${t('attendance.addPlaceholder')}" placeholder="${t('attendance.addPlaceholder')}" />
          </div>
          <button class="focusable v2-key-button" type="submit">${t('attendance.add')}</button>
        </form>

        <section class="v2-worker-list" aria-label="${t('attendance.list')}">
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
                    <input class="focusable" type="checkbox" aria-label="${escapeHtml(`${worker.name}: ${t('attendance.present')}`)}" data-attendance-worker="${escapeHtml(worker.id)}" ${
                      worker.present ? 'checked' : ''
                    } />
                    <span>${t('attendance.present')}</span>
                    </label>
                    <label class="v2-worker-fact">
                    <input class="focusable" type="checkbox" aria-label="${escapeHtml(`${worker.name}: ${t('attendance.ackSupervisor')}`)}" data-ack-worker="${escapeHtml(worker.id)}" ${
                      normalizeWorker(worker).acknowledgment.supervisorRecorded ? 'checked' : ''
                    } />
                    <span>${t('attendance.ackSupervisor')}</span>
                    </label>
                  </div>
                  <button class="focusable v2-key-button v2-key-small" aria-label="${escapeHtml(`${t('attendance.remove')}: ${worker.name}`)}" data-action="remove-worker" data-worker="${escapeHtml(
                    worker.id
                  )}">${t('attendance.remove')}</button>
                </div>
              `;
            })
            .join('')}
        </section>

        <p class="v2-attendance-count">${t('attendance.counts', { present: presentCount, acknowledged: supervisorAcknowledgedCount })}</p>
      </section>
      <section class="v2-action-row" aria-label="${t('common.actions')}">
        <button class="focusable v2-key-button" data-action="mark-all">${t('attendance.markAll')}</button>
        <button class="focusable v2-key-button" data-action="save-draft">${t('draft.record')}</button>
        <button class="focusable v2-key-button v2-key-primary" data-action="continue">${t('common.continue')} →</button>
      </section>
    </section>
  `;

  app.querySelector('#add-worker-form').addEventListener('submit', (event) => {
    event.preventDefault();
    pendingFocusSelector = '#worker-name';
    addWorker(app.querySelector('#worker-name').value);
  });

  app.querySelectorAll('input[data-attendance-worker]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      pendingFocusSelector = `[data-attendance-worker="${checkbox.dataset.attendanceWorker}"]`;
      setWorkerPresent(checkbox.dataset.attendanceWorker, checkbox.checked);
    });
  });

  app.querySelectorAll('input[data-ack-worker]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      pendingFocusSelector = `[data-ack-worker="${checkbox.dataset.ackWorker}"]`;
      setWorkerAcknowledgment(checkbox.dataset.ackWorker, checkbox.checked);
    });
  });

  bindButtons();
}

function renderManualEntry() {
  app.innerHTML = `
    <section class="v2-screen" role="main">
      ${v2Header(t('hazard.logNew'))}

      <form class="v2-manual-layout manual-entry-form" id="manual-entry-form">
        <section class="v2-card v2-manual-main">
          <div class="v2-two-col">
            <label class="v2-field-block">
              <span>${t('hazard.type')} *</span>
              <select class="focusable" name="type">
                <option value="new_hazard">${t('hazard.newHazard')}</option>
                <option value="near_miss">${t('hazard.nearMiss')}</option>
              </select>
            </label>

            <label class="v2-field-block">
              <span>${t('hazard.category')} *</span>
              <input class="focusable" name="category" maxlength="80" value="manual_entry" />
            </label>
          </div>

          <label class="v2-field-block">
            <span>${t('hazard.title')} *</span>
            <input class="focusable" name="title" maxlength="120" placeholder="${t('hazard.titlePlaceholder')}" required />
          </label>

          <label class="v2-field-block">
            <span>${t('hazard.location')} *</span>
            <input class="focusable" name="location" maxlength="120" placeholder="${t('hazard.locationPlaceholder')}" required />
          </label>

          <label class="v2-field-block">
            <span>${t('hazard.riskLevel')} *</span>
            <select class="focusable" name="riskLevel">
              <option value="low">${t('hazard.low')}</option>
              <option value="medium" selected>${t('hazard.medium')}</option>
              <option value="high">${t('hazard.high')}</option>
            </select>
          </label>

          <label class="v2-field-block">
            <span>${t('hazard.description')} *</span>
            <textarea class="v2-textarea focusable flexible-memo" name="description" maxlength="260" placeholder="${t('hazard.descriptionPlaceholder')}"></textarea>
          </label>

          <label class="v2-field-block">
            <span>${t('hazard.actionTaken')} *</span>
            <textarea class="v2-textarea focusable flexible-memo" name="actionText" maxlength="260" placeholder="${t('hazard.actionPlaceholder')}"></textarea>
          </label>
        </section>

        <aside class="v2-manual-side">
          <section class="v2-card v2-upload-card">
            <h3>${t('hazard.attachPhoto')}</h3>
            <label class="v2-upload-zone">
              ${v2Icon('photo')}
              <span id="photo-preview">${t('hazard.noPhoto')}</span>
              <input class="focusable" name="evidencePhotos" type="file" accept="image/jpeg,image/png,image/webp" multiple />
            </label>
            <p class="photo-preview">${t('hazard.photoTypes')}</p>
            <button class="focusable v2-key-button v2-key-primary" id="analyze-photo-button" data-action="analyze-photo" type="button" hidden disabled>
              ${t('hazard.generateMockSuggestion')}
            </button>
          </section>
          <div id="ai-suggestion-panel"></div>
          <p class="save-feedback" id="manual-entry-feedback">${escapeHtml(state.manualEntryFeedback)}</p>
        </aside>
      </form>

      <section class="v2-action-row" aria-label="${t('common.actions')}">
        <button class="focusable v2-key-button" data-action="cancel-manual">← ${t('common.cancel')}</button>
        <button class="focusable v2-key-button v2-key-primary" form="manual-entry-form" type="submit">${t('common.save')}</button>
      </section>
    </section>
  `;

  app.querySelector('input[name="evidencePhotos"]').addEventListener('change', (event) => {
    const files = Array.from(event.target.files ?? []);
    const preview = app.querySelector('#photo-preview');
    const analyzeButton = app.querySelector('#analyze-photo-button');
    preview.textContent = files.length
      ? files.map((file) => `${file.name} (${Math.ceil(file.size / 1024)} KB)`).join(', ')
      : t('hazard.noPhoto');
    analyzeButton.hidden = files.length === 0;
    analyzeButton.disabled = files.length === 0;
    state.manualAiSuggestion = null;
    state.manualAiDecision = null;
    state.manualUploadedEvidence = [];
    state.manualEntryFeedback = files.length ? t('feedback.photoChanged') : '';
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

function ensureGlassesFocus(actions, viewKey = state.glassesStep) {
  const available = actions.flatMap((action, index) => action.disabled ? [] : [action.id ?? `${action.action}-${index}`]);
  if (state.glassesFocusView !== viewKey || !available.includes(state.glassesFocusId)) {
    const preferred = actions.find((action) => action.initial && !action.disabled) ??
      actions.find((action) => action.primary && !action.disabled) ?? actions.find((action) => !action.disabled);
    const preferredIndex = preferred ? actions.indexOf(preferred) : -1;
    state.glassesFocusId = preferred ? (preferred.id ?? `${preferred.action}-${preferredIndex}`) : '';
    state.glassesFocusView = viewKey;
  }
  return available;
}

function renderGlassesActions(actions, viewKey = state.glassesStep) {
  if (!actions.length) return '';
  ensureGlassesFocus(actions, viewKey);
  return `
    <section class="glasses-actions">
      ${actions
        .filter((action) => !action.inline)
        .map((action, index) => {
          const sourceIndex = actions.indexOf(action);
          const id = action.id ?? `${action.action}-${sourceIndex}`;
          const focused = isMetaDisplayRuntime && !action.disabled && id === state.glassesFocusId;
          return `
            <button class="focusable v2-key-button ${action.primary ? 'v2-key-primary' : ''} ${focused ? 'is-logically-focused' : ''}" ${action.primary ? 'data-primary-action' : ''} ${action.disabled ? 'disabled' : ''} ${action.pressed == null ? '' : `aria-pressed="${action.pressed}"`} data-focus-id="${escapeHtml(id)}" tabindex="${focused ? '0' : '-1'}" aria-current="${focused ? 'true' : 'false'}" data-glasses-action="${escapeHtml(
              action.action
            )}">${escapeHtml(action.label)}</button>
          `;
        })
        .join('')}
    </section>
  `;
}

function bindGlassesButtons() {
  app.querySelectorAll('button[data-glasses-action]').forEach((button) => {
    button.addEventListener('click', () => state.phase === 'glasses-pairing'
      ? handlePairingAction(button.dataset.glassesAction)
      : handleGlassesAction(button.dataset.glassesAction));
  });
  requestAnimationFrame(() => {
    const focused = app.querySelector(`[data-focus-id="${CSS.escape(state.glassesFocusId)}"]`);
    focused?.focus({ preventScroll: true });
    focused?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
}

async function exchangeGlassesPairingCode() {
  if (state.glassesPairing.submitting) return;
  state.glassesPairing.submitting = true;
  state.glassesPairing.feedback = '연결 중…';
  renderGlassesPairing();
  const code = state.glassesPairing.digits.join('');
  try {
    const response = await apiRequest('/api/glasses/pair', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.scope) throw new Error(payload.error ?? '코드를 확인할 수 없습니다.');
    state.glassesPairing.submitting = false;
    state.glassesPairing.feedback = '';
    await establishGlassesScope(payload.scope);
  } catch (error) {
    state.glassesPairing.submitting = false;
    state.glassesPairing.feedback = getApiErrorMessage(error, '코드를 확인할 수 없습니다. 새 코드를 받아 다시 시도하세요.');
    state.glassesPairing.stage = 'confirm';
    state.glassesPairing.focusId = 'pairing-pair';
    renderGlassesPairing();
  }
}

function pairingActions() {
  const stage = state.glassesPairing.stage;
  if (stage === 'intro') return [
    { id: 'pairing-enter', action: 'pairing-enter', label: locale === 'ko' ? '페어링 코드 입력' : 'Enter pairing code', primary: true },
    { id: 'pairing-language', action: 'pairing-language', label: locale === 'ko' ? '언어 선택' : 'Choose language' }
  ];
  if (stage === 'language') return [
    { id: 'language-ko', action: 'language-ko', label: '한국어', primary: locale === 'ko', pressed: locale === 'ko' },
    { id: 'language-en', action: 'language-en', label: 'English', primary: locale === 'en', pressed: locale === 'en' }
  ];
  if (stage === 'confirm') return [
    { id: 'pairing-pair', action: 'pairing-submit', label: locale === 'ko' ? '연결' : 'Pair', primary: true, disabled: state.glassesPairing.submitting },
    { id: 'pairing-edit', action: 'pairing-edit', label: locale === 'ko' ? '코드 수정' : 'Edit code' },
    { id: 'pairing-cancel', action: 'pairing-cancel', label: locale === 'ko' ? '취소' : 'Cancel' }
  ];
  return [];
}

function renderGlassesPairing() {
  const pairing = state.glassesPairing;
  const stage = pairing.stage;
  const actions = pairingActions();
  state.glassesFocusId = pairing.focusId;
  if (stage === 'digits') {
    pairing.digitIndex = Math.max(0, Math.min(5, Number(pairing.digitIndex) || 0));
    state.glassesFocusId = `pairing-digit-${pairing.digitIndex}`;
    state.glassesFocusView = 'pairing:digits';
  } else {
    ensureGlassesFocus(actions, `pairing:${stage}`);
  }
  pairing.focusId = state.glassesFocusId;
  const grouped = `${pairing.digits.slice(0, 3).join('')} ${pairing.digits.slice(3).join('')}`;
  let body = '';
  if (stage === 'intro') body = `<p class="glasses-kicker">${locale === 'ko' ? '보안 연결' : 'Secure connection'}</p><h1>${locale === 'ko' ? '감독자에게 페어링 코드를 요청하세요' : 'Ask the supervisor for a pairing code'}</h1><p>${locale === 'ko' ? '코드는 5분 동안 한 번만 사용할 수 있습니다.' : 'The code is single-use and expires in five minutes.'}</p>`;
  if (stage === 'language') body = `<p class="glasses-kicker">Language</p><h1>${locale === 'ko' ? '언어 선택' : 'Choose language'}</h1><p>${locale === 'ko' ? '위/아래로 이동하고 Enter로 확인하세요.' : 'Move with Up/Down and confirm with Enter.'}</p>`;
  if (stage === 'digits') body = `<p class="glasses-kicker">${locale === 'ko' ? '6자리 코드' : 'Six-digit code'}</p><h1 class="pairing-code-preview">${grouped}</h1>
    <div class="pairing-digit-groups" role="group" aria-label="${locale === 'ko' ? '페어링 코드' : 'Pairing code'}">
      ${pairing.digits.map((digit, index) => `${index === 3 ? '<span class="pairing-group-gap" aria-hidden="true"></span>' : ''}<button type="button" class="pairing-digit ${index === pairing.digitIndex ? 'is-logically-focused' : ''}" data-pairing-digit="${index}" data-focus-id="pairing-digit-${index}" tabindex="${index === pairing.digitIndex ? '0' : '-1'}" aria-current="${index === pairing.digitIndex ? 'true' : 'false'}" aria-label="${locale === 'ko' ? `${index + 1}번째 숫자: ${digit}` : `Digit ${index + 1}: ${digit}`}"><span aria-hidden="true">▲</span><strong>${digit}</strong><span aria-hidden="true">▼</span></button>`).join('')}
    </div><p>${locale === 'ko' ? '↑/↓ 숫자 변경 · ←/→ 자리 이동 · Enter 다음 · Escape 뒤로' : '↑/↓ change digit · ←/→ move · Enter next · Escape back'}</p>`;
  if (stage === 'confirm') body = `<p class="glasses-kicker">${locale === 'ko' ? '최종 확인' : 'Final confirmation'}</p><h1 class="pairing-code-value">${grouped}</h1><p>${locale === 'ko' ? '실수로 전송되지 않습니다. 연결을 선택하고 Enter를 누르세요.' : 'Select Pair and press Enter. The code is not submitted automatically.'}</p>${pairing.feedback ? `<p class="glasses-validation" role="alert">${escapeHtml(pairing.feedback)}</p>` : ''}`;
  app.innerHTML = `<section class="glasses-screen pairing-screen"><main class="glasses-card">${body}</main>${renderGlassesActions(actions, `pairing:${stage}`)}</section>`;
  pairing.focusId = state.glassesFocusId;
  app.querySelectorAll('[data-pairing-digit]').forEach((button) => button.addEventListener('click', () => {
    pairing.digitIndex = Number(button.dataset.pairingDigit);
    pairing.focusId = `pairing-digit-${pairing.digitIndex}`;
    renderGlassesPairing();
  }));
  bindGlassesButtons();
  if (!isMetaDisplayRuntime) requestAnimationFrame(() => app.querySelector('[data-primary-action]')?.focus());
}

async function handlePairingAction(action) {
  const pairing = state.glassesPairing;
  if (action === 'pairing-enter') { pairing.stage = 'digits'; pairing.digitIndex = 0; }
  else if (action === 'pairing-language') pairing.stage = 'language';
  else if (action === 'language-ko' || action === 'language-en') {
    selectLanguage(action === 'language-en' ? 'en' : 'ko');
    pairing.stage = 'intro';
  } else if (action === 'pairing-edit') { pairing.stage = 'digits'; pairing.digitIndex = 5; }
  else if (action === 'pairing-cancel') { pairing.stage = 'intro'; pairing.digits = [0, 0, 0, 0, 0, 0]; pairing.digitIndex = 0; }
  else if (action === 'pairing-submit') { await exchangeGlassesPairingCode(); return; }
  pairing.focusId = '';
  renderGlassesPairing();
}

function renderGlasses() {
  if (state.draftStatus === DRAFT_STATUS_TEXT.CONFLICT) state.glassesStep = GLASSES_STEP.CONFLICT;
  const hazard = currentHazard();
  const response = currentResponse();
  const primaryHazard = buildPrimaryHazardModel({
    title: hazard?.name ?? t('hazard.none'),
    location: hazard?.location ?? '',
    current: getCurrentHazardNumber(),
    total: state.hazards.length
  });
  const { title, location } = primaryHazard;
  const syncPresentation = glassesSyncState(state.draftStatus);
  let body = '';
  let actions = [];

  if (state.glassesStep === GLASSES_STEP.START) {
    body = isMetaDisplayRuntime
      ? `<p class="glasses-kicker">${t('glasses.metaMode')}</p><h1>${escapeHtml(state.session.siteName)}</h1><p class="glasses-muted">${escapeHtml(state.session.taskName)}</p>`
      : `<p class="glasses-kicker">${t('glasses.previewMode')}</p><h1>${t('tbm.start')}</h1><p class="glasses-large">${escapeHtml(state.session.siteName)}</p>`;
    actions = [{ action: 'start', label: isMetaDisplayRuntime ? t('tbm.start') : t('glasses.start'), primary: true }];
  } else if (state.glassesStep === GLASSES_STEP.CONTEXT_CONFIRMATION) {
    const observed = state.glassesContext?.observedAt ?? new Date().toISOString();
    const locationSource = state.session.gps?.latitude != null ? t('glasses.deviceLocation') : t('glasses.sessionSite');
    body = `<p class="glasses-kicker">${t('glasses.contextTitle')}</p><h1>${escapeHtml(state.currentUser?.name)}</h1>
      <dl class="glasses-detail-list glasses-context-grid"><div><dt>${t('auth.role')}</dt><dd>${escapeHtml(state.currentUser?.role)}</dd></div>
      <div><dt>${t('tbm.siteName')}</dt><dd>${escapeHtml(state.session.siteName)}</dd><small>${t('glasses.sessionSite')}</small></div><div><dt>${t('tbm.taskName')}</dt><dd>${escapeHtml(state.session.taskName)}</dd></div>
      <div><dt>${t('hazard.location')}</dt><dd>${escapeHtml(state.session.siteArea)}</dd><small>${locationSource}</small></div>
      <div><dt>${t('tbm.dateTime')}</dt><dd>${escapeHtml(formatDateTime(new Date(observed)))}</dd><small>${t('glasses.deviceTime')}</small></div></dl>`;
    actions = [{ action: 'context-confirm', label: t('glasses.confirm'), primary: true }, { action: 'context-reject', label: t('glasses.reject') }];
  } else if (state.glassesStep === GLASSES_STEP.ATTENDANCE) {
    const d = state.glassesAttendanceDigits; const expected = attendanceValue(d.expectedTens, d.expectedOnes); const present = attendanceValue(d.presentTens, d.presentOnes);
    const valid = isAttendanceSummaryValid({ expectedCount: expected, presentCount: present });
    const editor = (kind, label) => `<fieldset class="glasses-digit-editor"><legend>${label}</legend>${['Tens','Ones'].map((part) => {
      const key = `${kind}${part}`; return `<label><span>${part === 'Tens' ? t('glasses.tens') : t('glasses.ones')}</span><select data-attendance-digit="${key}" aria-label="${label} ${part}">${Array.from({length:10},(_,i)=>`<option value="${i}" ${d[key]===i?'selected':''}>${i}</option>`).join('')}</select></label>`;
    }).join('')}</fieldset>`;
    if (isMetaDisplayRuntime) {
      const digitKeys = ['expectedTens','expectedOnes','presentTens','presentOnes'];
      actions = [
        ...digitKeys.map((key, index) => ({ id: `attendance-digit-${key}`, action: `attendance-cycle-${key}`, label: key, inline: true, initial: index === 0 })),
        { id: 'attendance-continue', action: 'attendance-continue', label: t('common.continue'), primary: true, disabled: !valid }
      ];
      ensureGlassesFocus(actions, state.glassesStep);
      const digit = (key, label) => {
        const focused = state.glassesFocusId === `attendance-digit-${key}`;
        return `<button type="button" class="attendance-digit ${focused ? 'is-logically-focused' : ''}" data-focus-id="attendance-digit-${key}" data-glasses-action="attendance-cycle-${key}" tabindex="${focused ? '0' : '-1'}" aria-current="${focused ? 'true' : 'false'}" aria-label="${escapeHtml(label)}: ${d[key]}"><span aria-hidden="true">▲</span><strong>${d[key]}</strong><span aria-hidden="true">▼</span></button>`;
      };
      body = `<p class="glasses-kicker">${t('attendance.title')}</p><h1 class="attendance-total">${present} / ${expected}</h1>
        <div class="meta-attendance-editors">
          <section aria-label="${t('glasses.expectedWorkers')}"><h2>${t('glasses.expectedWorkers')}</h2><div>${digit('expectedTens', `${t('glasses.expectedWorkers')} ${t('glasses.tens')}`)}${digit('expectedOnes', `${t('glasses.expectedWorkers')} ${t('glasses.ones')}`)}</div></section>
          <section aria-label="${t('glasses.workersPresent')}"><h2>${t('glasses.workersPresent')}</h2><div>${digit('presentTens', `${t('glasses.workersPresent')} ${t('glasses.tens')}`)}${digit('presentOnes', `${t('glasses.workersPresent')} ${t('glasses.ones')}`)}</div></section>
        </div><p class="glasses-muted">${t('glasses.countOnlyNotice')}</p>`;
    } else {
      body = `<p class="glasses-kicker">${t('attendance.title')}</p><h1>${present} / ${expected}</h1><div class="glasses-attendance-editors">${editor('expected', t('glasses.expectedWorkers'))}${editor('present', t('glasses.workersPresent'))}</div>
        <p class="glasses-muted">${t('glasses.countOnlyNotice')}</p>`;
      actions = [{ action: 'attendance-continue', label: t('common.continue'), primary: true, disabled: !valid }];
    }
  } else if (state.glassesStep === GLASSES_STEP.HAZARD_DECISION) {
    body = `<p class="glasses-kicker">${escapeHtml(getHazardProgressText())}</p>
      <h1 class="glasses-primary-title" aria-label="${escapeHtml(title.full)}">${escapeHtml(title.primary)}</h1>
      <p class="glasses-location" aria-label="${escapeHtml(location.full)}">${escapeHtml(location.primary)}</p>
      <h2 class="glasses-question">${t('glasses.reviewQuestion')}</h2>`;
    actions = [
      { action: 'controlled', label: t('hazard.controlled'), primary: true },
      { action: 'action-required', label: t('glasses.notControlled'), primary: true }
    ];
  } else if (state.glassesStep === GLASSES_STEP.CORRECTIVE_ACTION) {
    const corrective = normalizeCorrectiveAction(response?.correctiveAction, HAZARD_STATUS.ACTION_REQUIRED);
    const select = (field, label, values) => `<label>${label}<select data-corrective-field="${field}"><option value="">${t('corrective.selectStatus')}</option>${values.map(([v,l])=>`<option value="${v}" ${corrective[field]===v?'selected':''}>${l}</option>`).join('')}</select></label>`;
    body = `<p class="glasses-kicker">${t('glasses.notControlled')}</p><h1>${t('corrective.title')}</h1>${isMetaDisplayRuntime ? '<p>Enter를 눌러 각 값을 변경하세요.</p>' : `<div class="glasses-compact-form">
      ${select('immediateResponseCategory',t('corrective.immediateControl'),Object.values(IMMEDIATE_RESPONSE_CATEGORY).map(v=>[v,t(`glasses.control.${v}`)]))}
      ${select('responsibleParty',t('corrective.assignedPerson'),Object.values(RESPONSIBLE_PARTY).map(v=>[v,t(`glasses.party.${v}`)]))}
      ${select('workStatus',t('corrective.workStatus'),[[WORK_STATUS.STOPPED,t('corrective.stopped')],[WORK_STATUS.PERMITTED_WITH_CONTROLS,t('corrective.permitted')]])}
      ${select('duePeriod',t('corrective.dueAt'),Object.values(DUE_PERIOD).map(v=>[v,t(`glasses.due.${v}`)]))}
      <label>${t('corrective.verificationStatus')}<select data-corrective-field="verificationStatus"><option value="open">${t('corrective.open')}</option></select></label></div>`}`;
    const valid = corrective.immediateResponseCategory && corrective.responsibleParty && corrective.workStatus && corrective.duePeriod;
    actions = isMetaDisplayRuntime ? [
      { action: 'corrective-cycle-immediateResponseCategory', label: `${t('corrective.immediateControl')}: ${corrective.immediateResponseCategory ? t(`glasses.control.${corrective.immediateResponseCategory}`) : '—'}` },
      { action: 'corrective-cycle-responsibleParty', label: `${t('corrective.assignedPerson')}: ${corrective.responsibleParty ? t(`glasses.party.${corrective.responsibleParty}`) : '—'}` },
      { action: 'corrective-cycle-workStatus', label: `${t('corrective.workStatus')}: ${corrective.workStatus ? t(corrective.workStatus === WORK_STATUS.STOPPED ? 'corrective.stopped' : 'corrective.permitted') : '—'}` },
      { action: 'corrective-cycle-duePeriod', label: `${t('corrective.dueAt')}: ${corrective.duePeriod ? t(`glasses.due.${corrective.duePeriod}`) : '—'}` },
      { action: 'corrective-continue', label: t('common.continue'), primary: true, disabled: !valid }
    ] : [{ action: 'corrective-continue', label: t('common.continue'), primary: true, disabled: !valid }];
  } else if (state.glassesStep === GLASSES_STEP.PHOTO_EVIDENCE) {
    const photos = response?.evidencePhotos ?? [];
    body = `<p class="glasses-kicker">${t('glasses.photoEvidence')}</p><h1>${t('glasses.evidenceCount',{count:photos.length})}</h1>
      <ul class="glasses-evidence-list">${photos.map(p=>`<li>${escapeHtml(evidenceSourceLabel(p.source))}</li>`).join('') || `<li>${t('report.noPhoto')}</li>`}</ul><p class="glasses-muted">${t(isMetaDisplayRuntime ? 'glasses.metaEvidenceUnavailable' : 'glasses.previewEvidenceDisclaimer')}</p>
      ${state.glassesPhotoFeedback ? `<p class="glasses-validation" role="status">${escapeHtml(state.glassesPhotoFeedback)}</p>` : ''}`;
    actions = isMetaDisplayRuntime
      ? [{ action: 'native-evidence-start', label: locale === 'ko' ? '사진 촬영' : 'Take photo', primary: true, disabled: !state.nativeDeviceAvailable }, { action: 'evidence-continue', label: locale === 'ko' ? '사진 없이 계속' : 'Continue without photo' }]
      : [{ action: 'mock-photo', label: t('glasses.takePhoto'), primary: true }, { action: 'upload-photo', label: t('glasses.uploadPhoto'), disabled: true }, { action: 'evidence-continue', label: t('common.continue') }];
    if (isMetaDisplayRuntime && !state.nativeDeviceAvailable) {
      body += `<p class="glasses-validation">${locale === 'ko' ? '등록된 Android DAT 카메라 기기가 없습니다.' : 'No registered Android DAT camera device is available.'}</p>`;
    }
  } else if (state.glassesStep === GLASSES_STEP.NATIVE_CAPTURE_PREPARE) {
    body = `<p class="glasses-kicker">${locale === 'ko' ? '카메라 준비' : 'Camera preparation'}</p>
      <h1>${locale === 'ko' ? '위험 요소를 바라보세요' : 'Look at the hazard'}</h1>
      <p class="glasses-large">${escapeHtml(state.glassesEvidenceRequest?.hazard?.title ?? response?.title ?? '')}</p>
      <p class="glasses-muted">${locale === 'ko' ? '확인을 누르기 전에는 촬영되지 않습니다.' : 'Nothing is captured until you confirm.'}</p>
      ${state.glassesPhotoFeedback ? `<p class="glasses-validation" role="status">${escapeHtml(state.glassesPhotoFeedback)}</p>` : ''}`;
    actions = [{ action: 'native-capture-confirm', label: locale === 'ko' ? '촬영 확인' : 'Confirm capture', primary: true }, { action: 'phone-evidence-cancel', label: t('common.cancel') }];
  } else if (state.glassesStep === GLASSES_STEP.EVIDENCE_HANDOFF) {
    const requestItem = state.glassesEvidenceRequest;
    const nativeRequest = requestItem?.provider === EVIDENCE_PROVIDER.NATIVE_DAT_CAMERA;
    const completed = requestItem?.status === 'completed';
    const terminal = ['cancelled', 'expired', 'failed'].includes(requestItem?.status);
    body = `<p class="glasses-kicker">${nativeRequest ? (locale === 'ko' ? '안경 카메라 요청' : 'Glasses camera request') : (locale === 'ko' ? '휴대전화 사진 요청' : 'Phone evidence request')}</p>
      <h1>${completed ? (locale === 'ko' ? '사진 1장 수신됨' : 'One photo received') : terminal ? escapeHtml(requestItem.status) : nativeRequest ? (locale === 'ko' ? '카메라 대기 중' : 'Waiting for camera') : (locale === 'ko' ? '휴대전화 대기 중' : 'Waiting for phone')}</h1>
      <p class="glasses-large">${escapeHtml(requestItem?.hazard?.title ?? response?.title ?? '')}</p>
      <p class="glasses-muted">${requestItem?.expiresAt ? `${locale === 'ko' ? '만료' : 'Expires'}: ${escapeHtml(formatDateTime(new Date(requestItem.expiresAt)))}` : ''}</p>
      ${state.glassesPhotoFeedback ? `<p class="glasses-validation" role="status">${escapeHtml(state.glassesPhotoFeedback)}</p>` : ''}`;
    actions = completed
      ? [{ action: 'phone-evidence-attach', label: locale === 'ko' ? '사진 첨부 확인' : 'Attach photo', primary: true },
          { action: 'native-evidence-retake', label: locale === 'ko' ? '다시 촬영' : 'Retake' }]
      : terminal
        ? [{ action: 'prev', label: t('common.back'), primary: true }]
        : [{ action: 'phone-evidence-check', label: locale === 'ko' ? '다시 확인' : 'Check again', primary: true }, { action: 'phone-evidence-cancel', label: t('common.cancel') }];
  } else if (state.glassesStep === GLASSES_STEP.HAZARD_CONFIRMATION) {
    const corrective = normalizeCorrectiveAction(response?.correctiveAction, state.glassesProvisionalDecision);
    const complete = state.glassesProvisionalDecision === HAZARD_STATUS.CONTROLLED || Boolean(corrective.immediateResponseCategory && corrective.responsibleParty && corrective.workStatus && corrective.duePeriod);
    body = `<p class="glasses-kicker">${t('glasses.confirmHazard')}</p><h1>${escapeHtml(response?.title)}</h1><dl class="glasses-detail-list"><div><dt>${t('common.status')}</dt><dd>${state.glassesProvisionalDecision===HAZARD_STATUS.CONTROLLED?t('hazard.controlled'):t('glasses.notControlled')}</dd></div><div><dt>${t('report.photoEvidence')}</dt><dd>${response?.evidencePhotos?.length ?? 0}</dd></div></dl>`;
    actions = [{ action: 'hazard-confirm', label: t('glasses.confirm'), primary: true, disabled: !complete }];
  } else if (state.glassesStep === GLASSES_STEP.HAZARD_SUMMARY) {
    body = `<p class="glasses-kicker">${t('glasses.hazardSummary')}</p><h1>${t('summary.review')}</h1><ol class="glasses-summary-list">${state.responses.map((r,i)=>`<li><strong>${i+1}. ${escapeHtml(r.title)}</strong><span>${normalizeHazardStatus(r.status)===HAZARD_STATUS.CONTROLLED?t('hazard.controlled'):t('glasses.notControlled')} · ${r.evidencePhotos?.length??0} ${t('report.photoEvidence')}</span></li>`).join('')}</ol>`;
    actions = [{ action: 'summary-continue', label: t('common.continue'), primary: true }];
  } else if (state.glassesStep === GLASSES_STEP.SHARING_RECORD) {
    const sharing = normalizeSharing(state.session.sharing); const sharingErrors = getSharingScreenErrors(sharing); const ready = isSharingScreenComplete(sharing);
    const options = (values,selected,prefix)=>`<option value=""></option>${values.map(v=>`<option value="${v}" ${selected===v?'selected':''}>${t(`${prefix}.${v}`)}</option>`).join('')}`;
    body = `<p class="glasses-kicker">${t('sharing.title')}</p><h1>${t('glasses.sharingRecord')}</h1>${isMetaDisplayRuntime ? '<p>각 항목을 선택해 값을 변경하세요.</p>' : `<div class="glasses-compact-form">
      <label><input type="checkbox" data-sharing-field="shared" ${sharing.status===SHARING_STATUS.SHARED?'checked':''}/> ${t('glasses.resultsShared')}</label>
      <label>${t('sharing.method')}<select data-sharing-field="method">${options(Object.values(SHARING_METHOD),sharing.method,'glasses.share')}</select></label>
      <label>${t('glasses.proofType')}<select data-sharing-field="proofType">${options(Object.values(SHARING_PROOF_TYPE),sharing.proofType,'glasses.proof')}</select></label></div>`}
      ${sharingErrors.length ? `<p class="glasses-validation" role="status">${t('glasses.sharingMissing')}: ${sharingErrors.map(key=>t(`glasses.sharingError.${key}`)).join(', ')}</p>` : ''}
      ${state.glassesSharingFeedback ? `<p class="glasses-validation" role="alert">${escapeHtml(state.glassesSharingFeedback)}</p>` : ''}`;
    actions = isMetaDisplayRuntime ? [
      { action: 'sharing-toggle', label: `${t('glasses.resultsShared')}: ${sharing.status === SHARING_STATUS.SHARED ? '✓' : '—'}` },
      { action: 'sharing-cycle-method', label: `${t('sharing.method')}: ${sharing.method ? t(`glasses.share.${sharing.method}`) : '—'}` },
      { action: 'sharing-cycle-proof', label: `${t('glasses.proofType')}: ${sharing.proofType ? t(`glasses.proof.${sharing.proofType}`) : '—'}` },
      { action: 'record-continue', label: t('common.continue'), primary: true, disabled: !ready }
    ] : [{ action: 'record-continue', label: t('common.continue'), primary: true, disabled: !ready }];
  } else if (state.glassesStep === GLASSES_STEP.REPORT_REVIEW) {
    const sharing = normalizeSharing(state.session.sharing); const blockers = getFinalizationBlockers(buildSessionLog());
    const attendance = normalizeAttendanceSummary(state.session.attendanceSummary);
    const openActions = state.responses.filter(r=>normalizeHazardStatus(r.status)===HAZARD_STATUS.ACTION_REQUIRED && !isCorrectiveActionClosed(r.correctiveAction));
    body = `<header class="glasses-report-heading"><p class="glasses-kicker">${t('glasses.reportReview')}</p><h1>${t('glasses.reviewBeforeSubmit')}</h1></header>
      <section class="glasses-report-section"><h2>${t('summary.record')}</h2><dl class="glasses-report-grid"><div><dt>${t('tbm.supervisor')}</dt><dd>${escapeHtml(state.currentUser?.name)} / ${escapeHtml(state.currentUser?.role)}</dd></div><div><dt>${t('tbm.siteName')}</dt><dd>${escapeHtml(state.session.siteName)} / ${escapeHtml(state.session.taskName)}</dd></div></dl></section>
      <section class="glasses-report-section"><h2>${t('report.attendance')}</h2><div class="glasses-report-stats"><p><strong>${attendance ? `${attendance.presentCount} / ${attendance.expectedCount}` : '—'}</strong><span>${t('report.attendance')}</span></p><p><strong>${openActions.length}</strong><span>${t('report.openActions')}</span></p></div></section>
      <section class="glasses-report-section"><h2>${t('report.allHazards')}</h2><ol class="glasses-summary-list">${state.responses.map((r,i)=>`<li><strong>${i+1}. ${escapeHtml(r.title)}</strong><span>${normalizeHazardStatus(r.status)===HAZARD_STATUS.CONTROLLED?t('hazard.controlled'):t('glasses.notControlled')} · ${r.evidencePhotos?.length??0} ${t('report.photoEvidence')} · ${(r.evidencePhotos??[]).map(p=>escapeHtml(evidenceSourceLabel(p.source))).join(', ')||t('report.noPhoto')}</span></li>`).join('')}</ol></section>
      <section class="glasses-report-section"><h2>${t('sharing.title')}</h2><dl class="glasses-report-grid"><div><dt>${t('sharing.method')}</dt><dd>${t(`glasses.share.${sharing.method}`)}</dd></div><div><dt>${t('glasses.proofType')}</dt><dd>${t(`glasses.proof.${sharing.proofType}`)}</dd></div></dl></section>
      ${blockers.length ? `<section class="glasses-report-section glasses-validation"><h2>${t('summary.blockers')}</h2><ul>${blockers.map(b=>`<li>${escapeHtml(localizeFinalizationBlocker(b,t))}</li>`).join('')}</ul></section>` : `<p class="glasses-report-ready">✓ ${t('summary.noBlockers')}</p>`}
      ${state.glassesSubmissionStatus==='failed'?`<p class="glasses-validation" role="alert">${t('glasses.submitFailed')}</p>`:''}`;
    actions = [{ action: 'submit-report', label: t('glasses.submitReport'), primary: true, disabled: blockers.length>0 || state.isSavingSession }];
  } else if (state.glassesStep === GLASSES_STEP.SUBMITTING_REPORT) {
    body = `<p class="glasses-kicker">${t('glasses.submittingReport')}</p><h1>${t('feedback.queueing')}</h1><p>${t('glasses.noDuplicateSubmit')}</p>`; actions = [];
  } else if (state.glassesStep === GLASSES_STEP.CONFLICT) {
    body = `<p class="glasses-kicker">${t('sync.conflict')}</p><h1>${t('glasses.conflictTitle')}</h1><p class="glasses-large">${t('glasses.conflictBody')}</p>`;
    actions = [{ action: 'exit', label: t('glasses.reviewInBrowser'), primary: true }];
  } else if (state.glassesStep === GLASSES_STEP.COMPLETE) {
    const counts=getHazardReviewCounts(); const evidence=state.responses.reduce((n,r)=>n+(r.evidencePhotos?.length??0),0);
    const completionTitle = state.glassesSubmissionStatus === 'submitted' ? t('glasses.reportSubmitted') : t('glasses.reportQueued');
    body = `<p class="glasses-kicker">${t(syncPresentation.key)}</p><h1>${completionTitle}</h1><div class="glasses-completion-grid"><p><strong>${counts.controlled}</strong><span>✓ ${t('hazard.controlled')}</span></p><p><strong>${counts.actionRequired}</strong><span>! ${t('glasses.notControlled')}</span></p><p><strong>${counts.actionRequired}</strong><span>↻ ${t('report.openActions')}</span></p><p><strong>${evidence}</strong><span>▣ ${t('report.photoEvidence')}</span></p></div>`;
    actions = [{ action: 'done', label: t('glasses.done'), primary: true }];
  }

  app.innerHTML = `
    <section class="glasses-screen is-${escapeHtml(state.glassesStep)}">
      ${isMetaDisplayRuntime ? '' : `<header class="glasses-topline">
        ${v2Logo()}
        <nav aria-label="${t('glasses.secondaryNavigation')}">
          ${![GLASSES_STEP.START, GLASSES_STEP.SUBMITTING_REPORT, GLASSES_STEP.COMPLETE].includes(state.glassesStep) ? `<button class="focusable glasses-exit" data-glasses-action="prev">${t('common.back')}</button>` : ''}
          <button class="focusable glasses-exit" data-glasses-action="exit">${t('glasses.quit')}</button>
        </nav>
      </header>`}
      <main class="glasses-card" tabindex="-1">
        ${body}
      </main>
      ${renderGlassesActions(actions)}
      ${isMetaDisplayRuntime
        ? `<footer class="glasses-meta-status">${t(syncPresentation.key)} · ${t(state.deviceConnectionState === 'offline' ? 'glasses.networkOffline' : 'glasses.networkOnline')}</footer>`
        : `<footer class="glasses-shortcuts"><span class="glasses-sync is-${syncPresentation.tone}">${t(syncPresentation.key)} · ${t(state.deviceConnectionState === 'offline' ? 'glasses.networkOffline' : 'glasses.networkOnline')}</span><button class="focusable glasses-help-button" data-glasses-action="toggle-help" aria-expanded="${state.glassesHelpOpen}">${t('glasses.previewHelp')}</button></footer>`}
      <p class="sr-only" role="status" aria-live="polite" aria-atomic="true">${escapeHtml(state.glassesAnnouncement)}</p>
      ${state.glassesHelpOpen ? `<aside class="glasses-help-overlay" role="dialog" aria-modal="true" aria-labelledby="glasses-help-title">
        <h2 id="glasses-help-title">${t(isMetaDisplayRuntime ? 'glasses.deviceTooling' : 'glasses.previewTooling')}</h2><p>${t(isMetaDisplayRuntime ? 'glasses.metaCapabilityNotice' : 'glasses.previewDisclaimer')}</p>
        ${isMetaDisplayRuntime
          ? `<ul><li>↑/↓/←/→ — ${t('glasses.moveFocus')}</li><li>Enter — ${t('glasses.activateFocused')}</li><li>Escape — ${t('common.back')}</li></ul>`
          : `<ul><li>Enter — ${t('common.continue')}</li><li>← — ${t('common.back')}</li><li>1 — ${t('hazard.controlled')}</li><li>2 — ${t('glasses.notControlled')}</li><li>H / ? — ${t('glasses.previewHelp')}</li></ul>`}
        <button class="focusable v2-key-button v2-key-primary" data-glasses-action="toggle-help" data-primary-action>${t('common.close')}</button></aside>` : ''}
    </section>
  `;

  app.querySelectorAll('[data-corrective-field]').forEach((field) => {
    field.addEventListener('change', () => {
      const labels = { immediateResponseCategory: 'immediateControl', responsibleParty: 'assignedTo' };
      updateCorrectiveAction(field.dataset.correctiveField, field.value);
      if (labels[field.dataset.correctiveField]) updateCorrectiveAction(labels[field.dataset.correctiveField], field.value);
      if (field.dataset.correctiveField === 'duePeriod') updateCorrectiveAction('dueAt', duePeriodToDueAt(field.value));
      render();
    });
  });
  app.querySelectorAll('[data-attendance-digit]').forEach((field)=>field.addEventListener('change',()=>{state.glassesAttendanceDigits[field.dataset.attendanceDigit]=Number(field.value);saveLocalDraft();render();}));
  app.querySelectorAll('[data-sharing-field]').forEach((field)=>field.addEventListener('change',()=>{const key=field.dataset.sharingField;if(key==='shared'){state.session.sharing={...normalizeSharing(state.session.sharing),status:field.checked?SHARING_STATUS.SHARED:SHARING_STATUS.NOT_RECORDED,recipients:field.checked?'All expected workers':''};}else updateSharing(key,field.value);saveLocalDraft();render();}));
  bindGlassesButtons();
}

function renderCorrectiveActionEditor(response) {
  if (normalizeHazardStatus(response.status) !== HAZARD_STATUS.ACTION_REQUIRED) return '';
  const action = normalizeCorrectiveAction(response.correctiveAction, response.status);
  const closureEvidence = action.closureEvidence.join(', ');

  return `
    <section class="v2-card v2-corrective-card" aria-label="${t('corrective.title')}">
      <div class="v2-section-heading">
        <h2>${t('corrective.title')}</h2>
        <p>${t('corrective.openExplanation')}</p>
      </div>
      <div class="v2-two-col">
        <label class="v2-field-block"><span>${t('corrective.immediateControl')} *</span><input data-corrective-field="immediateControl" value="${escapeHtml(action.immediateControl)}" /></label>
        <label class="v2-field-block"><span>${t('corrective.assignedPerson')} *</span><input data-corrective-field="assignedTo" value="${escapeHtml(action.assignedTo)}" /></label>
        <label class="v2-field-block"><span>${t('corrective.dueAt')} *</span><input type="datetime-local" data-corrective-field="dueAt" value="${escapeHtml(action.dueAt)}" /></label>
        <label class="v2-field-block"><span>${t('corrective.workStatus')} *</span><select data-corrective-field="workStatus">
          <option value="">${t('corrective.selectStatus')}</option>
          <option value="${WORK_STATUS.STOPPED}" ${action.workStatus === WORK_STATUS.STOPPED ? 'selected' : ''}>${t('corrective.stopped')}</option>
          <option value="${WORK_STATUS.PERMITTED_WITH_CONTROLS}" ${action.workStatus === WORK_STATUS.PERMITTED_WITH_CONTROLS ? 'selected' : ''}>${t('corrective.permitted')}</option>
        </select></label>
        <label class="v2-field-block"><span>${t('corrective.verificationStatus')} *</span><select data-corrective-field="verificationStatus">
          <option value="${VERIFICATION_STATUS.OPEN}" ${action.verificationStatus === VERIFICATION_STATUS.OPEN ? 'selected' : ''}>${t('corrective.open')}</option>
          <option value="${VERIFICATION_STATUS.VERIFIED}" ${action.verificationStatus === VERIFICATION_STATUS.VERIFIED ? 'selected' : ''}>${t('corrective.verified')}</option>
        </select></label>
        <label class="v2-field-block"><span>${t('corrective.closureEvidence')}</span><input data-corrective-field="closureEvidence" value="${escapeHtml(closureEvidence)}" /></label>
        ${
          action.verificationStatus === VERIFICATION_STATUS.VERIFIED
            ? `<label class="v2-field-block"><span>${t('corrective.verifiedBy')} *</span><input data-corrective-field="verifiedBy" value="${escapeHtml(action.verifiedBy ?? '')}" /></label>
               <label class="v2-field-block"><span>${t('corrective.verifiedAt')} *</span><input type="datetime-local" data-corrective-field="verifiedAt" value="${escapeHtml(action.verifiedAt ?? '')}" /></label>`
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
    <section class="v2-screen ${normalizeHazardStatus(response.status) === HAZARD_STATUS.ACTION_REQUIRED ? 'is-corrective' : ''}" role="main">
      ${v2Header(t('hazard.checklist'), v2ChecklistProgress())}
      <section class="v2-card v2-hazard-card" aria-label="${t('hazard.current')}">
        <div class="v2-hazard-hero">
          <div class="v2-warning-tile">!</div>
          <div class="v2-hazard-title">
            <p class="v2-kicker">${t('hazard.current')}</p>
            <h2>${escapeHtml(hazard.name)}</h2>
          </div>
          ${v2StatusChip(t('common.status'), response.status ? t(`hazard.${response.status === HAZARD_STATUS.CONTROLLED ? 'controlled' : response.status === HAZARD_STATUS.ACTION_REQUIRED ? 'actionRequired' : 'notChecked'}`) : t('hazard.notMarked'), statusTone)}
        </div>

        <div class="v2-detail-list">
          <div class="v2-detail-row">${v2Icon('location')}<p>${t('hazard.location')}</p><strong>${escapeHtml(hazard.location)}</strong></div>
          <div class="v2-detail-row">${v2Icon('status')}<p>${t('hazard.riskLevel')}</p><strong>${escapeHtml(hazard.riskLevel ?? response.riskLevel ?? 'medium')}</strong></div>
          <div class="v2-detail-row">${v2Icon('category')}<p>${t('hazard.category')}</p><strong>${escapeHtml(hazard.category ?? response.category ?? 'general')}</strong></div>
          <div class="v2-detail-row">${v2Icon('risk')}<p>${t('hazard.risk')}</p><strong>${escapeHtml(hazard.risk)}</strong></div>
          <div class="v2-detail-row">${v2Icon('action')}<p>${t('hazard.recommendedAction')}</p><strong>${escapeHtml(hazard.action)}</strong></div>
        </div>
      </section>

      <section class="v2-card v2-memo-card">
        <label for="memo">${t('hazard.memo')} <span>${t('common.optional')}</span></label>
        <textarea id="memo" class="v2-textarea focusable" rows="2" maxlength="220" placeholder="${t('hazard.memoPlaceholder')}">${escapeHtml(
        state.memo
      )}</textarea>
        ${draftStatusHtml()}
      </section>

      ${renderCorrectiveActionEditor(response)}

      <section class="v2-action-row" aria-label="${t('hazard.checklist')}">
        <button class="focusable v2-key-button v2-key-primary" data-action="controlled">✓ ${t('hazard.controlledProceed')}</button>
        <button class="focusable v2-key-button" data-action="action-required">${t('hazard.actionRequired')}</button>
      </section>

      <section class="v2-action-row v2-action-row-nav" aria-label="${t('common.next')}">
        <button class="focusable v2-key-button" data-action="prev">← ${t('common.back')}</button>
        <button class="focusable v2-key-button" data-action="log-new">＋ ${t('hazard.logNew')}</button>
        <button class="focusable v2-key-button" data-action="save-draft">${t('draft.record')}</button>
        <button class="focusable v2-key-button" data-action="next">${t('common.next')} →</button>
      </section>
    </section>
  `;

  bindCompositionSafeInput(app.querySelector('#memo'), (value) => saveMemo(value));
  app.querySelectorAll('[data-corrective-field]').forEach((field) => {
    if (field.tagName === 'SELECT') {
      field.addEventListener('change', () => {
        updateCorrectiveAction(field.dataset.correctiveField, field.value);
        if (field.dataset.correctiveField === 'verificationStatus') render();
      });
    } else {
      bindCompositionSafeInput(field, (value) => updateCorrectiveAction(field.dataset.correctiveField, value));
    }
  });
  bindButtons();
}

function renderSharingEditor() {
  const sharing = normalizeSharing(state.session.sharing);
  return `
    <section class="v2-card v2-sharing-card" aria-label="${t('sharing.title')}">
      <div class="v2-section-heading">
        <h2>${t('sharing.title')}</h2>
        <p>${t('sharing.explanation')}</p>
      </div>
      <div class="v2-two-col">
        <label class="v2-field-block"><span>${t('sharing.question')} *</span><select data-sharing-field="status">
          <option value="${SHARING_STATUS.NOT_RECORDED}" ${sharing.status === SHARING_STATUS.NOT_RECORDED ? 'selected' : ''}>${t('sharing.notRecorded')}</option>
          <option value="${SHARING_STATUS.NOT_SHARED}" ${sharing.status === SHARING_STATUS.NOT_SHARED ? 'selected' : ''}>${t('sharing.notShared')}</option>
          <option value="${SHARING_STATUS.SHARED}" ${sharing.status === SHARING_STATUS.SHARED ? 'selected' : ''}>${t('sharing.supervisorReports')}</option>
        </select></label>
        ${
          sharing.status === SHARING_STATUS.SHARED
            ? `<label class="v2-field-block"><span>${t('sharing.method')} *</span><input data-sharing-field="method" value="${escapeHtml(sharing.method)}" /></label>
               <label class="v2-field-block"><span>${t('sharing.recipients')} *</span><input data-sharing-field="recipients" value="${escapeHtml(sharing.recipients)}" /></label>`
            : ''
        }
        <label class="v2-field-block"><span>${t('sharing.ackResults')}</span><textarea class="v2-textarea" data-sharing-field="acknowledgmentResults">${escapeHtml(sharing.acknowledgmentResults)}</textarea></label>
      </div>
      <p class="draft-status">${t('sharing.offlineEvidenceNote')}</p>
    </section>
  `;
}

function renderSummary() {
  const { controlled, actionRequired, unchecked } = getHazardReviewCounts();
  const blockers = getFinalizationBlockers(buildSessionLog());
  const { proposedStatus, title, explanation } = getSummaryPresentation(blockers);

  app.innerHTML = `
    <section class="v2-screen" role="main">
      ${v2Header(t('summary.record'), v2WorkflowProgress(4))}
      <section class="v2-card v2-summary-card">
        <div class="v2-summary-hero">
          <div class="${blockers.length ? 'v2-warning-tile' : 'v2-success-tile'}">${blockers.length ? '!' : '✓'}</div>
          <div>
            <h2 data-summary-title>${escapeHtml(title)}</h2>
            <p data-summary-explanation>${escapeHtml(explanation)}</p>
          </div>
          ${v2StatusChip(t('common.status'), proposedStatus, blockers.length ? 'warning' : 'success')}
        </div>

        <div class="v2-summary-stats">
          <div class="v2-stat-card">
            <div class="v2-warning-tile">✓</div>
            <p>${t('hazard.controlled')}</p>
            <strong>${controlled}</strong>
            <span>${t('summary.safeProceed')}</span>
          </div>
          <div class="v2-stat-card">
            <div class="v2-warning-tile">□</div>
            <p>${t('hazard.actionRequired')}</p>
            <strong>${actionRequired}</strong>
            <span>${t('summary.correctiveActions')}</span>
          </div>
          <div class="v2-stat-card"><p>${t('hazard.notChecked')}</p><strong>${unchecked}</strong><span>${t('summary.finalizationBlockers')}</span></div>
        </div>

        ${renderSharingEditor()}

        <section class="v2-report-preview" data-finalization-blockers>
          <h3>${t('summary.blockers')}</h3>
          ${
            blockers.length
              ? `<ul>${blockers.map((blocker) => `<li>${escapeHtml(localizeFinalizationBlocker(blocker, t))}</li>`).join('')}</ul>`
              : `<p>${t('summary.noBlockers')}</p>`
          }
        </section>

        <section class="v2-report-preview">
          <h3>${t('summary.reportPreview')}</h3>
          ${buildKoreanReportHtml()}
        </section>
      </section>
      <p class="save-feedback" data-save-feedback>${escapeHtml(state.saveFeedback)}</p>
      ${draftStatusHtml()}
      <div class="v2-action-grid" role="group" aria-label="${t('common.actions')}">
        <button class="focusable v2-key-button v2-key-primary" data-action="review">${t('summary.review')}</button>
        <button class="focusable v2-key-button" data-action="log-new">＋ ${t('hazard.logNew')}</button>
        <button class="focusable v2-key-button" data-action="save-draft" ${
          state.isSavingSession ? 'disabled' : ''
        }>${state.isSavingSession ? t('sync.queued') : t('draft.record')}</button>
        <button class="focusable v2-key-button" data-action="finalize" ${
          state.isSavingSession || blockers.length ? 'disabled' : ''
        }>${t('summary.finalize')}</button>
        <button class="focusable v2-key-button" data-action="saved-sessions">${t('sessions.saved')}</button>
        <button class="focusable v2-key-button" data-action="copy">${t('common.copyJson')}</button>
      </div>
    </section>
  `;

  app.querySelectorAll('[data-sharing-field]').forEach((field) => {
    if (field.tagName === 'SELECT') {
      field.addEventListener('change', () => {
        pendingFocusSelector = '[data-sharing-field="status"]';
        updateSharing(field.dataset.sharingField, field.value);
        render();
      });
    } else {
      bindCompositionSafeInput(field, (value) => updateSharing(field.dataset.sharingField, value));
    }
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
                <span>${escapeHtml(session.status ? recordStatusLabel(session.status) : t('common.unknown'))}</span>
              </div>
              <div class="v2-session-site">
                ${v2Icon('site')}
                <div>
                  <strong>${escapeHtml(getSavedSessionSiteName(session))}</strong>
                  <span>${escapeHtml(session.site?.siteArea ?? session.siteArea ?? t('sessions.fallback'))}</span>
                </div>
              </div>
              <div class="v2-session-status">
                  <span>${t('common.status')}</span>
                  <strong>${escapeHtml(session.status ? recordStatusLabel(session.status) : t('common.unknown'))}</strong>
              </div>
              <button class="focusable v2-key-button v2-key-small" data-action="open-report" data-session="${escapeHtml(
                session.sessionId
              )}">${t('sessions.openReport')}</button>
            </li>
          `
        )
        .join('')
    : '';

  app.innerHTML = `
    <section class="v2-screen" role="main">
      ${v2Header(t('sessions.saved'))}
      <section class="v2-card v2-saved-card" aria-label="${t('sessions.saved')}">
        <div class="v2-section-heading v2-section-heading-row">
          <div>
            <h2>${t('sessions.saved')}</h2>
            <p>${t('sessions.count', { count: state.savedSessions.length })}</p>
          </div>
          <button class="focusable v2-key-button v2-key-small" data-action="refresh-saved">${t('common.refresh')}</button>
        </div>
        <section class="v2-saved-panel">
        ${
          state.savedSessionsStatus === 'loading'
            ? `<div class="v2-empty-state">${t('sessions.loading')}</div>`
            : state.savedSessionsStatus === 'error'
              ? `<div class="v2-empty-state">${escapeHtml(state.savedSessionsError)}</div>`
              : sortedSessions.length
                ? `<ul class="saved-session-list">${sessionsHtml}</ul>`
                : `<div class="v2-empty-state">${t('sessions.empty')}</div>`
        }
        </section>
      </section>

      <section class="v2-action-row" aria-label="${t('common.actions')}">
        <button class="focusable v2-key-button" data-action="back-from-saved">← ${t('common.back')}</button>
        <button class="focusable v2-key-button" data-action="refresh-saved">${t('common.refresh')}</button>
      </section>
    </section>
  `;

  bindButtons();
}

// ---------------------------------------------------------------------------
// Event binding
// ---------------------------------------------------------------------------

function bindButtons() {
  app.querySelectorAll('[data-language-selector]').forEach((selector) => {
    selector.addEventListener('change', () => selectLanguage(selector.value));
  });
  app.querySelectorAll('[data-auth-tab]').forEach((tab) => {
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const tabs = Array.from(app.querySelectorAll('[data-auth-tab]'));
      const nextIndex = (tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      tabs[nextIndex]?.click();
    });
  });
  app.querySelectorAll('button[data-action]').forEach((button) => {
    button.addEventListener('click', async () => {
      const action = button.dataset.action;

      if (action === 'auth-login') {
        state.authMode = 'login';
        state.authFeedback = '';
        pendingFocusSelector = '[data-auth-tab][aria-selected="true"]';
        render();
      }
      if (action === 'auth-register') {
        state.authMode = 'register';
        state.authFeedback = '';
        pendingFocusSelector = '[data-auth-tab][aria-selected="true"]';
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
      if (action === 'remove-worker') {
        pendingFocusSelector = '#worker-name';
        removeWorker(button.dataset.worker);
      }
      if (action === 'mark-all') {
        pendingFocusSelector = '[data-action="mark-all"]';
        markAllPresent();
      }
      if (action === 'continue') continueToChecklist();
      if (action === 'log-new') openManualEntry();
      if (action === 'cancel-manual') {
        if (!manualEntryHasUnsavedValues() || window.confirm(t('hazard.discardManualConfirm'))) cancelManualEntry();
      }
      if (action === 'prev') goTo(state.index - 1);
      if (action === 'next') goTo(state.index + 1);
      if (action === 'controlled') setStatus(HAZARD_STATUS.CONTROLLED);
      if (action === 'action-required') setStatus(HAZARD_STATUS.ACTION_REQUIRED);
      if (action === 'review') continueToChecklist();
      if (action === 'copy') copySessionLog(button);
      if (action === 'save-session' || action === 'save-draft') saveCurrentSession('draft');
      if (action === 'finalize') saveCurrentSession('finalize');
      if (action === 'saved-sessions') openSavedSessions();
      if (action === 'pair-glasses') openPairGlasses();
      if (action === 'refresh-evidence-requests') loadEvidenceRequests();
      if (action === 'refresh-native-devices') loadNativeDevices();
      if (action === 'revoke-native-device') revokeNativeDevice(button.dataset.device);
      if (action === 'select-evidence-camera' || action === 'replace-evidence-camera') app.querySelector(`[data-evidence-camera="${CSS.escape(button.dataset.request)}"]`)?.click();
      if (action === 'select-evidence-gallery') app.querySelector(`[data-evidence-gallery="${CSS.escape(button.dataset.request)}"]`)?.click();
      if (action === 'confirm-evidence-upload') fulfillEvidenceRequest();
      if (action === 'clear-evidence-selection') { clearEvidenceSelection(); render(); }
      if (action === 'cancel-evidence-request') cancelSupervisorEvidenceRequest(button.dataset.request);
      if (action === 'refresh-pairing') refreshSupervisorPairing();
      if (action === 'cancel-pairing') endSupervisorPairing(false);
      if (action === 'revoke-pairing') endSupervisorPairing(true);
      if (action === 'close-pairing') { state.phase = 'start'; state.supervisorPairing = null; render(); }
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
  if (isDeviceDiagnosticsMode) { renderDeviceDiagnostics(); return; }
  if (isInvalidGlassesRuntime) { renderInvalidDeviceRuntime(); return; }
  if (isMetaDisplayRuntime && state.phase === 'glasses-pairing') { renderGlassesPairing(); return; }
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
  if (state.phase === 'pair-glasses') renderPairGlasses();
  enhanceNormalAccessibility();
}

function enhanceNormalAccessibility() {
  const viewKey = state.phase === 'checklist' ? `${state.phase}:${state.index}` : state.phase;
  updateApplicationAnnouncement();

  const selector = pendingFocusSelector || (viewKey !== lastNormalViewKey ? viewFocusSelector(state.phase) : '');
  pendingFocusSelector = '';
  lastNormalViewKey = viewKey;
  if (selector) requestAnimationFrame(() => app.querySelector(selector)?.focus());
}

// ---------------------------------------------------------------------------
// Device adapter and normal-browser keyboard controls
// ---------------------------------------------------------------------------

function deviceFocusableElements() {
  return [...app.querySelectorAll('.focusable:not([disabled]), select:not([disabled]), input:not([disabled])')]
    .filter((element) => element.getClientRects().length > 0);
}

function moveLogicalGlassesFocus(direction = 1) {
  const elements = [...app.querySelectorAll('[data-focus-id]:not([disabled])')]
    .filter((element) => element.getClientRects().length > 0);
  if (!elements.length) return false;
  const currentIndex = elements.findIndex((element) => element.dataset.focusId === state.glassesFocusId);
  const next = elements[currentIndex < 0 ? 0 : (currentIndex + direction + elements.length) % elements.length];
  state.glassesFocusId = next.dataset.focusId;
  if (state.phase === 'glasses-pairing') state.glassesPairing.focusId = state.glassesFocusId;
  state.glassesFocusView = state.phase === 'glasses-pairing' ? `pairing:${state.glassesPairing.stage}` : state.glassesStep;
  if (state.phase === 'glasses-pairing') renderGlassesPairing(); else renderGlasses();
  return true;
}

function activateLogicalGlassesFocus() {
  const focused = app.querySelector(`[data-focus-id="${CSS.escape(state.glassesFocusId)}"]`);
  if (!focused || focused.disabled) return false;
  focused.click();
  return true;
}

function handlePairingDeviceAction(action, event) {
  const pairing = state.glassesPairing;
  if (event.repeat) return true;
  if (pairing.stage === 'digits') {
    if (action === DEVICE_ACTION.BACK) {
      if (pairing.digitIndex > 0) pairing.digitIndex -= 1;
      else pairing.stage = 'intro';
      pairing.focusId = '';
      renderGlassesPairing();
      return true;
    }
    if (action === DEVICE_ACTION.ACTIVATE) {
      if (pairing.digitIndex < pairing.digits.length - 1) pairing.digitIndex += 1;
      else pairing.stage = 'confirm';
      pairing.focusId = '';
      renderGlassesPairing();
      return true;
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const delta = event.key === 'ArrowUp' ? 1 : -1;
      pairing.digits[pairing.digitIndex] = (pairing.digits[pairing.digitIndex] + delta + 10) % 10;
      renderGlassesPairing();
      return true;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const delta = event.key === 'ArrowRight' ? 1 : -1;
      pairing.digitIndex = Math.max(0, Math.min(pairing.digits.length - 1, pairing.digitIndex + delta));
      pairing.focusId = '';
      renderGlassesPairing();
      return true;
    }
    return false;
  }
  if (action === DEVICE_ACTION.BACK) {
    if (pairing.stage === 'confirm') {
      pairing.stage = 'digits';
      pairing.digitIndex = pairing.digits.length - 1;
    } else pairing.stage = 'intro';
    pairing.focusId = '';
    renderGlassesPairing();
    return true;
  }
  if (action === DEVICE_ACTION.FOCUS_NEXT || action === DEVICE_ACTION.FOCUS_PREVIOUS) {
    return moveLogicalGlassesFocus(action === DEVICE_ACTION.FOCUS_NEXT ? 1 : -1);
  }
  if (action === DEVICE_ACTION.ACTIVATE) return activateLogicalGlassesFocus();
  return false;
}

function moveDeviceFocus(direction = 1) {
  const elements = deviceFocusableElements();
  if (!elements.length) return false;
  const currentIndex = elements.indexOf(document.activeElement);
  const nextIndex = currentIndex < 0 ? 0 : (currentIndex + direction + elements.length) % elements.length;
  elements[nextIndex].focus();
  return true;
}

function activateDeviceFocus() {
  const focused = document.activeElement;
  if (focused?.matches('select')) return moveDeviceFocus(1);
  if (focused?.matches('button, input[type="checkbox"]')) {
    focused.click();
    return true;
  }
  return moveDeviceFocus(1);
}

function handleMetaAttendanceDeviceAction(action, event) {
  if (!isMetaDisplayRuntime || state.glassesStep !== GLASSES_STEP.ATTENDANCE) return false;
  const keys = ['expectedTens', 'expectedOnes', 'presentTens', 'presentOnes'];
  const currentIndex = keys.findIndex((key) => state.glassesFocusId === `attendance-digit-${key}`);
  if (currentIndex < 0) return false;
  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    const key = keys[currentIndex];
    const delta = event.key === 'ArrowUp' ? 1 : -1;
    state.glassesAttendanceDigits[key] = (state.glassesAttendanceDigits[key] + delta + 10) % 10;
    saveLocalDraft();
    render();
    return true;
  }
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || action === DEVICE_ACTION.ACTIVATE) {
    const nextIndex = action === DEVICE_ACTION.ACTIVATE
      ? currentIndex + 1
      : currentIndex + (event.key === 'ArrowRight' ? 1 : -1);
    state.glassesFocusId = nextIndex >= keys.length
      ? 'attendance-continue'
      : `attendance-digit-${keys[Math.max(0, nextIndex)]}`;
    state.glassesFocusView = state.glassesStep;
    render();
    return true;
  }
  return false;
}

function handleDeviceAction(action, event) {
  if (!isGlassesMode) return false;
  if (isMetaDisplayRuntime && state.phase === 'glasses-pairing') return handlePairingDeviceAction(action, event);
  if (!state.currentUser || !state.hazards.length) return false;
  if (state.glassesHelpOpen && action !== DEVICE_ACTION.BACK && action !== DEVICE_ACTION.ACTIVATE && action !== DEVICE_ACTION.TOGGLE_HELP) return false;

  if (action === DEVICE_ACTION.TOGGLE_HELP) {
    state.glassesHelpOpen = !state.glassesHelpOpen;
    render();
    return true;
  }
  if (action === DEVICE_ACTION.BACK && state.glassesHelpOpen) {
    state.glassesHelpOpen = false;
    render();
    return true;
  }
  if (handleMetaAttendanceDeviceAction(action, event)) return true;
  if (action === DEVICE_ACTION.FOCUS_NEXT || action === DEVICE_ACTION.FOCUS_PREVIOUS) {
    if (isMetaDisplayRuntime) return moveLogicalGlassesFocus(action === DEVICE_ACTION.FOCUS_NEXT ? 1 : -1);
    if (event.target?.matches?.('select')) return false;
    return moveDeviceFocus(action === DEVICE_ACTION.FOCUS_NEXT ? 1 : -1);
  }
  if (action === DEVICE_ACTION.ACTIVATE) return isMetaDisplayRuntime ? activateLogicalGlassesFocus() : activateDeviceFocus();
  if (event.target?.matches?.('input, textarea, select, button')) return false;
  if (action === DEVICE_ACTION.ADVANCE) {
    if (state.glassesStep === GLASSES_STEP.HAZARD_DECISION) return false;
    app.querySelector('[data-primary-action]:not([disabled])')?.click();
    return true;
  }
  if (action === DEVICE_ACTION.BACK) { void handleGlassesAction('prev'); return true; }
  if (action === DEVICE_ACTION.MARK_CONTROLLED) { void handleGlassesAction('controlled'); return true; }
  if (action === DEVICE_ACTION.MARK_ACTION_REQUIRED) { void handleGlassesAction('action-required'); return true; }
  if (action === DEVICE_ACTION.CAPTURE_MEMO) { void captureGlassesMemo(); return true; }
  if (action === DEVICE_ACTION.CAPTURE_EVIDENCE) { void captureGlassesPhoto(); return true; }
  return false;
}

if (!isDeviceDiagnosticsMode && !isInvalidGlassesRuntime) {
  deviceAdapter.connect({
    onAction: handleDeviceAction,
    onConnectionChange: (connectionState) => {
      state.deviceConnectionState = connectionState;
      if (isGlassesMode && state.currentUser && state.hazards.length) render();
    }
  });
}

window.addEventListener('keydown', (event) => {
  if (isGlassesMode) return;
  if (event.target.matches('input, textarea, select, button')) return;
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
        if (isGlassesMode && state.phase === 'summary') {
          if (status === SYNC_STATUS.CONFLICT) state.glassesStep = GLASSES_STEP.CONFLICT;
          state.glassesAnnouncement = t(glassesSyncState(status).key);
        }
        if (lastError && status === SYNC_STATUS.FAILED) state.saveFeedback = `${lastError} ${t('feedback.localRetained')}`;
        if (isGlassesMode && state.phase === 'summary') render();
        else refreshNonStructuralUi();
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
      state.saveFeedback = t('feedback.offlineQueued');
      refreshNonStructuralUi();
    }
  });
  await checkAuth();
  if (navigator.onLine) void synchronizeNow();
}

async function initializeDeviceDiagnostics() {
  if (!diagnosticsState) return;
  const refresh = () => renderDeviceDiagnostics();
  const recordKey = (event) => {
    const recorded = recordDiagnosticKey(event);
    if (!recorded) return;
    diagnosticsState.latestKey = recorded;
    renderDeviceDiagnostics();
    if (event.type === 'keydown' && event.key === 'Escape') window.location.href = exitDiagnosticsUrl(window.location.href);
  };
  window.addEventListener('keydown', recordKey);
  window.addEventListener('keyup', recordKey);
  window.addEventListener('resize', refresh);
  window.addEventListener('online', refresh);
  window.addEventListener('offline', refresh);
  document.addEventListener('visibilitychange', refresh);
  window.addEventListener('error', (event) => {
    event.preventDefault();
    diagnosticsState.runtimeError = sanitizeRuntimeError(event.error ?? event.message);
    renderDeviceDiagnostics();
  });
  window.addEventListener('unhandledrejection', (event) => {
    event.preventDefault();
    diagnosticsState.runtimeError = sanitizeRuntimeError(event.reason);
    renderDeviceDiagnostics();
  });

  renderDeviceDiagnostics();
  const [authentication, serviceWorker, indexedDb] = await Promise.all([
    probeAuthentication(),
    probeServiceWorker('serviceWorker' in navigator ? navigator.serviceWorker : undefined),
    probeIndexedDb('indexedDB' in window ? window.indexedDB : undefined)
  ]);
  diagnosticsState.authentication = authentication;
  diagnosticsState.serviceWorker = serviceWorker;
  diagnosticsState.indexedDb = indexedDb;
  renderDeviceDiagnostics();
}

if (isDeviceDiagnosticsMode) void initializeDeviceDiagnostics();
else if (isInvalidGlassesRuntime) renderInvalidDeviceRuntime();
else void initializeOfflineFirstApp();
