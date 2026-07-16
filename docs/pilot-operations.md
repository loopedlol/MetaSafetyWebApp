# Internal Pilot Operations

## Restricted glasses access

Pair glasses only from an authenticated supervisor dashboard and assign the narrowest available active TBM scope. Codes expire after `GLASSES_PAIRING_TTL_MS`, are one-time use, and are never recoverable from storage. Restricted sessions expire after `GLASSES_SESSION_TTL_MS` and can be revoked from the same pairing screen.

For lost glasses or suspected cookie compromise: revoke immediately, stop work that depends on the device, confirm subsequent glasses API requests return to pairing, preserve the sanitized audit chain, and assess whether `SESSION_SECRET` rotation is required. Rotation invalidates both supervisor and glasses cookies. There is no remote wipe or device-management guarantee.

Before each physical test verify: focus is unmistakable in bright conditions; arrow order is consistent; Korean/English can be selected without a native dropdown; two code groups can be entered without a keyboard; refresh preserves an unexpired restricted session; expiry and revocation return to pairing; voice remains unavailable; native photo capture occurs only through the registered Android DAT companion after explicit confirmation and attachment; and hazard decisions still require the separate human confirmation screen. Use the full checklist in [native DAT capture](native-dat-capture.md).

## Retention and deletion

- Expired sessions: signed cookie expiry is enforced server-side; presented expired/invalid cookies are cleared. There is no authentication-session table.
- Abandoned uploads: uploads older than `ABANDONED_UPLOAD_TTL_HOURS` are deleted only when not linked to a hazard, near miss, or AI analysis. Cleanup runs at startup and on the configured interval. Set the TTL longer than the pilot's maximum expected offline/synchronization delay; device-local recovery remains necessary.
- User accounts: `DELETE /api/account` requires the current password, disables login, replaces identity/credential fields with tombstone values, and preserves audit and safety records.
- Safety records: **policy placeholder—no automatic deletion**. Before real pilot data, the owner must approve retention periods, legal holds, deletion authority, backup expiry, evidence handling, and audit treatment. Account deactivation is not safety-record deletion.
- Browser data: offline IndexedDB data is device-local. Account deactivation cannot remotely erase it; use the approved browser-profile/device disposal procedure.

## Backup

The database and evidence directory form one sensitive backup set. Store it only in an approved encrypted, access-controlled location.

1. Stop the backend and confirm readiness is unavailable. Do not copy a live database piecemeal.
2. Copy the database and matching `-wal`/`-shm` files if present, plus the entire evidence directory, into one timestamped set. Preserve restrictive permissions.
3. Record checksums, application revision, migration list, time, operator, and configured paths without credentials.
4. Test restoration to isolated paths; never overwrite the active pilot during a drill.
5. Apply the approved backup retention/destruction policy once defined. Backup expiry remains unresolved until then.

## Restore drill

1. Stop the target and preserve the failed set for investigation.
2. Restore database and evidence from the same backup to isolated absolute paths.
3. Point `DATABASE_PATH` and `UPLOADS_DIR` there, run `npm run db:migrate`, then `npm run audit:verify`.
4. Start, check `/healthz` and `/readyz`, and verify a test-owned session/report/evidence item.
5. Confirm another account cannot retrieve that sample. Document the drill before controlled cutover.

## Manual security checklist

- [ ] TLS is valid at the proxy; HTTP redirects there; Node is not directly reachable.
- [ ] `TRUST_PROXY=1` is used only with exactly one trusted proxy.
- [ ] Secrets are non-default, host-supplied, access-controlled, and absent from source/logs.
- [ ] Browser/API use one origin; hostile `Origin` and cross-site fetch metadata receive 403.
- [ ] CSP/security headers are present; normal and glasses workflows show no CSP errors.
- [ ] Cookies are `Secure`, `HttpOnly`, `SameSite=Lax`; expired/tampered cookies fail.
- [ ] Cross-user session, report, upload, and AI access fails safely.
- [ ] Cross-user evidence-request list/complete and cross-session glasses create/read/cancel/attach fail safely.
- [ ] Camera and gallery selection remain local until confirmation; glasses require a separate attachment confirmation.
- [ ] Oversized JSON/arrays/nesting, invalid images, excessive files, and long auth fields fail.
- [ ] Logs contain correlation metadata but no bodies, cookies, photos, credentials, or unnecessary identity.
- [ ] 500 responses contain only the generic message and request ID, without paths/stacks.
- [ ] `/healthz` works; `/readyz` becomes 503 during shutdown/database failure.
- [ ] SIGTERM drains requests and closes SQLite within the configured timeout.
- [ ] Cleanup removes only old, unreferenced uploads.
- [ ] Pending evidence requests expire and completed-but-unattached request uploads survive abandoned-upload cleanup.
- [ ] Backup/restore and cross-owner checks pass on an isolated restored copy.
- [ ] Record/backup retention policy has an owner and approval date before real pilot data.
## Evidence-request operations

Pending requests expire after ten minutes using server time. Cleanup marks them expired and retains minimal state/audit history. Completed-request uploads are protected from abandoned-upload cleanup until attachment. Back up and restore the complete SQLite database and private evidence directory as one consistency set; then run migrations and `npm run audit:verify`. Safety-record deletion remains subject to the explicit pilot policy placeholder.
