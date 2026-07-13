// @ts-nocheck
// ---------------------------------------------------------------------------
// Imports / config
// ---------------------------------------------------------------------------

import express from 'express';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './repositories/database.ts';
import { ALLOWED_IMAGE_TYPES, detectImageMimeType as detectUploadedImageMimeType } from './services/image-validation.ts';
import { validateSessionPayload } from './validation/session.ts';
import {
  clearAuthCookie,
  getSessionUserId,
  normalizeEmail,
  requireSecureSessionSecret,
  setAuthCookie,
  toPublicUser
} from './middleware/authorization.ts';
import {
  HAZARD_STATUS,
  SHARING_STATUS,
  getFinalizationBlockers,
  isCorrectiveActionClosed,
  normalizeHazardStatus,
  normalizeSessionRecord,
  normalizeSharing
} from '../src/domain/workflow.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

loadEnvFile();

// ---------------------------------------------------------------------------
// Storage paths and constants
// ---------------------------------------------------------------------------

const DEFAULT_DATA_DIR = path.join(PROJECT_ROOT, 'data');
const DEFAULT_UPLOADS_DIR = path.join(PROJECT_ROOT, 'uploads');
const DEFAULT_DATABASE_PATH = path.join(DEFAULT_DATA_DIR, 'safety-lens.sqlite');
const MIGRATIONS_DIR = path.join(PROJECT_ROOT, 'db', 'migrations');
const DEFAULT_SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const DEFAULT_AUTH_RATE_LIMIT = { windowMs: 15 * 60 * 1000, max: 5 };
const SYNC_OPERATION_TYPES = new Set([
  'session_upsert',
  'attendance_acknowledgment',
  'hazard_review',
  'corrective_action',
  'sharing_event',
  'evidence_upload'
]);
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('safety-lens-nonexistent-account', 12);

// ---------------------------------------------------------------------------
// File / data helpers
// ---------------------------------------------------------------------------

