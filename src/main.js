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

function buildUserBadge() {
  if (!state.currentUser) return '';

  return `
    <section class="user-badge" aria-label="Logged in user">
      <span>${escapeHtml(state.currentUser.name)} / ${escapeHtml(state.currentUser.role)}</span>
      <button class="focusable small-button" data-action="logout">Logout</button>
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
    <section class="ai-suggestion-card ${state.manualAiDecision ? `is-${state.manualAiDecision}` : ''}" aria-label="Mock AI Suggestion">
      <p class="eyebrow">Mock AI Suggestion</p>
      <h2>${escapeHtml(suggestion.title)}</h2>
      <dl>
        <div><dt>Category</dt><dd>${escapeHtml(suggestion.category)}</dd></div>
        <div><dt>Risk</dt><dd>${escapeHtml(suggestion.riskLevel)}</dd></div>
        <div><dt>Confidence</dt><dd>${confidencePercent}</dd></div>
        <div><dt>Status</dt><dd>${decisionText}</dd></div>
      </dl>
      <p class="ai-review-note">Human review required before this suggestion can affect the saved TBM record.</p>
      <p>${escapeHtml(suggestion.description)}</p>
      <p>${escapeHtml(suggestion.recommendedAction)}</p>
      <section class="button-grid ai-suggestion-actions">
        <button class="focusable small-button" type="button" data-action="accept-ai">Accept Suggestion</button>
        <button class="focusable small-button" type="button" data-action="reject-ai">Reject Suggestion</button>
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
    <section class="flow-screen center-screen">
      <p class="eyebrow">Safety Lens</p>
      <h1>Checking Login</h1>
      <p class="helper-text">Preparing protected local access...</p>
    </section>
  `;
}

function renderAuth() {
  const isRegister = state.authMode === 'register';
  const submitText = state.isAuthSubmitting ? 'Please wait...' : isRegister ? 'Register' : 'Login';

  app.innerHTML = `
    <section class="flow-screen auth-screen">
      <header class="flow-header compact-header">
        <p class="eyebrow">Safety Lens</p>
        <p class="mode">${isRegister ? 'Register' : 'Login'}</p>
      </header>

      <section class="button-grid auth-tabs" aria-label="Authentication mode">
        <button class="focusable ${!isRegister ? 'primary' : ''}" data-action="auth-login">Login</button>
        <button class="focusable ${isRegister ? 'primary' : ''}" data-action="auth-register">Register</button>
      </section>

      <form class="form-panel auth-form" id="auth-form">
        ${
          isRegister
            ? `
              <label>
                <span>Name</span>
                <input class="focusable" name="name" autocomplete="name" />
              </label>
            `
            : ''
        }
        <label>
          <span>Email</span>
          <input class="focusable" name="email" type="email" autocomplete="email" required />
        </label>
        <label>
          <span>Password</span>
          <input class="focusable" name="password" type="password" autocomplete="${
            isRegister ? 'new-password' : 'current-password'
          }" minlength="8" required />
        </label>
        ${
          isRegister
            ? `
              <label>
                <span>Role</span>
                <input class="focusable" name="role" value="supervisor" />
              </label>
              <label>
                <span>Registration key</span>
                <input class="focusable" name="registrationKey" type="password" required />
              </label>
            `
            : ''
        }
        <p class="save-feedback">${escapeHtml(state.authFeedback)}</p>
      </form>

      <button class="focusable primary full-action" form="auth-form" type="submit" ${
        state.isAuthSubmitting ? 'disabled' : ''
      }>${submitText}</button>
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
    <section class="flow-screen center-screen">
      <p class="eyebrow">Safety Lens</p>
      <h1>Loading TBM</h1>
      <p class="helper-text">Loading hazard controls...</p>
    </section>
  `;
}

function renderError() {
  app.innerHTML = `
    <section class="flow-screen center-screen">
      <p class="eyebrow">Safety Lens</p>
      <h1>Hazards unavailable</h1>
      <p class="helper-text">${escapeHtml(state.error)}</p>
      <button class="focusable primary" data-action="retry">Retry</button>
    </section>
  `;
  bindButtons();
}

