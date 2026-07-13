export function isGlassesPreview(search: string): boolean {
  return new URLSearchParams(search).get('mode') === 'glasses';
}

export const GLASSES_STEP = Object.freeze({
  START: 'start',
  CONTEXT_CONFIRMATION: 'context_confirmation',
  ATTENDANCE: 'attendance',
  HAZARD_DECISION: 'hazard_decision',
  CORRECTIVE_ACTION: 'corrective_action',
  PHOTO_EVIDENCE: 'photo_evidence',
  HAZARD_CONFIRMATION: 'hazard_confirmation',
  HAZARD_SUMMARY: 'hazard_summary',
  SHARING_RECORD: 'sharing_record',
  RECORDING: 'recording',
  CONFLICT: 'conflict',
  COMPLETE: 'complete'
});

const LEGACY_STEPS: Record<string, string> = {
  intro: GLASSES_STEP.START,
  workers: GLASSES_STEP.ATTENDANCE,
  hazard: GLASSES_STEP.HAZARD_DECISION,
  hazard_details: GLASSES_STEP.HAZARD_DECISION,
  action_details: GLASSES_STEP.CORRECTIVE_ACTION,
  manual_actions: GLASSES_STEP.PHOTO_EVIDENCE,
  memo: GLASSES_STEP.PHOTO_EVIDENCE,
  photo: GLASSES_STEP.PHOTO_EVIDENCE,
  summary: GLASSES_STEP.HAZARD_SUMMARY,
  summary_incomplete: GLASSES_STEP.SHARING_RECORD,
  summary_ready: GLASSES_STEP.SHARING_RECORD,
  save_queued: GLASSES_STEP.COMPLETE,
  completion: GLASSES_STEP.COMPLETE
};

export function normalizeGlassesStep(value: unknown, { phase = 'start' }: { phase?: string } = {}) {
  const step = typeof value === 'string' ? (LEGACY_STEPS[value] ?? value) : '';
  if ((Object.values(GLASSES_STEP) as string[]).includes(step)) return step;
  if (phase === 'checklist') return GLASSES_STEP.HAZARD_DECISION;
  if (phase === 'summary') return GLASSES_STEP.HAZARD_SUMMARY;
  return GLASSES_STEP.START;
}

export function attendanceValue(tens: unknown, ones: unknown): number {
  const safeDigit = (value: unknown) => Math.max(0, Math.min(9, Number(value) || 0));
  return safeDigit(tens) * 10 + safeDigit(ones);
}

export function splitAttendanceValue(value: unknown): [number, number] {
  const safe = Math.max(0, Math.min(99, Number(value) || 0));
  return [Math.floor(safe / 10), safe % 10];
}

export function isAttendanceSummaryValid(summary: any): boolean {
  return Number.isInteger(summary?.expectedCount) && Number.isInteger(summary?.presentCount) &&
    summary.expectedCount >= 0 && summary.expectedCount <= 99 && summary.presentCount >= 0 &&
    summary.presentCount <= summary.expectedCount;
}

export function evidenceSourceLabel(source: unknown): string {
  return ({
    sdk_raw_camera: 'Raw camera photo', external_upload: 'Unverified external source',
    browser_file_picker: 'Unverified external source', browser_preview_mock: 'Browser preview mock',
    unknown_legacy_source: 'Unknown legacy source'
  } as Record<string, string>)[String(source)] ?? 'Unknown legacy source';
}

export function compactHudText(value: unknown, maximumCharacters = 54) {
  const full = String(value ?? '').trim();
  const characters = Array.from(full);
  const truncated = characters.length > maximumCharacters;
  return { full, primary: truncated ? `${characters.slice(0, Math.max(1, maximumCharacters - 1)).join('')}…` : full, truncated };
}

export function buildPrimaryHazardModel({ title, location, current, total }:
  { title: unknown; location: unknown; current: number; total: number }) {
  return { title: compactHudText(title, 56), location: compactHudText(location, 42), current, total,
    decisions: ['controlled', 'action_required'] as const };
}