function loadEnvFile() {
  const envPath = path.join(PROJECT_ROOT, '.env');
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
  return normalizeHazardStatus(hazard.status ?? hazard.humanReview?.decision);
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
  const normalized = normalizeSessionRecord(session);
  return {
    ...normalized,
    hazards: normalized.hazards.map((hazard) => ({
      ...hazard,
      aiSuggestion: normalizeAiSuggestion(hazard.aiSuggestion)
    })),
    nearMisses: normalized.nearMisses.map((nearMiss) => ({
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
      isMock: true,
      requiresHumanReview: true,
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
    isMock: true,
    requiresHumanReview: true,
    suggestedAt
  };
}

async function analyzeHazardImage({ entryType, photo, photos, imageUrl, aiMode }) {
  if (aiMode === 'mock' || !aiMode) {
    return createMockAiSuggestion(entryType);
  }

  // Future real vision providers should preserve this response contract so the
  // frontend and saved-session schema do not need to change.
  throw new Error(`Unsupported AI_MODE "${aiMode}". Set AI_MODE=mock until a real provider is implemented.`);
}

function renderCorrectiveAction(hazard) {
  const action = hazard.correctiveAction ?? {};
  const closure = isCorrectiveActionClosed(action) ? '검증 완료' : '미검증 / 조치 진행 중';
  const evidence = action.closureEvidence?.length ? action.closureEvidence.join(', ') : '없음';
  return `즉시 통제: ${formatReportValue(action.immediateControl)}<br />담당: ${formatReportValue(
    action.assignedTo
  )}<br />기한: ${formatReportDate(action.dueAt)}<br />작업 상태: ${formatReportValue(
    action.workStatus
  )}<br />검증: ${closure}<br />검증자: ${formatReportValue(action.verifiedBy)}<br />검증 시각: ${formatReportDate(
    action.verifiedAt
  )}<br />종결 증빙: ${formatReportValue(evidence)}`;
}

function renderSharingEvidence(sharing) {
  if (sharing.status === SHARING_STATUS.NOT_SHARED) return '공유하지 않음으로 기록됨';
  if (sharing.status !== SHARING_STATUS.SHARED) return '공유 여부 미기록';
  return `공유 방법: ${formatReportValue(sharing.method)}<br />수신자/그룹: ${formatReportValue(
    sharing.recipients
  )}<br />서버 기록 시각: ${formatReportDate(sharing.sharedAt)}<br />선택적 확인 결과: ${formatReportValue(
    sharing.acknowledgmentResults
  )}`;
}

export function renderSessionReport(session) {
  const presentWorkers = session.workers.filter((worker) => worker.present);
  const supervisorAcknowledgedWorkers = session.workers.filter(
    (worker) => worker.acknowledgment?.supervisorRecorded
  );
  const independentlyVerifiedWorkers = session.workers.filter(
    (worker) => worker.acknowledgment?.independentlyVerified
  );
  const controlledHazards = session.hazards.filter(
    (hazard) => getHazardStatus(hazard) === HAZARD_STATUS.CONTROLLED
  );
  const actionHazards = session.hazards.filter(
    (hazard) => getHazardStatus(hazard) === HAZARD_STATUS.ACTION_REQUIRED
  );
  const openActionHazards = actionHazards.filter((hazard) => !isCorrectiveActionClosed(hazard.correctiveAction));
  const closedActionHazards = actionHazards.filter((hazard) => isCorrectiveActionClosed(hazard.correctiveAction));
  const uncheckedHazards = session.hazards.filter(
    (hazard) => getHazardStatus(hazard) === HAZARD_STATUS.NOT_CHECKED
  );
  const conductedAt = session.startedAt ?? session.finalizedAt ?? session.exportedAt ?? session.createdAt;
  const sharing = normalizeSharing(session.sharing);

  const hazardColumns = [
    { key: 'title', label: '항목', render: (hazard) => renderReportTitle(hazard) },
    { key: 'location', label: '위치' },
    { key: 'riskLevel', label: '위험도' },
    { key: 'recommendedAction', label: '권장 조치' },
    { key: 'evidencePhotos', label: '사진 증빙', render: (hazard) => renderEvidencePhotos(hazard) }
  ];
  const actionColumns = [
    { key: 'title', label: '항목', render: (hazard) => renderReportTitle(hazard) },
    { key: 'location', label: '위치' },
    { key: 'correctiveAction', label: '시정조치 및 검증', render: (hazard) => renderCorrectiveAction(hazard) }
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
        <div class="summary-item"><dt>기록 상태</dt><dd>${formatReportValue(session.status)}</dd></div>
        <div class="summary-item"><dt>근로자 공유</dt><dd>${renderSharingEvidence(sharing)}</dd></div>
      </dl>

      <section>
        <h2>참석 근로자</h2>
        <table>
          <thead><tr><th>이름</th><th>역할</th><th>출석</th></tr></thead>
          <tbody>${renderRows(
            presentWorkers,
            [
              { key: 'name' },
              { key: 'role' },
              { key: 'present', render: () => '출석' }
            ],
            '참석 근로자 없음'
          )}</tbody>
        </table>
      </section>

      <section>
        <h2>감독자 기록 TBM 확인</h2>
        <table>
          <thead><tr><th>이름</th><th>기록자</th><th>기록 시각</th><th>근거</th></tr></thead>
          <tbody>${renderRows(
            supervisorAcknowledgedWorkers,
            [
              { key: 'name' },
              { key: 'recordedBy', render: (worker) => formatReportValue(worker.acknowledgment?.supervisorRecordedBy) },
              { key: 'recordedAt', render: (worker) => formatReportDate(worker.acknowledgment?.supervisorRecordedAt) },
              { key: 'source', render: (worker) => formatReportValue(worker.acknowledgment?.source) }
            ],
            '감독자가 기록한 확인 없음'
          )}</tbody>
        </table>
      </section>

      <section>
        <h2>독립적으로 검증된 근로자 확인</h2>
        <table>
          <thead><tr><th>이름</th><th>검증자</th><th>검증 시각</th><th>방법</th></tr></thead>
          <tbody>${renderRows(
            independentlyVerifiedWorkers,
            [
              { key: 'name' },
              { key: 'verifiedBy', render: (worker) => formatReportValue(worker.acknowledgment?.independentlyVerifiedBy) },
              { key: 'verifiedAt', render: (worker) => formatReportDate(worker.acknowledgment?.independentlyVerifiedAt) },
              { key: 'method', render: (worker) => formatReportValue(worker.acknowledgment?.independentVerificationMethod) }
            ],
            '독립적으로 검증된 확인 없음'
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
        <h2>통제 확인 항목(Controlled — 검토 후 작업 가능)</h2>
        <table>
          <thead><tr>${hazardColumns.map((column) => `<th>${column.label}</th>`).join('')}</tr></thead>
          <tbody>${renderRows(controlledHazards, hazardColumns, '통제 확인 항목 없음')}</tbody>
        </table>
      </section>

      <section>
        <h2>미종결 시정조치(Open Corrective Actions)</h2>
        <table>
          <thead><tr>${actionColumns.map((column) => `<th>${column.label}</th>`).join('')}</tr></thead>
          <tbody>${renderRows(openActionHazards, actionColumns, '미종결 시정조치 없음')}</tbody>
        </table>
      </section>

      <section>
        <h2>검증 완료 시정조치(Closed Corrective Actions)</h2>
        <table>
          <thead><tr>${actionColumns.map((column) => `<th>${column.label}</th>`).join('')}</tr></thead>
          <tbody>${renderRows(closedActionHazards, actionColumns, '검증 완료 시정조치 없음')}</tbody>
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

      <section>
        <h2>근로자 공유 증빙</h2>
        <table>
          <thead><tr><th>공유 상태와 근거</th></tr></thead>
          <tbody><tr><td>${renderSharingEvidence(sharing)}</td></tr></tbody>
        </table>
      </section>

      <div class="print-actions">
        <button type="button" onclick="window.print()">인쇄</button>
      </div>
    </main>
  </body>
</html>`;
}

function toPublicUpload(upload) {
  return {
    id: upload.id,
    uploadId: upload.id,
    originalName: upload.originalName,
    mimeType: upload.mimeType,
    size: upload.size,
    uploadedAt: upload.uploadedAt,
    source: 'uploaded_evidence',
    url: `/api/uploads/${encodeURIComponent(upload.id)}`
  };
}

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------

export function createApp({
  dataDir = DEFAULT_DATA_DIR,
  databasePath = process.env.DATABASE_PATH ?? (dataDir === DEFAULT_DATA_DIR ? DEFAULT_DATABASE_PATH : path.join(dataDir, 'safety-lens.sqlite')),
  uploadsDir = DEFAULT_UPLOADS_DIR,
  registrationKey: configuredRegistrationKey = process.env.REGISTRATION_KEY,
  sessionSecret: configuredSessionSecret = process.env.SESSION_SECRET,
  nodeEnv = process.env.NODE_ENV ?? 'development',
  sessionTtlMs = DEFAULT_SESSION_TTL_MS,
  secureCookies = false,
  authRateLimit = DEFAULT_AUTH_RATE_LIMIT,
  now = () => Date.now(),
  aiMode = process.env.AI_MODE ?? 'mock',
  staticDir = path.join(PROJECT_ROOT, 'dist')
} = {}) {
  const sessionSecret = requireSecureSessionSecret(configuredSessionSecret, nodeEnv);
  const useSecureCookies = nodeEnv === 'production' || secureCookies === true;
  const app = express();
  const database = openDatabase({
    databasePath,
    migrationsDir: MIGRATIONS_DIR,
    now: () => new Date(now()).toISOString()
  });
  app.locals.database = database;
  app.locals.closeDatabase = () => database.close();
  const authAttempts = new Map();

  mkdirSync(uploadsDir, { recursive: true });

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (_request, file, callback) => {
      if (!ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
        callback(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
        return;
      }
      callback(null, true);
    }
  });

  function authRateLimiter(scope) {
    return (request, response, next) => {
      const currentTime = now();
      const key = `${scope}:${request.ip}`;
      const existing = authAttempts.get(key);
      const entry = !existing || currentTime - existing.startedAt >= authRateLimit.windowMs
        ? { startedAt: currentTime, count: 0 }
        : existing;
      entry.count += 1;
      authAttempts.set(key, entry);

      if (entry.count > authRateLimit.max) {
        const retryAfterSeconds = Math.max(1, Math.ceil((entry.startedAt + authRateLimit.windowMs - currentTime) / 1000));
        response.set('Retry-After', String(retryAfterSeconds));
        response.status(429).json({ error: 'Too many authentication attempts. Try again later.' });
        return;
      }
      next();
    };
  }

  function sanitizeEvidencePhoto(photo, uploadsById, ownerId, strict) {
    const isMockEvidence =
      photo?.source === 'glasses_mock_capture' && String(photo?.url ?? '').startsWith('data:image/svg+xml');
    if (isMockEvidence) return photo;

    const uploadId = String(photo?.uploadId ?? photo?.id ?? '');
    const uploadRecord = uploadsById.get(uploadId);
    if (!uploadRecord || uploadRecord.ownerId !== ownerId) {
      if (strict) {
        const error = new Error('Session contains inaccessible evidence.');
        error.code = 'INACCESSIBLE_EVIDENCE';
        throw error;
      }
      return null;
    }
    return toPublicUpload(uploadRecord);
  }

  function sanitizeSessionEvidence(session, uploadRecords, ownerId, strict = false) {
    const uploadsById = new Map(uploadRecords.map((record) => [record.id, record]));
    const sanitizeItems = (items) =>
      (items ?? []).map((item) => ({
        ...item,
        evidencePhotos: (item.evidencePhotos ?? [])
          .map((photo) => sanitizeEvidencePhoto(photo, uploadsById, ownerId, strict))
          .filter(Boolean)
      }));

    return {
      ...session,
      hazards: sanitizeItems(session.hazards),
      nearMisses: sanitizeItems(session.nearMisses)
    };
  }

  async function getAuthenticatedUser(request) {
    const userId = getSessionUserId(request, sessionSecret, now);
    if (!userId) return null;
    return database.findUserById(userId);
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

  function getIdempotencyKey(request) {
    const key = String(request.get('Idempotency-Key') ?? '').trim();
    return key && key.length <= 128 ? key : null;
  }

  function replayClientOperation(request, response) {
    const idempotencyKey = getIdempotencyKey(request);
    if (!idempotencyKey) return false;
    const existing = database.getClientOperation(request.user.id, idempotencyKey);
    if (!existing) return false;
    response.set('Idempotent-Replay', 'true');
    response.status(existing.responseStatus).json(existing.response);
    return true;
  }

  app.use(express.json({ limit: '1mb' }));
  if (nodeEnv === 'production') app.set('trust proxy', 1);

  app.post('/api/auth/register', authRateLimiter('register'), async (request, response, next) => {
    try {
      const name = String(request.body?.name ?? '').trim();
      const email = normalizeEmail(request.body?.email);
      const password = String(request.body?.password ?? '');
      const role = String(request.body?.role ?? 'supervisor').trim() || 'supervisor';
      const registrationKey = String(request.body?.registrationKey ?? '');

      if (!configuredRegistrationKey) {
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
      if (registrationKey !== configuredRegistrationKey) {
        response.status(403).json({ error: 'Registration key is not authorized.' });
        return;
      }

      if (database.findUserByEmail(email)) {
        response.status(409).json({ error: 'A user with this email already exists.' });
        return;
      }

      const user = {
        id: randomUUID(),
        name: name || email,
        email,
        role,
        passwordHash: await bcrypt.hash(password, 12),
        createdAt: new Date(now()).toISOString()
      };
      try {
        database.createUser(user);
      } catch (error) {
        if (String(error.code ?? '').includes('CONSTRAINT')) {
          response.status(409).json({ error: 'A user with this email already exists.' });
          return;
        }
        throw error;
      }
      setAuthCookie(response, user.id, {
        sessionSecret,
        sessionTtlMs,
        secureCookies: useSecureCookies || request.secure,
        now
      });
      response.status(201).json({ user: toPublicUser(user) });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/auth/login', authRateLimiter('login'), async (request, response, next) => {
    try {
      const email = normalizeEmail(request.body?.email);
      const password = String(request.body?.password ?? '');

      if (!email || !password) {
        response.status(400).json({ error: 'Email and password are required.' });
        return;
      }

      const user = database.findUserByEmail(email);
      const passwordMatches = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
      if (!user || !passwordMatches) {
        response.status(401).json({ error: 'Invalid email or password.' });
        return;
      }

      setAuthCookie(response, user.id, {
        sessionSecret,
        sessionTtlMs,
        secureCookies: useSecureCookies || request.secure,
        now
      });
      response.json({ user: toPublicUser(user) });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/auth/logout', (request, response) => {
    clearAuthCookie(response, useSecureCookies || request.secure);
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
  // All current and future routes under these namespaces are authenticated by
  // default. Route authors cannot accidentally omit authorization per handler.
  app.use(['/api/sessions', '/api/uploads', '/api/ai'], requireAuth);

  app.post('/api/sessions', async (request, response, next) => {
    try {
      if (replayClientOperation(request, response)) return;
      const idempotencyKey = getIdempotencyKey(request);
      const operationType = String(request.body?.operationType ?? 'session_upsert');
      if (idempotencyKey && !SYNC_OPERATION_TYPES.has(operationType)) {
        response.status(400).json({ error: 'Unsupported sync operation type.' });
        return;
      }
      const validationError = validateSessionPayload(request.body);
      if (validationError) {
        response.status(400).json({ error: validationError });
        return;
      }

      const existingOwnerId = database.getSessionOwner(request.body.sessionId);
      if (existingOwnerId && existingOwnerId !== request.user.id) {
        response.status(404).json({ error: 'Resource not found.' });
        return;
      }
      const saveMode = request.body.saveMode === 'finalize' ? 'finalize' : 'draft';
      const submittedSession = normalizeSession(request.body);
      const { saveMode: _ignoredSaveMode, ...sessionWithoutSaveMode } = submittedSession;
      const submittedSharing = normalizeSharing(request.body.sharing);
      const ownerId = existingOwnerId ?? request.user.id;
      const uploadRecords = database.getUploadsForOwner(ownerId);
      let candidate;
      try {
        candidate = sanitizeSessionEvidence(
          {
            ...sessionWithoutSaveMode,
            ownerId,
            sharing: submittedSharing,
            createdBy: toPublicUser(request.user)
          },
          uploadRecords,
          ownerId,
          true
        );
      } catch (error) {
        if (error.code === 'INACCESSIBLE_EVIDENCE') {
          response.status(400).json({ error: 'Session contains inaccessible evidence.' });
          return;
        }
        throw error;
      }

      if (saveMode === 'finalize') {
        const blockers = getFinalizationBlockers(candidate);
        if (blockers.length) {
          response.status(400).json({ error: 'Session cannot be finalized.', blockers });
          return;
        }
      }
      const savedSession = database.saveSession(candidate, request.user.id, {
        saveMode,
        expectedRevision: idempotencyKey ? Number(request.body.baseRevision ?? 0) : undefined
      });
      const responseStatus = existingOwnerId ? 200 : 201;
      if (idempotencyKey) {
        database.recordClientOperation({
          ownerId: request.user.id,
          idempotencyKey,
          operationType,
          entityId: request.body.sessionId,
          responseStatus,
          response: savedSession
        });
      }
      response.status(responseStatus).json(savedSession);
    } catch (error) {
      if (error.code === 'NOT_FOUND') {
        response.status(404).json({ error: 'Resource not found.' });
        return;
      }
      if (error.code === 'INACCESSIBLE_EVIDENCE') {
        response.status(400).json({ error: 'Session contains inaccessible evidence.' });
        return;
      }
      if (error.code === 'CONFLICT') {
        const conflict = {
          error: 'Conflict requires review.',
          conflict: {
            serverRevision: error.serverRevision,
            serverSession: database.getSessionForOwner(request.body.sessionId, request.user.id)
          }
        };
        const idempotencyKey = getIdempotencyKey(request);
        if (idempotencyKey) {
          database.recordClientOperation({
            ownerId: request.user.id,
            idempotencyKey,
            operationType: String(request.body?.operationType ?? 'session_upsert'),
            entityId: request.body.sessionId,
            responseStatus: 409,
            response: conflict
          });
        }
        response.status(409).json(conflict);
        return;
      }
      next(error);
    }
  });

  app.post('/api/uploads', (request, response, next) => {
    if (replayClientOperation(request, response)) return;
    const idempotencyKey = getIdempotencyKey(request);
    upload.array('photos', 10)(request, response, async (error) => {
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
      const prepared = [];

      for (const file of files) {
        const detectedMimeType = detectUploadedImageMimeType(file.buffer);
        if (!detectedMimeType || detectedMimeType !== file.mimetype) {
          response.status(400).json({ error: 'Uploaded content is not a valid JPEG, PNG, or WebP image.' });
          return;
        }

        prepared.push({
          record: {
            id: randomUUID(),
            ownerId: request.user.id,
            filename: randomUUID(),
            originalName: path.basename(file.originalname),
            mimeType: detectedMimeType,
            size: file.size,
            hash: `sha256:${createHash('sha256').update(file.buffer).digest('hex')}`,
            uploadedAt: new Date(now()).toISOString()
          },
          buffer: file.buffer
        });
      }

      const writtenPaths = [];
      try {
        for (const item of prepared) {
          const filePath = path.join(uploadsDir, item.record.filename);
          await writeFile(filePath, item.buffer, { flag: 'wx', mode: 0o600 });
          writtenPaths.push(filePath);
        }
        const storedRecords = database.createEvidenceUploads(
          prepared.map((item) => item.record),
          request.user.id
        );
        const publicRecords = storedRecords.map(toPublicUpload);
        if (idempotencyKey) {
          database.recordClientOperation({
            ownerId: request.user.id,
            idempotencyKey,
            operationType: 'evidence_upload',
            entityId: publicRecords.map((record) => record.id).join(','),
            responseStatus: 201,
            response: publicRecords
          });
        }
        response.status(201).json(publicRecords);
      } catch (storageError) {
        await Promise.all(writtenPaths.map((filePath) => unlink(filePath).catch(() => {})));
        next(storageError);
      }
    });
  });

  app.get('/api/uploads/:uploadId', async (request, response, next) => {
    try {
      const uploadRecord = database.getUploadForOwner(request.params.uploadId, request.user.id);
      if (!uploadRecord) {
        response.status(404).json({ error: 'Resource not found.' });
        return;
      }

      let contents;
      try {
        contents = await readFile(path.join(uploadsDir, uploadRecord.filename));
      } catch (error) {
        if (error.code === 'ENOENT') {
          response.status(404).json({ error: 'Resource not found.' });
          return;
        }
        throw error;
      }

      const actualHash = `sha256:${createHash('sha256').update(contents).digest('hex')}`;
      if (actualHash !== uploadRecord.hash || detectUploadedImageMimeType(contents) !== uploadRecord.mimeType) {
        response.status(404).json({ error: 'Resource not found.' });
        return;
      }

      response.set({
        'Cache-Control': 'private, no-store',
        'Content-Type': uploadRecord.mimeType,
        'Content-Length': String(contents.length),
        'X-Content-Type-Options': 'nosniff'
      });
      response.send(contents);
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/ai/analyze-hazard', async (request, response, next) => {
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
      response.json(await analyzeHazardImage({ entryType, photo, photos, imageUrl, aiMode }));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/sessions', async (request, response, next) => {
    try {
      response.json(database.listSessionsForOwner(request.user.id).map(normalizeSession));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/sessions/:sessionId/report', async (request, response, next) => {
    try {
      const storedSession = database.getSessionForOwner(request.params.sessionId, request.user.id);
      const session = storedSession ? normalizeSession(storedSession) : null;

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
      <p>The requested resource was not found.</p>
    </body>
  </html>`);
        return;
      }

      response.type('html').send(renderSessionReport(session));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/sessions/:sessionId', async (request, response, next) => {
    try {
      const storedSession = database.getSessionForOwner(request.params.sessionId, request.user.id);
      const session = storedSession ? normalizeSession(storedSession) : null;

      if (!session) {
        response.status(404).json({ error: 'Resource not found.' });
        return;
      }

      response.json(session);
    } catch (error) {
      next(error);
    }
  });

  app.use(express.static(staticDir));

  // ---------------------------------------------------------------------------
  // Error handling / startup
  // ---------------------------------------------------------------------------

  app.use((error, _request, response, _next) => {
    console.error(error);
    response.status(500).json({ error: 'Internal server error.' });
  });

  return app;
}

export function startServer({
  port = process.env.PORT ?? 3001,
  host = process.env.HOST ?? '127.0.0.1',
  ...appOptions
} = {}) {
  const app = createApp(appOptions);
  const httpServer = app.listen(port, host, () => {
    console.log(`Safety Lens backend listening on http://${host}:${port}`);
  });

  httpServer.on('error', (error) => {
    console.error(`Safety Lens backend failed to start on ${host}:${port}.`);
    console.error(error);
    process.exitCode = 1;
  });
  httpServer.on('close', () => app.locals.closeDatabase());

  return httpServer;
}
