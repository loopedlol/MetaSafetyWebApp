# Meta Safety Web App

This is a project I built while exploring how **smart glasses and a normal web dashboard could work together for workplace safety tasks**.

The main idea was to take a process that normally involves checklists, notes, photos, and reports and see whether some of it could be made easier to access through a small wearable display.

The question I kept coming back to was:

> **What parts of a workplace-safety workflow actually make sense on smart glasses, and what should still stay on a normal computer or phone?**

The project became more complicated than I first expected because a glasses web app has very different limits from a normal browser. That ended up being one of the most useful parts of the project for me.

> **Important:** This is an experimental student/internship prototype. It is not a certified safety system and should not replace trained workplace-safety judgment.

## What the project does

The application has two main interfaces that share the same safety-session data.

### Normal browser dashboard

The normal browser interface is the more complete side of the project. It can be used to:

- register and sign in;
- start a TBM (toolbox meeting) safety session;
- record worker attendance;
- review a list of possible hazards;
- mark hazards as controlled or requiring action;
- enter corrective-action details;
- record a new hazard or near miss;
- attach photo evidence;
- save drafts and return to them later;
- generate a printable safety report;
- review previously saved sessions.

The interface is Korean by default because I designed the prototype around a Korean-style TBM workflow, but I also added an English interface.

### Smart-glasses interface

I also built a compact interface designed around a **600 × 600 display**.

Instead of trying to squeeze the entire desktop application onto the glasses, I made the glasses workflow much more focused. It steps through attendance, hazards, evidence, review, and saving using a small number of controls.

For testing in a normal browser, it can be opened with:

```text
http://localhost:5173/?mode=glasses
```

There is also a separate Meta Display Web App adapter:

```text
http://localhost:5173/?mode=glasses&adapter=meta-display
```

The Meta adapter is intentionally limited to capabilities the project actually supports. It uses documented keyboard-style D-pad events rather than pretending there is a custom gesture API.

## How I originally imagined it

At first, I imagined the flow being something like this:

```text
Worker sees a hazard
        ↓
Glasses take a photo
        ↓
AI analyzes it
        ↓
Hazard and suggested action appear
        ↓
Record is added to the safety report
```

That sounded simple, but building the prototype forced me to separate what I *wanted* the device to do from what its web environment could actually do.

The glasses web app itself does not simply get unrestricted camera access. Because of that, I changed the design instead of faking the capability.

The current project separates three things:

```text
Normal browser dashboard
        ↕
Shared session / server
        ↕
Glasses web interface
        ↕
Optional authenticated Android companion for real capture
```

The browser glasses preview still contains clearly labeled mock capture behavior so I can test the workflow without physical hardware.

## What I learned

### 1. Hardware limitations can completely change a software design

One of the biggest lessons from this project was that designing for smart glasses is not the same as making a smaller phone app.

The display is small, input is limited, and some capabilities I initially expected were not available directly to the web app. I had to redesign the workflow around what the device could reliably provide rather than build around assumptions.

This made me think much more carefully about separating **device capabilities** from the rest of the application. The shared app now receives simple actions such as move, select, back, controlled, or action-required instead of depending directly on one specific device.

### 2. A wearable interface should not try to do everything

My first instinct was to put as much functionality as possible on the glasses. After working with the 600 × 600 interface, I realized that this usually makes the experience worse.

The normal dashboard is better for tasks such as entering detailed corrective actions, reviewing records, managing pairing, and opening reports. The glasses are more useful for short actions that need to happen while somebody is moving through a worksite.

That division became an important design decision rather than just a screen-size problem.

### 3. Safety software needs more confirmation than a normal app

For a normal consumer app, fewer clicks is often better. I found that this idea does not always carry over to a safety workflow.

For example, the program separates:

- worker attendance from worker acknowledgment;
- identifying a hazard from confirming its status;
- saving a draft from finalizing a record;
- an AI suggestion from a human-approved safety record.

It would have been easier to automatically fill in some of these steps, but doing that could make the record say something happened when it did not.

### 4. I had to be careful not to make the AI look more capable than it is

The current AI mode is a **deterministic mock** used to test the workflow. It does not inspect image pixels and it is not a real automated safety inspector.

I kept it because it lets me test questions such as:

- Where should an AI suggestion appear?
- How should it be labeled?
- Can a user accept, edit, or reject it?
- What information should be stored afterward?

That taught me that integrating AI is not only about calling a model. The interface around the model and the way uncertainty is communicated matter too.

### 5. Offline behavior becomes difficult once the same record exists in several places

I wanted the app to remain usable when the network was unreliable, which led me to add local drafts, IndexedDB storage, queued changes, and synchronization.

The difficult part was not simply saving something offline. It was deciding what should happen when a local version and a server version both change.

This made me understand why synchronization and state management are major parts of real applications even when the visible feature seems simple.

### 6. Security became part of the architecture, not an extra feature

Once the project started storing users, worksite records, and photo evidence, I had to think about who should be able to access each item.

The backend therefore handles ownership checks, private uploads, restricted glasses sessions, expiring pairing codes, and audit events. The project also keeps uploaded evidence behind authenticated routes instead of exposing the files publicly.

