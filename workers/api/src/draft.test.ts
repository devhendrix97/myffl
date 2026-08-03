import { describe, expect, it } from "vitest";
import { draftSlotForPick, nextDraftState } from "./draft";

describe("draft sequencing", () => {
  it("creates a standard snake order", () => {
    expect(Array.from({ length: 12 }, (_, index) => draftSlotForPick("snake", index + 1, 4)))
      .toEqual([1, 2, 3, 4, 4, 3, 2, 1, 1, 2, 3, 4]);
  });

  it("keeps every linear round in the same order", () => {
    expect(Array.from({ length: 8 }, (_, index) => draftSlotForPick("linear", index + 1, 4)))
      .toEqual([1, 2, 3, 4, 1, 2, 3, 4]);
  });

  it("applies third-round reversal before continuing snake order", () => {
    expect(Array.from({ length: 20 }, (_, index) => draftSlotForPick("third-round-reversal", index + 1, 4)))
      .toEqual([1, 2, 3, 4, 4, 3, 2, 1, 4, 3, 2, 1, 1, 2, 3, 4, 4, 3, 2, 1]);
  });

  it("advances the server deadline and completes at the final pick", () => {
    expect(nextDraftState(3, 2, 2, 90, "2026-08-03T12:00:00.000Z")).toEqual({
      overallPick: 4,
      status: "active",
      deadline: "2026-08-03T12:01:30.000Z",
    });
    expect(nextDraftState(4, 2, 2, 90, "2026-08-03T12:00:00.000Z")).toEqual({
      overallPick: 4,
      status: "completed",
      deadline: null,
    });
  });
});
