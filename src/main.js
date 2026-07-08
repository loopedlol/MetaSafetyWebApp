import './styles.css';

const SCHEMA_VERSION = '1.0.0';
const APP_VERSION = '0.1.0';

const stressMemo =
  'Long memo stress test: crew reported this needs barricades, signage, owner assignment, and follow-up before restart. This text should wrap and scroll inside the memo field without pushing buttons over other content.';

const isStressTest = new URLSearchParams(window.location.search).has('stress');

const state = {
  phase: 'auth-check',
  authMode: 'login',
  authFeedback: '',
  isAuthSubmitting: false,
  currentUser: null,
  hazards: [],
  index: 0,
  memo: isStressTest ? stressMemo : '',
  session: {
    sessionId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    siteName: 'Seoul Site A',
    siteArea: 'Tower A / Level 3',
    gps: {
      latitude: null,
      longitude: null,
      accuracyMeters: null
    },
    taskName: 'Morning TBM / Risk Assessment',
    workType: 'Construction safety TBM',
    plannedWorkDescription: 'Daily toolbox meeting and pre-work hazard confirmation.',
    supervisorName: 'Kim Supervisor',
    supervisorRole: 'Site safety supervisor',
    scheduledAt: new Date(),
    startedAt: null,
    completedAt: null,
    sharing: {
      sharedWithWorkers: false,
      method: 'not_shared',
      sharedAt: null
    },
    device: {
      platform: 'browser_hud_prototype',
      appVersion: APP_VERSION,
      inputMode: 'keyboard_and_touch'
    }
  },
  workers: [
    { id: crypto.randomUUID(), name: 'Park Minjun', role: 'Worker', present: false, acknowledged: false },
    { id: crypto.randomUUID(), name: 'Lee Jisoo', role: 'Signal worker', present: false, acknowledged: false },
    { id: crypto.randomUUID(), name: 'Choi Hana', role: 'Electrician', present: false, acknowledged: false }
  ],
  responses: [],
  nearMisses: [],
  savedSessions: [],
  savedSessionsStatus: 'idle',
  saveFeedback: '',
  isSavingSession: false,
  manualEntryFeedback: '',
  manualAiSuggestion: null,
  manualAiDecision: null,
  returnPhase: 'checklist'
};

const app = document.querySelector('#app');

async function apiFetch(url, options = {}) {
  const response = await fetch(url, options);
  if (response.status === 401) {
    state.currentUser = null;
    state.authMode = 'login';
    state.authFeedback = 'Please log in to continue.';
    state.phase = 'auth';
    render();
  }

  return response;
}

