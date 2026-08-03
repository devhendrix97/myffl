type JsonObject = Record<string, unknown>;
type StatKey = "passCmp" | "passAtt" | "passYds" | "passTd" | "passInt" | "rushAtt" | "rushYds" | "rushTd" | "rec" | "targets" | "recYds" | "recTd" | "fgMade" | "fgAtt" | "xpMade" | "xpAtt";
type PlayerDelta = Partial<Record<StatKey, number>>;

interface PlayerDefinition {
  id: string;
  name: string;
  position: string;
  team: "home" | "away";
}

interface ReplayPlay {
  id: string;
  drive: string;
  team: "home" | "away";
  period: number;
  clock: string;
  type: string;
  text: string;
  yardage: number;
  homeScore: number;
  awayScore: number;
  scoring?: boolean;
  turnover?: boolean;
  down?: number;
  distance?: number;
  yardLine?: number;
  deltas?: Record<string, PlayerDelta>;
}

const eventId = "myffl-test-2026-001";
export const replayScenarioId = "full-sunday-game";
export const replayScenarioName = "Full Sunday Game Replay";

const homeTeam = team("9001", "AUS", "Austin Armadillos", "1d4ed8");
const awayTeam = team("9002", "BIR", "Birmingham Vulcans", "dc2626");

const players: PlayerDefinition[] = [
  { id: "99001", name: "Marcus Reed", position: "QB", team: "home" },
  { id: "99002", name: "Darius Cole", position: "RB", team: "home" },
  { id: "99003", name: "Eli Brooks", position: "WR", team: "home" },
  { id: "99004", name: "Noah Grant", position: "TE", team: "home" },
  { id: "99005", name: "Mason Lee", position: "K", team: "home" },
  { id: "99101", name: "Caleb Stone", position: "QB", team: "away" },
  { id: "99102", name: "Andre King", position: "RB", team: "away" },
  { id: "99103", name: "Jaylen Price", position: "WR", team: "away" },
  { id: "99104", name: "Owen Hart", position: "TE", team: "away" },
  { id: "99105", name: "Luca Ford", position: "K", team: "away" },
];

