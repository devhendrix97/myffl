import { authenticate, type HandlerResult } from "./auth";
import { ApiException, readJson } from "./http";
import { requireLeagueRole } from "./league";
import { resolveFantasyProsApiKey } from "./provider-credentials";

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
  byeWeek?: number;
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
  player_bye_week?: string | number;
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
  if (url.pathname === "/api/internal/fantasypros/csv" && request.method === "POST") {
    return importFantasyProsCsvFromInternalRequest(request, env);
  }
  if (url.pathname === "/api/internal/fantasypros/csv-sync" && request.method === "POST") {
    return syncFantasyProsCsvFromInternalRequest(request, env);
  }
  if (url.pathname === "/api/internal/fantasypros/api-sync" && request.method === "POST") {
    return syncFantasyProsApiFromInternalRequest(request, env);
  }
  const match = url.pathname.match(/^\/api\/leagues\/([^/]+)\/rankings$/);
  if (!match || request.method !== "GET") return undefined;
  const principal = await authenticate(request, env);
  const access = await requireLeagueRole(principal, match[1], env, ["commissioner", "co-commissioner", "manager"]);
  const context = await rankingContext(access.db, match[1], undefined);
  const rows = await env.NFL_DB.prepare(
    `select nfl_player_id as playerId,display_name as displayName,team_abbreviation as nflTeam,
      position,overall_rank as overallRank,position_rank as positionRank,tier,
      bye_week as byeWeek,source_updated_at as sourceUpdatedAt,fetched_at_utc as fetchedAtUtc
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
  if (![10, 14, 18].includes(now.getUTCHours()) || now.getUTCMinutes() !== 10) {
    const season = now.getUTCFullYear();
    const existing = await env.NFL_DB.prepare(
      "select 1 from fantasypros_rankings where season_year=?1 and nfl_player_id is not null limit 1",
    ).bind(season).first();
    const usage = await fantasyProsRequestUsage(env, now);
    if (existing || usage.requestsUsed > 0) return;
  }
  await syncFantasyProsNow(env, now);
}

export async function syncFantasyProsNow(env: Env, now = new Date()): Promise<void> {
  const apiKey = await resolveFantasyProsApiKey(env);
  if (!apiKey) return;
  const season = now.getUTCFullYear();
  const scopes: Array<{ scoring: RankingScoring; position: "ALL" | "IDP"; copyTo?: readonly RankingScoring[] }> = [
    ...SCORING.map((scoring) => ({ scoring, position: "ALL" as const })),
    { scoring: "STD", position: "IDP", copyTo: SCORING },
  ];
  const failures: string[] = [];
  for (const scope of scopes) {
    try { await syncScope(env, apiKey, season, scope.scoring, scope.position, now, scope.copyTo); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${scope.scoring}/${scope.position}: ${message}`);
      console.error(JSON.stringify({ level: "error", event: "fantasypros_sync_failed", scoring: scope.scoring, position: scope.position, error: message }));
    }
  }
  if (failures.length === scopes.length) {
    throw new ApiException(502, "fantasypros_sync_failed", failures[0] ?? "FantasyPros sync failed.");
  }
}

