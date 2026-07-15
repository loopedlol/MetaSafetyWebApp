import { validateSessionBoundary } from '../../src/domain/validation.ts';

const REQUIRED_FIELDS = ['sessionId', 'sessionType', 'site', 'work', 'supervisor', 'workers', 'hazards'] as const;

const ARRAY_LIMITS: Record<string, number> = {
  workers: 200,
  hazards: 200,
  nearMisses: 100,
  evidencePhotos: 10,
  closureEvidence: 20,
  workerFeedback: 100
};
const SHORT_FIELDS = /(^id$|Id$|sessionType|status|source|role|riskLevel|category|mimeType|proofType|method)$/;
const MEDIUM_FIELDS = /(name|title|email|location|recipients|assignedTo|verifiedBy|reportedBy|originalName)$/;

export function validatePayloadBounds(value: unknown, key = 'payload', depth = 0): string | null {
  if (depth > 10) return 'Session payload nesting exceeds 10 levels.';
  if (typeof value === 'string') {
    const maximum = key === 'url' && value.startsWith('data:image/svg+xml') ? 100_000 : SHORT_FIELDS.test(key) ? 200 : MEDIUM_FIELDS.test(key) ? 500 : 10_000;
    return value.length <= maximum ? null : `${key} exceeds the maximum length of ${maximum} characters.`;
  }
  if (Array.isArray(value)) {
    const maximum = ARRAY_LIMITS[key] ?? 200;
    if (value.length > maximum) return `${key} exceeds the maximum of ${maximum} items.`;
    for (const item of value) {
      const error = validatePayloadBounds(item, key, depth + 1);
      if (error) return error;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 100) return `${key} exceeds the maximum of 100 properties.`;
    for (const [childKey, child] of entries) {
      if (childKey.length > 100) return 'A property name exceeds 100 characters.';
      const error = validatePayloadBounds(child, childKey, depth + 1);
      if (error) return error;
    }
  }
  return null;
}

export function validateSessionPayload(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'Session payload must be a JSON object.';
  }
  const session = value as Record<string, unknown>;
  const boundsError = validatePayloadBounds(session);
  if (boundsError) return boundsError;
  const missingFields = REQUIRED_FIELDS.filter((field) => !(field in session) || session[field] == null);
  if (missingFields.length) return `Missing required field(s): ${missingFields.join(', ')}.`;
  if (typeof session.site !== 'object' || Array.isArray(session.site)) return 'site must be an object.';
  if (typeof session.work !== 'object' || Array.isArray(session.work)) return 'work must be an object.';
  if (typeof session.supervisor !== 'object' || Array.isArray(session.supervisor)) return 'supervisor must be an object.';
  if (!Array.isArray(session.workers)) return 'workers must be an array.';
  if (!Array.isArray(session.hazards)) return 'hazards must be an array.';
  if (session.nearMisses != null && !Array.isArray(session.nearMisses)) return 'nearMisses must be an array.';
  if (typeof session.sessionId !== 'string' || !session.sessionId.trim()) return 'sessionId must be a non-empty string.';
  return validateSessionBoundary(session) ? null : 'Session payload is invalid.';
}
