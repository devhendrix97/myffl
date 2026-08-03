# Phase 4: ESPN NFL Data Integration

Phase 4 introduces a provider boundary around the unofficial ESPN NFL endpoints. ESPN payloads are archived before normalization so parser changes and stat corrections remain auditable.

## Production Flow

1. A one-minute Worker cron enqueues scoreboard polling.
2. The `myffl-espn-updates` consumer fetches bounded ESPN responses.
3. Raw JSON is stored in `myffl-provider-archive` with parser and scope metadata.
4. Teams, events, game state, players, category-aware statistics, and injuries are normalized into `myffl-nfl`.
5. Live and final games enqueue summary refreshes. Failed messages retry and ultimately move to `myffl-dead-letter`.

Production rows use the `production` data scope. Provider failures are recorded without replacing the most recent valid snapshot with zero values.

## Test Mode

`myFFL Admin` exposes a deterministic Sunday game simulation with play, pause, step, reset, stop, and 1x/2x/4x pacing. Replay frames use ESPN-shaped scoreboard and summary payloads and pass through the same archive and normalization functions as live data.

Every run receives a unique ID. Its normalized rows use `simulation:<run-id>` and its R2 objects use a `simulations/<run-id>` prefix. Reset only deletes rows in that run's scope; production sync never reads simulation scopes.

## Local Verification

```powershell
pnpm --filter @myffl/api typecheck
pnpm --filter @myffl/api test
dotnet build apps/myffl-admin/MyFFL.Admin.csproj --configuration Debug
pnpm --filter @myffl/api dry-run
```

Run the desktop utility from Visual Studio by selecting `apps/myffl-admin/MyFFL.Admin.csproj`, or launch its Debug build directly. Sign in with a verified account that exists in `platform_admins`.

## Administrative API

- `GET /api/admin/provider/dashboard`
- `POST /api/admin/provider/sync`
- `GET|POST /api/admin/simulations`
- `POST /api/admin/simulations/{runId}/{play|pause|step|reset|stop}`

All endpoints require an active native session and platform-admin allowlist entry.
