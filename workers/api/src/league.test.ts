import { describe, expect, it } from "vitest";
import type { CreateLeagueRequest } from "@myffl/api-contracts";
import { normalizeInvitationCode, validateCreateLeagueRequest } from "./league";

function validLeague(): CreateLeagueRequest {
  return {
    requestId: "request-12345678",
    leagueName: "Sunday Night Legends",
    description: "A competitive friends league.",
    privacy: "private",
    teamCount: 12,
    seasonYear: new Date().getUTCFullYear(),
    timeZone: "America/Chicago",
    format: "redraft",
    scoringPreset: "full-ppr",
    commissionerTeamName: "Gridiron Gang",
    rosterSlots: [
      { slotType: "QB", displayName: "Quarterback", count: 1, eligiblePositions: ["QB"], contributesPoints: true },
      { slotType: "RB", displayName: "Running Back", count: 2, eligiblePositions: ["RB"], contributesPoints: true },
      { slotType: "WR", displayName: "Wide Receiver", count: 2, eligiblePositions: ["WR"], contributesPoints: true },
      { slotType: "BENCH", displayName: "Bench", count: 6, eligiblePositions: ["QB", "RB", "WR", "TE"], contributesPoints: false },
    ],
    rosterPositionLimits: [
      { position: "QB", displayName: "Quarterback", minimum: 1, maximum: 3 },
      { position: "RB", displayName: "Running Back", minimum: 2, maximum: 7 },
      { position: "WR", displayName: "Wide Receiver", minimum: 2, maximum: 7 },
      { position: "TE", displayName: "Tight End", minimum: 0, maximum: 3 },
    ],
    schedule: {
      regularSeasonStartWeek: 1,
      regularSeasonEndWeek: 14,
      scheduleMethod: "round-robin",
      playoffTeamCount: 6,
      playoffStartWeek: 15,
      playoffRoundLength: 1,
      reseed: true,
      consolationBracket: true,
      thirdPlaceMatchup: true,
    },
  };
}

describe("league creation validation", () => {
  it("normalizes safe league input", () => {
    const result = validateCreateLeagueRequest(validLeague());
    expect(result.leagueName).toBe("Sunday Night Legends");
    expect(result.rosterSlots).toHaveLength(4);
  });

  it("accepts a one-off single-season league", () => {
    const result = validateCreateLeagueRequest({ ...validLeague(), format: "single-season" });
    expect(result.format).toBe("single-season");
  });

  it("rejects a team count outside platform rules", () => {
    expect(() => validateCreateLeagueRequest({ ...validLeague(), teamCount: 2 })).toThrow(
      "League size must be between 4 and 32 teams.",
    );
  });

  it("rejects a playoff schedule that starts during the regular season", () => {
    const league = validLeague();
    league.schedule.playoffStartWeek = 14;
    expect(() => validateCreateLeagueRequest(league)).toThrow(
      "Regular-season and playoff weeks do not fit the NFL season.",
    );
  });

  it("rejects undersized rosters", () => {
    const league = validLeague();
    league.rosterSlots = [{ slotType: "QB", displayName: "QB", count: 1, eligiblePositions: ["QB"], contributesPoints: true }];
    expect(() => validateCreateLeagueRequest(league)).toThrow(
      "Total roster size must be between 5 and 60 players.",
    );
  });

  it("rejects position minimums below required starting slots", () => {
    const league = validLeague();
    league.rosterPositionLimits = league.rosterPositionLimits.map((limit) =>
      limit.position === "RB" ? { ...limit, minimum: 1 } : limit,
    );
    expect(() => validateCreateLeagueRequest(league)).toThrow(
      "Running Back minimum cannot be lower than its required starting slots.",
    );
  });

  it("rejects position maximums larger than the active roster", () => {
    const league = validLeague();
    league.rosterPositionLimits = league.rosterPositionLimits.map((limit) =>
      limit.position === "QB" ? { ...limit, maximum: 99 } : limit,
    );
    expect(() => validateCreateLeagueRequest(league)).toThrow(
      "Position limits must be between 0 and the 11-player active roster.",
    );
  });
});

describe("league invitations", () => {
  it("normalizes display formatting before hashing", () => {
    expect(normalizeInvitationCode("abcde-f2345")).toBe("ABCDEF2345");
  });
});
