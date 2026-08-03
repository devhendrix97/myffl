import { describe, expect, it } from "vitest";
import { normalizeCategoryStats, providerAthleteId } from "./provider";

describe("ESPN stat normalization", () => {
  it("uses category and label together so duplicate labels remain distinct", () => {
    expect(normalizeCategoryStats("passing", ["C/ATT", "YDS", "TD"], ["23/35", "291", "3"]))
      .toEqual({ "passing:C/ATT": "23/35", "passing:YDS": "291", "passing:TD": "3" });
    expect(normalizeCategoryStats("rushing", ["YDS"], ["18"]))
      .toEqual({ "rushing:YDS": "18" });
  });

  it("keeps a missing provider value explicit instead of inventing a zero", () => {
    expect(normalizeCategoryStats("receiving", ["REC", "YDS"], ["7"]))
      .toEqual({ "receiving:REC": "7", "receiving:YDS": null });
  });
});

describe("ESPN athlete identity", () => {
  it("uses a direct id when present and otherwise extracts the stable player-card id", () => {
    expect(providerAthleteId({ id: "123" })).toBe("123");
    expect(providerAthleteId({ links: [{ href: "https://www.espn.com/nfl/player/_/id/4685503/walter-nolen-iii" }] }))
      .toBe("4685503");
  });
});