function formatDateTime(date) {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function getApiErrorMessage(error, fallback) {
  if (error instanceof TypeError) {
    return `${fallback} Make sure the backend server is running with npm run server.`;
  }

  return error.message || fallback;
}

function v2Icon() {
  return '<span class="v2-icon-box" aria-hidden="true"></span>';
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

function v2Progress(current, total, label = '') {
  return `
    <div class="v2-progress">
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

function getV2Step() {
  if (state.phase === 'start') return 1;
  if (state.phase === 'participation') return 3;
  if (state.phase === 'checklist') return state.index + 1;
  if (state.phase === 'summary') return state.hazards.length || 8;
  if (state.phase === 'saved-sessions') return 2;
  return 1;
}

function v2Header(title, currentStep = getV2Step(), totalSteps = Math.max(state.hazards.length || 8, currentStep), label = '') {
  return `
    <header class="v2-header">
      ${v2Logo()}
      <div class="v2-header-title"><h1>${escapeHtml(title)}</h1></div>
      <div class="v2-header-right">
        ${v2Progress(currentStep, totalSteps, label)}
        ${buildUserBadge()}
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
      ${v2Icon()}
      <span>${escapeHtml(state.currentUser.name)}</span>
      <button class="focusable v2-user-logout" data-action="logout" aria-label="Logout">Logout</button>
    </section>
  `;
}

async function checkAuth() {
  state.phase = 'auth-check';
  render();

  try {
    const response = await fetch('/api/auth/me', { cache: 'no-store' });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      state.currentUser = null;
      state.phase = 'auth';
      render();
      return;
    }

    state.currentUser = payload.user;
    await loadHazards();
  } catch (error) {
    state.currentUser = null;
    state.authFeedback = getApiErrorMessage(error, 'Could not check login status.');
    state.phase = 'auth';
    render();
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
    const response = await fetch(isRegister ? '/api/auth/register' : '/api/auth/login', {
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

    state.currentUser = result.user;
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
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  state.currentUser = null;
  state.authMode = 'login';
  state.authFeedback = 'Logged out.';
  state.phase = 'auth';
  render();
}

function currentHazard() {
  return state.hazards[state.index];
}

function currentResponse() {
  return state.responses[state.index];
}

function createResponses(hazards) {
  return hazards.map((hazard) => ({
    id: hazard.id,
    source: hazard.source ?? 'preloaded_checklist',
    title: hazard.title ?? hazard.name,
    category: hazard.category ?? 'general',
    location: hazard.location,
    riskLevel: hazard.riskLevel ?? 'medium',
    riskDescription: hazard.risk,
    recommendedAction: hazard.recommendedAction ?? hazard.action,
    evidencePhotos: hazard.evidencePhotos ?? [],
    status: null,
    memo: isStressTest ? stressMemo : '',
    updatedAt: null,
    humanReview: {
      reviewed: false,
      decision: 'not_checked',
      reviewedBy: null,
      reviewedAt: null
    }
  }));
}

function createManualHazardResponse(entry) {
  return {
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
    status: null,
    memo: '',
    updatedAt: null,
    humanReview: {
      reviewed: false,
      decision: 'not_checked',
      reviewedBy: null,
      reviewedAt: null
    }
  };
}

async function loadHazards() {
  renderLoading();

  try {
    const response = await fetch('/hazards.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Could not load hazards.json (${response.status})`);

    const hazards = await response.json();
    state.hazards = isStressTest ? makeStressHazards(hazards) : hazards;
    state.responses = createResponses(state.hazards);
    state.phase = 'start';
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

function saveStartField(name, value) {
  state.session[name] = value.trim();
}

function startTbm() {
  state.session.startedAt = new Date().toISOString();
  state.phase = 'participation';
  render();
}

function addWorker(name) {
  const trimmed = name.trim();
  if (!trimmed) return;

  state.workers.push({
    id: crypto.randomUUID(),
    name: trimmed,
    role: 'Worker',
    present: true,
    acknowledged: true
  });
  render();
}

function removeWorker(id) {
  state.workers = state.workers.filter((worker) => worker.id !== id);
  render();
}

function setWorkerPresent(id, present) {
  const worker = state.workers.find((item) => item.id === id);
  if (worker) {
    worker.present = present;
    worker.acknowledged = present;
  }
}

function markAllPresent() {
  state.workers = state.workers.map((worker) => ({ ...worker, present: true, acknowledged: true }));
  render();
}

function continueToChecklist() {
  state.phase = 'checklist';
  state.index = 0;
  state.memo = currentResponse()?.memo ?? '';
  render();
}

function saveMemo(value) {
  state.memo = value;
  currentResponse().memo = value.trim();
}

function goTo(index) {
  if (state.phase !== 'checklist') return;

  state.index = Math.max(0, Math.min(state.hazards.length - 1, index));
  state.memo = currentResponse().memo;
  render();
}

function setStatus(status) {
  if (state.phase !== 'checklist') return;

  const response = currentResponse();
  const reviewedAt = new Date().toISOString();
  response.status = status;
  response.memo = state.memo.trim();
  response.updatedAt = reviewedAt;
  response.humanReview = {
    reviewed: true,
    decision: status === 'Fix Ordered' ? 'fix_ordered' : 'accepted',
    reviewedBy: state.session.supervisorName,
    reviewedAt
  };

  if (state.index === state.hazards.length - 1) {
    state.session.completedAt = new Date().toISOString();
    state.phase = 'summary';
  } else {
    state.index += 1;
    state.memo = currentResponse().memo;
  }

  render();
}

function toExportHazardStatus(status) {
  if (status === 'Confirmed') return 'confirmed';
  if (status === 'Fix Ordered') return 'fix_ordered';
  return 'not_checked';
}

function getSessionStatus() {
  const hasUncheckedHazard = state.responses.some((item) => toExportHazardStatus(item.status) === 'not_checked');

  if (state.phase === 'summary' && !hasUncheckedHazard) return 'completed';
  if (state.phase === 'summary' && hasUncheckedHazard) return 'incomplete';
  return 'in_progress';
}

function getHumanReview(item) {
  const hazardStatus = toExportHazardStatus(item.status);

  if (hazardStatus === 'not_checked') {
    return {
      reviewed: false,
      decision: 'not_checked',
      reviewedBy: null,
      reviewedAt: null
    };
  }

  return {
    reviewed: true,
    decision: hazardStatus === 'fix_ordered' ? 'fix_ordered' : 'accepted',
    reviewedBy: state.session.supervisorName,
    reviewedAt: item.humanReview.reviewedAt
  };
}

function getCorrectiveAction(item) {
  const requiresAction = toExportHazardStatus(item.status) === 'fix_ordered';

  return {
    required: requiresAction,
    description: requiresAction ? item.recommendedAction : '',
    assignedTo: null,
    dueAt: null,
    completedAt: null
  };
}

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

  const formData = new FormData();
  files.forEach((file) => formData.append('photos', file));

  const response = await apiFetch('/api/uploads', {
    method: 'POST',
    body: formData
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error ?? `Photo upload failed (${response.status})`);
  }

  return Array.isArray(payload) ? payload : [];
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

  let evidencePhotos = [];
  const feedback = app.querySelector('#manual-entry-feedback');
  const submitButton = app.querySelector('button[form="manual-entry-form"]');

  try {
    state.manualEntryFeedback = evidencePhotoFiles.length ? 'Uploading photo evidence...' : 'Saving entry...';
    if (feedback) feedback.textContent = state.manualEntryFeedback;
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = evidencePhotoFiles.length ? 'Uploading...' : 'Saving...';
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
  render();
}

function formatKoreanList(items, emptyText) {
  if (!items.length) return `<li>${escapeHtml(emptyText)}</li>`;

  return items.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
}

function buildKoreanReportHtml() {
  const presentWorkers = state.workers.filter((worker) => worker.present);
  const confirmed = state.responses.filter((item) => toExportHazardStatus(item.status) === 'confirmed');
  const fixOrdered = state.responses.filter((item) => toExportHazardStatus(item.status) === 'fix_ordered');
  const unchecked = state.responses.filter((item) => toExportHazardStatus(item.status) === 'not_checked');
  const hazardLines = state.responses.map(
    (item) => `${item.title} (${item.location}, 위험도: ${item.riskLevel})`
  );
  const nearMissLines = state.nearMisses.map(
    (item) => `${item.title} (${item.location}, 위험도: ${item.riskLevel}) - ${item.actionTaken || '조치 내용 미입력'}`
  );
  const manualHazardLines = state.responses
    .filter((item) => item.source === 'manual_entry')
    .map((item) => `${item.title} (${item.location}, 위험도: ${item.riskLevel})`);

  return `
    <section class="report-preview" aria-label="Korean TBM report preview">
      <h2>TBM 보고서 미리보기</h2>
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
          <dt>근로자 공유 여부</dt>
          <dd>${state.session.sharing.sharedWithWorkers ? '공유 완료' : '미공유'}</dd>
        </div>
      </dl>

      <section>
        <h3>참석 근로자</h3>
        <ul>${formatKoreanList(
          presentWorkers.map((worker) => `${worker.name} (${worker.role})`),
          '참석 근로자 없음'
        )}</ul>
      </section>

      <section>
        <h3>주요 유해위험요인</h3>
        <ul>${formatKoreanList(hazardLines, '등록된 유해위험요인 없음')}</ul>
      </section>

      <section>
        <h3>수기 입력 유해위험요인</h3>
        <ul>${formatKoreanList(manualHazardLines, '수기 입력 유해위험요인 없음')}</ul>
      </section>

      <section>
        <h3>아차사고 기록</h3>
        <ul>${formatKoreanList(nearMissLines, '아차사고 기록 없음')}</ul>
      </section>

      <section>
        <h3>확인 완료 항목</h3>
        <ul>${formatKoreanList(
          confirmed.map((item) => item.title),
          '확인 완료 항목 없음'
        )}</ul>
      </section>

      <section>
        <h3>조치 필요 항목</h3>
        <ul>${formatKoreanList(
          fixOrdered.map((item) => `${item.title} - ${item.recommendedAction}`),
          '조치 필요 항목 없음'
        )}</ul>
      </section>

      <section>
        <h3>미확인 항목</h3>
        <ul>${formatKoreanList(
          unchecked.map((item) => item.title),
          '미확인 항목 없음'
        )}</ul>
      </section>
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

async function saveCurrentSession() {
  if (state.isSavingSession) return;

  state.isSavingSession = true;
  state.saveFeedback = 'Saving session...';
  render();

  try {
    const response = await apiFetch('/api/sessions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(buildSessionLog())
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(payload.error ?? `Save failed (${response.status})`);
    }

    state.saveFeedback = 'Session saved locally.';
    await loadSavedSessions({ silent: true });
  } catch (error) {
    state.saveFeedback = getApiErrorMessage(error, 'Save session failed.');
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

    state.savedSessions = Array.isArray(payload) ? payload : [];
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
  state.phase = state.session.completedAt ? 'summary' : 'start';
  render();
}

function openSessionReport(sessionId) {
  if (!sessionId) return;
  window.open(`/api/sessions/${encodeURIComponent(sessionId)}/report`, '_blank', 'noopener');
}

function buildSessionLog() {
  const exportedAt = new Date().toISOString();
  const completedAt = state.session.completedAt ?? (state.phase === 'summary' ? exportedAt : null);

  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId: state.session.sessionId,
    sessionType: 'korean_tbm_risk_assessment',
    status: getSessionStatus(),
    createdAt: state.session.createdAt,
    startedAt: state.session.startedAt,
    completedAt,
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
    workers: state.workers.map((worker) => ({
      name: worker.name,
      role: worker.role,
      present: worker.present,
      acknowledged: worker.acknowledged
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
      status: toExportHazardStatus(item.status),
      memo: item.memo,
      humanReview: getHumanReview(item),
      correctiveAction: getCorrectiveAction(item)
    })),
    nearMisses: state.nearMisses.map((item) => ({
      ...item,
      evidencePhotos: item.evidencePhotos ?? []
    })),
    workerFeedback: [],
    sharing: state.session.sharing,
    device: state.session.device
  };
}

function renderAuthChecking() {
  app.innerHTML = `
    <section class="v2-screen is-auth auth-shell">
      <div class="auth-brand-large">
        ${v2Logo()}
        <p>Worksite Awareness. Safer Outcomes.</p>
      </div>
      <section class="v2-card v2-loading-card">
        ${v2Icon()}
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
        <button class="focusable ${!isRegister ? 'is-active' : ''}" data-action="auth-login" type="button">${v2Icon()} Login</button>
        <button class="focusable ${isRegister ? 'is-active' : ''}" data-action="auth-register" type="button">${v2Icon()} Register</button>
      </section>

      <form class="v2-card auth-form" id="auth-form">
        ${
          isRegister
            ? `
              <div class="auth-field">
                ${v2Icon()}
                <label>
                  <span>Name</span>
                  <input class="focusable" name="name" autocomplete="name" placeholder="Your name" />
                </label>
              </div>
            `
            : ''
        }
        <div class="auth-field">
          ${v2Icon()}
          <label>
            <span>Email</span>
            <input class="focusable" name="email" type="email" autocomplete="email" placeholder="name@company.com" required />
          </label>
        </div>
        <div class="auth-field">
          ${v2Icon()}
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
                ${v2Icon()}
                <label>
                  <span>Role</span>
                  <input class="focusable" name="role" value="supervisor" />
                </label>
              </div>
              <div class="auth-field">
                ${v2Icon()}
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
        ${v2Icon()}
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

function renderStart() {
  app.innerHTML = `
    <section class="v2-screen">
      ${v2Header('Start TBM', 1, Math.max(state.hazards.length || 8, 1))}
      <section class="v2-card v2-form-card" aria-label="TBM session details">
        <div class="v2-screen-intro">
          <div class="v2-warning-tile">▶</div>
          <div>
            <h2>Start TBM</h2>
            <p>Kick off a Toolbox Meeting to promote safety and alignment.</p>
          </div>
        </div>
        <div class="v2-form-grid">
          <label class="v2-field-row">
            ${v2Icon()}
            <span>Site name</span>
            <input class="focusable" name="siteName" value="${escapeHtml(state.session.siteName)}" />
          </label>
          <label class="v2-field-row">
            ${v2Icon()}
            <span>Task name</span>
            <input class="focusable" name="taskName" value="${escapeHtml(state.session.taskName)}" />
          </label>
          <label class="v2-field-row">
            ${v2Icon()}
            <span>Supervisor</span>
            <input class="focusable" name="supervisorName" value="${escapeHtml(state.session.supervisorName)}" />
          </label>
          <div class="v2-field-row">
            ${v2Icon()}
            <span>Date / time</span>
            <strong>${escapeHtml(formatDateTime(state.session.scheduledAt))}</strong>
          </div>
        </div>
        <button class="focusable v2-key-button v2-key-primary v2-full-button" data-action="start">▶ Start TBM</button>
      </section>

      <section class="v2-action-row v2-action-row-nav">
        <button class="focusable v2-key-button" type="button" disabled>← Previous</button>
        <button class="focusable v2-key-button" type="button" disabled>＋ Log New Hazard</button>
        <button class="focusable v2-key-button v2-key-primary" data-action="start">Start TBM</button>
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

  app.innerHTML = `
    <section class="v2-screen">
      ${v2Header('Worker Participation', 3, Math.max(state.hazards.length || 8, 3))}
      <section class="v2-card v2-participation-card">
        <div class="v2-section-heading">
          <h2>Worker Attendance</h2>
          <p>Add workers below and mark who is present for this briefing.</p>
        </div>

        <form class="v2-add-worker" id="add-worker-form">
          <div class="v2-input-with-icon">
            ${v2Icon()}
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
                  <label class="v2-worker-check">
                    <input class="focusable" type="checkbox" data-worker="${escapeHtml(worker.id)}" ${
                      worker.present ? 'checked' : ''
                    } />
                    <span class="v2-avatar">${escapeHtml(initials)}</span>
                    <strong>${escapeHtml(worker.name)}</strong>
                    <em>${escapeHtml(worker.role)}</em>
                  </label>
                  <button class="focusable v2-key-button v2-key-small" data-action="remove-worker" data-worker="${escapeHtml(
                    worker.id
                  )}">Remove</button>
                </div>
              `;
            })
            .join('')}
        </section>

        <p class="v2-attendance-count"><strong>${presentCount}</strong> of ${state.workers.length} workers marked present</p>
      </section>

      <section class="v2-action-row">
        <button class="focusable v2-key-button" data-action="mark-all">Mark All Present</button>
        <button class="focusable v2-key-button v2-key-primary" data-action="continue">Continue →</button>
      </section>
    </section>
  `;

  app.querySelector('#add-worker-form').addEventListener('submit', (event) => {
    event.preventDefault();
    addWorker(app.querySelector('#worker-name').value);
  });

  app.querySelectorAll('input[data-worker]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => setWorkerPresent(checkbox.dataset.worker, checkbox.checked));
  });

  bindButtons();
}

