import { describe, expect, it } from "vitest";
import { calculatePlayerScore, normalizeProviderStats, type EngineRule } from "./scoring-engine";

function rule(overrides: Partial<EngineRule> = {}): EngineRule {
  return {
    scoringRuleId: "rule-1",
    statisticKey: "rushing_yards",
    displayName: "Rushing yards",
    enabled: true,
    calculationType: "points-per-unit",
    pointValueMilli: 100,
    incrementValue: "1",
    positions: ["RB"],
    tiers: [],
    displayOrder: 1,
    ...overrides,
  };
}

describe("provider stat normalization", () => {
  it("maps category-qualified ESPN labels and compound made/attempted values", () => {
    expect(normalizeProviderStats({
      "passing:YDS": "291",
      "rushing:YDS": "-4",
      "kicking:FG": "2/3",
      "kicking:XP": "3/3",
    })).toEqual(expect.objectContaining({
      passing_yards: 291,
      rushing_yards: -4,
      field_goals_made: 2,
      extra_points_made: 3,
    }));
  });
});

describe("league scoring calculations", () => {
  it("uses exact milli-point arithmetic for positive, negative, and decimal rules", () => {
    const result = calculatePlayerScore({
      "rushing:YDS": "87",
      "receiving:REC": "6",
      "fumbles:LOST": "1",
    }, "RB", [
      rule(),
      rule({ scoringRuleId: "rule-2", statisticKey: "receptions", displayName: "Receptions", calculationType: "flat-per-event", pointValueMilli: 500 }),
      rule({ scoringRuleId: "rule-3", statisticKey: "fumbles_lost", displayName: "Fumbles lost", calculationType: "flat-per-event", pointValueMilli: -2000 }),
    ]);
    expect(result.totalPointsMilli).toBe(9700);
    expect(result.components.map((component) => component.pointsMilli)).toEqual([8700, 3000, -2000]);
  });

  it("supports one-time, repeating, capped, and position-specific awards", () => {
    const result = calculatePlayerScore({ "rushing:YDS": "160", "receiving:REC": "4" }, "TE", [
      rule({ calculationType: "one-time-threshold", pointValueMilli: 3000, thresholdValue: "100", positions: [] }),
      rule({ scoringRuleId: "rule-2", calculationType: "repeating-threshold", pointValueMilli: 1000, thresholdValue: "50", maxAwards: 2, positions: [] }),
      rule({ scoringRuleId: "rule-3", statisticKey: "tight_end_reception_bonus", displayName: "TE receptions", calculationType: "position-specific", pointValueMilli: 500, positions: ["TE"] }),
    ]);
    expect(result.totalPointsMilli).toBe(7000);
  });

  it("scores tiers and individual range events", () => {
    const tiers = [
      { minimum: "0", maximum: "39", points: "3" },
      { minimum: "40", maximum: "49", points: "4" },
      { minimum: "50", points: "5" },
    ];
    const ranges = calculatePlayerScore({ "myffl:field_goal_distances": [28, 44, 53] }, "K", [
      rule({ statisticKey: "field_goals_made", displayName: "Field goals", calculationType: "range-based", positions: ["K"], tiers }),
    ]);
    const tier = calculatePlayerScore({ "passing:YDS": "310" }, "QB", [
      rule({ statisticKey: "passing_yards", displayName: "Passing tier", calculationType: "tiered", positions: ["QB"], tiers: [{ minimum: "300", points: "3" }] }),
    ]);
    expect(ranges.totalPointsMilli).toBe(12000);
    expect(tier.totalPointsMilli).toBe(3000);
  });

  it("ignores disabled rules and position mismatches", () => {
    const result = calculatePlayerScore({ "rushing:YDS": "100" }, "WR", [
      rule(),
      rule({ scoringRuleId: "rule-2", enabled: false, positions: [] }),
    ]);
    expect(result.totalPointsMilli).toBe(0);
    expect(result.components).toEqual([]);
  });
});
