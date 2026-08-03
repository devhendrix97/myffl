# Phase 8: Transactions

Phase 8 provides an auditable player-movement system for immediate free agents, ordered waivers, FAAB, and multi-asset trades. Roster ownership remains authoritative in D1 and every completed move records its assets, actor, result, and audit context.

## Available

- Commissioner-selectable immediate free agency, rolling waivers, or FAAB
- Configurable budgets, minimum bids, processing periods, and tiebreakers
- Conditional drops and server-side roster validation
- Claim reordering, cancellation, result status, and failure reasons
- Queue-backed, idempotent waiver processing on the Worker schedule
- Highest-valid-bid resolution with team claim order and configurable ties
- Successful-claim-only FAAB deduction and rolling-priority updates
- Player, FAAB, and future draft-pick trades
- Trade messages, expiration, roster preview, counteroffers, and cancellation
- Commissioner review or league vote with automatic review deadlines
- Ownership, lock, balance, roster-size, and position-limit validation at settlement
- Atomic asset movement with transaction, activity, and audit records

## Test Flow

1. Open **Transactions** and configure the acquisition mode and trade review rules.
2. Search for an available player, select an optional conditional drop, and submit a move or claim.
3. Create multiple claims and reorder them using the priority controls.
4. In FAAB mode, submit competing bids and process the period from the scheduled queue or commissioner control.
5. Verify only successful claims deduct FAAB and every failed claim has a reason.
6. Propose a trade containing players, FAAB, or future picks; then accept, reject, counter, cancel, vote, or review it from another manager.
7. Confirm processed assets appear on their new teams and the official activity record contains the result.

The server revalidates every asset immediately before processing. A stale claim or trade cannot overwrite newer roster ownership or balance state.
