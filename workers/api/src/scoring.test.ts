import { describe, expect, it } from "vitest";
import type { ScoringRule } from "@myffl/api-contracts";
import { calculateAffectedWeeks, compareRules, parsePointValueMilli } from "./scoring";

function rule(overrides: Partial<ScoringRule> = {}): ScoringRule {
  return {
    scoringRuleId: "scr_1",
    statisticKey: "receptions",
    displayName: "Receptions",
    description: "Points for each reception.",
    category: "Receiving",
    enabled: true,
    calculationType: "flat-per-event",
    pointValue: "1",
    positions: ["RB", "WR", "TE"],
    tiers: [],
    displayOrder: 1,
    ...overrides,
  };
}

describe("scoring point precision", () => {
  it("converts decimal points to integer thousandths", () => {
    expect(parsePointValueMilli("0.04")).toBe(40);
    expect(parsePointValueMilli("-2.5")).toBe(-2500);
  });

  it("rejects more than three decimal places", () => {
    expect(() => parsePointValueMilli("0.0001")).toThrow("no more than three decimal places");
  });
});

describe("scoring previews", () => {
  it("calculates bounded future week ranges", () => {
    expect(calculateAffectedWeeks("selected-future-weeks", 5, 7)).toEqual([5, 6, 7]);
    expect(calculateAffectedWeeks("next-season", undefined, undefined)).toEqual([]);
  });

  it("reports changed and disabled rule values", () => {
    const differences = compareRules([rule()], [rule({ enabled: false })]);
    expect(differences).toEqual([expect.objectContaining({
      statisticKey: "receptions",
      change: "changed",
      currentValue: "1 points (flat per event)",
      proposedValue: "Disabled",
    })]);
  });
});
