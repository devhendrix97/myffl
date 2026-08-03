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
- `GET /auth/me`
- `POST /auth/register`
- `POST /auth/verify-email`
- `POST /auth/resend-verification`
- `POST /auth/login`
- `POST /auth/refresh`
- `POST /auth/logout`
- `POST /auth/forgot-password`
- `POST /auth/reset-password`

Browser sessions use a short-lived signed access token plus a rotating refresh token in an HttpOnly cookie. Native clients can request the refresh token in the response by setting `clientType` to `native`.

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
- Pages project: `myffl-mobile`
- Pages custom domain: `https://app.myfflapp.com`

Both production custom domains are active with SSL. Deployment-specific version identifiers remain available in the Cloudflare dashboard and Wrangler deployment history.

## Phase 1 Complete

- Account registration and transactional verification email.
- Verified-account login and authenticated user lookup.
- Signed access tokens and rotating refresh sessions.
- Logout, session revocation, and refresh-token reuse handling.
- Forgot-password and single-use password reset links.
- Responsive PWA account screens and authenticated shell.
- Cloudflare-native rate limiting on public authentication actions.

## Next Phase

Phase 2 adds league creation, league membership, invitations, and commissioner configuration.