function renderStart() {
  app.innerHTML = `
    <section class="flow-screen">
      <header class="flow-header">
        <p class="eyebrow">Safety Lens</p>
        <h1>Start TBM</h1>
      </header>
      ${buildUserBadge()}

      <section class="form-panel" aria-label="TBM session details">
        <label>
          <span>Site name</span>
          <input class="focusable" name="siteName" value="${escapeHtml(state.session.siteName)}" />
        </label>
        <label>
          <span>Task name</span>
          <input class="focusable" name="taskName" value="${escapeHtml(state.session.taskName)}" />
        </label>
        <label>
          <span>Supervisor</span>
          <input class="focusable" name="supervisorName" value="${escapeHtml(state.session.supervisorName)}" />
        </label>
        <div class="readonly-field">
          <span>Date / time</span>
          <strong>${escapeHtml(formatDateTime(state.session.scheduledAt))}</strong>
        </div>
      </section>

      <button class="focusable primary full-action" data-action="start">Start TBM</button>
    </section>
  `;

  app.querySelectorAll('input[name]').forEach((input) => {
    input.addEventListener('input', (event) => saveStartField(input.name, event.target.value));
  });
  bindButtons();
}

function renderParticipation() {
  app.innerHTML = `
    <section class="flow-screen participation-screen">
      <header class="flow-header compact-header">
        <p class="eyebrow">Worker Participation</p>
        <p class="mode">${escapeHtml(state.session.taskName)}</p>
      </header>
      ${buildUserBadge()}

      <form class="add-worker" id="add-worker-form">
        <input class="focusable" id="worker-name" autocomplete="off" placeholder="Add worker name" />
        <button class="focusable" type="submit">Add</button>
      </form>

      <section class="worker-list" aria-label="Attendance list">
        ${state.workers
          .map(
            (worker) => `
              <div class="worker-row">
                <label class="worker-check">
                  <input class="focusable" type="checkbox" data-worker="${escapeHtml(worker.id)}" ${
                    worker.present ? 'checked' : ''
                  } />
                  <span>${escapeHtml(worker.name)}</span>
                </label>
                <button class="focusable small-button" data-action="remove-worker" data-worker="${escapeHtml(
                  worker.id
                )}">Remove</button>
              </div>
            `
          )
          .join('')}
      </section>

      <section class="button-grid participation-actions">
        <button class="focusable" data-action="mark-all">Mark All Present</button>
        <button class="focusable primary" data-action="continue">Continue</button>
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
    <section class="flow-screen manual-entry-screen">
      <header class="flow-header compact-header">
        <p class="eyebrow">Safety Lens</p>
        <p class="mode">Log New Hazard</p>
      </header>
      ${buildUserBadge()}

      <form class="form-panel manual-entry-form" id="manual-entry-form">
        <p class="helper-text">Browser prototype / voice transcript placeholder</p>

        <label>
          <span>Type</span>
          <select class="focusable" name="type">
            <option value="new_hazard">new_hazard</option>
            <option value="near_miss">near_miss</option>
          </select>
        </label>

        <label>
          <span>Category</span>
          <input class="focusable" name="category" maxlength="80" value="manual_entry" />
        </label>

        <label>
          <span>Title - browser prototype / voice transcript placeholder</span>
          <input class="focusable" name="title" maxlength="120" placeholder="Example: Temporary ladder blocked" required />
        </label>

        <label>
          <span>Location - browser prototype / voice transcript placeholder</span>
          <input class="focusable" name="location" maxlength="120" placeholder="Example: Level 2 west stair" required />
        </label>

        <label>
          <span>Risk level</span>
          <select class="focusable" name="riskLevel">
            <option value="low">low</option>
            <option value="medium" selected>medium</option>
            <option value="high">high</option>
          </select>
        </label>

        <label>
          <span>Description - browser prototype / voice transcript placeholder</span>
          <textarea class="memo focusable flexible-memo" name="description" maxlength="260" placeholder="Describe what was observed"></textarea>
        </label>

        <label>
          <span>Action taken / recommended action - browser prototype / voice transcript placeholder</span>
          <textarea class="memo focusable flexible-memo" name="actionText" maxlength="260" placeholder="Action taken or recommended action"></textarea>
        </label>

        <label>
          <span>Attach Photo</span>
          <input class="focusable" name="evidencePhotos" type="file" accept="image/jpeg,image/png,image/webp" multiple />
        </label>
        <p class="photo-preview" id="photo-preview">No photo selected</p>
        <button class="focusable small-button" id="analyze-photo-button" data-action="analyze-photo" type="button" hidden disabled>
          Analyze Photo
        </button>
        <div id="ai-suggestion-panel"></div>
        <p class="save-feedback" id="manual-entry-feedback">${escapeHtml(state.manualEntryFeedback)}</p>
      </form>

      <section class="button-grid manual-entry-actions">
        <button class="focusable" data-action="cancel-manual">Cancel</button>
        <button class="focusable primary" form="manual-entry-form" type="submit">Save</button>
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

  app.innerHTML = `
    <section class="topbar">
      <div>
        <p class="eyebrow">Safety Lens</p>
        <p class="mode">Current mode: TBM Checklist</p>
        ${buildUserBadge()}
      </div>
      <p class="progress">${state.index + 1} / ${state.hazards.length}</p>
    </section>

    <section class="hazard-region" aria-label="Current hazard">
      <div class="hazard-card">
        <p class="label">Hazard</p>
        <h2>${escapeHtml(hazard.name)}</h2>
        <p class="location">${escapeHtml(hazard.location)}</p>
        <p class="risk">${escapeHtml(hazard.risk)}</p>
        <p class="action">${escapeHtml(hazard.action)}</p>
        ${response.status ? `<p class="status">Marked: ${escapeHtml(response.status)}</p>` : ''}
      </div>
    </section>

    <section class="memo-region">
      <label class="memo-label" for="memo">Memo</label>
      <textarea id="memo" class="memo focusable" rows="2" maxlength="220" placeholder="Short note...">${escapeHtml(
        state.memo
      )}</textarea>
    </section>

    <section class="button-grid action-grid" aria-label="Checklist actions">
      <button class="focusable primary" data-action="confirmed">Confirmed</button>
      <button class="focusable warning" data-action="fix">Fix Ordered</button>
    </section>

    <section class="button-grid nav-grid" aria-label="Navigation">
      <button class="focusable" data-action="prev">Previous</button>
      <button class="focusable" data-action="next">Next</button>
    </section>

    <button class="focusable log-hazard-button" data-action="log-new">Log New Hazard</button>
  `;

  app.querySelector('#memo').addEventListener('input', (event) => saveMemo(event.target.value));
  bindButtons();
}

function renderSummary() {
  const confirmed = state.responses.filter((item) => item.status === 'Confirmed').length;
  const fixOrdered = state.responses.filter((item) => item.status === 'Fix Ordered').length;
  const saveButtonText = state.isSavingSession ? 'Saving...' : 'Save Session';

  app.innerHTML = `
    <section class="summary">
      <p class="eyebrow">Safety Lens</p>
      ${buildUserBadge()}
      <h1>TBM Complete</h1>
      <div class="summary-grid">
        <div>
          <span>${confirmed}</span>
          <p>Confirmed</p>
        </div>
        <div>
          <span>${fixOrdered}</span>
          <p>Fix Ordered</p>
        </div>
      </div>
      ${buildKoreanReportHtml()}
      ${state.saveFeedback ? `<p class="save-feedback">${escapeHtml(state.saveFeedback)}</p>` : ''}
      <div class="button-grid summary-actions">
        <button class="focusable" data-action="review">Review</button>
        <button class="focusable" data-action="log-new">Log New Hazard</button>
        <button class="focusable primary" data-action="save-session" ${
          state.isSavingSession ? 'disabled' : ''
        }>${saveButtonText}</button>
        <button class="focusable" data-action="saved-sessions">Saved Sessions</button>
        <button class="focusable primary wide-button" data-action="copy">Copy JSON</button>
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
            <li>
              <div>
                <strong>${escapeHtml(formatSavedSessionDate(session))}</strong>
                <span>${escapeHtml(getSavedSessionSiteName(session))}</span>
                <em>${escapeHtml(session.status ?? 'unknown')}</em>
              </div>
              <button class="focusable small-button" data-action="open-report" data-session="${escapeHtml(
                session.sessionId
              )}">Open Report</button>
            </li>
          `
        )
        .join('')
    : '<li><strong>No saved sessions</strong><span>Start by saving a completed TBM.</span><em>empty</em></li>';

  app.innerHTML = `
    <section class="flow-screen saved-sessions-screen">
      <header class="flow-header compact-header">
        <p class="eyebrow">Safety Lens</p>
        <p class="mode">Saved Sessions</p>
        <p class="helper-text">${state.savedSessions.length} saved session${
          state.savedSessions.length === 1 ? '' : 's'
        }</p>
      </header>
      ${buildUserBadge()}

      <section class="saved-session-panel" aria-label="Saved TBM sessions">
        ${
          state.savedSessionsStatus === 'loading'
            ? '<p class="helper-text">Loading saved sessions...</p>'
            : state.savedSessionsStatus === 'error'
              ? `<p class="helper-text">${escapeHtml(state.savedSessionsError)}</p>`
              : `<ul class="saved-session-list">${sessionsHtml}</ul>`
        }
      </section>

      <section class="button-grid saved-session-actions">
        <button class="focusable" data-action="back-from-saved">Back</button>
        <button class="focusable primary" data-action="refresh-saved">Refresh</button>
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
