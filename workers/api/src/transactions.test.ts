import { describe, expect, it } from "vitest";
import { selectWaiverCandidates } from "./transactions";

function claim(team: string, player: string, order: number, bid: number, priority: number) {
  return {
    waiver_claim_id: `${team}-${order}`,
    waiver_claim_group_id: `group-${team}`,
    fantasy_team_id: team,
    user_id: `user-${team}`,
    add_nfl_player_id: player,
    conditional_drop_roster_player_id: null,
    bid_milli: bid * 1000,
    claim_order: order,
    priority_snapshot: priority,
    submitted_at_utc: `2026-08-03T12:00:0${priority}.000Z`,
  };
}

describe("waiver candidate selection", () => {
  it("exposes only each team's highest ordered pending claim", () => {
    const selected = selectWaiverCandidates([
      claim("alpha", "player-2", 2, 90, 1),
      claim("alpha", "player-1", 1, 10, 1),
      claim("beta", "player-1", 1, 20, 2),
    ], "faab");
    expect(selected.map((item) => item.waiver_claim_id)).toEqual(["beta-1", "alpha-1"]);
  });

  it("uses rolling priority when FAAB is disabled", () => {
    const selected = selectWaiverCandidates([
      claim("alpha", "player-1", 1, 0, 3),
      claim("beta", "player-1", 1, 0, 1),
    ], "waivers");
    expect(selected.map((item) => item.fantasy_team_id)).toEqual(["beta", "alpha"]);
  });

  it("uses submission time when that tiebreaker is configured", () => {
    const selected = selectWaiverCandidates([
      claim("alpha", "player-1", 1, 0, 1),
      claim("beta", "player-1", 1, 0, 9),
    ], "waivers", "submission-time");
    expect(selected.map((item) => item.fantasy_team_id)).toEqual(["alpha", "beta"]);
  });
});
