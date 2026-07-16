# Pilot Configuration

The application validates all settings below before the HTTP server starts. Invalid production secrets, ports, durations, proxy settings, paths, or AI modes stop startup. `.env` is a development convenience; production-like pilot secrets must come from the host environment and must not be committed.

## Development

Copy `.env.example` to `.env`, keep `NODE_ENV=development`, `HOST=127.0.0.1`, `TRUST_PROXY=false`, and `AI_MODE=mock`. Use disposable local secrets and local `data/` and `uploads/` paths. Run `npm run dev:all`. The Vite proxy keeps browser API calls same-origin.

### Temporary Cloudflare Quick Tunnel test

This exception is only for a short, supervised physical-device development test. It is not a deployment or production configuration. Start a Cloudflare Quick Tunnel for the Vite development port, then set the exact generated HTTPS origin:

```text
NODE_ENV=development
TRUST_PROXY=1
DEV_TUNNEL_MODE=true
DEV_TUNNEL_ORIGIN=https://example.trycloudflare.com
```

Run `npm run dev:all` after setting the values and use `https://example.trycloudflare.com/?mode=glasses&adapter=meta-display` on the glasses. The origin must be one exact HTTPS `*.trycloudflare.com` origin: no wildcard, list, credentials, path, query, or fragment. The configured tunnel origin and the ordinary local development origin are accepted; every other mutation origin is rejected, and `Sec-Fetch-Site: cross-site` is still rejected. `TRUST_PROXY=1` trusts exactly the controlled single proxy hop; tunnel mode does not broaden it automatically.

Quick Tunnel hostnames are temporary. If Cloudflare issues a different hostname, stop the application, update `DEV_TUNNEL_ORIGIN` to that exact origin, and restart. Disable tunnel mode and restore `TRUST_PROXY=false` when the physical test ends. Startup rejects tunnel mode under `NODE_ENV=test` or `NODE_ENV=production`.

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
| `DEV_TUNNEL_MODE` | `false` | Temporary Quick Tunnel testing only; accepted only in development |
| `DEV_TUNNEL_ORIGIN` | empty | When enabled, one exact HTTPS `*.trycloudflare.com` origin |
| `REGISTRATION_KEY` | empty | At least 16 non-default characters in production |
| `SESSION_SECRET` | development fallback | At least 32 non-default characters in production |
| `SESSION_TTL_MS` | `43200000` | 1 minute through 7 days |
| `GLASSES_PAIRING_TTL_MS` | `300000` | One-time code lifetime; 1–15 minutes |
| `GLASSES_SESSION_TTL_MS` | `3600000` | Restricted glasses session lifetime; 5 minutes–24 hours |
| `GLASSES_PAIRING_MAX_ATTEMPTS` | `5` | Per-record failure ceiling; 1–10 |
| `AI_MODE` / `AI_API_KEY` | `mock` / empty | Mock only; API key empty |
| `DATABASE_PATH` | `data/safety-lens.sqlite` | Absolute path recommended for pilot |
| `UPLOADS_DIR` | `uploads` | Private evidence directory |
| `ABANDONED_UPLOAD_TTL_HOURS` | `24` | 1 hour through 365 days |
| `RETENTION_CLEANUP_INTERVAL_MINUTES` | `60` | 1 minute through 24 hours |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | 1–60 seconds |

Cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` in production. Signed expiry is enforced server-side; expired/invalid cookies are cleared when presented. HTTPS redirection belongs at the reverse proxy, while production responses emit HSTS.
