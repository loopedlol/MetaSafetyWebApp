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
- Real Meta hardware, camera, sensor, Neural Band, and Meta SDK support are not implemented.
- TLS must be terminated by an approved reverse proxy; Node does not provision certificates.
- Authentication throttling is process-local and resets on restart.
- Safety-record deletion is disabled until the pilot owner approves a written retention policy.

Never include real credentials or unnecessary personal information in a report.
