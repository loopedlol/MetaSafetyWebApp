# Safety Lens

Minimal smart-glasses HUD prototype for a Korean-style workplace TBM and risk-assessment checklist, targeted at a 600x600 Meta Ray-Ban Display-style viewport.

## Starter Kit Note

I inspected the official `facebookincubator/meta-wearables-webapp` repository. Its README describes the project as an AI-assisted toolkit/plugin for generating standard HTML/CSS/JavaScript web apps for Meta Ray-Ban Display glasses, rather than a directly installable npm SDK package. The repo guidance calls out a 600x600 viewport, dark high-contrast UI, D-pad navigation mapped to arrow keys, and `.focusable` interactive elements.

Because this folder needs to be runnable immediately, this prototype uses a lightweight Vite/vanilla JavaScript fallback while following those starter-kit design constraints.

Source inspected: https://github.com/facebookincubator/meta-wearables-webapp

## Run

```bash
npm install
npm run dev
```

Open the local URL Vite prints, usually:

```text
http://localhost:5173
```

## Build

```bash
npm run build
```

The production files will be written to `dist/`.

## Flow

1. Start TBM: enter site name, task name, supervisor name, and review the auto-filled date/time.
2. Worker Participation: add/remove workers, mark attendance, or mark all workers present.
3. TBM Checklist: review one hazard card at a time, add a memo, and mark each item Confirmed or Fix Ordered.
4. Summary: review counts and copy the completed session JSON.

Mock hazards are loaded asynchronously from:

```text
public/hazards.json
```

The copied JSON includes site, task, supervisor, session start time, worker attendance, hazard statuses, and memos.

## Test Controls

- `ArrowRight`: next hazard
- `ArrowLeft`: previous hazard
- `1`: mark Confirmed
- `2`: mark Fix Ordered

Keyboard shortcuts are active only during the checklist step.

The app also includes on-screen controls, a memo field, progress text, a final summary screen, and a Copy JSON button for the completed session log.

## Layout Stress Test

Open this URL while the dev server is running to load exaggerated hazard title, location, action, and memo text:

```text
http://localhost:5173/?stress=1
```
