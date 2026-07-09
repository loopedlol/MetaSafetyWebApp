# Safety Lens

Minimal smart-glasses HUD prototype for a Korean-style workplace TBM and risk-assessment checklist, targeted at a 600x600 Meta Ray-Ban Display-style viewport.

## Starter Kit Note

I inspected the official `facebookincubator/meta-wearables-webapp` repository. Its README describes the project as an AI-assisted toolkit/plugin for generating standard HTML/CSS/JavaScript web apps for Meta Ray-Ban Display glasses, rather than a directly installable npm SDK package. The repo guidance calls out a 600x600 viewport, dark high-contrast UI, D-pad navigation mapped to arrow keys, and `.focusable` interactive elements.

Because this folder needs to be runnable immediately, this prototype uses a lightweight Vite/vanilla JavaScript fallback while following those starter-kit design constraints.

Source inspected: https://github.com/facebookincubator/meta-wearables-webapp

## Demo Script

Use these scripts for a short end-to-end Safety Lens V2 walkthrough.

### A. Normal dashboard demo

1. Start the backend and frontend with `npm run dev:all`.
2. Open `http://localhost:5173`.
3. Register or login.
4. On Start TBM, keep the demo site `서울 강동 스마트타워 신축공사` or edit the site/task/supervisor fields.
5. Click Start TBM.
6. Mark workers present, then continue to the checklist.
7. Review the first hazard and mark it `Confirmed`.
8. Review the next hazard and mark it `Fix Ordered`.
9. Click Log New Hazard.
10. Choose a new hazard or near-miss, add a title/location/description/action, and attach a JPG/PNG/WEBP photo.
11. Run Analyze Photo, then accept the mock AI suggestion after human review.
12. Save the entry and finish the checklist.
13. On Summary, click Save Session.
14. Confirm the save message says the backend saved the session and the browser draft was cleared.
15. Open Saved Sessions.
16. Click Open Report for the saved session.
17. Use browser print/save-to-PDF if needed.

To demonstrate offline draft restore during this path, refresh the page after changing attendance, memo, or hazard status. Choose Restore Draft when the local draft prompt appears.

### B. Glasses HUD demo

1. Start the backend and frontend with `npm run dev:all`.
2. Open `http://localhost:5173/?mode=glasses`.
3. Register or login if needed.
4. Press `Enter` or `ArrowRight` to start the wearable-style TBM.
5. Press `Enter` to mark demo workers present.
6. On a hazard card, press `M` to add the mock voice memo.
7. Press `P` to add mock glasses photo evidence.
8. Press `1` to mark one hazard Confirmed.
9. Press `2` on another hazard to mark Fix Ordered.
10. Refresh the page after a status or memo change and choose Restore Draft to show browser-local recovery.
11. Continue through the remaining hazards with `ArrowRight`.
12. Save the session on the Summary card.
13. Exit glasses mode, open the normal dashboard, and use Saved Sessions to open the Korean report.

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
http://127.0.0.1:3001
```

You can also run both during local development with:

```bash
npm run dev:all
```

This starts the Express backend and Vite frontend together and stops both when the command is interrupted.

## Glasses HUD Mode

Safety Lens includes a simplified wearable preview for Meta Display-style HUD workflows. It keeps the same auth, session, hazard, save, and report data model as the normal browser dashboard, but presents the TBM flow as one large card at a time.

Open it while the dev server is running:

```text
http://localhost:5173/?mode=glasses
```

Glasses HUD Mode is intended for:

- Meta Display / smart-glasses TBM walkthrough demos.
- Gesture-first hazard review with minimal controls.
- Validating the shared session/report pipeline from a wearable-style UI.

Keyboard controls currently stand in for future wearable gestures:

- `ArrowRight` or `Enter`: next / select / future pinch confirm.
- `ArrowLeft`: previous / future back gesture.
- `1`: mark hazard Confirmed.
- `2`: mark hazard Fix Ordered.
- `M`: capture mock voice memo.
- `P`: capture mock photo evidence.
- `Escape`: exit glasses mode.

Mock behavior in glasses mode:

- Voice memo is a fixed prototype transcript, not real speech-to-text.
- Photo evidence is a mock inline image placeholder, not a real camera capture.
- Save still uses the existing backend session endpoint.
- Actual Meta SDK, Neural Band, camera, sensor, GPS, and offline-storage integration are future work.

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

## Known Prototype Limits

- Mock AI is deterministic demo logic, not real hazard detection.
- Glasses HUD photo evidence is a mock placeholder unless a photo is uploaded through the normal dashboard flow.
- Meta SDK, Neural Band gestures, real camera capture, sensor input, and wearable deployment are future work.
- The offline draft uses `localStorage`; it is local to one browser/profile and is not shared across devices.
- The Korean report is printable HTML. Browser print/save-to-PDF works, but the app does not generate a standalone PDF file yet.

## Prototype / Mock Behavior

The following behavior is intentional for the current demo prototype:

- Authentication is local-file based and intended for demo use only.
- AI photo analysis is deterministic mock analysis from the backend.
- Uploaded photos are stored locally under `uploads/`.
- Saved TBM sessions are stored locally under `data/sessions.json`.
- The Korean report is generated as printable HTML; use the browser print dialog for PDF output.
- Smart-glasses camera streaming, real AI analysis, production auth, and cloud storage are not implemented yet.

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
