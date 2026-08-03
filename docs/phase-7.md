# Phase 7: Team and Player Management

Phase 7 gives managers an authoritative weekly roster workspace. The server initializes lineups from drafted rosters, validates every destination against the league's configured slots, and locks each NFL player independently at kickoff.

## Available

- Weekly starter, bench, IR, PUP, and taxi assignments derived from league roster settings
- Immediate legal swaps with optimistic revision conflict protection
- Per-player kickoff locks based on the NFL schedule and server time
- Live fantasy-point totals from the currently selected provider scope
- Lineup optimizer with a review step before any changes are saved
- League-wide player search and position filtering
- Current league ownership and availability indicators
- Injury status, watchlists, recent statistics, and player profiles
- Two-player comparison in both team and directory workflows
- Immutable lineup revisions and league audit events

## Test Flow

1. Complete a draft or otherwise place players on a managed fantasy team.
2. Open **Team**, choose a week, and select a player.
3. Choose a highlighted legal destination and verify the swap saves immediately.
4. Preview an optimized lineup and confirm the proposed moves.
5. Enter replay mode in myFFL Admin and advance the game; fantasy totals use replay scores without a client-side test-data branch.
6. Open **Players**, search and filter the league pool, inspect ownership, and add a player to the watchlist.
7. Add two players to the comparison panel and inspect their profiles and recent statistics.

Lineups are stored per fantasy team and week. Locked assignments cannot move, while unlocked players remain editable even after another NFL game has begun.
