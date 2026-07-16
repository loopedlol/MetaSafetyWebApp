// @ts-nocheck
// ---------------------------------------------------------------------------
// Imports / config
// ---------------------------------------------------------------------------

import express from 'express';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './repositories/database.ts';
import { validateEnvironment } from './config.ts';
import { rejectCrossSiteMutation, requestContext, sanitizeRequestPath, securityHeaders } from './middleware/http-security.ts';
import { ALLOWED_IMAGE_TYPES, detectImageMimeType as detectUploadedImageMimeType } from './services/image-validation.ts';
import { createAnalysisProvider, normalizeProviderResult } from './services/ai-provider.ts';
import { validatePayloadBounds, validateSessionPayload } from './validation/session.ts';
import { createTranslator, normalizeLocale } from '../src/i18n/index.ts';
import { EVIDENCE_SOURCE_CATEGORY, isBrowserFulfillmentProvider } from '../src/domain/evidence-acquisition.ts';
import {
  clearAuthCookie,
  clearGlassesAuthCookie,
  getGlassesSessionId,
  getSessionUserId,
  normalizeEmail,
  requireSecureSessionSecret,
  setAuthCookie,
  setGlassesAuthCookie,
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
const DEFAULT_GLASSES_EXCHANGE_RATE_LIMIT = { windowMs: 60 * 1000, max: 10 };
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

function secretsEqual(left, right) {
  const leftHash = createHash('sha256').update(String(left)).digest();
  const rightHash = createHash('sha256').update(String(right)).digest();
  return timingSafeEqual(leftHash, rightHash);
}

// ---------------------------------------------------------------------------
// Report rendering helpers
// ---------------------------------------------------------------------------

function formatReportDate(value, locale = 'ko') {
  if (!value) return '미입력';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '미입력';

  return new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'ko-KR', {
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

function renderEvidencePhotos(item, t = createTranslator()) {
  const photos = Array.isArray(item.evidencePhotos) ? item.evidencePhotos : [];
  if (!photos.length) return `<span class="empty">${t('report.noPhoto')}</span>`;

  return `
    <div class="photo-grid">
      ${photos
        .map((photo, index) => {
          const isMockEvidence = photo.source === 'glasses_mock_capture' || String(photo.url ?? '').startsWith('data:');
          const mockLabel = isMockEvidence ? ` (${t('report.mockPhoto')})` : '';
          return `
            <figure>
              <img src="${escapeHtml(photo.url)}" alt="${formatReportValue(photo.originalName ?? `Evidence ${index + 1}`)}" />
              <figcaption>${formatReportValue(photo.originalName ?? t('report.photoNumber', { number: index + 1 }))}${mockLabel}</figcaption>
            </figure>
          `;
        })
        .join('')}
    </div>
  `;
}

function renderAiSuggestionNote(item, t = createTranslator()) {
  if (!item.aiSuggestion) return '';

  const confidence = Number(item.aiSuggestion.confidence);
  const confidenceText = Number.isFinite(confidence) ? t('report.confidence', { percent: Math.round(confidence * 100) }) : '';
  const decisionText = item.aiSuggestion.edited
    ? t('report.aiEdited')
    : item.aiSuggestion.accepted
    ? t('report.aiAccepted')
    : item.aiSuggestion.rejected
      ? t('report.aiRejected')
      : t('report.aiPending');
  const originText = item.aiSuggestion.simulated
    ? t('report.aiMockOrigin', { provider: item.aiSuggestion.provider ?? 'deterministic_fixture' })
    : t('report.aiProviderOrigin', { provider: item.aiSuggestion.provider ?? 'unknown' });
  const rawTitle = item.aiSuggestion.rawSuggestion?.title ?? t('common.unknown');
  return `<p class="ai-note">${originText}</p><p class="ai-note">${t('report.aiOriginContent', { title: rawTitle })}</p><p class="ai-note">${t('report.aiDecision', { decision: decisionText, confidence: confidenceText })}</p><p class="ai-note">${t('report.aiHumanContent', { title: item.title })}</p>`;
}

function renderReportTitle(item, t = createTranslator()) {
  return `${formatReportValue(item.title)}${renderAiSuggestionNote(item, t)}`;
}

function getHazardStatus(hazard) {
  return normalizeHazardStatus(hazard.status ?? hazard.humanReview?.decision);
}

function normalizeAiSuggestion(aiSuggestion) {
  if (!aiSuggestion) return null;

  const accepted = aiSuggestion.accepted === true || aiSuggestion.humanDecision === 'accepted';
  const rejected = accepted ? false : aiSuggestion.rejected === true || aiSuggestion.humanDecision === 'rejected';

  return {
    analysisId: aiSuggestion.analysisId ?? null,
    uploadId: aiSuggestion.uploadId ?? null,
    uploadHash: aiSuggestion.uploadHash ?? null,
    source: aiSuggestion.source ?? (aiSuggestion.mode === 'mock' ? 'mock_ai' : 'ai_provider'),
    mode: aiSuggestion.mode ?? 'mock',
    provider: aiSuggestion.provider ?? 'deterministic_fixture',
    modelVersion: aiSuggestion.modelVersion ?? null,
    simulated: aiSuggestion.simulated !== false,
    pixelInterpretation: aiSuggestion.pixelInterpretation === true,
    disclaimer: aiSuggestion.disclaimer ?? null,
    requestedAt: aiSuggestion.requestedAt ?? aiSuggestion.suggestedAt ?? null,
    completedAt: aiSuggestion.completedAt ?? aiSuggestion.suggestedAt ?? null,
    rawSuggestion: aiSuggestion.rawSuggestion ?? aiSuggestion.suggestion ?? null,
    finalHumanSuggestion: aiSuggestion.finalHumanSuggestion ?? null,
    humanDecision: aiSuggestion.humanDecision ?? (accepted ? 'accepted' : rejected ? 'rejected' : 'pending'),
    accepted,
    rejected,
    edited: aiSuggestion.edited === true || aiSuggestion.humanDecision === 'edited',
    reviewer: aiSuggestion.reviewer ?? null,
    confidence: typeof aiSuggestion.confidence === 'number' ? aiSuggestion.confidence : null,
    suggestedAt: aiSuggestion.suggestedAt ?? null,
    reviewedAt: aiSuggestion.reviewedAt ?? null
  };
}

function normalizeEditedSuggestion(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const suggestion = {
    title: String(value.title ?? '').trim(), category: String(value.category ?? '').trim(),
    riskLevel: String(value.riskLevel ?? '').trim(), description: String(value.description ?? '').trim(),
    recommendedAction: String(value.recommendedAction ?? '').trim(), confidence: null
  };
  if (![suggestion.title, suggestion.category, suggestion.description, suggestion.recommendedAction].every(Boolean)) return null;
  if (!['low', 'medium', 'high'].includes(suggestion.riskLevel)) return null;
  return suggestion;
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

function renderCorrectiveAction(hazard, t = createTranslator(), locale = 'ko') {
  const action = hazard.correctiveAction ?? {};
  const closure = isCorrectiveActionClosed(action) ? t('report.verificationComplete') : t('report.verificationOpen');
  const evidence = action.closureEvidence?.length ? action.closureEvidence.join(', ') : t('report.none');
  return `${t('report.controlImmediate')}: ${formatReportValue(action.immediateControl)}<br />${t('report.assignee')}: ${formatReportValue(
    action.assignedTo
  )}<br />${t('report.dueAt')}: ${formatReportDate(action.dueAt, locale)}<br />${t('report.workStatus')}: ${formatReportValue(
    action.workStatus
  )}<br />${t('report.verification')}: ${closure}<br />${t('report.verifier')}: ${formatReportValue(action.verifiedBy)}<br />${t('report.verifiedAt')}: ${formatReportDate(
    action.verifiedAt, locale
  )}<br />${t('report.closureEvidence')}: ${formatReportValue(evidence)}`;
}

function renderSharingEvidence(sharing, t = createTranslator(), locale = 'ko') {
  if (sharing.status === SHARING_STATUS.NOT_SHARED) return t('report.notShared');
  if (sharing.status !== SHARING_STATUS.SHARED) return t('report.sharingNotRecorded');
  return `${t('report.shareMethod')}: ${formatReportValue(sharing.method)}<br />${t('report.recipients')}: ${formatReportValue(
    sharing.recipients
  )}<br />${t('report.serverRecordedAt')}: ${formatReportDate(sharing.sharedAt, locale)}<br />${t('report.optionalAck')}: ${formatReportValue(
    sharing.acknowledgmentResults
  )}`;
}

export function renderSessionReport(session, localeValue = 'ko') {
  const reportLocale = normalizeLocale(localeValue);
  const t = createTranslator(reportLocale);
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
    { key: 'title', label: t('report.item'), render: (hazard) => renderReportTitle(hazard, t) },
    { key: 'location', label: t('report.location') },
    { key: 'riskLevel', label: t('report.riskLevel') },
    { key: 'recommendedAction', label: t('report.recommendedAction') },
    { key: 'evidencePhotos', label: t('report.photoEvidence'), render: (hazard) => renderEvidencePhotos(hazard, t) }
  ];
  const actionColumns = [
    { key: 'title', label: t('report.item'), render: (hazard) => renderReportTitle(hazard, t) },
    { key: 'location', label: t('report.location') },
    { key: 'correctiveAction', label: t('report.correctiveVerification'), render: (hazard) => renderCorrectiveAction(hazard, t, reportLocale) }
  ];

  return `<!doctype html>
<html lang="${reportLocale}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${t('report.browserTitle', { site: session.site?.siteName ?? '' })}</title>
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
          <h1>${t('report.title')}</h1>
          <p>${formatReportValue(session.work?.taskName)}</p>
        </div>
        <p class="meta-note">Session ID<br />${formatReportValue(session.sessionId)}</p>
      </header>

      <dl class="summary-grid">
        <div class="summary-item"><dt>${t('report.siteName')}</dt><dd>${formatReportValue(session.site?.siteName)}</dd></div>
        <div class="summary-item"><dt>${t('report.siteArea')}</dt><dd>${formatReportValue(session.site?.siteArea)}</dd></div>
        <div class="summary-item"><dt>${t('report.taskName')}</dt><dd>${formatReportValue(session.work?.taskName)}</dd></div>
        <div class="summary-item"><dt>${t('report.conductor')}</dt><dd>${formatReportValue(session.supervisor?.name)} / ${formatReportValue(
          session.supervisor?.role
        )}</dd></div>
        <div class="summary-item"><dt>${t('report.conductedAt')}</dt><dd>${formatReportDate(conductedAt, reportLocale)}</dd></div>
        <div class="summary-item"><dt>${t('report.recordStatus')}</dt><dd>${formatReportValue(t(`status.${session.status}`))}</dd></div>
        <div class="summary-item"><dt>${t('report.workerSharing')}</dt><dd>${renderSharingEvidence(sharing, t, reportLocale)}</dd></div>
      </dl>

      <section>
        <h2>${t('report.attendance')}</h2>
        ${session.attendanceSummary ? `<p>${t('report.countOnlyAttendance')}: ${session.attendanceSummary.presentCount} / ${session.attendanceSummary.expectedCount} (${formatReportValue(session.attendanceSummary.captureSource)})</p>` : ''}
        <table>
          <thead><tr><th>${t('report.name')}</th><th>${t('report.role')}</th><th>${t('report.present')}</th></tr></thead>
          <tbody>${renderRows(
            presentWorkers,
            [
              { key: 'name' },
              { key: 'role' },
              { key: 'present', render: () => t('report.present') }
            ],
            t('report.noneAttendance')
          )}</tbody>
        </table>
      </section>

      <section>
        <h2>${t('report.supervisorAcknowledgment')}</h2>
        <table>
          <thead><tr><th>${t('report.name')}</th><th>${t('report.recorder')}</th><th>${t('report.recordedAt')}</th><th>${t('report.basis')}</th></tr></thead>
          <tbody>${renderRows(
            supervisorAcknowledgedWorkers,
            [
              { key: 'name' },
              { key: 'recordedBy', render: (worker) => formatReportValue(worker.acknowledgment?.supervisorRecordedBy) },
              { key: 'recordedAt', render: (worker) => formatReportDate(worker.acknowledgment?.supervisorRecordedAt, reportLocale) },
              { key: 'source', render: (worker) => formatReportValue(worker.acknowledgment?.source) }
            ],
            t('report.noneSupervisorAck')
          )}</tbody>
        </table>
      </section>

      <section>
        <h2>${t('report.independentAcknowledgment')}</h2>
        <table>
          <thead><tr><th>${t('report.name')}</th><th>${t('report.verifier')}</th><th>${t('report.verifiedAt')}</th><th>${t('report.method')}</th></tr></thead>
          <tbody>${renderRows(
            independentlyVerifiedWorkers,
            [
              { key: 'name' },
              { key: 'verifiedBy', render: (worker) => formatReportValue(worker.acknowledgment?.independentlyVerifiedBy) },
              { key: 'verifiedAt', render: (worker) => formatReportDate(worker.acknowledgment?.independentlyVerifiedAt, reportLocale) },
              { key: 'method', render: (worker) => formatReportValue(worker.acknowledgment?.independentVerificationMethod) }
            ],
            t('report.noneIndependentAck')
          )}</tbody>
        </table>
      </section>

      <section>
        <h2>${t('report.allHazards')}</h2>
        <table>
          <thead><tr>${hazardColumns.map((column) => `<th>${column.label}</th>`).join('')}</tr></thead>
          <tbody>${renderRows(session.hazards, hazardColumns, t('report.noneHazards'))}</tbody>
        </table>
      </section>

      <section>
        <h2>${t('report.controlled')}</h2>
        <table>
          <thead><tr>${hazardColumns.map((column) => `<th>${column.label}</th>`).join('')}</tr></thead>
          <tbody>${renderRows(controlledHazards, hazardColumns, t('report.noneControlled'))}</tbody>
        </table>
      </section>

      <section>
        <h2>${t('report.openActions')}</h2>
        <table>
          <thead><tr>${actionColumns.map((column) => `<th>${column.label}</th>`).join('')}</tr></thead>
          <tbody>${renderRows(openActionHazards, actionColumns, t('report.noneOpenActions'))}</tbody>
        </table>
      </section>

      <section>
        <h2>${t('report.closedActions')}</h2>
        <table>
          <thead><tr>${actionColumns.map((column) => `<th>${column.label}</th>`).join('')}</tr></thead>
          <tbody>${renderRows(closedActionHazards, actionColumns, t('report.noneClosedActions'))}</tbody>
        </table>
      </section>

      <section>
        <h2>${t('report.unchecked')}</h2>
        <table>
          <thead><tr>${hazardColumns.map((column) => `<th>${column.label}</th>`).join('')}</tr></thead>
          <tbody>${renderRows(uncheckedHazards, hazardColumns, t('report.noneUnchecked'))}</tbody>
        </table>
      </section>

      <section>
        <h2>${t('report.nearMisses')}</h2>
        <table>
          <thead><tr><th>${t('report.item')}</th><th>${t('report.location')}</th><th>${t('report.riskLevel')}</th><th>${t('report.actionDetails')}</th><th>${t('report.photoEvidence')}</th></tr></thead>
          <tbody>${renderRows(
            session.nearMisses ?? [],
            [
              { key: 'title', render: (nearMiss) => renderReportTitle(nearMiss, t) },
              { key: 'location' },
              { key: 'riskLevel' },
              { key: 'actionTaken' },
              { key: 'evidencePhotos', render: (nearMiss) => renderEvidencePhotos(nearMiss, t) }
            ],
            t('report.noneNearMiss')
          )}</tbody>
        </table>
      </section>

      <section>
        <h2>${t('report.sharing')}</h2>
        <table>
          <thead><tr><th>${t('report.sharingBasis')}</th></tr></thead>
          <tbody><tr><td>${renderSharingEvidence(sharing, t, reportLocale)}</td></tr></tbody>
        </table>
      </section>

      <div class="print-actions">
        <button type="button" id="print-report">${t('report.print')}</button>
      </div>
    </main>
    <script src="/report-print.js"></script>
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
    source: upload.source === 'sdk_raw_camera' ? 'sdk_raw_camera' : 'browser_file_picker',
    url: `/api/uploads/${encodeURIComponent(upload.id)}`
  };
}

function toPublicAiAnalysis(analysis) {
  if (!analysis) return null;
  const { ownerId, reviewerUserId, ...publicAnalysis } = analysis;
  return publicAnalysis;
}

function toPublicEvidenceRequest(item) {
  if (!item) return null;
  return {
    id: item.id, sessionId: item.sessionId, hazardId: item.hazardId, status: item.status,
    createdAt: item.createdAt, expiresAt: item.expiresAt, completedAt: item.completedAt,
    cancelledAt: item.cancelledAt, attachedAt: item.attachedAt,
    sourceCategory: item.provider === 'native_dat_camera' ? 'native_glasses_camera' : item.sourceCategory, provider: item.provider,
    nativeReadyAt: item.nativeReadyAt, supersededAt: item.supersededAt,
    hazard: { title: item.hazardTitle, location: item.hazardLocation || '' },
    tbm: { taskName: item.taskName, siteName: item.siteName, siteArea: item.siteArea || '' },
    evidence: item.upload ? { uploadId: item.upload.id, mimeType: item.upload.mimeType, size: item.upload.size,
      uploadedAt: item.upload.uploadedAt, source: item.upload.source, url: `/api/uploads/${encodeURIComponent(item.upload.id)}` } : null
  };
}

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------

export function createApp({
  dataDir = DEFAULT_DATA_DIR,
  databasePath = process.env.DATABASE_PATH ?? (dataDir === DEFAULT_DATA_DIR ? DEFAULT_DATABASE_PATH : path.join(dataDir, 'safety-lens.sqlite')),
  uploadsDir = process.env.UPLOADS_DIR ?? DEFAULT_UPLOADS_DIR,
  registrationKey: configuredRegistrationKey = process.env.REGISTRATION_KEY,
  sessionSecret: configuredSessionSecret = process.env.SESSION_SECRET,
  nodeEnv = process.env.NODE_ENV ?? 'development',
  sessionTtlMs = DEFAULT_SESSION_TTL_MS,
  glassesPairingTtlMs = 5 * 60 * 1000,
  glassesSessionTtlMs = 60 * 60 * 1000,
  glassesPairingMaxAttempts = 5,
  evidenceRequestTtlMs = 10 * 60 * 1000,
  nativeRegistrationTtlMs = 5 * 60 * 1000,
  nativeClaimLeaseMs = 2 * 60 * 1000,
  nativeAvailabilityWindowMs = 30 * 1000,
  secureCookies = false,
  authRateLimit = DEFAULT_AUTH_RATE_LIMIT,
  glassesExchangeRateLimit = DEFAULT_GLASSES_EXCHANGE_RATE_LIMIT,
  now = () => Date.now(),
  aiMode = process.env.AI_MODE ?? 'mock',
  analysisProvider: configuredAnalysisProvider = null,
  staticDir = path.join(PROJECT_ROOT, 'dist'),
  trustProxy = false,
  devTunnelOrigin = null,
  logger = console
} = {}) {
  const sessionSecret = requireSecureSessionSecret(configuredSessionSecret, nodeEnv);
  const useSecureCookies = nodeEnv === 'production' || secureCookies === true;
  const app = express();
  const analysisProvider = configuredAnalysisProvider ?? createAnalysisProvider(aiMode);
  const database = openDatabase({
    databasePath,
    migrationsDir: MIGRATIONS_DIR,
    now: () => new Date(now()).toISOString()
  });
  app.locals.database = database;
  app.locals.isShuttingDown = false;
  let databaseClosed = false;
  app.locals.closeDatabase = () => {
    if (databaseClosed) return;
    databaseClosed = true;
    database.close();
  };
  const authAttempts = new Map();
  const pairingCodeAttempts = new Map();

  mkdirSync(uploadsDir, { recursive: true, mode: 0o700 });

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 10, fields: 10, parts: 20, fieldNameSize: 100, fieldSize: 10_000 },
    fileFilter: (_request, file, callback) => {
      if (!ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
        callback(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
        return;
      }
      callback(null, true);
    }
  });

  function authRateLimiter(scope, limit = authRateLimit) {
    return (request, response, next) => {
      const currentTime = now();
      const key = `${scope}:${request.ip}`;
      const existing = authAttempts.get(key);
      const entry = !existing || currentTime - existing.startedAt >= limit.windowMs
        ? { startedAt: currentTime, count: 0 }
        : existing;
      entry.count += 1;
      authAttempts.set(key, entry);

      if (entry.count > limit.max) {
        const retryAfterSeconds = Math.max(1, Math.ceil((entry.startedAt + limit.windowMs - currentTime) / 1000));
        response.set('Retry-After', String(retryAfterSeconds));
        response.status(429).json({ error: 'Too many authentication attempts. Try again later.' });
        return;
      }
      next();
    };
  }

  function sanitizeEvidencePhoto(photo, uploadsById, ownerId, strict) {
    const isMockEvidence =
      photo?.source === 'browser_preview_mock' && String(photo?.url ?? '').startsWith('data:image/svg+xml');
    if (isMockEvidence) return { ...photo, source: 'browser_preview_mock' };

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
        if (request.headers.cookie?.includes('safety_lens_session=')) clearAuthCookie(response, useSecureCookies || request.secure);
        response.status(401).json({ error: 'Please log in to continue.' });
        return;
      }

      request.user = user;
      next();
    } catch (error) {
      next(error);
    }
  }

  function requireSupervisor(request, response, next) {
    if (request.user?.role !== 'supervisor') {
      response.status(403).json({ error: 'Supervisor authorization is required.' });
      return;
    }
    next();
  }

  async function getRestrictedGlassesSession(request) {
    const sessionId = getGlassesSessionId(request, sessionSecret, now);
    return sessionId ? database.getGlassesSession(sessionId) : null;
  }

  async function requireGlassesAuth(request, response, next) {
    try {
      const glassesSession = await getRestrictedGlassesSession(request);
      if (!glassesSession) {
        if (request.headers.cookie?.includes('safety_lens_glasses=')) clearGlassesAuthCookie(response, useSecureCookies || request.secure);
        response.status(401).json({ error: '안경 연결이 만료되었거나 해제되었습니다. 다시 페어링하세요.' });
        return;
      }
      request.glassesSession = glassesSession;
      request.user = database.findUserById(glassesSession.supervisorUserId);
      if (!request.user) {
        clearGlassesAuthCookie(response, useSecureCookies || request.secure);
        response.status(401).json({ error: '안경 연결이 만료되었거나 해제되었습니다. 다시 페어링하세요.' });
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  }

  function nativeCredentialDigest(deviceId, secret) {
    return createHmac('sha256', sessionSecret).update(`native-device:${deviceId}:${secret}`).digest('hex');
  }

  function requireNativeDevice(request, response, next) {
    try {
      const authorization = String(request.get('Authorization') ?? '');
      const match = /^Device ([0-9a-f-]{36})\.([A-Za-z0-9_-]{40,})$/.exec(authorization);
      const device = match ? database.authenticateNativeDevice(match[1], nativeCredentialDigest(match[1], match[2])) : null;
      if (!device) { response.status(401).json({ error: 'Native device authentication failed.' }); return; }
      request.nativeDevice = device;
      request.user = database.findUserById(device.ownerId);
      if (!request.user) { response.status(401).json({ error: 'Native device authentication failed.' }); return; }
      next();
    } catch (error) { next(error); }
  }

  async function requireSessionAuth(request, response, next) {
    try {
      const glassesSession = await getRestrictedGlassesSession(request);
      const glassesOwner = glassesSession ? database.findUserById(glassesSession.supervisorUserId) : null;
      if (glassesSession && glassesOwner) {
        request.user = glassesOwner;
        request.glassesSession = glassesSession;
        request.authKind = 'glasses';
        next();
        return;
      }
      const user = await getAuthenticatedUser(request);
      if (user) {
        request.user = user;
        request.authKind = 'supervisor';
        next();
        return;
      }
      response.status(401).json({ error: 'Please log in or pair the glasses to continue.' });
    } catch (error) {
      next(error);
    }
  }

  function isWithinGlassesScope(glassesSession, session) {
    if (!glassesSession) return true;
    if (glassesSession.scopeType === 'tbm_session') return session.sessionId === glassesSession.scopeSessionId;
    return session.site?.siteName === glassesSession.siteName && session.site?.siteArea === glassesSession.siteArea;
  }

  function getIdempotencyKey(request) {
    const key = String(request.get('Idempotency-Key') ?? '').trim();
    if (!key || key.length > 128) return null;
    return request.authKind === 'glasses' ? `glasses:${request.glassesSession.id}:${key}` : key;
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

  app.locals.runRetentionCleanup = async ({ cutoff = new Date(now() - 24 * 60 * 60 * 1000).toISOString() } = {}) => {
    const abandoned = database.listAbandonedUploadsBefore(cutoff);
    let deleted = 0;
    for (const record of abandoned) {
      try {
        // Keep the file removal and conditional metadata deletion in one event-loop turn.
        // That prevents a session save from linking the upload between those operations.
        unlinkSync(path.join(uploadsDir, record.filename));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (database.deleteAbandonedUpload(record.id)) deleted += 1;
    }
    const expiredPairings = database.cleanupExpiredGlassesPairings();
    const expiredEvidenceRequests = database.cleanupExpiredEvidenceRequests();
    return { examined: abandoned.length, deleted, expiredPairings, expiredEvidenceRequests };
  };

  app.disable('x-powered-by');
  if (trustProxy) app.set('trust proxy', trustProxy);
  app.use(requestContext(logger, now));
  app.use(securityHeaders(nodeEnv));
  app.use(rejectCrossSiteMutation({ approvedOrigins: devTunnelOrigin ? [devTunnelOrigin] : [] }));
  app.use(express.json({ limit: '1mb', strict: true }));
  app.use('/api', (request, response, next) => {
    const idempotencyKey = request.get('Idempotency-Key');
    if (idempotencyKey && idempotencyKey.trim().length > 128) {
      response.status(400).json({ error: 'Idempotency-Key exceeds 128 characters.' });
      return;
    }
    const boundsError = validatePayloadBounds(request.body);
    if (boundsError) {
      response.status(400).json({ error: boundsError });
      return;
    }
    next();
  });
  for (const parameter of ['sessionId', 'uploadId', 'analysisId', 'pairingId', 'requestId', 'deviceId']) {
    app.param(parameter, (request, response, next, value) => {
      if (String(value).length > 200) {
        response.status(400).json({ error: `${parameter} exceeds 200 characters.` });
        return;
      }
      next();
    });
  }

  app.get('/healthz', (_request, response) => response.json({ status: 'ok' }));
  app.get('/readyz', (_request, response) => {
    let ready = false;
    try {
      ready = !app.locals.isShuttingDown && database.readinessCheck();
    } catch {
      ready = false;
    }
    response.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready' });
  });

  app.post('/api/auth/register', authRateLimiter('register'), async (request, response, next) => {
    try {
      const name = String(request.body?.name ?? '').trim();
      const email = normalizeEmail(request.body?.email);
      const password = String(request.body?.password ?? '');
      const role = String(request.body?.role ?? 'supervisor').trim() || 'supervisor';
      const registrationKey = String(request.body?.registrationKey ?? '');

      if (name.length > 200 || email.length > 320 || password.length > 128 || role.length > 100 || registrationKey.length > 256) {
        response.status(400).json({ error: 'Registration fields exceed allowed lengths.' });
        return;
      }

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
      if (!secretsEqual(registrationKey, configuredRegistrationKey)) {
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

      if (email.length > 320 || password.length > 128) {
        response.status(400).json({ error: 'Email or password exceeds the allowed length.' });
        return;
      }

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
        if (request.headers.cookie?.includes('safety_lens_session=')) clearAuthCookie(response, useSecureCookies || request.secure);
        response.status(401).json({ error: 'Not logged in.' });
        return;
      }

      response.json({ user: toPublicUser(user) });
    } catch (error) {
      next(error);
    }
  });

  // Pairing codes are returned only by the creation response. The database and
  // audit trail receive only an HMAC digest and non-secret scope metadata.
  app.get('/api/glasses-pairings/scopes', requireAuth, (request, response) => {
    response.json(database.listPairingScopes(request.user.id));
  });

  app.post('/api/glasses-pairings', requireAuth, (request, response, next) => {
    try {
      const scopeType = String(request.body?.scopeType ?? '');
      const scopeId = String(request.body?.scopeId ?? '');
      if (!['site', 'tbm_session'].includes(scopeType) || !scopeId || scopeId.length > 200) {
        response.status(400).json({ error: 'A valid site or TBM scope is required.' });
        return;
      }
      const createdAt = new Date(now()).toISOString();
      const expiresAt = new Date(now() + glassesPairingTtlMs).toISOString();
      let created = null;
      let code = '';
      for (let attempt = 0; attempt < 5 && !created; attempt += 1) {
        code = String(randomInt(0, 1_000_000)).padStart(6, '0');
        const codeDigest = createHmac('sha256', sessionSecret).update(`glasses-pairing:${code}`).digest('hex');
        try {
          created = database.createGlassesPairing({
            id: randomUUID(), codeDigest, supervisorUserId: request.user.id, scopeType, scopeId,
            createdAt, expiresAt, maxAttempts: glassesPairingMaxAttempts
          });
        } catch (error) {
          if (!String(error.code ?? '').includes('CONSTRAINT')) throw error;
        }
      }
      if (!created) {
        response.status(404).json({ error: 'The selected site or TBM was not found.' });
        return;
      }
      response.status(201).json({
        pairing: created,
        code,
        groupedCode: `${code.slice(0, 3)} ${code.slice(3)}`
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/glasses-pairings/:pairingId', requireAuth, (request, response) => {
    const pairing = database.getGlassesPairingForOwner(request.params.pairingId, request.user.id);
    if (!pairing) {
      response.status(404).json({ error: 'Resource not found.' });
      return;
    }
    response.json({ pairing });
  });

  app.delete('/api/glasses-pairings/:pairingId', requireAuth, (request, response) => {
    if (!database.cancelGlassesPairing(request.params.pairingId, request.user.id)) {
      response.status(409).json({ error: 'The pairing request can no longer be cancelled.' });
      return;
    }
    response.status(204).end();
  });

  app.post('/api/glasses-pairings/:pairingId/revoke', requireAuth, (request, response) => {
    if (!database.revokeGlassesSessionForPairing(request.params.pairingId, request.user.id)) {
      response.status(409).json({ error: 'The glasses session is not active.' });
      return;
    }
    response.status(204).end();
  });

  app.post('/api/glasses/pair', authRateLimiter('glasses-pair', glassesExchangeRateLimit), (request, response, next) => {
    try {
      const code = String(request.body?.code ?? '').replace(/\s/g, '');
      const genericError = { error: '코드를 확인할 수 없습니다. 새 코드를 받아 다시 시도하세요.' };
      if (!/^\d{6}$/.test(code)) {
        database.recordUnknownPairingFailure(request.ip);
        response.status(401).json(genericError);
        return;
      }
      const codeDigest = createHmac('sha256', sessionSecret).update(`glasses-pairing:${code}`).digest('hex');
      const previous = pairingCodeAttempts.get(codeDigest);
      const codeAttempt = !previous || now() - previous.startedAt >= glassesPairingTtlMs
        ? { startedAt: now(), count: 1 }
        : { ...previous, count: previous.count + 1 };
      pairingCodeAttempts.set(codeDigest, codeAttempt);
      if (codeAttempt.count > glassesPairingMaxAttempts) {
        response.status(429).json(genericError);
        return;
      }
      const glassesSessionId = randomUUID();
      const glassesSession = database.redeemGlassesPairing({
        codeDigest,
        restrictedSessionId: glassesSessionId,
        sessionExpiresAt: new Date(now() + glassesSessionTtlMs).toISOString()
      });
      if (!glassesSession) {
        database.recordUnknownPairingFailure(request.ip);
        response.status(401).json(genericError);
        return;
      }
      pairingCodeAttempts.delete(codeDigest);
      setGlassesAuthCookie(response, glassesSessionId, {
        sessionSecret, sessionTtlMs: glassesSessionTtlMs,
        secureCookies: useSecureCookies || request.secure, now
      });
      response.json({ scope: {
        type: glassesSession.scopeType,
        siteId: glassesSession.scopeSiteId,
        sessionId: glassesSession.scopeSessionId,
        siteName: glassesSession.siteName,
        siteArea: glassesSession.siteArea,
        taskName: glassesSession.taskName,
        expiresAt: glassesSession.expiresAt
      } });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/glasses/session', requireGlassesAuth, (request, response) => {
    const item = request.glassesSession;
    response.json({ scope: {
      type: item.scopeType, siteId: item.scopeSiteId, sessionId: item.scopeSessionId,
      siteName: item.siteName, siteArea: item.siteArea, taskName: item.taskName, expiresAt: item.expiresAt
    } });
  });

  app.post('/api/glasses/logout', (request, response) => {
    clearGlassesAuthCookie(response, useSecureCookies || request.secure);
    response.status(204).end();
  });

  app.post('/api/native-devices/registrations', requireAuth, requireSupervisor, (request, response, next) => {
    try {
      const deviceName = String(request.body?.name ?? '').trim();
      if (!deviceName || deviceName.length > 100) { response.status(400).json({ error: 'Device name must be 1–100 characters.' }); return; }
      const code = String(randomInt(0, 100_000_000)).padStart(8, '0');
      const codeDigest = createHmac('sha256', sessionSecret).update(`native-registration:${code}`).digest('hex');
      const registration = database.createNativeDeviceRegistration({ id: randomUUID(), ownerId: request.user.id, deviceName,
        codeDigest, expiresAt: new Date(now() + nativeRegistrationTtlMs).toISOString(), maxAttempts: 5 });
      response.status(201).json({ registration, code, groupedCode: `${code.slice(0, 4)} ${code.slice(4)}` });
    } catch (error) { next(error); }
  });

  app.post('/api/native-devices/register', authRateLimiter('native-register'), (request, response, next) => {
    try {
      const code = String(request.body?.code ?? '').replace(/\s/g, '');
      if (!/^\d{8}$/.test(code)) { database.recordNativeRegistrationFailure(request.ip); response.status(401).json({ error: 'Registration code is invalid or expired.' }); return; }
      const deviceId = randomUUID();
      const secret = randomBytes(32).toString('base64url');
      const codeDigest = createHmac('sha256', sessionSecret).update(`native-registration:${code}`).digest('hex');
      const device = database.redeemNativeDeviceRegistration({ codeDigest, deviceId, credentialDigest: nativeCredentialDigest(deviceId, secret) });
      if (!device) { database.recordNativeRegistrationFailure(request.ip, codeDigest); response.status(401).json({ error: 'Registration code is invalid or expired.' }); return; }
      response.json({ device: { id: device.id, name: device.name, createdAt: device.createdAt }, credential: `${deviceId}.${secret}` });
    } catch (error) { next(error); }
  });

  app.get('/api/native-devices', requireAuth, requireSupervisor, (request, response) => response.json({ devices: database.listNativeDevicesForOwner(request.user.id) }));
  app.delete('/api/native-devices/:deviceId', requireAuth, requireSupervisor, (request, response) => {
    if (!database.revokeNativeDevice(request.params.deviceId, request.user.id)) { response.status(404).json({ error: 'Resource not found.' }); return; }
    response.status(204).end();
  });
  app.get('/api/native/device', requireNativeDevice, (request, response) => response.json({ device: {
    id: request.nativeDevice.id, name: request.nativeDevice.name, lastSeenAt: request.nativeDevice.lastSeenAt
  } }));

  app.get('/api/glasses/native-device-availability', requireGlassesAuth, (request, response) => {
    response.json({ available: database.hasActiveNativeDevice(request.user.id, new Date(now() - nativeAvailabilityWindowMs).toISOString()) });
  });

  app.post('/api/glasses/evidence-requests', requireGlassesAuth, (request, response, next) => {
    try {
      const sessionId = String(request.body?.sessionId ?? '');
      const hazardId = String(request.body?.hazardId ?? '');
      if (!sessionId || !hazardId || sessionId.length > 200 || hazardId.length > 200) {
        response.status(400).json({ error: 'A valid sessionId and hazardId are required.' }); return;
      }
      const provider = String(request.body?.provider ?? 'phone_browser_camera');
      if (!['phone_browser_camera', 'phone_browser_gallery', 'native_dat_camera'].includes(provider)) {
        response.status(400).json({ error: 'Unsupported evidence provider.' }); return;
      }
      if (provider === 'native_dat_camera' && !database.hasActiveNativeDevice(request.user.id, new Date(now() - nativeAvailabilityWindowMs).toISOString())) {
        response.status(409).json({ error: 'No registered native camera device is available.' }); return;
      }
      const result = database.createEvidenceRequest({ id: randomUUID(), ownerId: request.user.id,
        restrictedSessionId: request.glassesSession.id, sessionId, hazardId,
        expiresAt: new Date(now() + evidenceRequestTtlMs).toISOString(), provider });
      if (!result) { response.status(404).json({ error: 'Resource not found.' }); return; }
      response.status(result.created ? 201 : 200).json(toPublicEvidenceRequest(result.request));
    } catch (error) { next(error); }
  });

  app.post('/api/glasses/evidence-requests/:requestId/ready', requireGlassesAuth, (request, response, next) => {
    try {
      const item = database.markNativeEvidenceRequestReady(request.params.requestId, request.glassesSession.id,
        new Date(now() - nativeAvailabilityWindowMs).toISOString());
      if (!item) { response.status(404).json({ error: 'Resource not found.' }); return; }
      if (item.unavailable) { response.status(409).json({ error: 'No registered native camera device is available.' }); return; }
      response.json(toPublicEvidenceRequest(item));
    } catch (error) { next(error); }
  });

  app.post('/api/glasses/evidence-requests/:requestId/retake', requireGlassesAuth, (request, response, next) => {
    try {
      const item = database.supersedeNativeEvidenceRequest(request.params.requestId, request.glassesSession.id, {
        id: randomUUID(), expiresAt: new Date(now() + evidenceRequestTtlMs).toISOString()
      });
      if (!item) { response.status(409).json({ error: 'Attached or unavailable evidence cannot be retaken.' }); return; }
      response.status(201).json(toPublicEvidenceRequest(item));
    } catch (error) { next(error); }
  });

  app.get('/api/glasses/evidence-requests/:requestId', requireGlassesAuth, (request, response, next) => {
    try {
      const item = database.getEvidenceRequestForGlasses(request.params.requestId, request.glassesSession.id);
      if (!item) { response.status(404).json({ error: 'Resource not found.' }); return; }
      response.json(toPublicEvidenceRequest(item));
    } catch (error) { next(error); }
  });

  app.delete('/api/glasses/evidence-requests/:requestId', requireGlassesAuth, (request, response, next) => {
    try {
      const result = database.cancelEvidenceRequest(request.params.requestId, { restrictedSessionId: request.glassesSession.id });
      if (!result) { response.status(404).json({ error: 'Resource not found.' }); return; }
      if (result.conflict) { response.status(409).json({ error: 'The request can no longer be cancelled.', status: result.status }); return; }
      response.status(204).end();
    } catch (error) { next(error); }
  });

  app.post('/api/glasses/evidence-requests/:requestId/attach', requireGlassesAuth, (request, response, next) => {
    try {
      const result = database.attachEvidenceRequest(request.params.requestId, request.glassesSession.id);
      if (!result) { response.status(404).json({ error: 'Resource not found.' }); return; }
      if (result.conflict) { response.status(409).json({ error: 'Completed evidence is required.', status: result.status }); return; }
      response.json(toPublicEvidenceRequest(result.request));
    } catch (error) { next(error); }
  });

  app.get('/api/evidence-requests', requireAuth, (request, response, next) => {
    try {
      const requestedStatus = String(request.query.status ?? '');
      const items = database.listEvidenceRequestsForOwner(request.user.id)
        .filter((item) => !requestedStatus || item.status === requestedStatus)
        .map(toPublicEvidenceRequest);
      response.json({ requests: items });
    } catch (error) { next(error); }
  });

  app.delete('/api/evidence-requests/:requestId', requireAuth, (request, response, next) => {
    try {
      const result = database.cancelEvidenceRequest(request.params.requestId, { ownerId: request.user.id });
      if (!result) { response.status(404).json({ error: 'Resource not found.' }); return; }
      if (result.conflict) { response.status(409).json({ error: 'The request can no longer be cancelled.', status: result.status }); return; }
      response.status(204).end();
    } catch (error) { next(error); }
  });

  app.post('/api/evidence-requests/:requestId/complete', requireAuth, (request, response, next) => {
    try {
      const uploadId = String(request.body?.uploadId ?? '');
      const provider = String(request.body?.provider ?? '');
      if (!uploadId || uploadId.length > 200 || !isBrowserFulfillmentProvider(provider)) {
        response.status(400).json({ error: 'A valid owned uploadId and implemented provider are required.' }); return;
      }
      const result = database.completeEvidenceRequest({ id: request.params.requestId, ownerId: request.user.id,
        uploadId, provider, sourceCategory: EVIDENCE_SOURCE_CATEGORY[provider] });
      if (!result) { response.status(404).json({ error: 'Resource not found.' }); return; }
      if (result.inaccessible) { response.status(404).json({ error: 'Resource not found.' }); return; }
      if (result.conflict) { response.status(409).json({ error: 'The request cannot be completed.', status: result.status }); return; }
      response.json(toPublicEvidenceRequest(result.request));
    } catch (error) { next(error); }
  });

  app.get('/api/native/capture-requests/next', requireNativeDevice, (request, response, next) => {
    try {
      const item = database.nextNativeCaptureRequest(request.nativeDevice);
      response.json({ request: item ? toPublicEvidenceRequest(item) : null });
    } catch (error) { next(error); }
  });

  app.post('/api/native/capture-requests/:requestId/claim', requireNativeDevice, (request, response, next) => {
    try {
      const result = database.claimNativeCaptureRequest({ requestId: request.params.requestId, device: request.nativeDevice,
        leaseExpiresAt: new Date(now() + nativeClaimLeaseMs).toISOString() });
      if (!result) { response.status(404).json({ error: 'Resource not found.' }); return; }
      if (result.conflict) { response.status(409).json({ error: 'Capture request is already claimed.' }); return; }
      response.json({ claimed: true, leaseExpiresAt: new Date(now() + nativeClaimLeaseMs).toISOString() });
    } catch (error) { next(error); }
  });

  app.patch('/api/native/capture-requests/:requestId/status', requireNativeDevice, (request, response, next) => {
    try {
      const status = String(request.body?.status ?? '');
      const failureCode = String(request.body?.failureCode ?? '').slice(0, 80) || null;
      if (!['capturing','captured','failed','released'].includes(status)) { response.status(400).json({ error: 'Unsupported capture status.' }); return; }
      const result = database.updateNativeClaim(request.params.requestId, request.nativeDevice, status, failureCode,
        new Date(now() + nativeClaimLeaseMs).toISOString());
      if (!result) { response.status(404).json({ error: 'Resource not found.' }); return; }
      if (result.conflict) { response.status(409).json({ error: 'Invalid capture state transition.', status: result.status }); return; }
      response.json(result);
    } catch (error) { next(error); }
  });

  app.post('/api/native/capture-requests/:requestId/upload', requireNativeDevice, (request, response, next) => {
    const claim = database.getNativeClaim(request.params.requestId, request.nativeDevice);
    if (!claim || !['captured','uploaded'].includes(claim.status)) { response.status(404).json({ error: 'Resource not found.' }); return; }
    upload.single('photo')(request, response, async (error) => {
      if (error) { response.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'Image files must be 5MB or smaller.' : 'Only JPEG, PNG, and WebP image uploads are allowed.' }); return; }
      try {
        const file = request.file;
        const detectedMimeType = file ? detectUploadedImageMimeType(file.buffer) : null;
        if (!file || !detectedMimeType || detectedMimeType !== file.mimetype) {
          response.status(400).json({ error: 'Uploaded content is not a valid JPEG, PNG, or WebP image.' }); return;
        }
        if (claim.status === 'uploaded' && claim.upload_id) {
          response.json({ uploadId: claim.upload_id, idempotent: true });
          return;
        }
        const record = { id: randomUUID(), ownerId: request.nativeDevice.ownerId, filename: randomUUID(),
          originalName: 'native-dat-capture', mimeType: detectedMimeType, size: file.size,
          hash: `sha256:${createHash('sha256').update(file.buffer).digest('hex')}`, uploadedAt: new Date(now()).toISOString() };
        const filePath = path.join(uploadsDir, record.filename);
        await writeFile(filePath, file.buffer, { flag: 'wx', mode: 0o600 });
        try {
          database.createEvidenceUploads([record], request.nativeDevice.ownerId, 'sdk_raw_camera');
          const linked = database.setNativeClaimUpload(request.params.requestId, request.nativeDevice, record.id);
          if (!linked || linked.conflict) throw new Error('Native claim upload linkage failed.');
          response.status(201).json({ uploadId: record.id, mimeType: detectedMimeType, size: file.size });
        } catch (storageError) {
          database.deleteAbandonedUpload(record.id);
          await unlink(filePath).catch(() => {});
          throw storageError;
        }
      } catch (uploadError) { next(uploadError); }
    });
  });

  app.post('/api/native/capture-requests/:requestId/complete', requireNativeDevice, (request, response, next) => {
    try {
      const uploadId = String(request.body?.uploadId ?? '');
      if (!uploadId || uploadId.length > 200) { response.status(400).json({ error: 'A valid uploadId is required.' }); return; }
      const result = database.completeNativeCapture(request.params.requestId, request.nativeDevice, uploadId);
      if (!result) { response.status(404).json({ error: 'Resource not found.' }); return; }
      if (result.conflict) { response.status(409).json({ error: 'The capture request cannot be completed.' }); return; }
      response.json(toPublicEvidenceRequest(result.request));
    } catch (error) { next(error); }
  });

  // ---------------------------------------------------------------------------
  // Session / upload / AI / report routes
  // ---------------------------------------------------------------------------
  // All current and future routes under these namespaces are authenticated by
  // default. Route authors cannot accidentally omit authorization per handler.
  app.use('/api/sessions', requireSessionAuth);
  app.use(['/api/uploads', '/api/ai'], requireAuth);

  app.delete('/api/account', requireAuth, async (request, response, next) => {
    try {
      const password = String(request.body?.password ?? '');
      if (!password || password.length > 128 || !(await bcrypt.compare(password, request.user.passwordHash ?? DUMMY_PASSWORD_HASH))) {
        response.status(401).json({ error: 'Password confirmation failed.' });
        return;
      }
      if (!database.deactivateUser(request.user.id)) {
        response.status(404).json({ error: 'Resource not found.' });
        return;
      }
      clearAuthCookie(response, useSecureCookies || request.secure);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

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

      if (request.authKind === 'glasses') {
        const scope = request.glassesSession;
        const submittedSite = request.body?.site ?? {};
        const allowed = scope.scopeType === 'tbm_session'
          ? request.body.sessionId === scope.scopeSessionId
          : submittedSite.siteName === scope.siteName && submittedSite.siteArea === scope.siteArea;
        if (!allowed) {
          response.status(404).json({ error: 'Resource not found.' });
          return;
        }
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
        if (file.originalname.length > 255) {
          response.status(400).json({ error: 'Image filenames must be 255 characters or fewer.' });
          return;
        }
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
    const { entryType, uploadId, sessionId } = request.body ?? {};

    if (String(uploadId ?? '').length > 200 || String(sessionId ?? '').length > 200) {
      response.status(400).json({ error: 'Analysis identifiers exceed allowed lengths.' });
      return;
    }

    if (!['new_hazard', 'near_miss'].includes(entryType)) {
      response.status(400).json({ error: 'entryType must be new_hazard or near_miss.' });
      return;
    }

    if (typeof uploadId !== 'string' || !uploadId.trim()) {
      response.status(400).json({ error: 'A valid owned uploadId is required for analysis.' });
      return;
    }

    try {
      const uploadRecord = database.getUploadForOwner(uploadId, request.user.id);
      if (!uploadRecord) {
        response.status(404).json({ error: 'Resource not found.' });
        return;
      }
      let ownedSessionId = null;
      if (sessionId) {
        const sessionOwner = database.getSessionOwner(String(sessionId));
        if (sessionOwner && sessionOwner !== request.user.id) {
          response.status(404).json({ error: 'Resource not found.' });
          return;
        }
        if (sessionOwner === request.user.id) ownedSessionId = String(sessionId);
      }

      let imageBytes;
      try {
        imageBytes = await readFile(path.join(uploadsDir, uploadRecord.filename));
      } catch (error) {
        if (error.code === 'ENOENT') {
          response.status(404).json({ error: 'Resource not found.' });
          return;
        }
        throw error;
      }
      const actualHash = `sha256:${createHash('sha256').update(imageBytes).digest('hex')}`;
      if (actualHash !== uploadRecord.hash || detectUploadedImageMimeType(imageBytes) !== uploadRecord.mimeType) {
        response.status(400).json({ error: 'Evidence image failed integrity validation.' });
        return;
      }

      const requestedAt = new Date(now()).toISOString();
      let providerResult;
      try {
        providerResult = normalizeProviderResult(await analysisProvider.analyze({ entryType, upload: uploadRecord, imageBytes }));
      } catch (providerError) {
        response.status(502).json({ error: 'Image suggestion provider failed. Original evidence was retained.' });
        return;
      }
      const completedAt = new Date(now()).toISOString();
      const analysis = database.createAiAnalysis({
        analysisId: randomUUID(), ownerId: request.user.id, uploadId, sessionId: ownedSessionId,
        entryType, mode: providerResult.mode, provider: providerResult.provider, modelVersion: providerResult.modelVersion,
        requestedAt, completedAt, suggestion: providerResult.suggestion
      }, request.user.id);
      response.json({
        ...toPublicAiAnalysis(analysis),
        uploadHash: uploadRecord.hash,
        simulated: providerResult.simulated,
        pixelInterpretation: providerResult.pixelInterpretation,
        disclaimer: providerResult.disclaimer,
        requiresHumanReview: true
      });
    } catch (error) {
      next(error);
    }
  });

  app.patch('/api/ai/analyses/:analysisId/review', (request, response, next) => {
    try {
      const decision = String(request.body?.decision ?? '');
      if (!['accepted', 'edited', 'rejected'].includes(decision)) {
        response.status(400).json({ error: 'decision must be accepted, edited, or rejected.' });
        return;
      }
      const editedSuggestion = decision === 'edited' ? normalizeEditedSuggestion(request.body?.editedSuggestion) : null;
      if (decision === 'edited' && !editedSuggestion) {
        response.status(400).json({ error: 'A complete editedSuggestion is required for an edited decision.' });
        return;
      }
      const analysis = database.reviewAiAnalysis({
        analysisId: request.params.analysisId, ownerId: request.user.id, decision, editedSuggestion,
        reviewerUserId: request.user.id, reviewer: request.user.name
      });
      if (!analysis) {
        response.status(404).json({ error: 'Resource not found.' });
        return;
      }
      response.json(toPublicAiAnalysis(analysis));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/sessions', async (request, response, next) => {
    try {
      const sessions = database.listSessionsForOwner(request.user.id).map(normalizeSession);
      response.json(request.authKind === 'glasses'
        ? sessions.filter((session) => isWithinGlassesScope(request.glassesSession, session))
        : sessions);
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/sessions/:sessionId/report', async (request, response, next) => {
    try {
      const storedSession = database.getSessionForOwner(request.params.sessionId, request.user.id);
      const session = storedSession ? normalizeSession(storedSession) : null;
      const reportLocale = normalizeLocale(request.query.lang);
      const reportT = createTranslator(reportLocale);

      if (!session || (request.authKind === 'glasses' && !isWithinGlassesScope(request.glassesSession, session))) {
        response.status(404).type('html').send(`<!doctype html>
  <html lang="${reportLocale}">
    <head>
      <meta charset="utf-8" />
      <title>${reportT('report.notFound')}</title>
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
      <h1>${reportT('report.notFound')}</h1>
      <p>${reportT('report.notFoundDescription')}</p>
    </body>
  </html>`);
        return;
      }

      response.type('html').send(renderSessionReport(session, reportLocale));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/sessions/:sessionId', async (request, response, next) => {
    try {
      const storedSession = database.getSessionForOwner(request.params.sessionId, request.user.id);
      const session = storedSession ? normalizeSession(storedSession) : null;

      if (!session || (request.authKind === 'glasses' && !isWithinGlassesScope(request.glassesSession, session))) {
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

  app.use((error, request, response, _next) => {
    if (error?.type === 'entity.parse.failed') {
      response.status(400).json({ error: 'Malformed JSON request.', requestId: request.requestId });
      return;
    }
    if (error?.type === 'entity.too.large') {
      response.status(413).json({ error: 'Request body is too large.', requestId: request.requestId });
      return;
    }
    logger.error(JSON.stringify({
      level: 'error', event: 'request_failed', requestId: request.requestId,
      method: request.method, path: sanitizeRequestPath(request.originalUrl), errorType: error?.name ?? 'Error'
    }));
    response.status(500).json({ error: 'Internal server error.', requestId: request.requestId });
  });

  return app;
}

export function startServer(options = {}) {
  const { environment = process.env, logger = console } = options;
  const config = validateEnvironment(environment, PROJECT_ROOT);
  const { port = config.port, host = config.host, shutdownTimeoutMs = config.shutdownTimeoutMs,
    abandonedUploadTtlHours = config.abandonedUploadTtlHours,
    retentionCleanupIntervalMinutes = config.retentionCleanupIntervalMinutes,
    environment: _environment, logger: _logger, ...appOverrides } = options;
  const app = createApp({
    databasePath: config.databasePath, uploadsDir: config.uploadsDir, registrationKey: config.registrationKey,
    sessionSecret: config.sessionSecret, nodeEnv: config.nodeEnv, sessionTtlMs: config.sessionTtlMs,
    glassesPairingTtlMs: config.glassesPairingTtlMs, glassesSessionTtlMs: config.glassesSessionTtlMs,
    glassesPairingMaxAttempts: config.glassesPairingMaxAttempts,
    aiMode: config.aiMode, trustProxy: config.trustProxy, devTunnelOrigin: config.devTunnelOrigin, logger, ...appOverrides
  });
  const httpServer = app.listen(port, host, () => {
    logger.info(JSON.stringify({ level: 'info', event: 'server_listening', host, port }));
  });

  const cleanup = () => app.locals.runRetentionCleanup({
    cutoff: new Date(Date.now() - abandonedUploadTtlHours * 60 * 60 * 1000).toISOString()
  }).then((result) => {
    if (result.deleted || result.expiredPairings) logger.info(JSON.stringify({ level: 'info', event: 'retention_cleanup', ...result }));
  }).catch((error) => logger.error(JSON.stringify({ level: 'error', event: 'retention_cleanup_failed', errorType: error.name })));
  void cleanup();
  const cleanupTimer = setInterval(cleanup, retentionCleanupIntervalMinutes * 60 * 1000);
  cleanupTimer.unref();

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.locals.isShuttingDown = true;
    clearInterval(cleanupTimer);
    logger.info(JSON.stringify({ level: 'info', event: 'server_shutdown_started', signal }));
    const forcedExit = setTimeout(() => {
      logger.error(JSON.stringify({ level: 'error', event: 'server_shutdown_timeout' }));
      process.exitCode = 1;
      httpServer.closeAllConnections?.();
    }, shutdownTimeoutMs);
    forcedExit.unref();
    httpServer.close((error) => {
      clearTimeout(forcedExit);
      app.locals.closeDatabase();
      if (error) process.exitCode = 1;
    });
    httpServer.closeIdleConnections?.();
  };
  httpServer.shutdown = shutdown;
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  httpServer.on('error', (error) => {
    clearInterval(cleanupTimer);
    app.locals.closeDatabase();
    process.removeListener('SIGTERM', shutdown);
    process.removeListener('SIGINT', shutdown);
    logger.error(JSON.stringify({ level: 'error', event: 'server_start_failed', host, port, errorType: error.name }));
    process.exitCode = 1;
  });
  httpServer.on('close', () => {
    clearInterval(cleanupTimer);
    app.locals.closeDatabase();
    process.removeListener('SIGTERM', shutdown);
    process.removeListener('SIGINT', shutdown);
  });

  return httpServer;
}
