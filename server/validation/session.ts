import { validateSessionBoundary } from '../../src/domain/validation.ts';

const REQUIRED_FIELDS = ['sessionId', 'sessionType', 'site', 'work', 'supervisor', 'workers', 'hazards'] as const;

export function validateSessionPayload(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'Session payload must be a JSON object.';
  }
  const session = value as Record<string, unknown>;
  const missingFields = REQUIRED_FIELDS.filter((field) => !(field in session) || session[field] == null);
  if (missingFields.length) return `Missing required field(s): ${missingFields.join(', ')}.`;
  if (typeof session.site !== 'object' || Array.isArray(session.site)) return 'site must be an object.';
  if (typeof session.work !== 'object' || Array.isArray(session.work)) return 'work must be an object.';
  if (typeof session.supervisor !== 'object' || Array.isArray(session.supervisor)) return 'supervisor must be an object.';
  if (!Array.isArray(session.workers)) return 'workers must be an array.';
  if (!Array.isArray(session.hazards)) return 'hazards must be an array.';
  if (typeof session.sessionId !== 'string' || !session.sessionId.trim()) return 'sessionId must be a non-empty string.';
  return validateSessionBoundary(session) ? null : 'Session payload is invalid.';
}
