import { authenticate, type HandlerResult } from "./auth";
import { ApiException } from "./http";
import { requireLeagueRole } from "./league";

const SOURCE_NAME = "FantasyPros Expert Consensus Rankings";
const SOURCE_URL = "https://www.fantasypros.com/nfl/rankings/consensus-cheatsheets.php";
const API_BASE = "https://api.fantasypros.com/public/v2/json";
const DAILY_REQUEST_BUDGET = 8;
const SNAPSHOT_FRESH_HOURS = 20;
const SCORING = ["STD", "HALF", "PPR"] as const;

export type RankingScoring = typeof SCORING[number];

export interface FantasyProsRanking {
  playerId: string;
  overallRank: number;
  positionRank?: string;
  tier?: number;
  sourceUpdatedAt?: string;
  fetchedAtUtc: string;
}

export interface FantasyProsPlayer {
  player_id?: string | number;
  player_name?: string;
  player_team_id?: string;
  player_position_id?: string;
  player_positions?: string;
  player_page_url?: string;
  rank_ecr?: string | number;
  rank_min?: string | number;
  rank_max?: string | number;
  rank_ave?: string | number;
  rank_std?: string | number;
  pos_rank?: string;
  tier?: string | number;
}

interface FantasyProsPayload {
  last_updated?: string;
  players?: FantasyProsPlayer[];
}

export interface InternalPlayer {
  nfl_player_id: string;
  display_name: string;
  position: string | null;
  abbreviation: string | null;
}

export async function handleFantasyProsRequest(
  request: Request,
  url: URL,
  env: Env,
): Promise<HandlerResult<unknown> | undefined> {
  const match = url.pathname.match(/^\/api\/leagues\/([^/]+)\/rankings$/);
  if (!match || request.method !== "GET") return undefined;
  const principal = await authenticate(request, env);
  const access = await requireLeagueRole(principal, match[1], env, ["commissioner", "co-commissioner", "manager"]);
  const context = await rankingContext(access.db, match[1], undefined);
  const rows = await env.NFL_DB.prepare(
    `select nfl_player_id as playerId,display_name as displayName,team_abbreviation as nflTeam,
      position,overall_rank as overallRank,position_rank as positionRank,tier,
      source_updated_at as sourceUpdatedAt,fetched_at_utc as fetchedAtUtc
     from fantasypros_rankings
     where season_year=?1 and scoring=?2 and nfl_player_id is not null
     order by overall_rank limit 500`,
  ).bind(context.seasonYear, context.scoring).all();
  return {
    data: {
      seasonYear: context.seasonYear,
      scoring: context.scoring,
      sourceName: SOURCE_NAME,
      sourceUrl: SOURCE_URL,
      fetchedAtUtc: rows.results?.[0] && String((rows.results[0] as Record<string, unknown>).fetchedAtUtc),
      players: rows.results ?? [],
    },
  };
}

export async function syncFantasyProsIfDue(env: Env, now = new Date()): Promise<void> {
  if (String(env.FANTASYPROS_SYNC_ENABLED) !== "true" || !env.FANTASYPROS_API_KEY) return;
  if (![10, 14, 18].includes(now.getUTCHours()) || now.getUTCMinutes() !== 10) return;
  const season = now.getUTCFullYear();
  const scopes: Array<{ scoring: RankingScoring; position: "ALL" | "IDP"; copyTo?: readonly RankingScoring[] }> = [
    ...SCORING.map((scoring) => ({ scoring, position: "ALL" as const })),
    { scoring: "STD", position: "IDP", copyTo: SCORING },
  ];
  for (const scope of scopes) {
    try { await syncScope(env, season, scope.scoring, scope.position, now, scope.copyTo); }
    catch (error) { console.error(JSON.stringify({ level: "error", event: "fantasypros_sync_failed", scoring: scope.scoring, position: scope.position, error: error instanceof Error ? error.message : String(error) })); }
  }
}

