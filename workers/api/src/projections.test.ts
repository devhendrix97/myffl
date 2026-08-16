import { describe, expect, it } from "vitest";
import { normalizeEspnProjectionStats } from "./provider";

describe("ESPN projection normalization", () => {
  it("maps core projected player stat ids into scoring-engine provider keys", () => {
    expect(normalizeEspnProjectionStats({
      0: 33.2,
      1: 22.7,
      3: 272.4,
      4: 2.1,
      20: 0.7,
      23: 3.5,
      24: 18.6,
      25: 0.2,
      42: 74.5,
      43: 0.6,
      53: 5.8,
      72: 0.1,
    })).toEqual({
      "passing:ATT": 33.2,
      "passing:CMP": 22.7,
      "passing:YDS": 272.4,
      "passing:TD": 2.1,
      "passing:INT": 0.7,
      "rushing:ATT": 3.5,
      "rushing:YDS": 18.6,
      "rushing:TD": 0.2,
      "receiving:YDS": 74.5,
      "receiving:TD": 0.6,
      "receiving:REC": 5.8,
      "fumbles:LOST": 0.1,
    });
  });

  it("maps kicker and defense projection ids used by the scoring engine", () => {
    expect(normalizeEspnProjectionStats({
      83: 1.8,
      86: 2.9,
      99: 3.1,
      100: 0.8,
      101: 0.6,
      102: 0.2,
    })).toEqual({
      "kicking:FG": 1.8,
      "kicking:XP": 2.9,
      "defense:SACKS": 3.1,
      "defense:INT": 0.8,
      "defense:FR": 0.6,
      "defense:TD": 0.2,
    });
  });
});
