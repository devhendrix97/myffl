import { describe, expect, it } from "vitest";
import { bracketSeedOrder, roundRobinPairings, shuffleTeamIds } from "./schedule-engine";

describe("round-robin scheduling", () => {
  it("pairs every even-team combination exactly once per cycle", () => {
    const rounds = roundRobinPairings(["a", "b", "c", "d"]);
    const pairs = rounds.flat().map(([left, right]) => [left, right].sort().join(":"));
    expect(rounds).toHaveLength(3);
    expect(new Set(pairs)).toEqual(new Set(["a:b", "a:c", "a:d", "b:c", "b:d", "c:d"]));
  });

  it("assigns one bye per team in an odd-team cycle", () => {
    const rounds = roundRobinPairings(["a", "b", "c"]);
    const byes = rounds.flat().filter(([, opponent]) => opponent === null).map(([team]) => team);
    expect(rounds).toHaveLength(3);
    expect(new Set(byes)).toEqual(new Set(["a", "b", "c"]));
  });

  it("shuffles teams without losing or duplicating an entry", () => {
    const shuffled = shuffleTeamIds(["a", "b", "c", "d"], () => 0);
    expect(shuffled).toEqual(["b", "c", "d", "a"]);
    expect([...shuffled].sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("places six-team playoff byes on the top two seeds", () => {
    const firstRound = bracketSeedOrder(8);
    const pairs = Array.from({ length: 4 }, (_, index) => firstRound.slice(index * 2, index * 2 + 2));
    expect(pairs).toEqual([[1, 8], [4, 5], [2, 7], [3, 6]]);
  });
});
