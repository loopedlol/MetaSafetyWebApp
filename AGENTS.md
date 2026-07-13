# MetaSafetyWebApp Repository Guide

## Project

Safety Lens is a workplace-safety prototype for Korean-style toolbox meetings (TBM) and risk assessment. It has a Vite browser UI, an Express API, local SQLite persistence, private photo uploads, printable reports, deterministic mock AI suggestions, a tamper-evident audit chain, and both normal-browser and glasses-preview workflows.

## Repository Structure

- `src/main.ts`: minimal browser entrypoint.
- `src/workflows/application.ts`: shared normal/glasses application orchestration and event binding.
- `src/api/`, `src/state/`, `src/storage/`, `src/domain/`, `src/views/`, and `src/types/`: typed frontend network, state, persistence, domain, presentation, and public-record ownership.
- `src/i18n/`: Korean-default catalogs, translation/fallback behavior, language preference, and localized workflow presentation.
- `src/styles.css`: shared normal-browser and glasses HUD styles.
- `server.ts`: minimal backend entrypoint and public exports.
- `server/app.ts`: Express composition and route orchestration.
- `server/middleware/`, `server/services/`, `server/validation/`, `server/repositories/`, and `server/types/`: centralized authorization, boundary services, validation, SQLite/audit persistence, and Express types.
- `db/migrations/`: ordered SQL migrations. Never edit an applied migration; add a new numbered migration.
- `docs/database.md`: legacy field map, normalized schema, authoritative timestamps, import, recovery, and audit guarantees.
- `test/`: Node test runner and Supertest API integration tests. Every test must use its own OS temporary data and upload directories.
- `browser-tests/`: deterministic Playwright Chromium scenarios for normal and 600×600 glasses views. Generated evidence belongs only in ignored `test-artifacts/`.
- `public/hazards.json`: prototype hazard checklist data copied into the Vite build.
- `public/sw.js`: versioned application-shell and static-hazard cache; API responses are never cached.
- `scripts/dev-all.mjs`: runs the Vite and Express development processes together.
- `scripts/import-json.mjs`: backed-up, idempotent importer for legacy prototype JSON.
- `data/` and `uploads/`: ignored local SQLite and private evidence state. Never use these paths from automated tests.
- `dist/`: ignored Vite production output.

## Commands

Install dependencies:

```bash
npm install
```

Run the frontend and backend together:

```bash
npm run dev:all
```

Run them separately:

```bash
npm run dev
npm run server
```

Build the production frontend:

```bash
npm run build
```

Check JavaScript syntax:

```bash
npm run syntax-check
```

Run strict TypeScript checking directly:

```bash
npm run typecheck
```

Run tests once or in watch mode:

```bash
npm test
npm run test:watch
```

Run the isolated browser suite:

```bash
npm run test:browser
```

Run the full repository check (syntax, tests, and production build):

```bash
npm run check
```

Run database migrations, import legacy JSON, or verify the audit chain:

```bash
npm run db:migrate
npm run db:import-json -- --default-owner-email supervisor@example.com
npm run audit:verify
```

## Product Rules

- This is a workplace-safety prototype, not a certified safety system.
- Never describe mock AI, mock photos, fixed voice transcripts, wearable inputs, or other prototype behavior as real.
- AI suggestions are reference material and must require explicit human review before affecting saved safety records.
- Attendance and worker acknowledgment are different facts. Do not infer one from the other in new code or data migrations.
- Authenticated users must never access another user's sessions or photos. Keep ownership and evidence-reference checks server-controlled and covered by regression tests.
- Preserve both the normal-browser workflow and the `?mode=glasses` workflow, including their shared session, draft, save, and report pipeline.
- Never label device-only data as server-saved or worker-shared. Preserve local drafts and evidence through failed synchronization, and surface revision conflicts for human review.

## Expectations For Every Codex Task

- Inspect relevant code and existing tests before editing.
- Make the smallest change that satisfies the task and preserve current UI behavior unless a UI change is requested.
- Keep tests deterministic and isolated. Use fresh temporary SQLite databases and upload directories; never read from or write to the real `data/` or `uploads/` paths in tests.
- Add or update tests for changed behavior, including negative and authorization cases where relevant.
- Run `npm run syntax-check`, `npm test`, and `npm run build` before handoff. Prefer `npm run check` when it covers the task, and report exact results and any skipped tests.
- Do not make unrelated refactors, formatting sweeps, dependency upgrades, schema changes, or framework/language rewrites.
- Do not commit, push, or open a pull request unless the user explicitly requests it.
