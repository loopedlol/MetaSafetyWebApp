import {
  hazardStatuses,
  sharingStatuses,
  syncOperationTypes,
  syncStatuses,
  type OfflineDraftRecord,
  type QueuedOperation,
  type TbmSessionRecord
} from '../types/contracts.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isHazardStatus(value: unknown): boolean {
  return typeof value === 'string' && hazardStatuses.includes(value as never);
}

export function isSharingStatus(value: unknown): boolean {
  return typeof value === 'string' && sharingStatuses.includes(value as never);
}

export function isSyncStatus(value: unknown): boolean {
  return typeof value === 'string' && syncStatuses.includes(value as never);
}

export function isSyncOperationType(value: unknown): boolean {
  return typeof value === 'string' && syncOperationTypes.includes(value as never);
}

export function validateSessionBoundary(value: unknown): value is TbmSessionRecord {
  if (!isRecord(value)) return false;
  return ['sessionId', 'sessionType'].every((key) => typeof value[key] === 'string') &&
    ['site', 'work', 'supervisor'].every((key) => isRecord(value[key])) &&
    ['workers', 'hazards', 'nearMisses'].every((key) => Array.isArray(value[key]));
}

export function validatePublicUserBoundary(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return ['id', 'name', 'email', 'role'].every((key) => typeof value[key] === 'string');
}

export function validateOfflineDraftBoundary(value: unknown): value is OfflineDraftRecord {
  if (!isRecord(value) || !isRecord(value.session)) return false;
  return typeof value.version === 'number' &&
    typeof value.session.sessionId === 'string' &&
    Array.isArray(value.workers) && Array.isArray(value.responses) && Array.isArray(value.nearMisses) &&
    (value.syncStatus === undefined || isSyncStatus(value.syncStatus));
}

export function validateQueuedOperationBoundary(value: unknown): value is QueuedOperation {
  if (!isRecord(value)) return false;
  return ['operationId', 'entityId', 'sessionId', 'deviceObservedAt'].every((key) => typeof value[key] === 'string') &&
    isSyncOperationType(value.type) && isSyncStatus(value.status) &&
    typeof value.retryCount === 'number' && isRecord(value.payload);
}

export function parseJsonBoundary(value: string): unknown {
  return JSON.parse(value) as unknown;
}
