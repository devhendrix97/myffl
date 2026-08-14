# FantasyPros Rankings Integration

## License Requirement

FantasyPros free API access is for personal, non-production prototyping. Do not enable production synchronization with a free key. A public, commercial, redistributive, or potentially competing fantasy product must obtain written approval and the appropriate production/commercial license from FantasyPros before enabling this integration.

Player image URLs returned by FantasyPros are intentionally not stored or displayed because those images require separate Sportradar permission.

## Request Strategy

myFFL never calls FantasyPros from a browser. One scheduled Worker job creates shared D1 snapshots for every user and league:

- One `position=ALL` request for STD rankings.
- One `position=ALL` request for HALF rankings.
- One `position=ALL` request for PPR rankings.
- One `position=IDP` request copied into all three scoring snapshots.

That is four successful provider requests per day, regardless of the number of leagues, users, drafts, searches, or position filters. Position filtering happens against D1 and does not consume provider requests. A database-backed circuit breaker allows at most eight attempts per UTC day, leaving at least 42 of a 50-call allowance untouched. Retry windows occur at 10:10, 14:10, and 18:10 UTC; snapshots newer than 20 hours are skipped.

The league's active reception rule selects STD, HALF, or PPR automatically. Draft queues retain priority over ECR, then autopick uses the highest-ranked legal available player. When a snapshot or player mapping is unavailable, myFFL's existing scoring-aware fallback order remains active.

## Licensed Setup

After FantasyPros confirms that the key may be used in production, an owner can manage it from the **Provider Credentials** tab in myFFL Admin. Saving a replacement key validates it against FantasyPros before it replaces the active credential. The plaintext key is never returned to the Admin app; it is encrypted at rest and all changes are audited.

The original Cloudflare secret remains a recovery fallback. Initial infrastructure setup requires these encrypted Worker secrets without placing either in source control:

```powershell
pnpm exec wrangler secret put FANTASYPROS_API_KEY --config workers/api/wrangler.jsonc --env production
pnpm exec wrangler secret put PROVIDER_CREDENTIAL_ENCRYPTION_KEY --config workers/api/wrangler.jsonc --env production
```

The Admin screen shows the masked key suffix, storage source, enabled state, validation timestamp, daily request usage, and recent request ledger. It also provides an audited manual snapshot refresh. Validation and manual refresh requests use the same database-backed daily circuit breaker as scheduled synchronization.

The draft board and league Players tab always display the attribution: "FantasyPros Expert Consensus Rankings," linked to the FantasyPros consensus rankings page.

## Projection CSV Imports

Projected stats are imported from FantasyPros CSV exports separately from rankings. The import stores raw projected stat columns in D1 and intentionally ignores FantasyPros `FPTS`, because myFFL recalculates projected points from each league's scoring rules.

Weekly projections are downloaded by `.github/workflows/fantasypros-projections-sync.yml` on Tuesdays. The sync reads FantasyPros projection tables, posts each CSV to `/api/internal/fantasypros/projections/csv`, and the Worker writes normalized provider-stat keys such as `passing:YDS`, `rushing:TD`, and `receiving:REC` into `fantasypros_projections.projected_stats_json`.

Season projections use the same importer with `FANTASYPROS_PROJECTION_TYPE=season`. Weekly imports may pass `FANTASYPROS_WEEK`, but the API can infer the next scheduled NFL week from D1 when the workflow omits it. CSV filenames are not trusted to determine season-vs-weekly scope, so the workflow or manual import must pass the projection type explicitly.

GitHub-hosted unauthenticated requests may only see FantasyPros' public top rows. The script rejects partial exports by default; configure the repository secret `FANTASYPROS_COOKIE` with an authenticated FantasyPros cookie string, or set `FANTASYPROS_PROJECTION_INPUT_DIR` for manual CSV uploads from exported files.
