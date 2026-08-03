import { describe, expect, it } from "vitest";
import { fullGameReplayFrames } from "./replay-scenario";

describe("full game replay", () => {
  it("progresses from scheduled kickoff through a final game", () => {
    expect(fullGameReplayFrames).toHaveLength(31);
    const first = fullGameReplayFrames[0] as any;
    const final = fullGameReplayFrames.at(-1) as any;
    expect(first.scoreboard.events[0].status.type.state).toBe("pre");
    expect(final.scoreboard.events[0].status.type).toMatchObject({ state: "post", completed: true });
    expect(final.scoreboard.events[0].competitions[0].competitors.map((team: any) => team.score)).toEqual(["20", "17"]);
    expect(final.summaries["myffl-test-2026-001"].drives.previous).toHaveLength(10);
  });

  it("publishes cumulative multi-player stats and one additional play per frame", () => {
    const middle = fullGameReplayFrames[15] as any;
    const final = fullGameReplayFrames.at(-1) as any;
    const middlePlays = middle.summaries["myffl-test-2026-001"].drives.previous.flatMap((drive: any) => drive.plays);
    const finalSummary = final.summaries["myffl-test-2026-001"];
    const finalPlays = finalSummary.drives.previous.flatMap((drive: any) => drive.plays);
    const athleteIds = new Set(finalSummary.boxscore.players.flatMap((team: any) => team.statistics)
      .flatMap((category: any) => category.athletes).map((entry: any) => entry.athlete.id));
    expect(middlePlays).toHaveLength(15);
    expect(finalPlays).toHaveLength(30);
    expect(athleteIds.size).toBe(10);
    expect(finalSummary.boxscore.players[0].statistics.map((category: any) => [category.name, category.labels])).toEqual([
      ["passing", ["C/ATT", "YDS", "AVG", "TD", "INT", "SACKS", "QBR", "RTG"]],
      ["rushing", ["CAR", "YDS", "AVG", "TD", "LONG"]],
      ["receiving", ["REC", "YDS", "AVG", "TD", "LONG", "TGTS"]],
      ["kicking", ["FG", "PCT", "LONG", "XP", "PTS"]],
    ]);
  });
});
