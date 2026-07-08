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

- `POST /api/sessions`: validates and saves an exported TBM JSON session.
- `GET /api/sessions`: returns all saved sessions.
- `GET /api/sessions/:sessionId`: returns one saved session.
- `GET /api/sessions/:sessionId/report`: returns a printable HTML TBM report for one saved session.
- `POST /api/uploads`: accepts JPEG, PNG, and WebP image files up to 5MB each and returns local photo metadata.

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

## Mock AI Prototype

Photo analysis is currently mocked in the browser. No real AI API, API key, cloud service, or camera stream is used.

The intended future path is:

```text
uploaded image -> AI model -> suggestion -> human review -> saved record -> report
```

For now, attaching a photo enables Analyze Photo, which generates a local mock suggestion. A human must accept or reject it before AI metadata is saved.

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
