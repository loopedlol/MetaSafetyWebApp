export const hazardStatuses = ['controlled', 'action_required', 'not_checked'] as const;
export type HazardStatus = (typeof hazardStatuses)[number];

export const verificationStatuses = ['open', 'verified'] as const;
export type VerificationStatus = (typeof verificationStatuses)[number];

export const workStatuses = ['stopped', 'permitted_with_controls'] as const;
export type WorkStatus = (typeof workStatuses)[number];

export const sharingStatuses = ['not_recorded', 'not_shared', 'shared'] as const;
export type SharingStatus = (typeof sharingStatuses)[number];

export const syncStatuses = ['device_only', 'queued', 'syncing', 'synced', 'failed', 'conflict'] as const;
export type SyncStatus = (typeof syncStatuses)[number];

export const syncOperationTypes = [
  'session_upsert',
  'attendance_acknowledgment',
  'hazard_review',
  'corrective_action',
  'sharing_event',
  'evidence_upload'
] as const;
export type SyncOperationType = (typeof syncOperationTypes)[number];

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  role: string;
  createdAt?: string;
}

export interface PersistedUser extends PublicUser {
  passwordHash: string;
  createdAt: string;
}

export interface AuthenticationSessionPayload {
  userId: string;
  issuedAt: number;
  expiresAt: number;
}

export interface SiteRecord {
  id?: string;
  ownerId?: string;
  siteName: string;
  siteArea: string;
  gps?: { latitude?: number | null; longitude?: number | null; accuracyMeters?: number | null };
}

export interface WorkerAcknowledgment {
  supervisorRecorded: boolean;
  supervisorRecordedBy: string | null;
  supervisorRecordedAt: string | null;
  source: string | null;
  independentlyVerified: boolean;
  independentlyVerifiedBy: string | null;
  independentlyVerifiedAt: string | null;
  independentVerificationMethod: string | null;
}

export interface WorkerRecord {
  id: string;
  name: string;
  role: string;
  present: boolean;
  acknowledged?: boolean;
  acknowledgment: WorkerAcknowledgment;
}

export interface EvidenceRecord {
  id?: string;
  uploadId?: string;
  localEvidenceId?: string;
  originalName?: string;
  mimeType?: string;
  mimetype?: string;
  size?: number;
  uploadedAt?: string;
  deviceObservedAt?: string;
  source?: string;
  url?: string;
}

export interface PersistedEvidenceUpload extends EvidenceRecord {
  id: string;
  ownerId: string;
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  hash: string;
  uploadedAt: string;
}

export interface AiSuggestionRecord {
  title: string;
  category: string;
  riskLevel: 'low' | 'medium' | 'high';
  description: string;
  recommendedAction: string;
  confidence: number | null;
}

export interface AiAnalysisRecord {
  analysisId: string;
  uploadId: string;
  uploadHash?: string;
  sessionId?: string | null;
  entryType: 'new_hazard' | 'near_miss';
  mode: string;
  provider: string;
  modelVersion: string | null;
  requestedAt: string;
  completedAt: string;
  suggestion: AiSuggestionRecord;
  humanDecision: 'pending' | 'accepted' | 'edited' | 'rejected';
  editedSuggestion?: AiSuggestionRecord | null;
  reviewer?: string | null;
  reviewedAt?: string | null;
  simulated?: boolean;
  pixelInterpretation?: boolean;
  disclaimer?: string;
  requiresHumanReview?: boolean;
}

export interface AttendanceRecord {
  sessionId: string;
  workerId: string;
  ownerId: string;
  present: boolean;
  recordedByUserId: string;
  recordedAt: string;
}

export interface AcknowledgmentRecord {
  id: string;
  sessionId: string;
  workerId: string;
  ownerId: string;
  acknowledgmentType: 'supervisor_recorded' | 'independently_verified';
  recordedByUserId: string;
  recordedAt: string;
  clientObservedAt?: string | null;
}