export async function validateFantasyProsApiKey(env: Env, apiKey: string, now = new Date()): Promise<{ validatedAtUtc: string; playersSeen: number }> {
  const value = apiKey.trim();
  if (value.length < 16) throw new ApiException(400, "invalid_provider_key", "Enter a valid FantasyPros API key.");
  const requestDate = now.toISOString().slice(0, 10);
  await reserveFantasyProsRequest(env.NFL_DB, requestDate, now);
  const runId = crypto.randomUUID();
  const started = now.toISOString();
  await env.NFL_DB.prepare(
    `insert into fantasypros_sync_runs
      (fantasypros_sync_run_id,request_date,season_year,scoring,position_scope,status,started_at_utc)
     values(?1,?2,?3,'PPR','VALIDATION','started',?4)`,
  ).bind(runId, requestDate, now.getUTCFullYear(), started).run();
  try {
    const endpoint = `${API_BASE}/nfl/${now.getUTCFullYear()}/consensus-rankings?position=ALL&scoring=PPR&week=0`;
    const response = await fetch(endpoint, {
      headers: { accept: "application/json", "x-api-key": value },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      const message = response.status === 401 || response.status === 403
        ? "FantasyPros rejected the API key."
        : `FantasyPros validation returned ${response.status}.`;
      throw new ApiException(response.status === 401 || response.status === 403 ? 400 : 502, "provider_key_validation_failed", message);
    }
    const payload = await response.json() as FantasyProsPayload;
    const players = Array.isArray(payload.players) ? payload.players.length : 0;
    if (!players) throw new ApiException(502, "provider_key_validation_failed", "FantasyPros returned no ranking players.");
    const validatedAtUtc = new Date().toISOString();
    await env.NFL_DB.prepare(
      "update fantasypros_sync_runs set status='succeeded',records_seen=?2,completed_at_utc=?3 where fantasypros_sync_run_id=?1",
    ).bind(runId, players, validatedAtUtc).run();
    return { validatedAtUtc, playersSeen: players };
  } catch (error) {
    await env.NFL_DB.prepare(
      "update fantasypros_sync_runs set status='failed',error_message=?2,completed_at_utc=?3 where fantasypros_sync_run_id=?1",
    ).bind(runId, error instanceof Error ? error.message.slice(0, 500) : "FantasyPros validation failed.", new Date().toISOString()).run();
    throw error;
  }
}

export async function fantasyProsRequestUsage(env: Env, now = new Date()): Promise<{ requestDate: string; requestsUsed: number; requestLimit: number; requestsRemaining: number }> {
  const requestDate = now.toISOString().slice(0, 10);
  const [budget, ledger] = await Promise.all([
    env.NFL_DB.prepare("select attempts from fantasypros_daily_budgets where request_date=?1").bind(requestDate).first<{ attempts: number }>(),
    env.NFL_DB.prepare("select count(*) as count from fantasypros_sync_runs where request_date=?1").bind(requestDate).first<{ count: number }>(),
  ]);
  const requestsUsed = Math.max(budget?.attempts ?? 0, ledger?.count ?? 0);
  return { requestDate, requestsUsed, requestLimit: DAILY_REQUEST_BUDGET, requestsRemaining: Math.max(0, DAILY_REQUEST_BUDGET - requestsUsed) };
}

async function syncScope(
  env: Env,
  apiKey: string,
  season: number,
  scoring: RankingScoring,
  position: "ALL" | "IDP",
  now: Date,
  copyTo: readonly RankingScoring[] = [scoring],
): Promise<void> {
  const requestDate = now.toISOString().slice(0, 10);
  const latest = await env.NFL_DB.prepare(
    "select completed_at_utc from fantasypros_sync_runs where season_year=?1 and scoring=?2 and position_scope=?3 and status='succeeded' order by completed_at_utc desc limit 1",
  ).bind(season, scoring, position).first<{ completed_at_utc: string }>();
  if (latest && now.getTime() - Date.parse(latest.completed_at_utc) < SNAPSHOT_FRESH_HOURS * 3_600_000) return;
  await reserveFantasyProsRequest(env.NFL_DB, requestDate, now);

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
             bye_week,source_scope,source_updated_at,fetched_at_utc)
           values(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)
           on conflict(season_year,scoring,fantasypros_player_id) do update set
             nfl_player_id=excluded.nfl_player_id,display_name=excluded.display_name,
             team_abbreviation=excluded.team_abbreviation,position=excluded.position,
             overall_rank=excluded.overall_rank,position_rank=excluded.position_rank,tier=excluded.tier,
             rank_min=excluded.rank_min,rank_max=excluded.rank_max,rank_average=excluded.rank_average,
             rank_std_dev=excluded.rank_std_dev,player_page_url=excluded.player_page_url,bye_week=excluded.bye_week,
             source_updated_at=excluded.source_updated_at,fetched_at_utc=excluded.fetched_at_utc,source_scope=excluded.source_scope`,
        ).bind(
          season, targetScoring, String(source.player_id), nflPlayerId, source.player_name,
          source.player_team_id ?? null, primaryPosition(source), integer(source.rank_ecr, 9999),
          source.pos_rank ?? null, nullableInteger(source.tier), nullableInteger(source.rank_min),
          nullableInteger(source.rank_max), nullableNumber(source.rank_ave), nullableNumber(source.rank_std),
          source.player_page_url ?? null, nullableInteger(source.player_bye_week), "API", payload.last_updated ?? null, fetchedAt,
        )));
      }
      const positionClause = position === "ALL"
        ? "position not in ('DL','LB','DB','IDP')"
        : "position in ('DL','LB','DB','IDP')";
      await env.NFL_DB.prepare(
        `delete from fantasypros_rankings
         where season_year=?1 and scoring=?2 and ${positionClause} and fetched_at_utc<>?3 and source_scope='API'`,
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

export async function syncFantasyProsApiScopeNow(
  env: Env,
  options: { seasonYear?: number; scoring?: RankingScoring; position?: "ALL" | "IDP" } = {},
): Promise<{ seasonYear: number; scoring: RankingScoring; position: "ALL" | "IDP"; status: "succeeded" }> {
  const apiKey = await resolveFantasyProsApiKey(env);
  if (!apiKey) throw new ApiException(409, "provider_key_required", "Configure the FantasyPros API key before syncing rankings.");
  const seasonYear = options.seasonYear ?? new Date().getUTCFullYear();
  const scoring = options.scoring ?? "PPR";
  const position = options.position ?? "ALL";
  await syncScope(env, apiKey, seasonYear, scoring, position, new Date());
  return { seasonYear, scoring, position, status: "succeeded" };
}

async function syncFantasyProsApiFromInternalRequest(request: Request, env: Env): Promise<HandlerResult<unknown>> {
  requireCsvImportToken(request, env);
  const body = await readJson<{ seasonYear?: number; scoring?: RankingScoring; position?: "ALL" | "IDP" }>(request);
  const seasonYear = Number(body.seasonYear ?? new Date().getUTCFullYear());
  if (!Number.isInteger(seasonYear) || seasonYear < 2020 || seasonYear > 2100) {
    throw new ApiException(400, "invalid_season_year", "Choose a valid FantasyPros season year.");
  }
  const scoring = body.scoring && SCORING.includes(body.scoring) ? body.scoring : "PPR";
  const position = body.position === "IDP" ? "IDP" : "ALL";
  const result = await syncFantasyProsApiScopeNow(env, { seasonYear, scoring, position });
  return { status: 201, data: { ...result, sourceName: SOURCE_NAME, importedAtUtc: new Date().toISOString() } };
}

async function reserveFantasyProsRequest(db: D1Database, requestDate: string, now: Date): Promise<void> {
  const reservation = await db.prepare(
    `insert into fantasypros_daily_budgets(request_date,attempts,updated_at_utc)
     select ?1,min(?2,count(*)+1),?3 from fantasypros_sync_runs where request_date=?1
     on conflict(request_date) do update set attempts=attempts+1,updated_at_utc=excluded.updated_at_utc
     where attempts<?2 returning attempts`,
  ).bind(requestDate, DAILY_REQUEST_BUDGET, now.toISOString()).first<{ attempts: number }>();
  if (!reservation) {
    throw new ApiException(429, "provider_daily_budget_reached", "The FantasyPros daily request budget is exhausted. Try again tomorrow.");
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
        bye_week as byeWeek,source_updated_at as sourceUpdatedAt,fetched_at_utc as fetchedAtUtc
       from fantasypros_rankings where season_year=?1 and scoring=?2 and nfl_player_id in (${placeholders})`,
    ).bind(seasonYear, scoring, ...chunk).all<FantasyProsRanking>();
    for (const row of rows.results ?? []) rankings.set(row.playerId, row);
  }
  return rankings;
}

