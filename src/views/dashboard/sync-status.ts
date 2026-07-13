import { SYNC_STATUS } from '../../storage/offline-store.ts';
import type { SyncStatus } from '../../types/contracts.ts';

export const DRAFT_STATUS_TEXT = Object.freeze({
  CLEARED: 'Device draft removed', DEVICE_ONLY: 'Recorded on this device only', QUEUED: 'Queued for synchronization',
  SYNCING: 'Synchronizing with server', SYNCED: 'Synchronized to server',
  FAILED: 'Synchronization failed — local record retained',
  CONFLICT: 'Conflict requires review — server was not overwritten', UNAVAILABLE: 'Offline storage unavailable',
  RESTORED: 'Restored from this device', FOUND: 'Device draft available'
});

export function syncStatusForLabel(label: string): SyncStatus {
  const values: Partial<Record<string, SyncStatus>> = {
    [DRAFT_STATUS_TEXT.QUEUED]: SYNC_STATUS.QUEUED,
    [DRAFT_STATUS_TEXT.SYNCING]: SYNC_STATUS.SYNCING,
    [DRAFT_STATUS_TEXT.SYNCED]: SYNC_STATUS.SYNCED,
    [DRAFT_STATUS_TEXT.FAILED]: SYNC_STATUS.FAILED,
    [DRAFT_STATUS_TEXT.CONFLICT]: SYNC_STATUS.CONFLICT
  };
  return values[label] ?? SYNC_STATUS.DEVICE_ONLY;
}
