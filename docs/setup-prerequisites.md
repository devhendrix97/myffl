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

## Action Required In Cloudflare

Before the remaining resources can be completed:

1. Enable R2 once in the Cloudflare Dashboard. Wrangler currently returns Cloudflare API code `10042` until this is done.
2. Confirm the account plan supports Cloudflare Email Sending. Cloudflare docs currently list outbound Email Sending as a Workers Paid feature.
3. Resolve Cloudflare Email Sending API error `Unauthorized [2036]` for zone `myfflapp.com`.

## Secrets

Run:

```powershell
pnpm run secrets:generate
```

This creates `secrets/myffl-secrets.local.env`, which is ignored by git. Production secrets should be set with Wrangler secret commands after the Worker API exists.

## Cloudflare Email Service

Cloudflare docs currently require Cloudflare DNS for Email Service. Outbound Email Sending is listed as a Workers Paid feature, while Email Routing is available on Free and Paid plans.

The app will use the Worker `send_email` binding and send transactional email from:

- `noreply@myfflapp.com`
