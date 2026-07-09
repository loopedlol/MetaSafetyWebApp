// ---------------------------------------------------------------------------
// Imports / config
// ---------------------------------------------------------------------------

import express from 'express';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

loadEnvFile();

const PORT = process.env.PORT ?? 3001;
const HOST = process.env.HOST ?? '127.0.0.1';
const REGISTRATION_KEY = process.env.REGISTRATION_KEY;
const SESSION_SECRET = process.env.SESSION_SECRET ?? 'change-me-session-secret';
const AI_MODE = process.env.AI_MODE ?? 'mock';

// ---------------------------------------------------------------------------
// Storage paths and constants
// ---------------------------------------------------------------------------

const DATA_DIR = path.join(__dirname, 'data');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const REQUIRED_FIELDS = ['sessionId', 'sessionType', 'site', 'work', 'supervisor', 'workers', 'hazards'];
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const IMAGE_EXTENSIONS = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp'
};

// ---------------------------------------------------------------------------
// Express app setup
// ---------------------------------------------------------------------------

const app = express();

mkdirSync(UPLOADS_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Upload setup
// ---------------------------------------------------------------------------

const upload = multer({
  storage: multer.diskStorage({
    destination: (_request, _file, callback) => {
      callback(null, UPLOADS_DIR);
    },
    filename: (_request, file, callback) => {
      const id = randomUUID();
      file.uploadId = id;
      file.uploadedAt = new Date().toISOString();
      callback(null, `${id}${IMAGE_EXTENSIONS[file.mimetype]}`);
    }
  }),
  limits: {
    fileSize: 5 * 1024 * 1024
  },
  fileFilter: (_request, file, callback) => {
    if (!ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
      callback(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
      return;
    }

    callback(null, true);
  }
});

app.use(express.json({ limit: '1mb' }));
app.use('/uploads', express.static(UPLOADS_DIR));

// ---------------------------------------------------------------------------
// File / data helpers
// ---------------------------------------------------------------------------

function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!existsSync(envPath)) return;

  const envLines = readFileSync(envPath, 'utf8').split(/\r?\n/);
  envLines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) return;

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim().replace(/^["']|["']$/g, '');
    if (key && process.env[key] == null) process.env[key] = value;
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function normalizeEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Auth / session helpers
// ---------------------------------------------------------------------------

function toPublicUser(user) {
  if (!user) return null;

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role
  };
}

function parseCookies(cookieHeader = '') {
  return Object.fromEntries(
    cookieHeader
      .split(';')
      .map((cookie) => cookie.trim())
      .filter(Boolean)
      .map((cookie) => {
        const separatorIndex = cookie.indexOf('=');
        if (separatorIndex === -1) return [cookie, ''];
        return [cookie.slice(0, separatorIndex), decodeURIComponent(cookie.slice(separatorIndex + 1))];
      })
  );
}

function signValue(value) {
  return createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}

function verifySignature(value, signature) {
  const expected = signValue(value);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return signatureBuffer.length === expectedBuffer.length && timingSafeEqual(signatureBuffer, expectedBuffer);
}

function createSessionCookie(userId) {
  const payload = Buffer.from(JSON.stringify({ userId, createdAt: Date.now() })).toString('base64url');
  return `${payload}.${signValue(payload)}`;
}

function getSessionUserId(request) {
  const cookie = parseCookies(request.headers.cookie).safety_lens_session;
  if (!cookie) return null;

  const [payload, signature] = cookie.split('.');
  if (!payload || !signature || !verifySignature(payload, signature)) return null;

  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof session.userId === 'string' ? session.userId : null;
  } catch {
    return null;
  }
}

function setAuthCookie(response, userId) {
  response.cookie('safety_lens_session', createSessionCookie(userId), {
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    maxAge: 1000 * 60 * 60 * 12
  });
}

function clearAuthCookie(response) {
  response.clearCookie('safety_lens_session', {
    httpOnly: true,
    sameSite: 'lax',
    secure: false
  });
}

// ---------------------------------------------------------------------------
// Report rendering helpers
// ---------------------------------------------------------------------------

