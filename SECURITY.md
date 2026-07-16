# Security Policy

Safety Lens is a controlled internal-pilot prototype, not a production, certified, or legally compliant safety system.

## Responsible reporting

Report suspected vulnerabilities privately to the pilot repository owner or designated internal security contact. Include the affected version, reproduction steps, impact, and only the minimum test data needed. Do not open a public issue containing credentials, personal information, workplace records, or photographs. Do not test systems or accounts without explicit permission.

The pilot owner should acknowledge the report, restrict access, preserve relevant metadata without sensitive request bodies, assess severity, and coordinate remediation and disclosure. There is no public bug-bounty program or guaranteed response SLA.

## Supported scope

Only the current internal-pilot branch and documented Node.js runtime are in scope. Historical copies, local modifications, exposed development servers, and unsupported deployments are not maintained security releases.

## Known prototype limitations

- Local SQLite, uploads, authentication, rate limiting, and audit state are single-host controls without high availability or independent monitoring.
- The audit chain is tamper-evident, not tamper-proof, independently anchored, or legally certified.
- Mock AI is deterministic reference material; it does not inspect pixels or make safety decisions.
- Browser offline drafts and evidence remain in one browser profile until cleared; remote wipe is unavailable.
- The Meta Display Web App itself supports only documented web display and D-pad keyboard events. It has no direct camera, microphone, sensor, or Neural Band API. Native camera capture requires the separately registered Android DAT companion and explicit ready/attach confirmations; remote wipe is unavailable.
- Glasses pairing is a single-host, short-lived pilot control. Lost glasses require immediate supervisor revocation; expiration is not a substitute for revocation.
- Development Quick Tunnels temporarily expose the local development UI to the public internet. They are limited to an exact configured `*.trycloudflare.com` origin and must be disabled after supervised physical-device testing; they are not a production hosting model.
- TLS must be terminated by an approved reverse proxy; Node does not provision certificates.
- Authentication throttling is process-local and resets on restart.
- Safety-record deletion is disabled until the pilot owner approves a written retention policy.

Never include real credentials or unnecessary personal information in a report.
## Native-photo limitations

The server implements a narrow `native_dat_camera` pilot provider; the Web App never accesses the camera. Android uses a visible foreground service only when enabled, saves captures in app-private storage, and uploads only an explicitly confirmed claimed request. There is no silent launch/connection capture, public gallery copy, third-party image service, remote wipe, or formal evidence-authenticity guarantee. Android JPEG re-encoding normally omits source EXIF, but the server does not independently strip or certify metadata removal. Treat all evidence as sensitive under the approved retention policy.
