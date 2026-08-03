# myFFL Setup Prerequisites

## Accounts

- Cloudflare account with `myfflapp.com` added as a zone.
- GitHub account with permission to create a private repository.
- Cloudflare Email Service enabled for `myfflapp.com`.

## Local Tools

- Node.js and pnpm.
- Wrangler, installed by this repo as a dev dependency.
- Git.
- .NET SDK and Visual Studio with WPF workload for the desktop/admin apps.

## Cloudflare Resources

The provisioning script creates:

- D1: `myffl-core`, `myffl-nfl`, `myffl-leagues-001`
- R2: `myffl-assets`, `myffl-provider-archive`
- Queues: `myffl-espn-updates`, `myffl-scoring`, `myffl-notifications`, `myffl-audit`, `myffl-waivers`
- Pages: `myffl-mobile`
- Email Sending onboarding for `myfflapp.com`

Durable Object classes and Workflows are declared by Worker configuration and deployed with the backend implementation.

Current Cloudflare state is tracked in `infrastructure/cloudflare/resource-state.json`.

## Cloudflare Status

- `api.myfflapp.com` is active on the production Worker.
- `app.myfflapp.com` is active on the Pages project with SSL.
- Email Sending is enabled and its SPF, DKIM, and DMARC records resolve publicly.
- Keep the Workers Paid plan enabled so transactional Email Sending remains available.

## Secrets

Run:

```powershell
pnpm run secrets:generate
```

This creates `secrets/myffl-secrets.local.env`, which is ignored by git. Production secrets should be set with Wrangler secret commands after the Worker API exists.

The current secret names are:

- `ACCESS_TOKEN_SIGNING_SECRET`
- `REFRESH_TOKEN_HASHING_SECRET`
- `PASSWORD_RESET_SECRET`
- `EMAIL_VERIFICATION_SECRET`

The generated values remain in `secrets/myffl-secrets.local.env`; do not commit or paste them into issues or chat.

## Cloudflare Email Service

Cloudflare docs currently require Cloudflare DNS for Email Service. Outbound Email Sending is listed as a Workers Paid feature, while Email Routing is available on Free and Paid plans.

The app will use the Worker `send_email` binding and send transactional email from:

- `noreply@myfflapp.com`

Email Sending is enabled for `myfflapp.com` with tag `0a661d51650649d68f52d4f3169cc645`.
