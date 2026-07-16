import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const CSP = ["default-src 'self'", "base-uri 'none'", "object-src 'none'", "frame-ancestors 'none'",
  "form-action 'self'", "script-src 'self'", "script-src-attr 'none'", "style-src 'self' 'unsafe-inline'",
  "style-src-attr 'none'", "img-src 'self' data: blob:", "connect-src 'self'", "font-src 'self'",
  "manifest-src 'self'", "media-src 'none'", "frame-src 'none'", "worker-src 'self'"].join('; ');

export function sanitizeRequestPath(originalUrl: string): string {
  const path = originalUrl.split('?', 1)[0];
  if (/^\/api\/sessions\/[^/]+\/report$/.test(path)) return '/api/sessions/:sessionId/report';
  if (/^\/api\/sessions\/[^/]+$/.test(path)) return '/api/sessions/:sessionId';
  if (/^\/api\/uploads\/[^/]+$/.test(path)) return '/api/uploads/:uploadId';
  if (/^\/api\/ai\/analyses\/[^/]+\/review$/.test(path)) return '/api/ai/analyses/:analysisId/review';
  if (/^\/api\/glasses\/evidence-requests\/[^/]+\/attach$/.test(path)) return '/api/glasses/evidence-requests/:requestId/attach';
  if (/^\/api\/glasses\/evidence-requests\/[^/]+$/.test(path)) return '/api/glasses/evidence-requests/:requestId';
  if (/^\/api\/evidence-requests\/[^/]+\/complete$/.test(path)) return '/api/evidence-requests/:requestId/complete';
  if (/^\/api\/evidence-requests\/[^/]+$/.test(path)) return '/api/evidence-requests/:requestId';
  if (/^\/api\/native-devices\/(?!registrations$|register$)[^/]+$/.test(path)) return '/api/native-devices/:deviceId';
  if (/^\/api\/native\/capture-requests\/[^/]+\/(claim|status|upload|complete)$/.test(path)) {
    return path.replace(/\/api\/native\/capture-requests\/[^/]+\//, '/api/native/capture-requests/:requestId/');
  }
  if (/^\/api\/glasses\/evidence-requests\/[^/]+\/(ready|retake)$/.test(path)) {
    return path.replace(/\/api\/glasses\/evidence-requests\/[^/]+\//, '/api/glasses/evidence-requests/:requestId/');
  }
  const fixed = new Set(['/healthz', '/readyz', '/api/auth/register', '/api/auth/login', '/api/auth/logout',
    '/api/auth/me', '/api/account', '/api/sessions', '/api/uploads', '/api/ai/analyze-hazard',
    '/api/glasses/evidence-requests', '/api/glasses/native-device-availability', '/api/evidence-requests',
    '/api/native-devices', '/api/native-devices/registrations', '/api/native-devices/register',
    '/api/native/device', '/api/native/capture-requests/next']);
  return fixed.has(path) ? path : '<other>';
}

export function securityHeaders(nodeEnv: string) {
  return (_request: Request, response: Response, next: NextFunction) => {
    response.set({
      'Content-Security-Policy': CSP, 'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin', 'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
      'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY'
    });
    if (nodeEnv === 'production') response.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (_request.path.startsWith('/api/') || _request.path === '/healthz' || _request.path === '/readyz') {
      response.set('Cache-Control', 'no-store');
    }
    next();
  };
}

export function requestContext(logger: Pick<Console, 'info' | 'error'>, now: () => number) {
  return (request: Request, response: Response, next: NextFunction) => {
    const requestId = randomUUID();
    const startedAt = now();
    const path = sanitizeRequestPath(request.originalUrl);
    request.requestId = requestId;
    response.set('X-Request-ID', requestId);
    response.on('finish', () => logger.info(JSON.stringify({
      level: 'info', event: 'http_request', requestId, method: request.method,
      path, status: response.statusCode, durationMs: Math.max(0, now() - startedAt)
    })));
    next();
  };
}

export function rejectCrossSiteMutation({ approvedOrigins = [] }: { approvedOrigins?: string[] } = {}) {
  const exactApprovedOrigins = new Set(approvedOrigins);
  return (request: Request, response: Response, next: NextFunction) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      if (request.get('Sec-Fetch-Site') === 'cross-site') {
        response.status(403).json({ error: 'Cross-site request rejected.' });
        return;
      }
      const origin = request.get('Origin');
      const requestOrigin = `${request.protocol}://${request.get('host')}`;
      if (origin && origin !== requestOrigin && !exactApprovedOrigins.has(origin)) {
        response.status(403).json({ error: 'Request origin rejected.' });
        return;
      }
    }
    next();
  };
}
