import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import type { PublicUser } from '../../src/types/contracts.ts';

const INSECURE_SESSION_SECRETS = new Set(['', 'change-me-session-secret', 'test-session-secret']);

interface StoredUser extends PublicUser {
  passwordHash?: string;
}

export interface CookieOptions {
  sessionSecret: string;
  sessionTtlMs: number;
  secureCookies: boolean;
  now: () => number;
}

export function normalizeEmail(email: unknown): string {
  return String(email ?? '').trim().toLowerCase();
}

export function toPublicUser(user: StoredUser | null | undefined): PublicUser | null {
  if (!user) return null;
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

function parseCookies(cookieHeader = ''): Record<string, string> {
  return Object.fromEntries(cookieHeader.split(';').map((cookie) => cookie.trim()).filter(Boolean).map((cookie) => {
    const separatorIndex = cookie.indexOf('=');
    return separatorIndex === -1
      ? [cookie, '']
      : [cookie.slice(0, separatorIndex), decodeURIComponent(cookie.slice(separatorIndex + 1))];
  }));
}

function signValue(value: string, sessionSecret: string): string {
  return createHmac('sha256', sessionSecret).update(value).digest('base64url');
}

function verifySignature(value: string, signature: string, sessionSecret: string): boolean {
  const expected = Buffer.from(signValue(value, sessionSecret));
  const actual = Buffer.from(signature);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function createSessionCookie(userId: string, options: CookieOptions): string {
  const issuedAt = options.now();
  const payload = Buffer.from(JSON.stringify({
    userId,
    issuedAt,
    expiresAt: issuedAt + options.sessionTtlMs
  })).toString('base64url');
  return `${payload}.${signValue(payload, options.sessionSecret)}`;
}

export function getSessionUserId(request: Request, sessionSecret: string, now: () => number): string | null {
  const cookie = parseCookies(request.headers.cookie).safety_lens_session;
  if (!cookie) return null;
  const [payload, signature] = cookie.split('.');
  if (!payload || !signature || !verifySignature(payload, signature, sessionSecret)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    const currentTime = now();
    const issuedAt = Number(session.issuedAt);
    const expiresAt = Number(session.expiresAt);
    const validTimes = Number.isFinite(issuedAt) && Number.isFinite(expiresAt) &&
      issuedAt <= currentTime + 60_000 && expiresAt > currentTime && expiresAt > issuedAt;
    return typeof session.userId === 'string' && validTimes ? session.userId : null;
  } catch {
    return null;
  }
}

export function setAuthCookie(response: Response, userId: string, options: CookieOptions): void {
  response.cookie('safety_lens_session', createSessionCookie(userId, options), {
    httpOnly: true,
    sameSite: 'lax',
    secure: options.secureCookies,
    maxAge: options.sessionTtlMs
  });
}

export function clearAuthCookie(response: Response, secureCookies: boolean): void {
  response.clearCookie('safety_lens_session', { httpOnly: true, sameSite: 'lax', secure: secureCookies });
}

export function requireSecureSessionSecret(sessionSecret: unknown, nodeEnv: string): string {
  const secret = String(sessionSecret ?? '');
  if (!['development', 'test'].includes(nodeEnv) && (INSECURE_SESSION_SECRETS.has(secret) || secret.length < 32)) {
    throw new Error('SESSION_SECRET must be a non-default value of at least 32 characters outside development/test.');
  }
  return secret || 'development-only-session-secret';
}
