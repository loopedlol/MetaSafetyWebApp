# Safety Lens

I built this prototype to explore how smart glasses could help people record workplace hazards. It pairs a browser dashboard for detailed records with a simpler glasses interface for quick decisions.

<a id="system"></a>
## What I built

The app lets a user record attendance, add hazards and photos, review suggested actions, and create a printable report. It also saves local drafts when the connection drops. The interface supports Korean and English.

One thing I learned was that a glasses app shouldn't just be a smaller version of a dashboard. I kept detailed editing in the browser and gave the glasses fewer, simpler actions.

**Current status:** this is a prototype, not a tool to rely on for workplace safety. Its AI suggestions are simulated; they do not analyze photos. Real glasses-camera capture needs a separate companion app and hardware testing. That companion app is not included here.

<a id="interfaces"></a>
[Dashboard screenshot](docs/assets/portfolio/dashboard.png) · [Glasses browser preview](docs/assets/portfolio/glasses-preview.png)

These show the app with demo data. The glasses preview is not a photo of a physical device.

**Built with:** TypeScript, Vite, Express, and SQLite.

<a id="start"></a>
## Run locally

<details>
<summary>Setup and run commands</summary>

Requires Node.js 24 or newer.

```bash
git clone https://github.com/loopedlol/MetaSafetyWebApp.git
cd MetaSafetyWebApp
npm ci
cp .env.example .env
npm run dev:all
```

On Windows, copy `.env.example` to `.env` using your shell or file manager.

Open `http://localhost:5173`. Register a local account using the registration key configured in `.env`. The glasses preview is at `http://localhost:5173/?mode=glasses`.

The example environment settings are for local development, not deployment. See the [configuration guide](docs/configuration.md) for the required settings.

To run the checks and build:

```bash
npm run check
```

</details>

<a id="docs"></a>
[Project reflection](docs/PROJECT_STORY.md) · [Code structure](docs/typescript-architecture.md) · [Glasses-camera setup and limits](docs/native-dat-capture.md) · [Security notes](SECURITY.md)