function formatReportDate(value) {
  if (!value) return '미입력';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '미입력';

  return new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function formatReportValue(value) {
  const text = String(value ?? '').trim();
  return text ? escapeHtml(text) : '미입력';
}

function renderRows(items, columns, emptyText) {
  if (!items.length) {
    return `<tr><td colspan="${columns.length}" class="empty">${escapeHtml(emptyText)}</td></tr>`;
  }

  return items
    .map(
      (item, index) => `
        <tr>
          ${columns
            .map((column) => `<td>${column.render ? column.render(item, index) : formatReportValue(item[column.key])}</td>`)
            .join('')}
        </tr>
      `
    )
    .join('');
}

function renderEvidencePhotos(item) {
  const photos = Array.isArray(item.evidencePhotos) ? item.evidencePhotos : [];
  if (!photos.length) return '<span class="empty">사진 없음</span>';

  return `
    <div class="photo-grid">
      ${photos
        .map((photo, index) => {
          const isMockEvidence = photo.source === 'glasses_mock_capture' || String(photo.url ?? '').startsWith('data:');
          const mockLabel = isMockEvidence ? ' (Glasses HUD mock photo - prototype evidence)' : '';
          return `
            <figure>
              <img src="${escapeHtml(photo.url)}" alt="${formatReportValue(photo.originalName ?? `Evidence ${index + 1}`)}" />
              <figcaption>${formatReportValue(photo.originalName ?? `사진 ${index + 1}`)}${mockLabel}</figcaption>
            </figure>
          `;
        })
        .join('')}
    </div>
  `;
}

function renderAiSuggestionNote(item) {
  if (!item.aiSuggestion) return '';

  const confidence = Number(item.aiSuggestion.confidence);
  const confidenceText = Number.isFinite(confidence) ? ` / 신뢰도 ${Math.round(confidence * 100)}%` : '';
  const decisionText = item.aiSuggestion.accepted
    ? '작업자가 수락한 참고 의견'
    : item.aiSuggestion.rejected
      ? '작업자가 거부한 참고 의견'
      : '작업자 검토 전 참고 의견';
  return `<p class="ai-note">Mock AI 분석: ${decisionText}${confidenceText}. 공식 기록은 작업자 검토 결과를 기준으로 합니다.</p>`;
}

function renderReportTitle(item) {
  return `${formatReportValue(item.title)}${renderAiSuggestionNote(item)}`;
}

function getHazardStatus(hazard) {
  const status = hazard.status ?? hazard.humanReview?.decision ?? 'not_checked';
  if (status === 'Confirmed' || status === 'accepted') return 'confirmed';
  if (status === 'Fix Ordered') return 'fix_ordered';
  return status;
}

function normalizeAiSuggestion(aiSuggestion) {
  if (!aiSuggestion) return null;

  const accepted = aiSuggestion.accepted === true;
  const rejected = accepted ? false : aiSuggestion.rejected === true;

  return {
    source: aiSuggestion.source ?? 'mock_ai',
    accepted,
    rejected,
    confidence: typeof aiSuggestion.confidence === 'number' ? aiSuggestion.confidence : null,
    suggestedAt: aiSuggestion.suggestedAt ?? null,
    reviewedAt: aiSuggestion.reviewedAt ?? null
  };
}

function normalizeSession(session) {
  return {
    ...session,
    hazards: session.hazards.map((hazard) => ({
      ...hazard,
      evidencePhotos: Array.isArray(hazard.evidencePhotos) ? hazard.evidencePhotos : [],
      aiSuggestion: normalizeAiSuggestion(hazard.aiSuggestion)
    })),
    nearMisses: (session.nearMisses ?? []).map((nearMiss) => ({
      ...nearMiss,
      evidencePhotos: Array.isArray(nearMiss.evidencePhotos) ? nearMiss.evidencePhotos : [],
      aiSuggestion: normalizeAiSuggestion(nearMiss.aiSuggestion)
    }))
  };
}

// ---------------------------------------------------------------------------
// AI mock helpers
// ---------------------------------------------------------------------------

function createMockAiSuggestion(entryType) {
  const suggestedAt = new Date().toISOString();

  if (entryType === 'near_miss') {
    return {
      title: 'Near miss: struck-by risk observed',
      category: 'near_miss_observation',
      riskLevel: 'high',
      description:
        'Photo evidence may indicate a near-miss condition with workers or materials exposed to moving equipment or falling objects.',
      recommendedAction:
        'Pause related work, confirm exclusion zones, brief nearby workers, and document corrective action before restart.',
      confidence: 0.78,
      source: 'mock_ai',
      suggestedAt
    };
  }

  return {
    title: 'Potential blocked access or housekeeping hazard',
    category: 'site_housekeeping',
    riskLevel: 'medium',
    description:
      'Photo evidence may indicate clutter, blocked access, or an unsecured work area that should be reviewed before work continues.',
    recommendedAction:
      'Clear the access path, secure loose materials, add signage or barricades if needed, and verify the area with the supervisor.',
    confidence: 0.74,
    source: 'mock_ai',
    suggestedAt
  };
}

async function analyzeHazardImage({ entryType, photo, photos, imageUrl }) {
  if (AI_MODE === 'mock' || !AI_MODE) {
    return createMockAiSuggestion(entryType);
  }

  // Future real vision providers should preserve this response contract so the
  // frontend and saved-session schema do not need to change.
  throw new Error(`Unsupported AI_MODE "${AI_MODE}". Set AI_MODE=mock until a real provider is implemented.`);
}

function renderSessionReport(session) {
  const presentWorkers = session.workers.filter((worker) => worker.present);
  const confirmedHazards = session.hazards.filter((hazard) => getHazardStatus(hazard) === 'confirmed');
  const fixOrderedHazards = session.hazards.filter((hazard) => getHazardStatus(hazard) === 'fix_ordered');
  const uncheckedHazards = session.hazards.filter((hazard) => getHazardStatus(hazard) === 'not_checked');
  const conductedAt = session.startedAt ?? session.completedAt ?? session.exportedAt ?? session.createdAt;
  const sharedText = session.sharing?.sharedWithWorkers ? '공유 완료' : '미공유';

  const hazardColumns = [
    { key: 'title', label: '항목', render: (hazard) => renderReportTitle(hazard) },
    { key: 'location', label: '위치' },
    { key: 'riskLevel', label: '위험도' },
    { key: 'recommendedAction', label: '권장 조치' },
    { key: 'evidencePhotos', label: '사진 증빙', render: (hazard) => renderEvidencePhotos(hazard) }
  ];

  return `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>TBM 보고서 - ${formatReportValue(session.site?.siteName)}</title>
    <style>
      :root {
        color-scheme: light;
        font-family: "Apple SD Gothic Neo", "Malgun Gothic", Arial, sans-serif;
        color: #111;
        background: #fff;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        background: #f5f5f5;
      }

      main {
        width: min(100%, 960px);
        margin: 0 auto;
        padding: 40px 28px 56px;
        background: #fff;
      }

      header {
        display: flex;
        justify-content: space-between;
        gap: 24px;
        align-items: end;
        padding-bottom: 18px;
        border-bottom: 3px solid #111;
      }

      h1,
      h2,
      p {
        margin: 0;
      }

      h1 {
        font-size: 32px;
        line-height: 1.2;
      }

      h2 {
        margin: 28px 0 10px;
        font-size: 20px;
        line-height: 1.3;
      }

      .meta-note {
        color: #444;
        font-size: 13px;
        text-align: right;
      }

      .summary-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 0;
        margin-top: 22px;
        border-top: 1px solid #222;
        border-left: 1px solid #222;
      }

      .summary-item {
        display: grid;
        grid-template-columns: 130px minmax(0, 1fr);
        border-right: 1px solid #222;
        border-bottom: 1px solid #222;
      }

      .summary-item dt,
      .summary-item dd {
        margin: 0;
        padding: 10px 12px;
        min-width: 0;
        overflow-wrap: anywhere;
      }

      .summary-item dt {
        font-weight: 700;
        background: #f0f0f0;
        border-right: 1px solid #222;
      }

      table {
        width: 100%;
        border-collapse: collapse;
        page-break-inside: avoid;
      }

      th,
      td {
        padding: 9px 10px;
        border: 1px solid #222;
        vertical-align: top;
        text-align: left;
        overflow-wrap: anywhere;
      }

      th {
        background: #f0f0f0;
        font-weight: 700;
      }

      .empty {
        color: #555;
        text-align: center;
      }

      .photo-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
        gap: 10px;
      }

      figure {
        margin: 0;
        page-break-inside: avoid;
      }

      img {
        display: block;
        width: 100%;
        max-height: 140px;
        object-fit: cover;
        border: 1px solid #777;
      }

      figcaption {
        margin-top: 4px;
        color: #444;
        font-size: 12px;
        line-height: 1.25;
        overflow-wrap: anywhere;
      }

      .ai-note {
        margin-top: 6px;
        color: #555;
        font-size: 12px;
        font-weight: 700;
      }

      .print-actions {
        margin-top: 28px;
        text-align: right;
      }

      button {
        padding: 10px 14px;
        border: 1px solid #111;
        background: #111;
        color: #fff;
        font: inherit;
        cursor: pointer;
      }

      @media print {
        body {
          background: #fff;
        }

        main {
          width: 100%;
          padding: 0;
        }

        .print-actions {
          display: none;
        }

        h2 {
          page-break-after: avoid;
        }

        img {
          max-height: 120px;
        }
      }

      @page {
        margin: 18mm;
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div>
          <h1>작업 전 안전회의(TBM) 보고서</h1>
          <p>${formatReportValue(session.work?.taskName)}</p>
        </div>
        <p class="meta-note">Session ID<br />${formatReportValue(session.sessionId)}</p>
      </header>

      <dl class="summary-grid">
        <div class="summary-item"><dt>현장명</dt><dd>${formatReportValue(session.site?.siteName)}</dd></div>
        <div class="summary-item"><dt>작업구역</dt><dd>${formatReportValue(session.site?.siteArea)}</dd></div>
        <div class="summary-item"><dt>작업명</dt><dd>${formatReportValue(session.work?.taskName)}</dd></div>
        <div class="summary-item"><dt>TBM 실시자</dt><dd>${formatReportValue(session.supervisor?.name)} / ${formatReportValue(
          session.supervisor?.role
        )}</dd></div>
        <div class="summary-item"><dt>실시 시간</dt><dd>${formatReportDate(conductedAt)}</dd></div>
        <div class="summary-item"><dt>근로자 공유 여부</dt><dd>${sharedText}</dd></div>
      </dl>

      <section>
        <h2>참석 근로자</h2>
        <table>
          <thead><tr><th>이름</th><th>역할</th><th>확인</th></tr></thead>
          <tbody>${renderRows(
            presentWorkers,
            [
              { key: 'name' },
              { key: 'role' },
              { key: 'acknowledged', render: (worker) => (worker.acknowledged ? '확인' : '미확인') }
            ],
            '참석 근로자 없음'
          )}</tbody>
        </table>
      </section>

      <section>
        <h2>전체 유해위험요인</h2>
        <table>
          <thead><tr>${hazardColumns.map((column) => `<th>${column.label}</th>`).join('')}</tr></thead>
          <tbody>${renderRows(session.hazards, hazardColumns, '등록된 유해위험요인 없음')}</tbody>
        </table>
      </section>

      <section>
        <h2>확인 완료 항목(Confirmed Hazards)</h2>
        <table>
          <thead><tr>${hazardColumns.map((column) => `<th>${column.label}</th>`).join('')}</tr></thead>
          <tbody>${renderRows(confirmedHazards, hazardColumns, '확인 완료 항목 없음')}</tbody>
        </table>
      </section>

      <section>
        <h2>조치 필요 항목(Fix Ordered)</h2>
        <table>
          <thead><tr>${hazardColumns.map((column) => `<th>${column.label}</th>`).join('')}</tr></thead>
          <tbody>${renderRows(fixOrderedHazards, hazardColumns, '조치 필요 항목 없음')}</tbody>
        </table>
      </section>

      <section>
        <h2>미확인 항목(Not Checked)</h2>
        <table>
          <thead><tr>${hazardColumns.map((column) => `<th>${column.label}</th>`).join('')}</tr></thead>
          <tbody>${renderRows(uncheckedHazards, hazardColumns, '미확인 항목 없음')}</tbody>
        </table>
      </section>

      <section>
        <h2>아차사고 및 Near-miss 기록</h2>
        <table>
          <thead><tr><th>항목</th><th>위치</th><th>위험도</th><th>조치 내용</th><th>사진 증빙</th></tr></thead>
          <tbody>${renderRows(
            session.nearMisses ?? [],
            [
              { key: 'title', render: (nearMiss) => renderReportTitle(nearMiss) },
              { key: 'location' },
              { key: 'riskLevel' },
              { key: 'actionTaken' },
              { key: 'evidencePhotos', render: (nearMiss) => renderEvidencePhotos(nearMiss) }
            ],
            '아차사고 기록 없음'
          )}</tbody>
        </table>
      </section>

      <div class="print-actions">
        <button type="button" onclick="window.print()">인쇄</button>
      </div>
    </main>
  </body>
</html>`;
}

// ---------------------------------------------------------------------------
// File / data persistence helpers
// ---------------------------------------------------------------------------

async function readSessions() {
  try {
    const file = await readFile(SESSIONS_FILE, 'utf8');
    const sessions = JSON.parse(file);
    return Array.isArray(sessions) ? sessions : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function readUsers() {
  try {
    const file = await readFile(USERS_FILE, 'utf8');
    const users = JSON.parse(file);
    return Array.isArray(users) ? users : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function writeSessions(sessions) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(SESSIONS_FILE, `${JSON.stringify(sessions, null, 2)}\n`);
}

async function writeUsers(users) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(USERS_FILE, `${JSON.stringify(users, null, 2)}\n`);
}

async function getAuthenticatedUser(request) {
  const userId = getSessionUserId(request);
  if (!userId) return null;

  const users = await readUsers();
  return users.find((user) => user.id === userId) ?? null;
}

async function requireAuth(request, response, next) {
  try {
    const user = await getAuthenticatedUser(request);
    if (!user) {
      response.status(401).json({ error: 'Please log in to continue.' });
      return;
    }

    request.user = user;
    next();
  } catch (error) {
    next(error);
  }
}

function validateSession(session) {
  if (!session || typeof session !== 'object' || Array.isArray(session)) {
    return 'Session payload must be a JSON object.';
  }

  const missingFields = REQUIRED_FIELDS.filter((field) => !(field in session) || session[field] == null);
  if (missingFields.length) return `Missing required field(s): ${missingFields.join(', ')}.`;
  if (typeof session.site !== 'object' || Array.isArray(session.site)) return 'site must be an object.';
  if (typeof session.work !== 'object' || Array.isArray(session.work)) return 'work must be an object.';
  if (typeof session.supervisor !== 'object' || Array.isArray(session.supervisor)) {
    return 'supervisor must be an object.';
  }
  if (!Array.isArray(session.workers)) return 'workers must be an array.';
  if (!Array.isArray(session.hazards)) return 'hazards must be an array.';
  if (typeof session.sessionId !== 'string' || !session.sessionId.trim()) {
    return 'sessionId must be a non-empty string.';
  }

  return null;
}

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------

app.post('/api/auth/register', async (request, response, next) => {
  try {
    const name = String(request.body?.name ?? '').trim();
    const email = normalizeEmail(request.body?.email);
    const password = String(request.body?.password ?? '');
    const role = String(request.body?.role ?? 'supervisor').trim() || 'supervisor';
    const registrationKey = String(request.body?.registrationKey ?? '');

    if (!REGISTRATION_KEY) {
      response.status(500).json({ error: 'Registration is not configured on this server.' });
      return;
    }
    if (!email) {
      response.status(400).json({ error: 'Email is required.' });
      return;
    }
    if (!password) {
      response.status(400).json({ error: 'Password is required.' });
      return;
    }
    if (password.length < 8) {
      response.status(400).json({ error: 'Password must be at least 8 characters.' });
      return;
    }
    if (!registrationKey) {
      response.status(400).json({ error: 'Registration key is required.' });
      return;
    }
    if (registrationKey !== REGISTRATION_KEY) {
      response.status(403).json({ error: 'Registration key is not authorized.' });
      return;
    }

    const users = await readUsers();
    if (users.some((user) => user.email === email)) {
      response.status(409).json({ error: 'A user with this email already exists.' });
      return;
    }

    const user = {
      id: randomUUID(),
      name: name || email,
      email,
      role,
      passwordHash: await bcrypt.hash(password, 12),
      createdAt: new Date().toISOString()
    };
    users.push(user);
    await writeUsers(users);
    setAuthCookie(response, user.id);
    response.status(201).json({ user: toPublicUser(user) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/login', async (request, response, next) => {
  try {
    const email = normalizeEmail(request.body?.email);
    const password = String(request.body?.password ?? '');

    if (!email || !password) {
      response.status(400).json({ error: 'Email and password are required.' });
      return;
    }

    const users = await readUsers();
    const user = users.find((item) => item.email === email);
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      response.status(401).json({ error: 'Invalid email or password.' });
      return;
    }

    setAuthCookie(response, user.id);
    response.json({ user: toPublicUser(user) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/logout', (_request, response) => {
  clearAuthCookie(response);
  response.json({ ok: true });
});

app.get('/api/auth/me', async (request, response, next) => {
  try {
    const user = await getAuthenticatedUser(request);
    if (!user) {
      response.status(401).json({ error: 'Not logged in.' });
      return;
    }

    response.json({ user: toPublicUser(user) });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// Session / upload / AI / report routes
// ---------------------------------------------------------------------------

app.post('/api/sessions', requireAuth, async (request, response, next) => {
  try {
    const validationError = validateSession(request.body);
    if (validationError) {
      response.status(400).json({ error: validationError });
      return;
    }

    const sessions = await readSessions();
    const existingIndex = sessions.findIndex((session) => session.sessionId === request.body.sessionId);
    const savedSession = {
      ...normalizeSession(request.body),
      createdBy: toPublicUser(request.user),
      savedAt: new Date().toISOString()
    };

    if (existingIndex >= 0) {
      sessions[existingIndex] = savedSession;
    } else {
      sessions.push(savedSession);
    }

    await writeSessions(sessions);
    response.status(existingIndex >= 0 ? 200 : 201).json(savedSession);
  } catch (error) {
    next(error);
  }
});

app.post('/api/uploads', requireAuth, (request, response, next) => {
  upload.array('photos', 10)(request, response, (error) => {
    if (error) {
      if (error instanceof multer.MulterError) {
        const message =
          error.code === 'LIMIT_FILE_SIZE'
            ? 'Image files must be 5MB or smaller.'
            : 'Only JPEG, PNG, and WebP image uploads are allowed.';
        response.status(400).json({ error: message });
        return;
      }

      next(error);
      return;
    }

    const files = request.files ?? [];
    response.status(201).json(
      files.map((file) => ({
        id: file.uploadId,
        originalName: file.originalname,
        filename: file.filename,
        url: `/uploads/${file.filename}`,
        uploadedAt: file.uploadedAt
      }))
    );
  });
});

app.post('/api/ai/analyze-hazard', requireAuth, async (request, response, next) => {
  const { entryType, photo, photos, imageUrl } = request.body ?? {};
  const hasPhotoMetadata = Boolean(photo) || (Array.isArray(photos) && photos.length > 0);
  const hasImageUrl = typeof imageUrl === 'string' && imageUrl.trim();

  if (!['new_hazard', 'near_miss'].includes(entryType)) {
    response.status(400).json({ error: 'entryType must be new_hazard or near_miss.' });
    return;
  }

  if (!hasPhotoMetadata && !hasImageUrl) {
    response.status(400).json({ error: 'Photo metadata or imageUrl is required for analysis.' });
    return;
  }

  try {
    response.json(await analyzeHazardImage({ entryType, photo, photos, imageUrl }));
  } catch (error) {
    next(error);
  }
});

app.get('/api/sessions', requireAuth, async (_request, response, next) => {
  try {
    response.json(await readSessions());
  } catch (error) {
    next(error);
  }
});

app.get('/api/sessions/:sessionId/report', requireAuth, async (request, response, next) => {
  try {
    const sessions = await readSessions();
    const session = sessions.find((item) => item.sessionId === request.params.sessionId);

    if (!session) {
      response.status(404).type('html').send(`<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <title>Report not found</title>
    <style>
      body {
        margin: 40px;
        color: #111;
        background: #fff;
        font-family: Arial, sans-serif;
      }
    </style>
  </head>
  <body>
    <h1>Report not found</h1>
    <p>No saved TBM session exists for this report URL.</p>
  </body>
</html>`);
      return;
    }

    response.type('html').send(renderSessionReport(session));
  } catch (error) {
    next(error);
  }
});

app.get('/api/sessions/:sessionId', requireAuth, async (request, response, next) => {
  try {
    const sessions = await readSessions();
    const session = sessions.find((item) => item.sessionId === request.params.sessionId);

    if (!session) {
      response.status(404).json({ error: 'Session not found.' });
      return;
    }

    response.json(session);
  } catch (error) {
    next(error);
  }
});

app.use(express.static(path.join(__dirname, 'dist')));

// ---------------------------------------------------------------------------
// Error handling / startup
// ---------------------------------------------------------------------------

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({ error: 'Internal server error.' });
});

const httpServer = app.listen(PORT, HOST, () => {
  console.log(`Safety Lens backend listening on http://${HOST}:${PORT}`);
});

httpServer.on('error', (error) => {
  console.error(`Safety Lens backend failed to start on ${HOST}:${PORT}.`);
  console.error(error);
  process.exitCode = 1;
});
