import { describe, expect, it } from "vitest";
import { expandSlots } from "./team";

describe("lineup slot expansion", () => {
  it("creates stable indexed destinations with eligibility and scoring state", () => {
    expect(expandSlots([
      { slot_type: "RB", display_name: "Running Back", slot_count: 2, eligible_positions_json: '["RB"]', contributes_points: 1 },
      { slot_type: "FLEX", display_name: "Flex", slot_count: 1, eligible_positions_json: '["RB","WR","TE"]', contributes_points: 1 },
      { slot_type: "BENCH", display_name: "Bench", slot_count: 2, eligible_positions_json: '["QB","RB","WR","TE"]', contributes_points: 0 },
    ])).toEqual([
      { slotType: "RB", slotIndex: 1, displayName: "Running Back", eligiblePositions: ["RB"], contributesPoints: true },
      { slotType: "RB", slotIndex: 2, displayName: "Running Back", eligiblePositions: ["RB"], contributesPoints: true },
      { slotType: "FLEX", slotIndex: 1, displayName: "Flex", eligiblePositions: ["RB", "WR", "TE"], contributesPoints: true },
      { slotType: "BENCH", slotIndex: 1, displayName: "Bench", eligiblePositions: ["QB", "RB", "WR", "TE"], contributesPoints: false },
      { slotType: "BENCH", slotIndex: 2, displayName: "Bench", eligiblePositions: ["QB", "RB", "WR", "TE"], contributesPoints: false },
    ]);
  });
});