const plays: ReplayPlay[] = [
  play("p001", "d01", "away", 1, "15:00", "Kickoff", "Mason Lee kicks to the Birmingham 4; returned to the 27.", 23, 0, 0),
  play("p002", "d01", "away", 1, "14:21", "Rush", "Andre King rushes right for 6 yards.", 6, 0, 0, { "99102": { rushAtt: 1, rushYds: 6 } }, 2, 4, 33),
  play("p003", "d01", "away", 1, "13:40", "Pass Reception", "Caleb Stone completes to Jaylen Price for 18 yards.", 18, 0, 0, { "99101": { passCmp: 1, passAtt: 1, passYds: 18 }, "99103": { rec: 1, targets: 1, recYds: 18 } }, 1, 10, 49),
  play("p004", "d01", "away", 1, "12:58", "Pass Incompletion", "Caleb Stone pass incomplete for Owen Hart.", 0, 0, 0, { "99101": { passAtt: 1 }, "99104": { targets: 1 } }, 2, 10, 49),
  play("p005", "d01", "away", 1, "11:44", "Field Goal", "Luca Ford makes a 42-yard field goal.", 42, 0, 3, { "99105": { fgMade: 1, fgAtt: 1 } }, 1, 10, 25, true),
  play("p006", "d02", "home", 1, "10:52", "Rush", "Darius Cole rushes up the middle for 9 yards.", 9, 0, 3, { "99002": { rushAtt: 1, rushYds: 9 } }, 2, 1, 34),
  play("p007", "d02", "home", 1, "09:57", "Pass Reception", "Marcus Reed completes to Noah Grant for 12 yards.", 12, 0, 3, { "99001": { passCmp: 1, passAtt: 1, passYds: 12 }, "99004": { rec: 1, targets: 1, recYds: 12 } }, 1, 10, 46),
  play("p008", "d02", "home", 1, "08:31", "Pass Reception", "Marcus Reed completes deep to Eli Brooks for 31 yards.", 31, 0, 3, { "99001": { passCmp: 1, passAtt: 1, passYds: 31 }, "99003": { rec: 1, targets: 1, recYds: 31 } }, 1, 10, 23),
  play("p009", "d02", "home", 1, "07:46", "Rushing Touchdown", "Darius Cole rushes 7 yards for a touchdown.", 7, 6, 3, { "99002": { rushAtt: 1, rushYds: 7, rushTd: 1 } }, 1, 10, 7, true),
  play("p010", "d02", "home", 1, "07:42", "Extra Point", "Mason Lee makes the extra point.", 0, 7, 3, { "99005": { xpMade: 1, xpAtt: 1 } }, 0, 0, 0, true),
  play("p011", "d03", "away", 2, "13:18", "Pass Reception", "Caleb Stone completes to Owen Hart for 22 yards.", 22, 7, 3, { "99101": { passCmp: 1, passAtt: 1, passYds: 22 }, "99104": { rec: 1, targets: 1, recYds: 22 } }, 1, 10, 48),
  play("p012", "d03", "away", 2, "11:59", "Rush", "Andre King breaks left for 26 yards.", 26, 7, 3, { "99102": { rushAtt: 1, rushYds: 26 } }, 1, 10, 22),
  play("p013", "d03", "away", 2, "10:41", "Passing Touchdown", "Caleb Stone finds Jaylen Price for a 14-yard touchdown.", 14, 7, 9, { "99101": { passCmp: 1, passAtt: 1, passYds: 14, passTd: 1 }, "99103": { rec: 1, targets: 1, recYds: 14, recTd: 1 } }, 1, 10, 14, true),
  play("p014", "d03", "away", 2, "10:37", "Extra Point", "Luca Ford makes the extra point.", 0, 7, 10, { "99105": { xpMade: 1, xpAtt: 1 } }, 0, 0, 0, true),
  play("p015", "d04", "home", 2, "08:26", "Pass Reception", "Marcus Reed completes to Eli Brooks for 17 yards.", 17, 7, 10, { "99001": { passCmp: 1, passAtt: 1, passYds: 17 }, "99003": { rec: 1, targets: 1, recYds: 17 } }, 2, 3, 44),
  play("p016", "d04", "home", 2, "06:03", "Pass Incompletion", "Marcus Reed pass incomplete for Eli Brooks.", 0, 7, 10, { "99001": { passAtt: 1 }, "99003": { targets: 1 } }, 3, 8, 39),
  play("p017", "d04", "home", 2, "04:55", "Field Goal", "Mason Lee makes a 46-yard field goal.", 46, 10, 10, { "99005": { fgMade: 1, fgAtt: 1 } }, 1, 10, 28, true),
  play("p018", "d05", "away", 2, "01:12", "Interception", "Caleb Stone is intercepted by Austin at the Austin 38.", 0, 10, 10, { "99101": { passAtt: 1, passInt: 1 } }, 1, 10, 38, false, true),
  play("p019", "d06", "home", 3, "12:34", "Rush", "Darius Cole rushes for 14 yards.", 14, 10, 10, { "99002": { rushAtt: 1, rushYds: 14 } }, 1, 10, 49),
  play("p020", "d06", "home", 3, "10:48", "Passing Touchdown", "Marcus Reed completes to Noah Grant for a 24-yard touchdown.", 24, 16, 10, { "99001": { passCmp: 1, passAtt: 1, passYds: 24, passTd: 1 }, "99004": { rec: 1, targets: 1, recYds: 24, recTd: 1 } }, 1, 10, 24, true),
  play("p021", "d06", "home", 3, "10:44", "Extra Point", "Mason Lee makes the extra point.", 0, 17, 10, { "99005": { xpMade: 1, xpAtt: 1 } }, 0, 0, 0, true),
  play("p022", "d07", "away", 3, "07:18", "Pass Reception", "Caleb Stone completes to Jaylen Price for 34 yards.", 34, 17, 10, { "99101": { passCmp: 1, passAtt: 1, passYds: 34 }, "99103": { rec: 1, targets: 1, recYds: 34 } }, 1, 10, 33),
  play("p023", "d07", "away", 3, "05:02", "Rushing Touchdown", "Andre King rushes 11 yards for a touchdown.", 11, 17, 16, { "99102": { rushAtt: 1, rushYds: 11, rushTd: 1 } }, 1, 10, 11, true),
  play("p024", "d07", "away", 3, "04:58", "Extra Point", "Luca Ford makes the extra point.", 0, 17, 17, { "99105": { xpMade: 1, xpAtt: 1 } }, 0, 0, 0, true),
  play("p025", "d08", "home", 4, "12:47", "Pass Reception", "Marcus Reed completes to Eli Brooks for 28 yards.", 28, 17, 17, { "99001": { passCmp: 1, passAtt: 1, passYds: 28 }, "99003": { rec: 1, targets: 1, recYds: 28 } }, 1, 10, 36),
  play("p026", "d08", "home", 4, "09:23", "Field Goal", "Mason Lee makes a 38-yard field goal.", 38, 20, 17, { "99005": { fgMade: 1, fgAtt: 1 } }, 1, 10, 20, true),
  play("p027", "d09", "away", 4, "04:16", "Pass Reception", "Caleb Stone completes to Owen Hart for 19 yards.", 19, 20, 17, { "99101": { passCmp: 1, passAtt: 1, passYds: 19 }, "99104": { rec: 1, targets: 1, recYds: 19 } }, 1, 10, 41),
  play("p028", "d09", "away", 4, "02:08", "Missed Field Goal", "Luca Ford misses a 51-yard field goal wide right.", 51, 20, 17, { "99105": { fgAtt: 1 } }, 1, 10, 33),
  play("p029", "d10", "home", 4, "01:21", "Rush", "Darius Cole rushes for 5 yards; Birmingham takes its final timeout.", 5, 20, 17, { "99002": { rushAtt: 1, rushYds: 5 } }, 2, 5, 38),
  play("p030", "d10", "home", 4, "00:00", "End Game", "Marcus Reed kneels. The game is over.", -1, 20, 17, { "99001": { rushAtt: 1, rushYds: -1 } }, 0, 0, 0),
];

