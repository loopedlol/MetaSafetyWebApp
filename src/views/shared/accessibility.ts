export const STATUS_SYMBOLS = Object.freeze({
  success: '✓',
  warning: '!',
  danger: '!',
  neutral: '•'
});

export function statusSymbol(tone: string): string {
  return STATUS_SYMBOLS[tone as keyof typeof STATUS_SYMBOLS] ?? STATUS_SYMBOLS.neutral;
}

export function conciseAnnouncement({
  feedback = '',
  status = '',
  statusLabel = ''
}: { feedback?: unknown; status?: string; statusLabel?: unknown } = {}): string {
  const cleanFeedback = String(feedback ?? '').trim();
  if (cleanFeedback) return cleanFeedback;
  if (['device_only', 'queued', 'syncing', 'synced', 'failed', 'conflict'].includes(status)) {
    return String(statusLabel ?? '').trim();
  }
  return '';
}

export function viewFocusSelector(phase: string): string {
  if (phase === 'auth') return '[data-auth-tab][aria-selected="true"]';
  return '[data-view-heading]';
}

export function hasUnsavedManualEntry(values: Record<string, unknown>): boolean {
  return ['title', 'location', 'description', 'actionText', 'evidencePhotos'].some((key) => {
    const value = values[key];
    if (typeof FileList !== 'undefined' && value instanceof FileList) return value.length > 0;
    if (Array.isArray(value)) return value.length > 0;
    return String(value ?? '').trim().length > 0;
  });
}