export async function importFantasyProsCsv(
  env: Env,
  csvText: string,
  options: { seasonYear: number; scoring: RankingScoring; scope?: string; sourceUpdatedAt?: string },
): Promise<{ imported: number; mapped: number; scope: string; scoring: RankingScoring; seasonYear: number }> {
  const rows = parseCsv(csvText);
  const internal = await loadInternalPlayers(env.NFL_DB);
  const fetchedAt = new Date().toISOString();
  const scope = (options.scope || inferCsvScope(rows) || "CSV").toUpperCase();
  const players = csvRowsToFantasyProsPlayers(rows, scope);
  const mapped = mapPlayers(players, internal);
  let imported = 0;
  for (let index = 0; index < mapped.length; index += 75) {
    const chunk = mapped.slice(index, index + 75);
    if (!chunk.length) continue;
    await env.NFL_DB.batch(chunk.map(({ source, nflPlayerId }) => env.NFL_DB.prepare(
      `insert into fantasypros_rankings
        (season_year,scoring,fantasypros_player_id,nfl_player_id,display_name,team_abbreviation,position,
         overall_rank,position_rank,tier,rank_min,rank_max,rank_average,rank_std_dev,player_page_url,
         bye_week,source_scope,source_updated_at,fetched_at_utc)
       values(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)
       on conflict(season_year,scoring,fantasypros_player_id) do update set
         nfl_player_id=excluded.nfl_player_id,display_name=excluded.display_name,
         team_abbreviation=excluded.team_abbreviation,position=excluded.position,
         overall_rank=excluded.overall_rank,position_rank=excluded.position_rank,tier=excluded.tier,
         rank_min=excluded.rank_min,rank_max=excluded.rank_max,rank_average=excluded.rank_average,
         rank_std_dev=excluded.rank_std_dev,player_page_url=excluded.player_page_url,
         bye_week=excluded.bye_week,source_scope=excluded.source_scope,
         source_updated_at=excluded.source_updated_at,fetched_at_utc=excluded.fetched_at_utc`,
    ).bind(
      options.seasonYear, options.scoring, String(source.player_id), nflPlayerId, source.player_name,
      source.player_team_id ?? null, primaryPosition(source), integer(source.rank_ecr, 9999),
      source.pos_rank ?? null, nullableInteger(source.tier), nullableInteger(source.rank_min),
      nullableInteger(source.rank_max), nullableNumber(source.rank_ave), nullableNumber(source.rank_std),
      source.player_page_url ?? null, nullableInteger((source as FantasyProsPlayer & { bye_week?: number }).bye_week),
      scope, options.sourceUpdatedAt ?? null, fetchedAt,
    )));
    imported += chunk.length;
  }
  await env.NFL_DB.prepare(
    `delete from fantasypros_rankings
     where season_year=?1 and scoring=?2 and source_scope=?3 and fetched_at_utc<>?4`,
  ).bind(options.seasonYear, options.scoring, scope, fetchedAt).run();
  return { imported, mapped: mapped.filter((item) => item.nflPlayerId).length, scope, scoring: options.scoring, seasonYear: options.seasonYear };
}