async function syncScope(
  env: Env,
  season: number,
  scoring: RankingScoring,
  position: "ALL" | "IDP",
  now: Date,
  copyTo: readonly RankingScoring[] = [scoring],
): Promise<void> {
  const apiKey = env.FANTASYPROS_API_KEY;
  if (!apiKey) return;
  const requestDate = now.toISOString().slice(0, 10);
  const [daily, latest] = await Promise.all([
    env.NFL_DB.prepare("select count(*) as count from fantasypros_sync_runs where request_date=?1").bind(requestDate).first<{ count: number }>(),
    env.NFL_DB.prepare(
      "select completed_at_utc from fantasypros_sync_runs where season_year=?1 and scoring=?2 and position_scope=?3 and status='succeeded' order by completed_at_utc desc limit 1",
    ).bind(season, scoring, position).first<{ completed_at_utc: string }>(),
  ]);
  if ((daily?.count ?? 0) >= DAILY_REQUEST_BUDGET) throw new Error("FantasyPros daily request circuit breaker is open.");
  if (latest && now.getTime() - Date.parse(latest.completed_at_utc) < SNAPSHOT_FRESH_HOURS * 3_600_000) return;

  const runId = crypto.randomUUID();
  const started = now.toISOString();
  await env.NFL_DB.prepare(
    `insert into fantasypros_sync_runs
      (fantasypros_sync_run_id,request_date,season_year,scoring,position_scope,status,started_at_utc)
     values(?1,?2,?3,?4,?5,'started',?6)`,
  ).bind(runId, requestDate, season, scoring, position, started).run();

  try {
    const endpoint = `${API_BASE}/nfl/${season}/consensus-rankings?position=${position}&scoring=${scoring}&week=0`;
    const response = await fetch(endpoint, {
      headers: { accept: "application/json", "x-api-key": apiKey },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`FantasyPros returned ${response.status}.`);
    const payload = await response.json() as FantasyProsPayload;
    const players = Array.isArray(payload.players) ? payload.players : [];
    const internal = await loadInternalPlayers(env.NFL_DB);
    const mapped = mapPlayers(players, internal);
    const fetchedAt = new Date().toISOString();

    for (const targetScoring of copyTo) {
      for (let index = 0; index < mapped.length; index += 75) {
        await env.NFL_DB.batch(mapped.slice(index, index + 75).map(({ source, nflPlayerId }) => env.NFL_DB.prepare(
          `insert into fantasypros_rankings
            (season_year,scoring,fantasypros_player_id,nfl_player_id,display_name,team_abbreviation,position,
             overall_rank,position_rank,tier,rank_min,rank_max,rank_average,rank_std_dev,player_page_url,
             source_updated_at,fetched_at_utc)
           values(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)
           on conflict(season_year,scoring,fantasypros_player_id) do update set
             nfl_player_id=excluded.nfl_player_id,display_name=excluded.display_name,
             team_abbreviation=excluded.team_abbreviation,position=excluded.position,
             overall_rank=excluded.overall_rank,position_rank=excluded.position_rank,tier=excluded.tier,
             rank_min=excluded.rank_min,rank_max=excluded.rank_max,rank_average=excluded.rank_average,
             rank_std_dev=excluded.rank_std_dev,player_page_url=excluded.player_page_url,
             source_updated_at=excluded.source_updated_at,fetched_at_utc=excluded.fetched_at_utc`,
        ).bind(
          season, targetScoring, String(source.player_id), nflPlayerId, source.player_name,
          source.player_team_id ?? null, primaryPosition(source), integer(source.rank_ecr, 9999),
          source.pos_rank ?? null, nullableInteger(source.tier), nullableInteger(source.rank_min),
          nullableInteger(source.rank_max), nullableNumber(source.rank_ave), nullableNumber(source.rank_std),
          source.player_page_url ?? null, payload.last_updated ?? null, fetchedAt,
        )));
      }
      const positionClause = position === "ALL"
        ? "position not in ('DL','LB','DB','IDP')"
        : "position in ('DL','LB','DB','IDP')";
      await env.NFL_DB.prepare(
        `delete from fantasypros_rankings
         where season_year=?1 and scoring=?2 and ${positionClause} and fetched_at_utc<>?3`,
      ).bind(season, targetScoring, fetchedAt).run();
    }

    const mappingWrites = mapped.filter((item) => item.nflPlayerId).map((item) => env.NFL_DB.prepare(
      `insert into provider_player_mappings(provider,provider_player_id,nfl_player_id,created_at_utc)
       values('fantasypros',?1,?2,?3)
       on conflict(provider,provider_player_id) do update set nfl_player_id=excluded.nfl_player_id`,
    ).bind(String(item.source.player_id), item.nflPlayerId, fetchedAt));
    for (let index = 0; index < mappingWrites.length; index += 75) await env.NFL_DB.batch(mappingWrites.slice(index, index + 75));
    await env.NFL_DB.prepare(
      "update fantasypros_sync_runs set status='succeeded',records_seen=?2,records_mapped=?3,completed_at_utc=?4 where fantasypros_sync_run_id=?1",
    ).bind(runId, players.length, mapped.filter((item) => item.nflPlayerId).length, fetchedAt).run();
  } catch (error) {
    await env.NFL_DB.prepare(
      "update fantasypros_sync_runs set status='failed',error_message=?2,completed_at_utc=?3 where fantasypros_sync_run_id=?1",
    ).bind(runId, error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500), new Date().toISOString()).run();
    throw error;
  }
}