export const fullGameReplayFrames: JsonObject[] = buildFrames();

function buildFrames(): JsonObject[] {
  const totals = new Map(players.map((player) => [player.id, emptyStats()]));
  const frames: JsonObject[] = [frame(0, undefined, totals, [])];
  plays.forEach((currentPlay, index) => {
    for (const [playerId, delta] of Object.entries(currentPlay.deltas ?? {})) {
      const current = totals.get(playerId);
      if (!current) continue;
      for (const [key, value] of Object.entries(delta) as Array<[StatKey, number]>) current[key] += value;
    }
    frames.push(frame(index + 1, currentPlay, totals, plays.slice(0, index + 1)));
  });
  return frames;
}

function frame(frameNumber: number, current: ReplayPlay | undefined, totals: Map<string, Record<StatKey, number>>, visiblePlays: ReplayPlay[]): JsonObject {
  const final = current?.id === "p030";
  const state = !current ? "pre" : final ? "post" : "in";
  const period = current?.period ?? 0;
  const clock = current?.clock ?? "15:00";
  const homeScore = current?.homeScore ?? 0;
  const awayScore = current?.awayScore ?? 0;
  const possessionTeam = current?.team === "away" ? awayTeam : homeTeam;
  const driveGroups = [...new Set(visiblePlays.map((item) => item.drive))].map((driveId) => {
    const drivePlays = visiblePlays.filter((item) => item.drive === driveId);
    const last = drivePlays[drivePlays.length - 1];
    return { id: driveId, team: last.team === "home" ? homeTeam : awayTeam, description: `Drive ${driveId.slice(1)}`, isScore: drivePlays.some((item) => item.scoring), displayResult: last.scoring ? last.type : "Drive", plays: drivePlays.map(providerPlay) };
  });
  return {
    frameNumber,
    simulatedAtUtc: `2026-09-13T${String(17 + Math.floor(frameNumber / 12)).padStart(2, "0")}:${String((frameNumber * 3) % 60).padStart(2, "0")}:00.000Z`,
    message: current?.text ?? "The test game is scheduled and awaiting kickoff.",
    scoreboard: { events: [{ id: eventId, date: "2026-09-13T17:00:00.000Z", season: { year: 2026, type: 2 }, week: { number: 1 }, status: { period, displayClock: clock, type: { state, detail: final ? "Final" : !current ? "Scheduled" : `${ordinal(period)} Quarter`, description: final ? "Final" : "In Progress", completed: final } }, competitions: [{ situation: current ? { possession: String(possessionTeam.id), down: current.down ?? 1, distance: current.distance ?? 10, yardLine: current.yardLine ?? 25, lastPlay: providerPlay(current) } : null, competitors: [{ homeAway: "home", team: homeTeam, score: String(homeScore) }, { homeAway: "away", team: awayTeam, score: String(awayScore) }] }] }] },
    summaries: { [eventId]: { drives: { previous: driveGroups }, scoringPlays: visiblePlays.filter((item) => item.scoring).map(providerPlay), boxscore: { players: [teamBox("home", totals), teamBox("away", totals)] } } },
  };
}

