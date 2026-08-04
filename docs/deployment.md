# Production Deployment

## Preflight

1. Run the verification matrix from the root `README.md`.
2. Confirm `pnpm exec wrangler whoami` reports the myFFL Cloudflare account.
3. Export all three D1 databases using `docs/backup-restore.md`.
4. Review pending migrations with `wrangler d1 migrations list` for each database.

## Database Migrations

Apply migrations before code that depends on them:

```powershell
pnpm exec wrangler d1 migrations apply myffl-core --config workers/api/wrangler.jsonc --remote --env production
pnpm exec wrangler d1 migrations apply myffl-nfl --config workers/api/wrangler.jsonc --remote --env production
pnpm exec wrangler d1 migrations apply myffl-leagues-001 --config workers/api/wrangler.jsonc --remote --env production
```

## API and Web App

```powershell
pnpm --filter @myffl/api deploy
pnpm --filter @myffl/mobile build
pnpm exec wrangler pages deploy apps/myffl-mobile/dist --project-name myffl-mobile --branch main
```

Verify `https://api.myfflapp.com/health`, `https://api.myfflapp.com/phase-status`, account sign-in, one league read, and one admin dashboard read. Confirm `https://app.myfflapp.com` resolves to the latest Pages deployment.

## Rollback

Use Cloudflare Workers Deployments to roll back the Worker version and Pages Deployments to promote the previous successful site build. Database migrations are forward-only; restore a pre-deploy D1 export only when a data migration caused corruption and after stopping writes.
