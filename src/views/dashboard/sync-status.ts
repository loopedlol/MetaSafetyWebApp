import { SYNC_STATUS } from '../../storage/offline-store.ts';
import type { SyncStatus } from '../../types/contracts.ts';
import type { createTranslator } from '../../i18n/index.ts';

export const DRAFT_STATUS_TEXT = Object.freeze({
  CLEARED: 'cleared', DEVICE_ONLY: SYNC_STATUS.DEVICE_ONLY, QUEUED: SYNC_STATUS.QUEUED,
  SYNCING: SYNC_STATUS.SYNCING, SYNCED: SYNC_STATUS.SYNCED, FAILED: SYNC_STATUS.FAILED,
  CONFLICT: SYNC_STATUS.CONFLICT, UNAVAILABLE: 'unavailable', RESTORED: 'restored', FOUND: 'found'
});

export function syncStatusForLabel(label: string): SyncStatus {
  return Object.values(SYNC_STATUS).includes(label as SyncStatus) ? label as SyncStatus : SYNC_STATUS.DEVICE_ONLY;
}

export function draftStatusLabel(status: string, t: ReturnType<typeof createTranslator>): string {
  const keys: Record<string, string> = {
    cleared: 'sync.cleared', device_only: 'sync.deviceOnly', queued: 'sync.queued', syncing: 'sync.syncing',
    synced: 'sync.synced', failed: 'sync.failed', conflict: 'sync.conflict', unavailable: 'sync.unavailable',
    restored: 'sync.restored', found: 'sync.found'
  };
  return t(keys[status] ?? status);
}
