# Pilot Security Review

Scope: HTTP/browser boundary, local auth/cookies, proxy/HTTPS/CORS/CSRF, validation, private uploads, SQLite lifecycle, retention/deletion, logs/errors, configuration, scanning, backup/restore, and product claims.

Implemented controls are documented in `configuration.md`, `pilot-operations.md`, and `../SECURITY.md`. This supports only a controlled internal prototype pilot after the manual environment checklist is completed; it does not establish production readiness, certification, or regulatory compliance.

## Residual findings

- **Critical:** none identified in the reviewed pilot scope.
- **High:** safety-record, evidence, audit, and backup retention/deletion periods and legal-hold rules are not approved. Do not collect real pilot data until an accountable owner approves them.
- **High:** the single-host SQLite/evidence design has no high availability, independent audit anchoring, or remote disaster recovery. Acceptance requires tested protected backups.
- **Medium:** authentication throttling is process-local; a trusted edge should add rate controls for a networked pilot.
- **Medium:** account deactivation cannot remotely erase IndexedDB and does not delete retained safety records.
- **Medium:** CSP permits inline styles for printable reports/current UI; scripts remain self-only.
- **Medium:** scans are point-in-time. The built-in secret scan uses high-confidence signatures, not entropy or Git-history analysis.
- **Low:** HSTS/secure cookies depend on production mode and correct TLS proxy configuration.
- **Low:** Node's SQLite API is experimental and should be monitored during runtime upgrades.

## Review execution record — 2026-07-15

| Check | Result |
| --- | --- |
| Syntax and strict TypeScript | Passed (`npm run syntax-check`) |
| Node/Supertest regressions | Passed, 95/95 (`npm test`) |
| Normal and 600×600 glasses browser workflows | Passed, 13/13 (`npm run test:browser`) |
| Production frontend build | Passed (`npm run build`) |
| Registry dependency advisory scan | Passed, 0 vulnerabilities (`npm audit --audit-level=high`) |
| High-confidence non-ignored-file secret scan | Passed, 72 files (`npm run security:secrets`) |
| Header/CSP, request-ID, safe-log, CSRF, cookie/HSTS/CORS, bounded-input, sanitized-error, graceful-shutdown, retention, and account-deactivation checks | Passed in focused automated regressions |
| TLS redirect/certificate, trusted-proxy network isolation, backup destination controls, restore drill, and real pilot-device disposal | Not executable in the repository; must be completed in the target pilot environment using `pilot-operations.md` |

Repository-executable manual-checklist items were reviewed against the tests and built assets: the report uses an external self-hosted print script under the CSP, API responses omit permissive CORS headers, logs contain only bounded route metadata, and browser workflows complete with isolated test storage. Target TLS/proxy routing, backup controls/restore, and device disposal remain unchecked until an actual pilot environment exists.

No deployment was performed. Generated browser evidence remains under ignored `test-artifacts/`.
