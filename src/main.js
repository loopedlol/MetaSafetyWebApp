import './styles.css';

const SCHEMA_VERSION = '1.0.0';
const APP_VERSION = '0.1.0';

const stressMemo =
  'Long memo stress test: crew reported this needs barricades, signage, owner assignment, and follow-up before restart. This text should wrap and scroll inside the memo field without pushing buttons over other content.';

const isStressTest = new URLSearchParams(window.location.search).has('stress');

const state = {
  phase: 'loading',
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
  returnPhase: 'checklist'
};

const app = document.querySelector('#app');

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
    category: 'manual_entry',
    location: entry.location,
    riskLevel: entry.riskLevel,
    riskDescription: entry.description,
    recommendedAction: entry.recommendedAction,
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
    state.error = error.message;
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
  state.phase = 'manual-entry';
  render();
}

function cancelManualEntry() {
  state.phase = state.returnPhase;
  render();
}

function saveManualEntry(form) {
  const formData = new FormData(form);
  const type = formData.get('type');
  const now = new Date().toISOString();
  const title = String(formData.get('title') ?? '').trim();
  const location = String(formData.get('location') ?? '').trim();
  const riskLevel = String(formData.get('riskLevel') ?? 'medium');
  const description = String(formData.get('description') ?? '').trim();
  const actionText = String(formData.get('actionText') ?? '').trim();

  if (!title || !location) return;

  if (type === 'near_miss') {
    state.nearMisses.push({
      id: crypto.randomUUID(),
      source: 'near_miss',
      title,
      location,
      riskLevel,
      description,
      actionTaken: actionText,
      reportedBy: state.session.supervisorName,
      reportedAt: now
    });
  } else {
    const hazard = {
      id: crypto.randomUUID(),
      name: title,
      source: 'manual_entry',
      category: 'manual_entry',
      location,
      riskLevel,
      risk: description,
      action: actionText
    };
    state.hazards.push(hazard);
    state.responses.push(
      createManualHazardResponse({
        id: hazard.id,
        title,
        location,
        riskLevel,
        description,
        recommendedAction: actionText
      })
    );
  }

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
      status: toExportHazardStatus(item.status),
      memo: item.memo,
      humanReview: getHumanReview(item),
      correctiveAction: getCorrectiveAction(item)
    })),
    nearMisses: state.nearMisses,
    workerFeedback: [],
    sharing: state.session.sharing,
    device: state.session.device
  };
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
      </form>

      <section class="button-grid manual-entry-actions">
        <button class="focusable" data-action="cancel-manual">Cancel</button>
        <button class="focusable primary" form="manual-entry-form" type="submit">Save</button>
      </section>
    </section>
  `;

  app.querySelector('#manual-entry-form').addEventListener('submit', (event) => {
    event.preventDefault();
    saveManualEntry(event.currentTarget);
  });
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

  app.innerHTML = `
    <section class="summary">
      <p class="eyebrow">Safety Lens</p>
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
      <div class="button-grid summary-actions">
        <button class="focusable" data-action="review">Review</button>
        <button class="focusable" data-action="log-new">Log New Hazard</button>
        <button class="focusable primary wide-button" data-action="copy">Copy JSON</button>
      </div>
    </section>
  `;

  bindButtons();
}

function bindButtons() {
  app.querySelectorAll('button[data-action]').forEach((button) => {
    button.addEventListener('click', () => {
      const action = button.dataset.action;

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
    });
  });
}

function render() {
  if (state.phase === 'loading') renderLoading();
  if (state.phase === 'error') renderError();
  if (state.phase === 'start') renderStart();
  if (state.phase === 'participation') renderParticipation();
  if (state.phase === 'manual-entry') renderManualEntry();
  if (state.phase === 'checklist') renderChecklist();
  if (state.phase === 'summary') renderSummary();
}

window.addEventListener('keydown', (event) => {
  if (event.target.matches('input, textarea')) return;
  if (state.phase !== 'checklist') return;

  if (event.key === 'ArrowRight') goTo(state.index + 1);
  if (event.key === 'ArrowLeft') goTo(state.index - 1);
  if (event.key === '1') setStatus('Confirmed');
  if (event.key === '2') setStatus('Fix Ordered');
});

loadHazards();
