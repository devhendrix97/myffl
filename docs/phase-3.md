# Phase 3 - Custom Scoring Engine

Phase 3 turns each scoring preset into an editable, season-specific configuration. Commissioners can create a draft from the current rules or one of six presets, change individual statistics, preview the impact, and apply a new immutable version.

## League Creation Language

- `Single Season` is a one-year league intended for office pools, events, and groups that do not want a continuing league.
- `Redraft` is a continuing league that runs a new player draft each season.
- Every scoring preset now includes a plain-language explanation in the setup wizard.
- Superflex is described as both a scoring and roster starting point because its defining feature is the quarterback-eligible flex position.

## Shared Catalog

The NFL D1 database owns the shared statistic and preset catalog:

- `scoring_statistic_definitions` describes each statistic, supported calculations, and eligible positions.
- `scoring_presets` contains the display name and explanation shown to users.
- `scoring_preset_rules` stores exact point values as integer thousandths.

The initial catalog covers passing, rushing, receiving, kicking, fumbles, team defense, and individual defensive players. Standard, Half PPR, Full PPR, Superflex, TE Premium, and IDP are seeded as editable starting points.

## League Scoring Versions

Each league season owns its scoring versions and rules on its assigned shard. A season has one active version and may have one working draft. Applying a draft supersedes the old active version without deleting it.

Rule changes support:

- Enable and disable controls
- Positive and negative decimal point values
- Points per unit and flat event scoring
- Threshold, repeating, range, tier, position, minimum, and maximum calculations
- Position filters, award limits, and tier definitions
- Optimistic revision checks with HTTP `409` conflicts

## Preview And Apply

Commissioners select an effective scope before applying a draft. The preview compares official and proposed rules, lists affected weeks, and identifies when recalculation is required. Applying creates league audit and activity records and publishes a scoring configuration message to `SCORING_QUEUE`.

Player and matchup examples remain explicitly unavailable until the NFL statistics ingestion and matchup phases provide real weekly data. The configuration preview is otherwise live and complete.

## API Surface

- `GET /api/leagues/{leagueId}/scoring`
- `GET /api/leagues/{leagueId}/scoring/catalog`
- `GET /api/leagues/{leagueId}/scoring/versions`
- `GET /api/leagues/{leagueId}/scoring/versions/{versionId}`
- `POST /api/leagues/{leagueId}/scoring/draft`
- `POST /api/leagues/{leagueId}/scoring/preset`
- `POST /api/leagues/{leagueId}/scoring/rules`
- `PUT /api/leagues/{leagueId}/scoring/rules/{ruleId}`
- `DELETE /api/leagues/{leagueId}/scoring/rules/{ruleId}`
- `POST /api/leagues/{leagueId}/scoring/preview`
- `POST /api/leagues/{leagueId}/scoring/apply`

All reads require active league membership. Mutations require the commissioner or co-commissioner role.
