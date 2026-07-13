# TypeScript Module And Contract Map

The TypeScript migration preserves the existing HTTP paths, JSON field names, SQLite migrations, IndexedDB database/version/store names, localStorage migration key, cookie name, and normal/glasses query contract.

## Old To New Ownership

- `src/main.js` -> `src/main.ts` entrypoint plus `src/workflows/application.ts`, `src/api/client.ts`, `src/state/application-state.ts`, `src/views/**`, and `src/types/contracts.ts`.
- `src/workflow.js` -> `src/domain/workflow.ts`; legacy status and saved-session normalization remains the compatibility layer.
- `src/offline-store.js` and `src/sync-engine.js` -> `src/storage/*.ts`; IndexedDB v1 stores and the `safety-lens-active-draft-v1` importer are unchanged.
- `server.js` -> `server.ts` entrypoint and `server/app.ts`, with authentication primitives in `server/middleware/authorization.ts`, image-byte checks in `server/services/image-validation.ts`, request validation in `server/validation/session.ts`, and persistence in `server/repositories/database.ts`.
- `src/database.js` -> `server/repositories/database.ts`; migrations and transactional behavior are unchanged.

## Public Contracts

`src/types/contracts.ts` owns TypeScript definitions for users, workers, acknowledgment, hazards, corrective actions, evidence, sharing, TBM sessions, offline drafts, queued operations, sync statuses, and API errors. `src/domain/validation.ts` validates untrusted API and IndexedDB values at runtime. Server request validation remains intentionally error-message compatible.

Protected API namespaces (`/api/sessions`, `/api/uploads`, and `/api/ai`) pass through one centralized authorization middleware registration before route dispatch. Report rendering is a pure exported function and can be tested without starting HTTP.

## Compatibility Guarantees

- No SQL migration was added or modified.
- `Confirmed` and `Fix Ordered` legacy status migration remains in `normalizeHazardStatus`.
- Legacy `acknowledged`, completion, and sharing normalization remains unchanged.
- IndexedDB database/store names, operation ordering, Blob retention, idempotency keys, and legacy localStorage migration remain unchanged.
- Existing API status codes, generic ownership 404s, cookie behavior, report routes, and response shapes remain covered by the original integration tests.