function teamBox(side: "home" | "away", totals: Map<string, Record<StatKey, number>>): JsonObject {
  const selected = players.filter((player) => player.team === side);
  const athlete = (player: PlayerDefinition, stats: Array<string | number>) => ({ athlete: { id: player.id, displayName: player.name, position: { abbreviation: player.position } }, stats: stats.map(String) });
  const byPosition = (positions: string[]) => selected.filter((player) => positions.includes(player.position));
  return { team: side === "home" ? homeTeam : awayTeam, statistics: [
    { name: "passing", labels: ["C/ATT", "YDS", "AVG", "TD", "INT", "SACKS", "QBR", "RTG"], athletes: byPosition(["QB"]).map((player) => { const s = totals.get(player.id)!; return athlete(player, [`${s.passCmp}/${s.passAtt}`, s.passYds, average(s.passYds, s.passAtt), s.passTd, s.passInt, "0-0", "0.0", "0.0"]); }) },
    { name: "rushing", labels: ["CAR", "YDS", "AVG", "TD", "LONG"], athletes: byPosition(["QB", "RB"]).map((player) => { const s = totals.get(player.id)!; return athlete(player, [s.rushAtt, s.rushYds, average(s.rushYds, s.rushAtt), s.rushTd, Math.max(0, s.rushYds)]); }) },
    { name: "receiving", labels: ["REC", "YDS", "AVG", "TD", "LONG", "TGTS"], athletes: byPosition(["WR", "TE"]).map((player) => { const s = totals.get(player.id)!; return athlete(player, [s.rec, s.recYds, average(s.recYds, s.rec), s.recTd, Math.max(0, s.recYds), s.targets]); }) },
    { name: "kicking", labels: ["FG", "PCT", "LONG", "XP", "PTS"], athletes: byPosition(["K"]).map((player) => { const s = totals.get(player.id)!; return athlete(player, [`${s.fgMade}/${s.fgAtt}`, percentage(s.fgMade, s.fgAtt), s.fgMade ? (side === "home" ? 46 : 42) : 0, `${s.xpMade}/${s.xpAtt}`, s.fgMade * 3 + s.xpMade]); }) },
  ] };
}

function providerPlay(item: ReplayPlay): JsonObject {
  const teamValue = item.team === "home" ? homeTeam : awayTeam;
  return { id: item.id, sequenceNumber: item.id.slice(1), type: { text: item.type }, text: item.text, awayScore: item.awayScore, homeScore: item.homeScore, period: { number: item.period }, clock: { displayValue: item.clock }, scoringPlay: Boolean(item.scoring), isTurnover: Boolean(item.turnover), statYardage: item.yardage, start: { down: item.down ?? 1, distance: item.distance ?? 10, yardLine: item.yardLine ?? 25, team: { id: teamValue.id } }, end: {}, teamParticipants: [{ team: { id: teamValue.id } }] };
}

function play(id: string, drive: string, teamSide: "home" | "away", period: number, clock: string, type: string, text: string, yardage: number, homeScore: number, awayScore: number, deltas?: Record<string, PlayerDelta>, down?: number, distance?: number, yardLine?: number, scoring = false, turnover = false): ReplayPlay {
  return { id, drive, team: teamSide, period, clock, type, text, yardage, homeScore, awayScore, deltas, down, distance, yardLine, scoring, turnover };
}

function emptyStats(): Record<StatKey, number> {
  return { passCmp: 0, passAtt: 0, passYds: 0, passTd: 0, passInt: 0, rushAtt: 0, rushYds: 0, rushTd: 0, rec: 0, targets: 0, recYds: 0, recTd: 0, fgMade: 0, fgAtt: 0, xpMade: 0, xpAtt: 0 };
}
function team(id: string, abbreviation: string, displayName: string, color: string): JsonObject { return { id, abbreviation, displayName, color, alternateColor: "ffffff", isActive: true }; }
function ordinal(period: number): string { return period === 1 ? "1st" : period === 2 ? "2nd" : period === 3 ? "3rd" : "4th"; }
function average(total: number, count: number): string { return count ? (total / count).toFixed(1) : "0.0"; }
function percentage(made: number, attempts: number): string { return attempts ? ((made / attempts) * 100).toFixed(1) : "0.0"; }