I did not start this project mainly to learn backend security, but it ended up becoming a large part of what I learned.

## How the project is built

The project is written mostly in TypeScript.

| Part | Technology |
| --- | --- |
| Frontend | TypeScript + Vite |
| Backend | Express |
| Database | SQLite |
| Offline storage | IndexedDB + service worker |
| Browser testing | Playwright |
| API testing | Node test runner + Supertest |
| Languages | Korean + English |

A simplified view of the architecture is:

```text
                 ┌─────────────────────┐
                 │   Normal Browser    │
                 └──────────┬──────────┘
                            │
                 ┌──────────▼──────────┐
                 │  Shared App Logic   │
                 └──────────┬──────────┘
                            │
           ┌────────────────┼────────────────┐
           │                │                │
     IndexedDB         Express API      Glasses Adapter
                            │                │
                       SQLite DB       600×600 Display
                            │
                    Private Evidence
```

## Repository structure

The main parts of the repository are:

```text
src/
  api/          Browser API communication
  device/       Browser/glasses device adapters
  domain/       Safety workflow rules and validation
  i18n/         Korean and English localization
  state/        Application state
  storage/      Offline storage and synchronization
  views/        UI rendering helpers
  workflows/    Main application workflow

server/
  Backend routes, authorization, services, and database access

db/migrations/
  SQLite schema migrations

browser-tests/
  Playwright tests for normal and glasses interfaces

docs/
  More detailed technical and pilot documentation
```

One part I would like to improve in the future is `src/workflows/application.ts`. It grew quite large as I added more features and is a good example of how a prototype can slowly become harder to maintain.

## Running it locally

This project currently requires **Node.js 24 or newer**.

### 1. Clone the repository

```bash
git clone https://github.com/loopedlol/MetaSafetyWebApp.git
cd MetaSafetyWebApp
```

### 2. Install dependencies

```bash
npm install
```

### 3. Create the local environment file

```bash
cp .env.example .env
```

The example already contains development placeholders. At minimum, the local project expects values such as a registration key and session secret.

### 4. Start the frontend and backend

```bash
npm run dev:all
```

Then open:

```text
http://localhost:5173
```

The frontend normally runs on port `5173` and the backend on port `3001`.

## Testing

As the project became larger, I added automated tests because changing one workflow would sometimes affect another part of the app.

Run the normal test suite:

```bash
npm test
```

Run browser tests:

```bash
npx playwright install chromium
npm run test:browser
```

Run the syntax checks, tests, type checking, and production build together:

```bash
npm run check
```

There are separate Playwright tests for both the normal interface and the glasses interface.

## Current limitations

This project is still a prototype, and there are several important limitations:

- It is not a certified or production workplace-safety system.
- The current built-in AI behavior is simulated and does not analyze image pixels.
- The browser glasses preview contains mock evidence/capture behavior for testing.
- The Meta Display web interface does not pretend to have camera or voice APIs that are not available to it.
- Real capture in the prototype requires the separate authenticated companion-device flow.
- Physical-device behavior still needs to be tested separately from Chromium browser tests.
- The current application is larger and more complex than I originally planned, especially the main workflow file.
- The database and deployment setup are appropriate for a prototype/internal test, not something I would treat as a finished commercial system.

## What I would work on next

If I continued developing the project, I would focus on:

1. testing the glasses workflow more extensively on physical hardware;
2. replacing the mock AI path with a carefully evaluated real vision pipeline;
3. measuring whether AI suggestions actually help users instead of only making the interface more complicated;
4. breaking the large application workflow into smaller modules;
5. simplifying the glasses screens based on real usability testing;
6. improving synchronization and conflict handling;
7. testing the full Android-companion capture flow on more devices;
8. creating clearer measurements for task completion time, mistakes, and user corrections.

I think those experiments would be more useful than simply adding more features.

## More detailed documentation

I kept the lower-level documentation separate from this README so the main page can explain the project without becoming a full operations manual.

- [`docs/configuration.md`](docs/configuration.md) — environment and server configuration
- [`docs/database.md`](docs/database.md) — database, migrations, imports, recovery, and audit data
- [`docs/native-dat-capture.md`](docs/native-dat-capture.md) — Android DAT companion capture design
- [`docs/pilot-operations.md`](docs/pilot-operations.md) — pilot operation and retention notes
- [`docs/pilot-security-review.md`](docs/pilot-security-review.md) — security review notes
- [`docs/typescript-architecture.md`](docs/typescript-architecture.md) — code organization
- [`docs/localization.md`](docs/localization.md) — Korean/English localization
- [`SECURITY.md`](SECURITY.md) — responsible reporting and security information

## Final reflection

This started as an idea about using smart glasses to make workplace-safety information easier to access. The most useful part of building it was learning how many other problems appear once that idea becomes an actual system: limited hardware inputs, small-screen UI design, offline data, authentication, privacy, evidence storage, synchronization, and deciding when automation should *not* make a decision for the user.

The project is not a finished safety product, but it gave me a much better understanding of how a hardware idea turns into a real software architecture—and how the constraints of the device can be just as important as the original idea.