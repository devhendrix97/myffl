# Backup and Restore

## D1 Export

Create a timestamped folder under the ignored `infrastructure/cloudflare/backups` directory, then export each production database:

```powershell
pnpm exec wrangler d1 export myffl-core --config workers/api/wrangler.jsonc --remote --env production --output infrastructure/cloudflare/backups/core.sql
pnpm exec wrangler d1 export myffl-nfl --config workers/api/wrangler.jsonc --remote --env production --output infrastructure/cloudflare/backups/nfl.sql
pnpm exec wrangler d1 export myffl-leagues-001 --config workers/api/wrangler.jsonc --remote --env production --output infrastructure/cloudflare/backups/league.sql
```

Record the Worker version, Pages deployment URL, migration ledger, export time, and incident/change reference beside the files. R2 provider archives and uploaded assets are independent of D1 exports; apply bucket lifecycle and retention policies in Cloudflare and copy critical archives to separate storage when required.

## Restore Drill

Never test a restore against production. Create an empty recovery D1 database, import one SQL export with `wrangler d1 execute <database> --remote --file <export.sql>`, then check table counts and application queries. For a production incident, pause write-producing cron/queue activity, preserve a fresh incident export, restore to a new database, validate it, update the binding, deploy, and resume processing.

Cloudflare D1 Time Travel is the preferred short-window recovery mechanism when available. Record every restore and validate league, scoring, audit, and authentication tables before reopening writes.