export interface CorrectiveActionRecord {
  required: boolean;
  immediateControl: string;
  assignedTo: string;
  dueAt: string;
  workStatus: WorkStatus | '';
  verificationStatus: VerificationStatus;
  verifiedBy: string;
  verifiedAt: string | null;
  closureEvidence: string[];
  immediateResponseCategory?: string;
  responsibleParty?: string;
  duePeriod?: string;
}

export interface HumanReviewRecord {
  reviewed: boolean;
  decision: HazardStatus;
  reviewedBy: string | null;
  reviewedAt: string | null;
}

export interface HazardRecord {
  id: string;
  source?: string;
  title: string;
  category?: string;
  location?: string;
  riskLevel?: string;
  riskDescription?: string;
  recommendedAction?: string;
  evidencePhotos: EvidenceRecord[];
  status: HazardStatus;
  memo?: string;
  updatedAt?: string | null;
  humanReview: HumanReviewRecord;
  correctiveAction: CorrectiveActionRecord;
  aiSuggestion?: Record<string, unknown> | null;
}

export interface SharingRecord {
  status: SharingStatus;
  method: string;
  recipients: string;
  sharedAt: string | null;
  acknowledgmentResults: string;
  clientObservedSharedAt?: string | null;
  proofType?: string;
}

export interface SharingEventRecord extends SharingRecord {
  id: string;
  sessionId: string;
  ownerId: string;
  actorUserId: string;
  recordedAt: string;
}

export interface NearMissRecord {
  id: string;
  source?: string;
  title: string;
  category?: string;
  location?: string;
  riskLevel?: string;
  description?: string;
  actionTaken?: string;
  evidencePhotos: EvidenceRecord[];
  reportedBy?: string;
  reportedAt?: string;
  aiSuggestion?: Record<string, unknown> | null;
}

export interface AuditEventRecord {
  id: string;
  entityType: string;
  entityId: string;
  action: string;
  actorUserId: string | null;
  serverTimestamp: string;
  metadata: Record<string, unknown>;
  previousEventHash: string | null;
  currentEventHash: string;
}

export interface TbmSessionRecord {
  schemaVersion?: string;
  sessionId: string;
  sessionType: string;
  ownerId?: string;
  revision?: number;
  status?: 'draft' | 'actions_open' | 'completed';
  site: SiteRecord;
  work: Record<string, unknown> & { taskName?: string };
  supervisor: Record<string, unknown> & { name?: string; role?: string };
  workers: WorkerRecord[];
  attendanceSummary?: { expectedCount: number; presentCount: number; captureSource: string; deviceObservedAt: string | null } | null;
  hazards: HazardRecord[];
  nearMisses: NearMissRecord[];
  sharing: SharingRecord;
  device?: Record<string, unknown>;
  createdBy?: PublicUser;
  createdAt?: string | null;
  startedAt?: string | null;
  savedAt?: string | null;
  finalizedAt?: string | null;
  completedAt?: string | null;
  exportedAt?: string | null;
  [key: string]: unknown;
}

export interface OfflineDraftRecord {
  id: string;
  ownerId?: string | null;
  version: number;
  session: Record<string, unknown> & { sessionId: string };
  workers: WorkerRecord[];
  hazards?: Array<Record<string, unknown>>;
  responses: HazardRecord[];
  nearMisses: Array<Record<string, unknown>>;
  syncStatus: SyncStatus;
  serverRevision?: number;
  deviceObservedAt?: string;
  deviceUpdatedAt?: string;
  migratedFromLocalStorage?: boolean;
  [key: string]: unknown;
}

export interface QueuedOperation {
  operationId: string;
  ownerId?: string;
  type: SyncOperationType;
  entityId: string;
  sessionId: string;
  payload: Record<string, unknown>;
  baseRevision: number;
  deviceObservedAt: string;
  retryCount: number;
  lastError: string | null;
  status: SyncStatus;
  dependsOnEvidenceIds: string[];
  createdAt: string;
  updatedAt: string;
  conflict?: { serverRevision?: number; serverSession?: TbmSessionRecord } | null;
  result?: unknown;
}

export interface ApiErrorResponse {
  error: string;
  blockers?: string[];
  conflict?: { serverRevision: number; serverSession: TbmSessionRecord | null };
}
