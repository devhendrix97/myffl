# Phase 5: Live Scoring Engine

Phase 5 converts provider box-score statistics into league-specific fantasy points. The ESPN ingestion layer stores raw normalized statistics and publishes a `score-event` message. The scoring consumer then evaluates those same statistics independently for every active league season and scoring version.

## Implemented

- Integer milli-point arithmetic for exact decimal and negative scoring
- ESPN category/label mapping for passing, rushing, receiving, fumbles, kicking, defense, and IDP
- Points-per-unit, flat, threshold, repeating, range, tier, position, minimum, and capped calculations
- Position filters, maximum awards, and tier values
- Idempotent scoring queue receipts
- Current player-event totals and individual scoring components
- Immutable score revisions for live updates and postgame stat corrections
- Recalculation jobs when a commissioner applies a scoring version
- League-scored player totals and point breakdowns in Game Center
- One backend path for live ESPN data and Admin replay data

## Production Test

1. Create a league and choose a scoring preset.
2. In `myFFL Admin`, create a test run and enable **Route Game Center to replay data**.
3. In the regular app, open **Game center** and select the league under **Scoring for**.
4. Step through replay frames in Admin. Player statistics, fantasy totals, and point breakdowns update through the production scoring queue.
5. Expand **Point breakdown** under a player to inspect each scoring component.
6. Disable replay routing in Admin to return the regular app to live ESPN data.

The regular application is not told whether the active provider scope is live or replay. Source selection remains a server-side operational setting.
