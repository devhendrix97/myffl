# Phase 2 - Scalable League Management

## User Workflows

- Create a league through the guided basics, format, roster, schedule, and review steps.
- Create a commissioner-owned fantasy team during league creation.
- Share a 30-day invitation code or link.
- Join a league with an invitation and choose a unique team name.
- View league members, teams, activity, roster rules, schedule settings, and status.
- Edit general, roster, and schedule settings as a commissioner or co-commissioner.
- Rotate invitations and revoke the previous active code.
- Archive and restore leagues as the commissioner.

## API Endpoints

- `GET /api/leagues?limit=20&cursor=...`
- `POST /api/leagues`
- `POST /api/leagues/join`
- `GET /api/leagues/{leagueId}`
- `PATCH /api/leagues/{leagueId}/settings`
- `POST /api/leagues/{leagueId}/invitations`
- `POST /api/leagues/{leagueId}/archive`
- `POST /api/leagues/{leagueId}/restore`

All endpoints require a valid access token. League operations resolve the shard on the server and verify the active role in both the core projection and the league shard.

## Storage Model

The core database stores:

- League routing and current status.
- Per-user league summaries for paginated directory queries.
- Hashed invitation-code routing.
- Idempotent league-creation responses.
- Shard registry and platform audit events.

The league shard stores:

- Full leagues and seasons.
- Memberships and roles.
- Fantasy teams, team seasons, and managers.
- Hashed invitations and use counts.
- Roster definitions and slots.
- Schedule configuration.
- General settings, league activity, and immutable audit events.

The client never receives a shard binding name. Mutable league settings use revision numbers; a stale write returns `409 Conflict` and must be reloaded before retrying.

## Migrations

Apply locally:

```powershell
pnpm exec wrangler d1 migrations apply myffl-core --config workers/api/wrangler.jsonc --local
pnpm exec wrangler d1 migrations apply myffl-leagues-001 --config workers/api/wrangler.jsonc --local
```

Apply to production:

```powershell
pnpm exec wrangler d1 migrations apply myffl-core --config workers/api/wrangler.jsonc --remote --env production
pnpm exec wrangler d1 migrations apply myffl-leagues-001 --config workers/api/wrangler.jsonc --remote --env production
```

## Local Development

Run the API and web app in separate Visual Studio terminals:

```powershell
pnpm dev:api
pnpm dev:mobile
```

Open `myFFL.slnx` in Visual Studio to run the WPF desktop and administrator projects. The ordinary-user desktop shell checks production API health and opens the shared create/join workspace.

## Verification

The Phase 2 smoke scenario covers two authenticated users, league creation, list pagination, invitation joining, settings revision, invitation rotation, archive, and restore. Unit coverage validates league input, roster size, schedule boundaries, team limits, and invitation normalization.
