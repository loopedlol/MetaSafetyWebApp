# Safety Lens

Minimal smart-glasses HUD prototype for a Korean-style workplace TBM and risk-assessment checklist, targeted at a 600x600 Meta Ray-Ban Display-style viewport.

## Starter Kit Note

I inspected the official `facebookincubator/meta-wearables-webapp` repository. Its README describes the project as an AI-assisted toolkit/plugin for generating standard HTML/CSS/JavaScript web apps for Meta Ray-Ban Display glasses, rather than a directly installable npm SDK package. The repo guidance calls out a 600x600 viewport, dark high-contrast UI, D-pad navigation mapped to arrow keys, and `.focusable` interactive elements.

Because this folder needs to be runnable immediately, this prototype uses a lightweight Vite/vanilla JavaScript fallback while following those starter-kit design constraints.

Source inspected: https://github.com/facebookincubator/meta-wearables-webapp

## Run Frontend

```bash
npm install
npm run dev
```

Open the local URL Vite prints, usually:

```text
http://localhost:5173
```

The frontend is still a Vite app. API calls to `/api/*` are proxied to the local backend at `http://localhost:3001` while Vite is running.

## Run Backend

In a second terminal:

Create a local `.env` first:

```text
REGISTRATION_KEY=change-me-local-dev-key
SESSION_SECRET=change-me-session-secret
AI_MODE=mock
AI_API_KEY=
```

```bash
npm run server
```

The backend listens on:

```text
http://localhost:3001
```

You can also run both during local development with:

```bash
npm run dev:all
```

## Build

```bash
npm run build
```

The production files will be written to `dist/`.

## Local Session Storage

The Express backend provides:

- `POST /api/auth/register`: creates a local user when the registration key matches `REGISTRATION_KEY`.
- `POST /api/auth/login`: logs in with email and password.
- `POST /api/auth/logout`: clears the local auth cookie.
- `GET /api/auth/me`: returns the logged-in user.
- `POST /api/sessions`: validates and saves an exported TBM JSON session.
- `GET /api/sessions`: returns all saved sessions.
- `GET /api/sessions/:sessionId`: returns one saved session.
- `GET /api/sessions/:sessionId/report`: returns a printable HTML TBM report for one saved session.
- `POST /api/uploads`: accepts JPEG, PNG, and WebP image files up to 5MB each and returns local photo metadata.
- `POST /api/ai/analyze-hazard`: accepts an entry type plus photo metadata or an image URL and returns a structured mock hazard suggestion.

Saved sessions are written to:

```text
data/sessions.json
```

Uploaded evidence photos are written to:

```text
uploads/
```

The `data/` and `uploads/` folders are created automatically and ignored by git because they contain local prototype data.

Reports are generated from saved session JSON on demand. They are clean HTML pages with Korean labels, white background, black text, tabular sections, print-friendly CSS, and photo evidence thumbnails under related hazards and near-misses. PDF generation is intentionally not included yet.

## Local Auth Prototype

The app shows a login/register screen before the Safety Lens workflow. Registration requires `REGISTRATION_KEY`, which is checked only by the backend and is never exposed to frontend code. Passwords are hashed with bcryptjs and stored in:

```text
data/users.json
```

Logged-in access uses a signed HTTP-only cookie backed by `SESSION_SECRET`. Protected routes include saved sessions, uploads, reports, and mock AI analysis. Saved sessions include `createdBy` metadata for the logged-in user.

This is local prototype authentication only. Before production, replace it with hardened session management, HTTPS-only secure cookies, stronger validation, rate limiting, password reset/account recovery, audit logging, and a real user database.

## Mock AI Prototype

Photo analysis is currently mocked by the local backend. No real AI API, API key, cloud service, or camera stream is used.

The backend defaults to mock mode:

```text
AI_MODE=mock
```

Copy `.env.example` if you want a local environment file later. `AI_API_KEY` is included there as an empty placeholder for future real AI work, but it is not used yet.

The intended future path is:

```text
uploaded image -> backend AI endpoint -> AI model/API -> suggestion -> human review -> saved record -> report
```

For now, attaching a photo enables Analyze Photo, which calls `POST /api/ai/analyze-hazard` and receives a deterministic mock suggestion from the backend. A human must accept or reject it before AI metadata is saved. This keeps the frontend/backend contract ready for a future real vision model while preserving the current local-only prototype.

## Flow

1. Start TBM: enter site name, task name, supervisor name, and review the auto-filled date/time.
2. Worker Participation: add/remove workers, mark attendance, or mark all workers present.
3. TBM Checklist: review one hazard card at a time, add a memo, and mark each item Confirmed or Fix Ordered.
4. Log New Hazard: add a manual hazard or near-miss record from the checklist or summary screen, with optional JPEG, PNG, or WebP photo evidence.
5. Summary: review counts, read the Korean report preview, save the session locally, browse saved sessions, open a printable HTML report, or copy the completed session JSON.

Mock hazards are loaded asynchronously from:

```text
public/hazards.json
```

The copied JSON uses `schemaVersion: 1.0.0` and includes session metadata, site, work, supervisor, workers, hazards with human review decisions, manual hazards, near-miss records, local photo evidence metadata, worker feedback, sharing state, and device metadata.

## Test Controls

- `ArrowRight`: next hazard
- `ArrowLeft`: previous hazard
- `1`: mark Confirmed
- `2`: mark Fix Ordered

Keyboard shortcuts are active only during the checklist step.

The app also includes on-screen controls, a memo field, progress text, a final summary screen, a Save Session button, a Saved Sessions screen with Open Report actions, and a Copy JSON button for the completed session log.

## Layout Stress Test

Open this URL while the dev server is running to load exaggerated hazard title, location, action, and memo text:

```text
http://localhost:5173/?stress=1
```
