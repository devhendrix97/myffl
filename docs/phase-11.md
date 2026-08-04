# Phase 11: Administration

Phase 11 completes the platform control plane in myFFL Admin. All operational reads use the production Worker API, and every sensitive write is role-gated, reasoned, and audited.

## Available

- Dashboard totals for active users, sessions, leagues, live NFL games, failed provider requests, jobs, and recent administrative actions
- User search, account and league inspection, login history, notification devices, lock/unlock, session revocation, and platform-role management
- League search with settings, scoring versions, members, teams, rosters, transactions, matchups, commissioner audits, archive/restore, and queued recalculation
- Player search with internal and ESPN IDs, aliases, injuries, normalized statistics, mapping correction, position/team changes, and duplicate merging
- NFL event inspection with status, snapshots, plays, players, raw R2 provider archives, synchronization, reprocessing, finalization, and reopening
- Full scoring lineage from raw provider values through normalized stats, scoring components, versions, totals, revisions, and prior corrections
- Preview-before-apply score corrections with optimistic revision checks, required reasons, affected-team previews, matchup refresh, league notification, audit, and conflict-safe reversal
- Health views for Worker/D1/provider resources, league shards, administrative jobs, notification delivery, and scoring receipts
- The provider replay workspace remains available beside live operations and continues to route the regular app through the same scoring path

## Administrator Roles

- `owner`: all actions, including platform-role changes
- `operator`: operational corrections, account controls, league controls, provider actions, and recalculation
- `support`: read-only investigation plus user session revocation

## Test Flow

1. Sign in to myFFL Admin with an active platform administrator account.
2. Inspect the dashboard, monitoring, audit, users, leagues, players, and NFL events tabs.
3. Select a user and inspect leagues, sessions, login history, and push devices.
4. Select a league and inspect all detailed tabs; queue a reasoned recalculation for selected weeks.
5. Start a replay, step through events, and inspect the resulting player and event records.
6. Open Scoring Investigation with a league, season, event, player, and data scope.
7. Enter corrected points and a reason, preview the delta and affected teams, then apply.
8. Confirm a score revision, matchup refresh, notification, league audit, and global audit were created.
9. Revert the correction and confirm the previous score is restored as a new revision.

Correction history is append-only. Reversal creates another authoritative revision instead of deleting the original administrative action.
