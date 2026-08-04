import { describe, expect, it } from "vitest";
import { mapPlayers, scoringFromReceptionPoints, type FantasyProsPlayer, type InternalPlayer } from "./fantasypros";

describe("FantasyPros rankings", () => {
  it("selects a scoring snapshot from the league reception rule", () => {
    expect(scoringFromReceptionPoints(0)).toBe("STD");
    expect(scoringFromReceptionPoints(500)).toBe("HALF");
    expect(scoringFromReceptionPoints(1000)).toBe("PPR");
  });

  it("maps rankings to canonical players without relying on licensed images", () => {
    const internal: InternalPlayer[] = [
      { nfl_player_id: "nfl-bijan", display_name: "Bijan Robinson", position: "RB", abbreviation: "ATL" },
      { nfl_player_id: "nfl-marvin", display_name: "Marvin Harrison Jr.", position: "WR", abbreviation: "ARI" },
      { nfl_player_id: "nfl-denver", display_name: "Denver D/ST", position: "DST", abbreviation: "DEN" },
    ];
    const source: FantasyProsPlayer[] = [
      { player_id: 1, player_name: "Bijan Robinson", player_team_id: "ATL", player_position_id: "RB", rank_ecr: 1 },
      { player_id: 2, player_name: "Marvin Harrison", player_team_id: "ARI", player_position_id: "WR", rank_ecr: 12 },
      { player_id: 3, player_name: "Denver Broncos", player_team_id: "DEN", player_position_id: "DST", rank_ecr: 150 },
      { player_id: 4, player_name: "Unknown Rookie", player_team_id: "FA", player_position_id: "RB", rank_ecr: 300 },
    ];

    expect(mapPlayers(source, internal).map((item) => item.nflPlayerId)).toEqual([
      "nfl-bijan",
      "nfl-marvin",
      "nfl-denver",
      null,
    ]);
  });
});