function renderManualEntry() {
  app.innerHTML = `
    <section class="v2-screen">
      ${v2Header('Log New Hazard', 1, 3, 'Details')}

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
              ${v2Icon()}
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

      <section class="v2-action-row v2-action-row-nav">
        <button class="focusable v2-key-button" data-action="cancel-manual">← Cancel</button>
        <button class="focusable v2-key-button" type="button" disabled>Save Draft</button>
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

function renderChecklist() {
  const hazard = currentHazard();
  const response = currentResponse();
  const statusTone = response.status === 'Fix Ordered' ? 'warning' : response.status ? 'danger' : 'neutral';

  app.innerHTML = `
    <section class="v2-screen">
      ${v2Header('TBM Checklist', state.index + 1, state.hazards.length)}
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
          <div class="v2-detail-row">${v2Icon()}<p>Location</p><strong>${escapeHtml(hazard.location)}</strong></div>
          <div class="v2-detail-row">${v2Icon()}<p>Risk Level</p><strong>${escapeHtml(hazard.riskLevel ?? response.riskLevel ?? 'medium')}</strong></div>
          <div class="v2-detail-row">${v2Icon()}<p>Category</p><strong>${escapeHtml(hazard.category ?? response.category ?? 'general')}</strong></div>
          <div class="v2-detail-row">${v2Icon()}<p>Risk</p><strong>${escapeHtml(hazard.risk)}</strong></div>
          <div class="v2-detail-row">${v2Icon()}<p>Recommended Action</p><strong>${escapeHtml(hazard.action)}</strong></div>
        </div>
      </section>

      <section class="v2-card v2-memo-card">
        <label for="memo">Memo <span>Optional</span></label>
        <textarea id="memo" class="v2-textarea focusable" rows="2" maxlength="220" placeholder="Add notes, details, or follow-up actions...">${escapeHtml(
        state.memo
      )}</textarea>
      </section>

      <section class="v2-action-row" aria-label="Checklist actions">
        <button class="focusable v2-key-button v2-key-primary" data-action="confirmed">✓ Confirmed</button>
        <button class="focusable v2-key-button" data-action="fix">Fix Ordered</button>
      </section>

      <section class="v2-action-row v2-action-row-nav" aria-label="Navigation">
        <button class="focusable v2-key-button" data-action="prev">← Previous</button>
        <button class="focusable v2-key-button" data-action="log-new">＋ Log New Hazard</button>
        <button class="focusable v2-key-button" data-action="next">Next →</button>
      </section>
    </section>
  `;

  app.querySelector('#memo').addEventListener('input', (event) => saveMemo(event.target.value));
  bindButtons();
}

function renderSummary() {
  const confirmed = state.responses.filter((item) => item.status === 'Confirmed').length;
  const fixOrdered = state.responses.filter((item) => item.status === 'Fix Ordered').length;
  const saveButtonText = state.isSavingSession ? 'Saving...' : 'Save Session';

  app.innerHTML = `
    <section class="v2-screen">
      ${v2Header('TBM Complete', state.hazards.length, state.hazards.length)}
      <section class="v2-card v2-summary-card">
        <div class="v2-summary-hero">
          <div class="v2-success-tile">✓</div>
          <div>
            <h2>TBM Complete</h2>
            <p>Great work. Your TBM has been completed.</p>
          </div>
          ${v2StatusChip('Status', getSessionStatus(), 'success')}
        </div>

        <div class="v2-summary-stats">
          <div class="v2-stat-card">
            <div class="v2-warning-tile">✓</div>
            <p>Confirmed</p>
            <strong>${confirmed}</strong>
            <span>Hazards confirmed</span>
          </div>
          <div class="v2-stat-card">
            <div class="v2-warning-tile">□</div>
            <p>Fix Ordered</p>
            <strong>${fixOrdered}</strong>
            <span>Hazards to be fixed</span>
          </div>
        </div>

        <section class="v2-report-preview">
          <h3>Report Preview</h3>
          ${buildKoreanReportHtml()}
        </section>
      </section>
      ${state.saveFeedback ? `<p class="save-feedback">${escapeHtml(state.saveFeedback)}</p>` : ''}
      <div class="v2-action-grid">
        <button class="focusable v2-key-button v2-key-primary" data-action="review">Review</button>
        <button class="focusable v2-key-button" data-action="log-new">＋ Log New Hazard</button>
        <button class="focusable v2-key-button" data-action="save-session" ${
          state.isSavingSession ? 'disabled' : ''
        }>${saveButtonText}</button>
        <button class="focusable v2-key-button" data-action="saved-sessions">Saved Sessions</button>
        <button class="focusable v2-key-button" data-action="copy">Copy JSON</button>
      </div>
    </section>
  `;

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
              ${v2Icon()}
              <div class="v2-session-date">
                <strong>${escapeHtml(formatSavedSessionDate(session))}</strong>
                <span>${escapeHtml(session.status ?? 'unknown')}</span>
              </div>
              <div class="v2-session-site">
                ${v2Icon()}
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
      ${v2Header('Saved Sessions', 2, Math.max(state.hazards.length || 8, 2))}
      <section class="v2-card v2-saved-card" aria-label="Saved TBM sessions">
        <div class="v2-section-heading v2-section-heading-row">
          <div>
            <h2>Saved Sessions</h2>
            <p>You have ${state.savedSessions.length} saved session${state.savedSessions.length === 1 ? '' : 's'}.</p>
          </div>
          <button class="focusable v2-key-button v2-key-small" data-action="refresh-saved">Newest First</button>
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

function bindButtons() {
  app.querySelectorAll('button[data-action]').forEach((button) => {
    button.addEventListener('click', () => {
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
      if (action === 'logout') logout();
      if (action === 'retry') loadHazards();
      if (action === 'start') startTbm();
      if (action === 'remove-worker') removeWorker(button.dataset.worker);
      if (action === 'mark-all') markAllPresent();
      if (action === 'continue') continueToChecklist();
      if (action === 'log-new') openManualEntry();
      if (action === 'cancel-manual') cancelManualEntry();
      if (action === 'prev') goTo(state.index - 1);
      if (action === 'next') goTo(state.index + 1);
      if (action === 'confirmed') setStatus('Confirmed');
      if (action === 'fix') setStatus('Fix Ordered');
      if (action === 'review') continueToChecklist();
      if (action === 'copy') copySessionLog(button);
      if (action === 'save-session') saveCurrentSession();
      if (action === 'saved-sessions') openSavedSessions();
      if (action === 'back-from-saved') closeSavedSessions();
      if (action === 'refresh-saved') loadSavedSessions().then(render);
      if (action === 'open-report') openSessionReport(button.dataset.session);
      if (action === 'analyze-photo') analyzeManualPhoto(app.querySelector('#manual-entry-form'));
    });
  });
}

function render() {
  if (state.phase === 'auth-check') renderAuthChecking();
  if (state.phase === 'auth') renderAuth();
  if (state.phase === 'loading') renderLoading();
  if (state.phase === 'error') renderError();
  if (state.phase === 'start') renderStart();
  if (state.phase === 'participation') renderParticipation();
  if (state.phase === 'manual-entry') renderManualEntry();
  if (state.phase === 'checklist') renderChecklist();
  if (state.phase === 'summary') renderSummary();
  if (state.phase === 'saved-sessions') renderSavedSessions();
}

window.addEventListener('keydown', (event) => {
  if (event.target.matches('input, textarea')) return;
  if (state.phase !== 'checklist') return;

  if (event.key === 'ArrowRight') goTo(state.index + 1);
  if (event.key === 'ArrowLeft') goTo(state.index - 1);
  if (event.key === '1') setStatus('Confirmed');
  if (event.key === '2') setStatus('Fix Ordered');
});

checkAuth();
