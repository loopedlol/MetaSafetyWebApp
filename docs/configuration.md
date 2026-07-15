# Pilot Configuration

The application validates all settings below before the HTTP server starts. Invalid production secrets, ports, durations, proxy settings, paths, or AI modes stop startup. `.env` is a development convenience; production-like pilot secrets must come from the host environment and must not be committed.

## Development

Copy `.env.example` to `.env`, keep `NODE_ENV=development`, `HOST=127.0.0.1`, `TRUST_PROXY=false`, and `AI_MODE=mock`. Use disposable local secrets and local `data/` and `uploads/` paths. Run `npm run dev:all`. The Vite proxy keeps browser API calls same-origin.

## Test

Tests pass settings directly to `createApp`, use `NODE_ENV=test`, deterministic mock AI, fresh OS temporary database/upload directories, and isolated loopback ports. Tests must never use development or pilot storage. Run `npm run check`; browser checks remain separate (`npm run test:browser`).

## Production-like internal pilot

This configuration does not make the prototype production-ready or certified.

- Set `NODE_ENV=production`; use a random `SESSION_SECRET` of at least 32 characters and non-default `REGISTRATION_KEY` of at least 16 characters.
- Keep `AI_MODE=mock` and `AI_API_KEY` empty. This build rejects live-provider configuration.
- Put an approved TLS reverse proxy in front of Node. Set `TRUST_PROXY=1` only when exactly one trusted proxy is present, and block direct access to Node.
- Keep browser and API on one HTTPS origin. Cross-origin state changes are rejected and permissive CORS headers are not emitted.
- Use absolute, access-controlled `DATABASE_PATH` and `UPLOADS_DIR` values on one backup boundary. Never serve uploads statically.

## Variables

| Variable | Default | Pilot rule |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development`, `test`, or `production` |
| `HOST` / `PORT` | `127.0.0.1` / `3001` | Valid host and port 1–65535 |
| `TRUST_PROXY` | `false` | Only `false` or exactly one trusted proxy; production does not enable trust implicitly |
| `REGISTRATION_KEY` | empty | At least 16 non-default characters in production |
| `SESSION_SECRET` | development fallback | At least 32 non-default characters in production |
| `SESSION_TTL_MS` | `43200000` | 1 minute through 7 days |
| `AI_MODE` / `AI_API_KEY` | `mock` / empty | Mock only; API key empty |
| `DATABASE_PATH` | `data/safety-lens.sqlite` | Absolute path recommended for pilot |
| `UPLOADS_DIR` | `uploads` | Private evidence directory |
| `ABANDONED_UPLOAD_TTL_HOURS` | `24` | 1 hour through 365 days |
| `RETENTION_CLEANUP_INTERVAL_MINUTES` | `60` | 1 minute through 24 hours |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | 1–60 seconds |

Cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` in production. Signed expiry is enforced server-side; expired/invalid cookies are cleared when presented. HTTPS redirection belongs at the reverse proxy, while production responses emit HSTS.
