import path from 'node:path';

const NODE_ENVS = new Set(['development', 'test', 'production']);

export function validateDevelopmentTunnelOrigin(value: string | undefined): string {
  const raw = value?.trim() ?? '';
  if (!raw) throw new Error('DEV_TUNNEL_ORIGIN is required when DEV_TUNNEL_MODE=true.');
  if (raw.includes('*') || raw.includes(',') || /\s/.test(raw)) {
    throw new Error('DEV_TUNNEL_ORIGIN must be one exact HTTPS trycloudflare.com origin.');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('DEV_TUNNEL_ORIGIN must be an absolute HTTPS origin.');
  }
  const validHostname = url.hostname.endsWith('.trycloudflare.com') &&
    url.hostname.length > '.trycloudflare.com'.length;
  if (url.protocol !== 'https:' || !validHostname || url.pathname !== '/' || url.search || url.hash ||
      url.username || url.password) {
    throw new Error('DEV_TUNNEL_ORIGIN must be one exact HTTPS *.trycloudflare.com origin without credentials, path, query, or fragment.');
  }
  return url.origin;
}

function integer(name: string, value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value == null || value === '') return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function absoluteOrResolved(name: string, value: string | undefined, fallback: string, root: string): string {
  const selected = value?.trim() || fallback;
  if (selected.includes('\0')) throw new Error(`${name} contains an invalid character.`);
  return path.isAbsolute(selected) ? selected : path.resolve(root, selected);
}

export function validateEnvironment(env: NodeJS.ProcessEnv, projectRoot: string) {
  const nodeEnv = env.NODE_ENV?.trim() || 'development';
  if (!NODE_ENVS.has(nodeEnv)) throw new Error('NODE_ENV must be development, test, or production.');
  const host = env.HOST?.trim() || '127.0.0.1';
  if (!/^[a-zA-Z0-9.:[\]-]+$/.test(host)) throw new Error('HOST is invalid.');
  const port = integer('PORT', env.PORT, 3001, 1, 65535);
  const sessionTtlMs = integer('SESSION_TTL_MS', env.SESSION_TTL_MS, 12 * 60 * 60 * 1000, 60_000, 7 * 24 * 60 * 60 * 1000);
  const glassesPairingTtlMs = integer('GLASSES_PAIRING_TTL_MS', env.GLASSES_PAIRING_TTL_MS, 5 * 60 * 1000, 60_000, 15 * 60 * 1000);
  const glassesSessionTtlMs = integer('GLASSES_SESSION_TTL_MS', env.GLASSES_SESSION_TTL_MS, 60 * 60 * 1000, 5 * 60 * 1000, 24 * 60 * 60 * 1000);
  const glassesPairingMaxAttempts = integer('GLASSES_PAIRING_MAX_ATTEMPTS', env.GLASSES_PAIRING_MAX_ATTEMPTS, 5, 1, 10);
  const shutdownTimeoutMs = integer('SHUTDOWN_TIMEOUT_MS', env.SHUTDOWN_TIMEOUT_MS, 10_000, 1_000, 60_000);
  const abandonedUploadTtlHours = integer('ABANDONED_UPLOAD_TTL_HOURS', env.ABANDONED_UPLOAD_TTL_HOURS, 24, 1, 24 * 365);
  const retentionCleanupIntervalMinutes = integer('RETENTION_CLEANUP_INTERVAL_MINUTES', env.RETENTION_CLEANUP_INTERVAL_MINUTES, 60, 1, 24 * 60);
  const trustProxy = env.TRUST_PROXY?.trim() || 'false';
  if (!['false', '1'].includes(trustProxy)) throw new Error('TRUST_PROXY must be false or 1.');
  const devTunnelModeValue = env.DEV_TUNNEL_MODE?.trim() || 'false';
  if (!['false', 'true'].includes(devTunnelModeValue)) throw new Error('DEV_TUNNEL_MODE must be false or true.');
  const devTunnelMode = devTunnelModeValue === 'true';
  if (devTunnelMode && nodeEnv !== 'development') {
    throw new Error('DEV_TUNNEL_MODE may be enabled only when NODE_ENV=development.');
  }
  const devTunnelOrigin = devTunnelMode ? validateDevelopmentTunnelOrigin(env.DEV_TUNNEL_ORIGIN) : null;
  const aiMode = env.AI_MODE?.trim() || 'mock';
  if (aiMode !== 'mock') throw new Error('AI_MODE must be mock for this pilot build.');
  if (env.AI_API_KEY?.trim()) throw new Error('AI_API_KEY must be empty while AI_MODE=mock.');
  const registrationKey = env.REGISTRATION_KEY?.trim() || '';
  const sessionSecret = env.SESSION_SECRET || '';
  if (nodeEnv === 'production') {
    if (registrationKey.length < 16 || registrationKey === 'change-me-local-dev-key') {
      throw new Error('REGISTRATION_KEY must be a non-default value of at least 16 characters in production.');
    }
    if (sessionSecret.length < 32 || sessionSecret.includes('replace-with')) {
      throw new Error('SESSION_SECRET must be a non-default value of at least 32 characters in production.');
    }
  }
  return {
    nodeEnv, host, port, sessionTtlMs, glassesPairingTtlMs, glassesSessionTtlMs, glassesPairingMaxAttempts,
    shutdownTimeoutMs, abandonedUploadTtlHours,
    retentionCleanupIntervalMinutes, trustProxy: trustProxy === '1' ? 1 : false,
    devTunnelMode, devTunnelOrigin,
    aiMode, registrationKey, sessionSecret,
    databasePath: absoluteOrResolved('DATABASE_PATH', env.DATABASE_PATH, 'data/safety-lens.sqlite', projectRoot),
    uploadsDir: absoluteOrResolved('UPLOADS_DIR', env.UPLOADS_DIR, 'uploads', projectRoot)
  };
}