export function reducePreviewHelp(open: boolean, key: string): boolean {
  if (key === '?' || key.toLowerCase() === 'h') return !open;
  if (key === 'Escape' && open) return false;
  return open;
}

export function glassesSyncState(status: string) {
  if (status === 'conflict') return { key: 'sync.conflict', tone: 'conflict' };
  if (status === 'synced') return { key: 'sync.synced', tone: 'synced' };
  if (status === 'syncing') return { key: 'sync.syncing', tone: 'syncing' };
  if (status === 'failed') return { key: 'sync.failed', tone: 'failed' };
  if (status === 'queued') return { key: 'sync.queued', tone: 'queued' };
  return { key: 'sync.deviceOnly', tone: 'device' };
}

export function transitionGlassesStep(step: string, event: string) {
  const forward: Record<string, Record<string, string>> = {
    [GLASSES_STEP.START]: { start: GLASSES_STEP.CONTEXT_CONFIRMATION, continue: GLASSES_STEP.CONTEXT_CONFIRMATION },
    [GLASSES_STEP.CONTEXT_CONFIRMATION]: { confirm: GLASSES_STEP.ATTENDANCE, reject: GLASSES_STEP.START },
    [GLASSES_STEP.ATTENDANCE]: { continue: GLASSES_STEP.HAZARD_DECISION },
    [GLASSES_STEP.HAZARD_DECISION]: { controlled: GLASSES_STEP.PHOTO_EVIDENCE, action_required: GLASSES_STEP.CORRECTIVE_ACTION },
    [GLASSES_STEP.CORRECTIVE_ACTION]: { continue: GLASSES_STEP.PHOTO_EVIDENCE },
    [GLASSES_STEP.PHOTO_EVIDENCE]: { continue: GLASSES_STEP.HAZARD_CONFIRMATION },
    [GLASSES_STEP.HAZARD_CONFIRMATION]: { summary: GLASSES_STEP.HAZARD_SUMMARY, next: GLASSES_STEP.HAZARD_DECISION },
    [GLASSES_STEP.HAZARD_SUMMARY]: { continue: GLASSES_STEP.SHARING_RECORD },
    [GLASSES_STEP.SHARING_RECORD]: { continue: GLASSES_STEP.RECORDING },
    [GLASSES_STEP.RECORDING]: { complete: GLASSES_STEP.COMPLETE }
  };
  if (event === 'back') {
    const back: Record<string, string> = {
      [GLASSES_STEP.CONTEXT_CONFIRMATION]: GLASSES_STEP.START,
      [GLASSES_STEP.ATTENDANCE]: GLASSES_STEP.CONTEXT_CONFIRMATION,
      [GLASSES_STEP.CORRECTIVE_ACTION]: GLASSES_STEP.HAZARD_DECISION,
      [GLASSES_STEP.PHOTO_EVIDENCE]: GLASSES_STEP.HAZARD_DECISION,
      [GLASSES_STEP.HAZARD_CONFIRMATION]: GLASSES_STEP.PHOTO_EVIDENCE,
      [GLASSES_STEP.HAZARD_SUMMARY]: GLASSES_STEP.HAZARD_CONFIRMATION,
      [GLASSES_STEP.SHARING_RECORD]: GLASSES_STEP.HAZARD_SUMMARY
    };
    return back[step] ?? step;
  }
  return forward[step]?.[event] ?? step;
}

export function normalBrowserUrl(currentUrl: string): string {
  const url = new URL(currentUrl); url.searchParams.delete('mode'); return url.toString();
}

export function createMockGlassesEvidence(hazardNumber: number) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#f2f4f6"/><text x="160" y="95" text-anchor="middle" font-family="Arial" font-size="20">Browser preview mock</text></svg>`;
  const now = new Date().toISOString();
  return { uploadId: crypto.randomUUID(), originalName: `browser_preview_mock_${hazardNumber}.svg`, size: svg.length,
    mimetype: 'image/svg+xml', url: `data:image/svg+xml,${encodeURIComponent(svg)}`, uploadedAt: now,
    deviceObservedAt: now, source: 'browser_preview_mock' };
}
