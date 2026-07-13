# Safety Lens SQLite Persistence

## Structured glasses records

Migration `004_glasses_structured_records.sql` adds nullable, backward-compatible fields for the glasses workflow. Count-only attendance is stored on the TBM session as expected/present counts, capture source, and device-observed time; it does not create named attendance or acknowledgment rows. Reports show it separately from named attendance.

Corrective actions retain the existing open/verified and work-status semantics while optionally storing stable immediate-response, responsible-party, and due-period identifiers. Sharing events may store a structured proof type. Evidence provenance is server normalized: legacy evidence defaults to `unknown_legacy_source`, HTTP uploads are `browser_file_picker`, and browser mock SVG evidence is `browser_preview_mock`. Only a trusted native integration may assign `sdk_raw_camera`; provenance does not prove an unstaged or unmodified scene.

## Legacy Field Map

The one-time importer maps the prototype JSON fields as follows:

| Legacy source | Persisted fields | SQLite destination |
| --- | --- | --- |
| `users.json` | `id`, `name`, `email`, `role`, `passwordHash`, `createdAt` | `users` |
| Session identity | `sessionId`, `schemaVersion`, `sessionType`, `status`, owner/creator | `tbm_sessions` and `users` foreign key |
| Client/device timing | `createdAt`, `startedAt`, `exportedAt`, device platform/version/input mode | `tbm_sessions.client_observed_*` and device columns |
| Site | site name/area and GPS latitude/longitude/accuracy | `sites` |
| Work/supervisor | task/work/plan and supervisor display fields | `tbm_sessions` |
| Workers | worker ID/name/role | `workers` and `session_participants` |
| Attendance | `present` | `attendance_records` |
| Acknowledgment | legacy `acknowledged` or structured supervisor/independent evidence | `acknowledgment_records` |
| Hazards | identity, order, source, title, category, location, risk, recommendation, memo, mock-AI metadata | `hazards` |
| Hazard review | status, reviewer, client-observed review time | `hazard_reviews`; authoritative review time is server-generated |
| Corrective action | immediate control, assignee, due time, work/verification status, verifier, closure evidence | `corrective_actions`; authoritative verification time is server-generated |
| Near misses | identity, order, description, action, reporter, mock-AI metadata | `near_misses` |
| Evidence | opaque ID, owner, internal filename, original name, MIME, size, SHA-256, time | `evidence_uploads` and evidence junction tables |
| Image suggestions | analysis/upload IDs, upload hash relationship, mode/provider/model, server times, normalized fixture, human decision/reviewer | `ai_analyses`; hazard/near-miss JSON retains report-facing provenance |
| Sharing | decision, method, recipients, acknowledgment results, client time | append-only `sharing_events`; `shared_at` is server-generated |
| Worker feedback | current unstructured array | `tbm_sessions.worker_feedback_json` until a product schema exists |

Mock glasses images remain explicitly labeled and are stored separately in `mock_evidence`; they are never converted into real uploaded evidence.

## Relationship And Ownership Model

- Every site, TBM session, worker, hazard, near miss, evidence upload, and sharing event is tied to an owner.
- Composite foreign keys prevent a session from linking another owner's site, worker, hazard, or upload.
- Child records cascade only with their TBM session. Users, sites, workers, and evidence use restrictive deletion rules.
- The application exposes no ordinary audit-event update or delete operation, and database triggers reject both.

## Server-Authoritative Time

SQLite writes `created_at`, `saved_at`, `shared_at`, review time, verification time, evidence upload time, and audit time from the server clock. Original session creation is excluded from update assignments. Device-provided values are retained only in columns or response properties named `client_observed_*` / `clientObserved*`.

## Audit Hash Chain

`audit_events.sequence` defines the append order. Each hash covers the event ID, entity type and ID, action, actor, server timestamp, sanitized metadata, and previous hash using canonical JSON and SHA-256. Verification recomputes every hash and link from the beginning.

The chain is tamper-evident rather than tamper-proof. Someone with full database write access can remove triggers or replace and recompute the database. Independent, access-controlled backups are required to make such replacement detectable outside this machine.

## Migration, Recovery, And Rollback

1. Stop the backend and back up the existing `data/` and `uploads/` directories.
2. Run `npm run db:migrate`.
3. Run `npm run db:import-json -- --default-owner-email <email>` when legacy records need an explicit owner.
4. Run `npm run audit:verify` and then start the backend.

The importer creates its own timestamped JSON backup before reading source records and records source IDs in `legacy_imports`. Reruns skip completed imports.

To roll back, stop the backend and restore a complete SQLite copy, including matching `-wal` and `-shm` files when they existed. To rebuild, migrate a new database path and import from a timestamped JSON backup. Applied migration files must never be edited; recovery fixes use a new numbered migration.