export async function rankingContext(
  db: D1Database,
  leagueId: string,
  seasonId?: string,
): Promise<{ seasonYear: number; scoring: RankingScoring }> {
  const season = await db.prepare(
    `select seasons.season_year as seasonYear,
      coalesce((select rules.point_value_milli from scoring_rules rules
       join scoring_versions versions on versions.scoring_version_id=rules.scoring_version_id
       where versions.league_season_id=seasons.league_season_id and versions.status='active'
       and rules.statistic_key='receptions' and rules.enabled=1 limit 1),0) as receptionPoints
     from league_seasons seasons where seasons.league_id=?1 and (?2 is null or seasons.league_season_id=?2)
     order by seasons.season_year desc limit 1`,
  ).bind(leagueId, seasonId ?? null).first<{ seasonYear: number; receptionPoints: number }>();
  if (!season) throw new ApiException(404, "league_season_not_found", "The league season was not found.");
  return { seasonYear: season.seasonYear, scoring: scoringFromReceptionPoints(season.receptionPoints) };
}

export async function rankingsForPlayers(
  db: D1Database,
  seasonYear: number,
  scoring: RankingScoring,
  playerIds: string[],
): Promise<Map<string, FantasyProsRanking>> {
  if (!playerIds.length) return new Map();
  const rankings = new Map<string, FantasyProsRanking>();
  for (let start = 0; start < playerIds.length; start += 75) {
    const chunk = playerIds.slice(start, start + 75);
    const placeholders = chunk.map((_, index) => `?${index + 3}`).join(",");
    const rows = await db.prepare(
      `select nfl_player_id as playerId,overall_rank as overallRank,position_rank as positionRank,tier,
        source_updated_at as sourceUpdatedAt,fetched_at_utc as fetchedAtUtc
       from fantasypros_rankings where season_year=?1 and scoring=?2 and nfl_player_id in (${placeholders})`,
    ).bind(seasonYear, scoring, ...chunk).all<FantasyProsRanking>();
    for (const row of rows.results ?? []) rankings.set(row.playerId, row);
  }
  return rankings;
}

export function scoringFromReceptionPoints(pointsMilli: number): RankingScoring {
  if (pointsMilli >= 750) return "PPR";
  if (pointsMilli >= 250) return "HALF";
  return "STD";
}

export function mapPlayers(players: FantasyProsPlayer[], internal: InternalPlayer[]): Array<{ source: Required<Pick<FantasyProsPlayer, "player_id" | "player_name">> & FantasyProsPlayer; nflPlayerId: string | null }> {
  const byName = new Map<string, InternalPlayer[]>();
  for (const player of internal) {
    const key = normalizeName(player.display_name);
    byName.set(key, [...(byName.get(key) ?? []), player]);
  }
  return players.filter((player): player is Required<Pick<FantasyProsPlayer, "player_id" | "player_name">> & FantasyProsPlayer =>
    player.player_id !== undefined && Boolean(player.player_name) && Number.isFinite(Number(player.rank_ecr)),
  ).map((source) => {
    const position = primaryPosition(source);
    const candidates = byName.get(normalizeName(source.player_name)) ?? [];
    let match = candidates.find((candidate) => candidate.position === position && candidate.abbreviation === source.player_team_id)
      ?? candidates.find((candidate) => candidate.position === position)
      ?? (position === "DST" ? internal.find((candidate) => candidate.position === "DST" && candidate.abbreviation === source.player_team_id) : undefined);
    return { source, nflPlayerId: match?.nfl_player_id ?? null };
  });
}

async function loadInternalPlayers(db: D1Database): Promise<InternalPlayer[]> {
  const rows = await db.prepare(
    `select players.nfl_player_id,players.display_name,players.position,teams.abbreviation
     from nfl_players players left join nfl_teams teams on teams.nfl_team_id=players.current_team_id
     where players.merged_into_player_id is null`,
  ).all<InternalPlayer>();
  return rows.results ?? [];
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/\b(jr|sr|ii|iii|iv)\b/g, "").replace(/[^a-z0-9]/g, "");
}

function primaryPosition(player: FantasyProsPlayer): string {
  return String(player.player_position_id ?? player.player_positions ?? "UNK").split(",")[0].trim().toUpperCase();
}

function integer(value: unknown, fallback: number): number { const parsed = Number(value); return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback; }
function nullableInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}
function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
