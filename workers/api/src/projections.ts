import { calculatePlayerScore } from "./scoring-engine";
import { loadScoringRules } from "./scoring-rules";

type ProjectionKind = "season" | "weekly";

interface SeasonProjectionContext {
  seasonYear: number;
  scoringVersionId: string | null;
}

interface ProjectionRow {
  nfl_player_id: string;
  position: string | null;
  week_number: number;
  projected_stats_json: string;
}

export async function loadUpcomingProjectionWeek(nflDb: D1Database, seasonYear: number): Promise<number> {
  const row = await nflDb.prepare(
    `select coalesce(
       (select min(week) from nfl_events where season_year = ?1 and season_type = 2 and starts_at_utc >= ?2),
       (select max(week) from nfl_events where season_year = ?1 and season_type = 2),
       1
     ) as week`,
  ).bind(seasonYear, new Date().toISOString()).first<{ week: number }>();
  const week = Number(row?.week ?? 1);
  return Number.isInteger(week) && week >= 1 && week <= 22 ? week : 1;
}

export async function loadSeasonAverageProjectionPoints(
  leagueDb: D1Database,
  nflDb: D1Database,
  seasonId: string,
  playerIds: string[],
): Promise<Map<string, number>> {
  return calculateProjectionPoints(leagueDb, nflDb, seasonId, playerIds, { kind: "season", divisor: 17 });
}

export async function loadWeeklyProjectionPoints(
  leagueDb: D1Database,
  nflDb: D1Database,
  seasonId: string,
  playerIds: string[],
  week: number,
): Promise<Map<string, number>> {
  return calculateProjectionPoints(leagueDb, nflDb, seasonId, playerIds, { kind: "weekly", week });
}

export async function loadRemainingAverageProjectionPoints(
  leagueDb: D1Database,
  nflDb: D1Database,
  seasonId: string,
  playerIds: string[],
  startWeek: number,
): Promise<Map<string, number>> {
  return calculateProjectionPoints(leagueDb, nflDb, seasonId, playerIds, { kind: "remaining", startWeek });
}

async function calculateProjectionPoints(
  leagueDb: D1Database,
  nflDb: D1Database,
  seasonId: string,
  playerIds: string[],
  options: { kind: ProjectionKind; week?: number; divisor?: number } | { kind: "remaining"; startWeek: number },
): Promise<Map<string, number>> {
  const ids = [...new Set(playerIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const context = await loadProjectionContext(leagueDb, seasonId);
  if (!context.scoringVersionId) return new Map();
  const rules = await loadScoringRules(leagueDb, context.scoringVersionId);
  const rows = await loadProjectionRows(nflDb, context.seasonYear, ids, options);
  const totals = new Map<string, { points: number; count: number }>();
  for (const row of rows) {
    const calculation = calculatePlayerScore(parseObject(row.projected_stats_json), row.position, rules);
    const bucket = totals.get(row.nfl_player_id) ?? { points: 0, count: 0 };
    bucket.points += calculation.totalPointsMilli / 1000;
    bucket.count += 1;
    totals.set(row.nfl_player_id, bucket);
  }
  const result = new Map<string, number>();
  for (const [playerId, value] of totals) {
    const divisor = options.kind === "season" ? options.divisor ?? 17 : options.kind === "remaining" ? value.count : 1;
    result.set(playerId, roundTenths(value.points / Math.max(1, divisor)));
  }
  return result;
}

async function loadProjectionContext(db: D1Database, seasonId: string): Promise<SeasonProjectionContext> {
  return await db.prepare(
    "select season_year as seasonYear, scoring_version_id as scoringVersionId from league_seasons where league_season_id = ?1",
  ).bind(seasonId).first<SeasonProjectionContext>() ?? { seasonYear: new Date().getUTCFullYear(), scoringVersionId: null };
}

async function loadProjectionRows(
  db: D1Database,
  seasonYear: number,
  playerIds: string[],
  options: { kind: ProjectionKind; week?: number } | { kind: "remaining"; startWeek: number },
): Promise<ProjectionRow[]> {
  const rows: ProjectionRow[] = [];
  for (const chunk of chunks(playerIds, 75)) {
    const placeholders = chunk.map((_, index) => `?${index + 1}`).join(",");
    const binds: unknown[] = [...chunk, seasonYear];
    let where = `nfl_player_id in (${placeholders}) and provider = 'espn' and season_year = ?${binds.length} and projection_type = 'season' and week_number = 0`;
    if (options.kind === "weekly") {
      binds.push(options.week ?? 1);
      where = `nfl_player_id in (${placeholders}) and provider = 'espn' and season_year = ?${binds.length - 1} and projection_type = 'weekly' and week_number = ?${binds.length}`;
    } else if (options.kind === "remaining") {
      binds.push(options.startWeek);
      where = `nfl_player_id in (${placeholders}) and provider = 'espn' and season_year = ?${binds.length - 1} and projection_type = 'weekly' and week_number >= ?${binds.length} and week_number <= 18`;
    }
    const result = await db.prepare(
      `select nfl_player_id, position, week_number, projected_stats_json from player_projections where ${where}`,
    ).bind(...binds).all<ProjectionRow>();
    rows.push(...(result.results ?? []));
  }
  return rows;
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function roundTenths(value: number): number {
  return Math.round(value * 10) / 10;
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}
