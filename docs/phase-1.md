# Phase 1 - Cloudflare Foundation and Authentication

## Run Locally

Backend API:

```powershell
pnpm dev:api
```

Mobile PWA:

```powershell
pnpm dev:mobile
```

Windows apps:

```powershell
dotnet build .\myFFL.slnx
```

Open `myFFL.slnx` in Visual Studio and run either WPF project.

## Current API Endpoints

- `GET /health`
- `GET /phase-status`
- `POST /auth/register`
- `POST /auth/login`

## Database Migrations

Local:

```powershell
pnpm --dir workers/api exec wrangler d1 migrations apply myffl-core --local
pnpm --dir workers/api exec wrangler d1 migrations apply myffl-nfl --local
pnpm --dir workers/api exec wrangler d1 migrations apply myffl-leagues-001 --local
```

Remote:

```powershell
pnpm --dir workers/api exec wrangler d1 migrations apply myffl-core --remote
pnpm --dir workers/api exec wrangler d1 migrations apply myffl-nfl --remote
pnpm --dir workers/api exec wrangler d1 migrations apply myffl-leagues-001 --remote
```

## Deployed Resources

- Worker API: `myffl-api-production`
- Worker API custom domain: `https://api.myfflapp.com`
- Worker version: `4ebf7879-2b43-4acd-82d3-0a453f7c4be1`
- Pages project: `myffl-mobile`
- Pages deployment: `https://c6827128.myffl-mobile-bgq.pages.dev`

Cloudflare accepted the Worker custom domain, but this machine did not resolve `api.myfflapp.com` immediately after deployment. If it still does not resolve in Cloudflare, open **Workers & Pages > myffl-api-production > Settings > Domains & Routes** and verify `api.myfflapp.com` is active.

## Not Complete Yet

- Email verification token flow.
- Refresh-token rotation endpoint.
- Session revocation UI.
- League creation.
- Scoring editor.
- ESPN synchronization.
