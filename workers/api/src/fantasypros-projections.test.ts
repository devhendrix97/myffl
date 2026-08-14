import { describe, expect, it } from "vitest";
import { csvRowsToProjectionRows } from "./fantasypros-projections";

describe("FantasyPros projection CSV parsing", () => {
  it("maps duplicate QB headers by position order and ignores FantasyPros FPTS", () => {
    const rows = csvRowsToProjectionRows(`"Player","Team","ATT","CMP","YDS","TDS","INTS","ATT","YDS","TDS","FL","FPTS"
"Josh Allen","BUF","492.3","333.4","3816.9","27.4","11.2","118.1","585.5","11.8","4.1","372.3"`, "QB");

    expect(rows[0].stats).toEqual({
      "passing:ATT": 492.3,
      "passing:CMP": 333.4,
      "passing:YDS": 3816.9,
      "passing:TD": 27.4,
      "passing:INT": 11.2,
      "rushing:ATT": 118.1,
      "rushing:YDS": 585.5,
      "rushing:TD": 11.8,
      "fumbles:LOST": 4.1,
    });
    expect(rows[0].stats).not.toHaveProperty("FPTS");
  });

  it("maps weekly WR receiving and rushing projection columns", () => {
    const rows = csvRowsToProjectionRows(`"Player","Team","REC","YDS","TDS","ATT","YDS","TDS","FL","FPTS"
"Ja'Marr Chase","CIN","7.1","96.3","0.8","0.1","0.7","0.0","0.0","17.7"`, "WR");

    expect(rows[0].stats).toEqual({
      "receiving:REC": 7.1,
      "receiving:YDS": 96.3,
      "receiving:TD": 0.8,
      "rushing:ATT": 0.1,
      "rushing:YDS": 0.7,
      "rushing:TD": 0,
      "fumbles:LOST": 0,
    });
  });
});