export async function syncFantasyProsCsvExportNow(
  env: Env,
  options: { seasonYear?: number; scoring?: RankingScoring; scope?: string; sourceUpdatedAt?: string } = {},
): Promise<{ imported: number; mapped: number; scope: string; scoring: RankingScoring; seasonYear: number; sourceUrl: string }> {
  const seasonYear = options.seasonYear ?? new Date().getUTCFullYear();
  const scoring = options.scoring ?? "PPR";
  const scope = (options.scope || "OVERALL").toUpperCase();
  const sourceUrl = fantasyProsExportUrl(scoring, scope);
  const response = await fetch(sourceUrl, {
    headers: {
      accept: "application/vnd.ms-excel,text/html,application/xhtml+xml",
      "user-agent": "Mozilla/5.0 myFFL rankings sync",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new ApiException(502, "fantasypros_export_failed", `FantasyPros export returned ${response.status}.`);
  const html = await response.text();
  const csv = fantasyProsExportHtmlToCsv(html);
  if (!csv) throw new ApiException(502, "fantasypros_export_empty", "FantasyPros export did not include a rankings table.");
  const result = await importFantasyProsCsv(env, csv, {
    seasonYear,
    scoring,
    scope,
    sourceUpdatedAt: options.sourceUpdatedAt ?? new Date().toISOString(),
  });
  return { ...result, sourceUrl };
}

async function syncFantasyProsCsvFromInternalRequest(request: Request, env: Env): Promise<HandlerResult<unknown>> {
  requireCsvImportToken(request, env);
  const body = await readJson<{ seasonYear?: number; scoring?: RankingScoring; scope?: string; sourceUpdatedAt?: string }>(request);
  const seasonYear = Number(body.seasonYear ?? new Date().getUTCFullYear());
  if (!Number.isInteger(seasonYear) || seasonYear < 2020 || seasonYear > 2100) {
    throw new ApiException(400, "invalid_season_year", "Choose a valid FantasyPros season year.");
  }
  const scoring = body.scoring && SCORING.includes(body.scoring) ? body.scoring : "PPR";
  const result = await syncFantasyProsCsvExportNow(env, {
    seasonYear,
    scoring,
    scope: body.scope,
    sourceUpdatedAt: body.sourceUpdatedAt,
  });
  return { status: 201, data: { ...result, sourceName: SOURCE_NAME, importedAtUtc: new Date().toISOString() } };
}

async function importFantasyProsCsvFromInternalRequest(request: Request, env: Env): Promise<HandlerResult<unknown>> {
  requireCsvImportToken(request, env);
  const body = await readJson<{ csv?: string; seasonYear?: number; scoring?: RankingScoring; scope?: string; sourceUpdatedAt?: string }>(request);
  const csv = body.csv?.trim();
  if (!csv) throw new ApiException(400, "csv_required", "FantasyPros CSV content is required.");
  const seasonYear = Number(body.seasonYear ?? new Date().getUTCFullYear());
  if (!Number.isInteger(seasonYear) || seasonYear < 2020 || seasonYear > 2100) {
    throw new ApiException(400, "invalid_season_year", "Choose a valid FantasyPros season year.");
  }
  const scoring = body.scoring && SCORING.includes(body.scoring) ? body.scoring : "PPR";
  const result = await importFantasyProsCsv(env, csv, {
    seasonYear,
    scoring,
    scope: body.scope,
    sourceUpdatedAt: body.sourceUpdatedAt,
  });
  return { status: 201, data: { ...result, sourceName: SOURCE_NAME, importedAtUtc: new Date().toISOString() } };
}

function requireCsvImportToken(request: Request, env: Env): void {
  const expected = env.FANTASYPROS_CSV_IMPORT_TOKEN?.trim();
  if (!expected) throw new ApiException(503, "csv_import_not_configured", "FantasyPros CSV automation is not configured.");
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match || match[1].trim() !== expected) {
    throw new ApiException(403, "csv_import_forbidden", "FantasyPros CSV automation token is invalid.");
  }
}

function fantasyProsExportUrl(scoring: RankingScoring, scope: string): string {
  const normalizedScope = scope.toLowerCase();
  const file = normalizedScope === "overall"
    ? scoring === "PPR"
      ? "ppr-cheatsheets.php"
      : scoring === "HALF"
        ? "half-point-ppr-cheatsheets.php"
        : "consensus-cheatsheets.php"
    : `${normalizedScope === "dst" ? "dst" : normalizedScope}-cheatsheets.php`;
  return `https://www.fantasypros.com/nfl/rankings/${file}?export=xls`;
}

function fantasyProsExportHtmlToCsv(html: string): string | undefined {
  const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((match) => [...match[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => decodeHtml(stripTags(cell[1])).trim()))
    .filter((cells) => cells.some(Boolean));
  const headerIndex = rows.findIndex((cells) => cells.some((cell) => /player/i.test(cell)));
  if (headerIndex < 0) return undefined;
  const headers = rows[headerIndex].map(normalizeExportHeader);
  const records = rows.slice(headerIndex + 1).map((cells) => {
    const record = Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""]));
    const parsed = parseExportPlayer(record.Player ?? "");
    return {
      Rank: record.Rank,
      Player: parsed.name || record.Player || "",
      Team: parsed.team || record.Team || "",
      Position: parseExportPosition(record.Position),
      Bye: record.Bye ?? "",
      Tier: /^tier\s+\d+/i.test(record.Rank ?? "") ? (record.Rank.match(/\d+/)?.[0] ?? "") : record.Tier ?? "",
    };
  }).filter((row) => Number.isFinite(Number(row.Rank)) && row.Player);
  return records.length ? toCsv(records) : undefined;
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

function csvRowsToFantasyProsPlayers(rows: Array<Record<string, string>>, fallbackScope: string): Array<FantasyProsPlayer & { bye_week?: number }> {
  return rows.map((row, index) => {
    const rank = pick(row, ["ecr", "rank", "rk", "overall", "overall rank", "#"]) ?? String(index + 1);
    const name = pick(row, ["player name", "player", "name"]);
    const team = pick(row, ["team", "tm"]);
    const position = (pick(row, ["position", "pos"]) ?? fallbackScope).replace(/\d+$/, "");
    const bye = pick(row, ["bye", "bye week", "byeweek"]);
    const positionRank = pick(row, ["pos rank", "position rank", "posrank"]) ?? (position ? `${position}${rank}` : undefined);
    const playerId = pick(row, ["player id", "player_id", "id"]) ?? `${normalizeName(name ?? "player")}-${team ?? "FA"}-${position ?? "UNK"}`;
    return {
      player_id: playerId,
      player_name: name,
      player_team_id: team,
      player_position_id: position || fallbackScope,
      rank_ecr: rank,
      pos_rank: positionRank,
      tier: pick(row, ["tier"]),
      rank_min: pick(row, ["best", "rank min", "min"]),
      rank_max: pick(row, ["worst", "rank max", "max"]),
      rank_ave: pick(row, ["avg", "average", "rank avg"]),
      rank_std: pick(row, ["std dev", "stddev"]),
      bye_week: nullableInteger(bye) ?? undefined,
    };
  }).filter((row) => Boolean(row.player_name) && Number.isFinite(Number(row.rank_ecr)));
}

function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  const source = text.replace(/^\uFEFF/, "");
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (char === "\"" && source[index + 1] === "\"") { value += "\""; index++; }
      else if (char === "\"") quoted = false;
      else value += char;
    } else if (char === "\"") quoted = true;
    else if (char === ",") { row.push(value); value = ""; }
    else if (char === "\n") { row.push(value); rows.push(row); row = []; value = ""; }
    else if (char !== "\r") value += char;
  }
  if (value || row.length) { row.push(value); rows.push(row); }
  const headerIndex = rows.findIndex((candidate) => candidate.some((cell) => normalizeHeader(cell) === "player" || normalizeHeader(cell) === "playername"));
  const headers = (rows[headerIndex >= 0 ? headerIndex : 0] ?? []).map(normalizeHeader);
  return rows.slice((headerIndex >= 0 ? headerIndex : 0) + 1)
    .filter((cells) => cells.some((cell) => cell.trim()))
    .map((cells) => Object.fromEntries(headers.map((header, index) => [header, cells[index]?.trim() ?? ""])));
}

