import './styles.css';

const stressMemo =
  'Long memo stress test: crew reported this needs barricades, signage, owner assignment, and follow-up before restart. This text should wrap and scroll inside the memo field without pushing buttons over other content.';

const isStressTest = new URLSearchParams(window.location.search).has('stress');

const state = {
  phase: 'loading',
  hazards: [],
  index: 0,
  memo: isStressTest ? stressMemo : '',
  session: {
    siteName: 'Seoul Site A',
    taskName: 'Morning TBM / Risk Assessment',
    supervisorName: 'Kim Supervisor',
    scheduledAt: new Date(),
    startedAt: null
  },
  workers: [
    { id: crypto.randomUUID(), name: 'Park Minjun', present: false },
    { id: crypto.randomUUID(), name: 'Lee Jisoo', present: false },
    { id: crypto.randomUUID(), name: 'Choi Hana', present: false }
  ],
  responses: []
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
    hazardId: hazard.id,
    hazard: hazard.name,
    location: hazard.location,
    risk: hazard.risk,
    requiredAction: hazard.action,
    status: null,
    memo: isStressTest ? stressMemo : '',
    updatedAt: null
  }));
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
    present: true
  });
  render();
}

function removeWorker(id) {
  state.workers = state.workers.filter((worker) => worker.id !== id);
  render();
}

function setWorkerPresent(id, present) {
  const worker = state.workers.find((item) => item.id === id);
  if (worker) worker.present = present;
}

function markAllPresent() {
  state.workers = state.workers.map((worker) => ({ ...worker, present: true }));
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
  response.status = status;
  response.memo = state.memo.trim();
  response.updatedAt = new Date().toISOString();

  if (state.index === state.hazards.length - 1) {
    state.phase = 'summary';
  } else {
    state.index += 1;
    state.memo = currentResponse().memo;
  }

  render();
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
  return {
    app: 'Safety Lens',
    mode: 'TBM Checklist',
    siteName: state.session.siteName,
    taskName: state.session.taskName,
    supervisorName: state.session.supervisorName,
    scheduledAt: state.session.scheduledAt.toISOString(),
    sessionStartTime: state.session.startedAt,
    completedAt: new Date().toISOString(),
    workers: state.workers.map((worker) => ({
      id: worker.id,
      name: worker.name,
      present: worker.present
    })),
    hazardsReviewed: state.responses.filter((item) => item.status).length,
    totalHazards: state.hazards.length,
    hazards: state.responses
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
  `;

  app.querySelector('#memo').addEventListener('input', (event) => saveMemo(event.target.value));
  bindButtons();
}

function renderSummary() {
  const confirmed = state.responses.filter((item) => item.status === 'Confirmed').length;
  const fixOrdered = state.responses.filter((item) => item.status === 'Fix Ordered').length;
  const present = state.workers.filter((worker) => worker.present).length;

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
      <ol class="log-list">
        <li>
          <strong>${escapeHtml(state.session.siteName)}</strong>
          <span>${escapeHtml(state.session.taskName)} / Present ${present} of ${state.workers.length}</span>
        </li>
        ${state.responses
          .map(
            (item) => `
              <li>
                <strong>${escapeHtml(item.hazard)}</strong>
                <span>${escapeHtml(item.status ?? 'Not marked')}</span>
              </li>
            `
          )
          .join('')}
      </ol>
      <div class="button-grid summary-actions">
        <button class="focusable" data-action="review">Review</button>
        <button class="focusable primary" data-action="copy">Copy JSON</button>
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
