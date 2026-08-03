# Phase 9: Real-Time Gameday

Phase 9 turns provider scoring updates into the live league experience. Production ESPN ingestion and administrator replay data travel through the same scoring, matchup, standings, playoff, and realtime delivery paths; only the isolated provider data scope changes.

## Available

- Round-robin regular-season schedule generation with commissioner regeneration before play begins
- Weekly league scoreboards with live, scheduled, final, and corrected states
- Starter and bench scoring, projections, remaining players, win probability, and scoring-component detail
- Persisted matchup revisions and score history for replay, auditing, and corrections
- Ranked standings with W-L-T, points for and against, all-play records, streaks, waiver priority, and playoff state
- Standing snapshots for historical week views and correction safety
- Seeded playoff brackets with proper byes for non-power-of-two fields
- One- or two-week aggregate rounds, consolation brackets, third-place games, and winner advancement
- League, matchup, and NFL-event Durable Object rooms using hibernating WebSockets
- Short-lived authenticated realtime tickets, revision replay, reconnect backoff, and full scoreboard resynchronization
- A responsive Gameday workspace for scoreboard, matchup detail, standings, schedule, and playoff views

## Test Flow

1. Create or open a league with at least two claimed teams.
2. Open **Gameday** and inspect the generated regular-season schedule.
3. Start an administrator replay and advance its game events.
4. Confirm the scoreboard updates without a page reload and identifies the simulation data source.
5. Open a matchup and verify player totals, remaining players, projections, and scoring explanations.
6. Complete the replay and confirm final results and standings.
7. Configure a 4-, 6-, or 8-team playoff and verify seeding, byes, advancement, consolation, and third-place behavior.
8. Disconnect and reconnect the browser, then confirm the room resynchronizes from the latest revision.

Every authoritative score is persisted in D1 before it is broadcast. Realtime delivery can be interrupted without losing official state.