function inferCsvScope(rows: Array<Record<string, string>>): string | undefined {
  for (const row of rows) {
    const position = pick(row, ["position", "pos"]);
    if (position) return position.replace(/\d+$/, "").toUpperCase();
  }
  return undefined;
}

function pick(row: Record<string, string>, names: string[]): string | undefined {
  for (const name of names) {
    const value = row[normalizeHeader(name)];
    if (value) return value.trim();
  }
  return undefined;
}

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9#]/g, "");
}

function normalizeExportHeader(value: string): string {
  const normalized = value.toLowerCase().replace(/\s+/g, " ").trim();
  if (normalized === "rk" || normalized === "rank" || normalized === "ecr") return "Rank";
  if (normalized.includes("player")) return "Player";
  if (normalized === "pos" || normalized === "position") return "Position";
  if (normalized.includes("bye")) return "Bye";
  if (normalized.includes("tier")) return "Tier";
  if (normalized === "team" || normalized === "tm") return "Team";
  return value;
}

function parseExportPlayer(value: string): { name: string; team: string } {
  const match = value.match(/^(.*?)\s+\(([A-Z]{2,3})\)/);
  return match ? { name: match[1].trim(), team: match[2] } : { name: value.trim(), team: "" };
}

function parseExportPosition(value: string | undefined): string {
  const match = String(value ?? "").match(/[A-Z]+/);
  return match?.[0] ?? "";
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function toCsv(rows: Array<Record<string, string | number | undefined>>): string {
  const headers = ["Rank", "Player", "Team", "Position", "Bye", "Tier"];
  return [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(",")),
  ].join("\n");
}

function csvCell(value: unknown): string {
  const text = String(value ?? "");
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, "\"\"")}"`;
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
