# myFFL

myFFL is a complete fantasy football platform with commissioner-defined league formats, roster rules, versioned scoring, live drafts, waivers, trades, real-time gameday scoring, league communication, notifications, and a role-gated administration console.

## Applications

- `apps/myffl-mobile`: React/Vite responsive web app and installable PWA at `https://app.myfflapp.com`.
- `apps/myffl-desktop`: Windows WPF desktop workspace backed by the same production app, account, and APIs.
- `apps/myffl-admin`: Windows WPF operations console for provider replay, platform support, and scoring investigations.
- `workers/api`: Cloudflare Worker API using D1, Durable Objects, Queues, R2, rate limiting, Email Sending, and Web Push.

## Local Development

Install Node.js 24, pnpm 11, .NET 10, and Visual Studio with the .NET desktop workload. Then run:

```powershell
pnpm install
pnpm dev:api
pnpm dev:mobile
dotnet build myFFL.slnx
```

Open `http://127.0.0.1:5173` for the web app. Open `myFFL.slnx` in Visual Studio and choose either Windows project as the startup project. Local secret setup and database migration instructions are in [setup prerequisites](docs/setup-prerequisites.md).

## Verification

```powershell
pnpm typecheck
pnpm test
pnpm --filter @myffl/mobile build
pnpm --filter @myffl/api dry-run
dotnet build myFFL.slnx --configuration Release
```

Operational procedures are in [deployment](docs/deployment.md), [backup and restore](docs/backup-restore.md), [testing](docs/testing.md), [security](docs/security.md), and [troubleshooting](docs/troubleshooting.md).

The optional, licensed expert-ranking provider and its request-budget controls are documented in [FantasyPros rankings](docs/fantasypros-rankings.md).
