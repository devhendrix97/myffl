# Phase 6: Draft System

Phase 6 turns league teams and the NFL player directory into an authoritative, auditable draft workflow. The server owns draft order, pick numbers, deadlines, player availability, roster legality, and revision state.

## Available

- Snake, linear, third-round-reversal, and offline-entry formats
- Commissioner-controlled rounds, pick timer, scheduled start, and team order
- Responsive draft board with current team, round, pick, and server deadline
- Searchable and position-filtered NFL player pool
- League-scoring-aware positional ranking weights
- Personal queues used as the first autopick source
- Automatic picks from the queue or highest legal available player
- Atomic picks with duplicate-player and simultaneous-pick protection
- Drafted players written directly to authoritative fantasy rosters
- Pause, resume, skip, add time, undo, reset, and manual completion controls
- Immutable audit events for setup, picks, clock changes, and commissioner actions
- Scheduled Worker processing for due starts and expired pick clocks

## Test Flow

1. Create a league and invite at least one additional manager.
2. Open the league and choose **Draft**.
3. Set the format, rounds, timer, scheduled time, and team order.
4. Save setup and start the draft.
5. Each manager searches or filters players, builds a queue, and drafts while on the clock.
6. Let a timer expire to verify queue-first autopick.
7. Use pause, add time, skip, and undo to verify commissioner recovery.
8. Finish the draft and inspect roster counts in the Draft side panel.

The database enforces one active player selection per draft and one active roster owner per player in a league season. A stale client receives a revision conflict and reloads current state.
