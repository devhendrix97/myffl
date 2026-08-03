import type { HandlerResult } from "./auth";
import { authenticate } from "./auth";

interface RuntimeModeRow {
  mode: "live" | "replay";
  active_simulation_run_id: string | null;
  revision_number: number;
  updated_at_utc: string;
}

export async function handleGameFeedRequest(
  request: Request,
  url: URL,
  env: Env,
): Promise<HandlerResult<unknown> | undefined> {
  if (request.method !== "GET" || url.pathname !== "/api/games/current") return undefined;
  await authenticate(request, env);
  const runtime = await getProviderRuntime(env);
  return { data: await readGameFeed(env, runtime.dataScope) };
}

export async function getProviderRuntime(env: Env): Promise<{
  mode: "live" | "replay";
  runId: string | null;
  dataScope: string;
  revisionNumber: number;
  updatedAtUtc: string;
}> {
  const row = await env.NFL_DB.prepare(
    `select mode, active_simulation_run_id, revision_number, updated_at_utc
     from provider_runtime_mode where sport_key = 'nfl'`,
  ).first<RuntimeModeRow>();
  const mode = row?.mode ?? "live";
  const runId = mode === "replay" ? row?.active_simulation_run_id ?? null : null;
  return {
    mode,
    runId,
    dataScope: providerDataScope(mode, runId),
    revisionNumber: row?.revision_number ?? 1,
    updatedAtUtc: row?.updated_at_utc ?? new Date(0).toISOString(),
  };
}

export function providerDataScope(mode: "live" | "replay", runId: string | null): string {
  return mode === "replay" && runId ? `simulation:${runId}` : "production";
}

export async function readGameFeed(env: Env, scope: string): Promise<{
  games: unknown[];
  players: unknown[];
  plays: unknown[];
  currentPlay: unknown | null;
}> {
  const [gameRows, playerRows, playRows] = await Promise.all([
    env.NFL_DB.prepare(
      `select events.provider_event_id as eventId, snapshots.status, snapshots.status_detail as statusDetail,
        snapshots.period, snapshots.clock, snapshots.home_score as homeScore, snapshots.away_score as awayScore,
        snapshots.completed, snapshots.situation_json as situationJson,
        home.abbreviation as homeTeam, home.display_name as homeTeamName,
        away.abbreviation as awayTeam, away.display_name as awayTeamName,
        snapshots.updated_at_utc as updatedAtUtc
       from nfl_event_snapshots snapshots
       join nfl_events events on events.nfl_event_id = snapshots.nfl_event_id
       left join nfl_team_snapshots home on home.nfl_team_id = snapshots.home_team_id and home.data_scope = snapshots.data_scope
       left join nfl_team_snapshots away on away.nfl_team_id = snapshots.away_team_id and away.data_scope = snapshots.data_scope
       where snapshots.data_scope = ?1 order by snapshots.updated_at_utc desc limit 16`,
    ).bind(scope).all(),
    env.NFL_DB.prepare(
      `select players.display_name as displayName, stats.position, stats.stats_json as statsJson,
        teams.abbreviation as team
       from nfl_player_game_stats stats
       join nfl_players players on players.nfl_player_id = stats.nfl_player_id
       left join nfl_team_snapshots teams on teams.nfl_team_id = stats.team_id and teams.data_scope = stats.data_scope
       where stats.data_scope = ?1 order by teams.abbreviation, players.display_name limit 300`,
    ).bind(scope).all(),
    env.NFL_DB.prepare(
      `select provider_play_id as playId, sequence_number as sequenceNumber, drive_id as driveId,
        period, clock, play_type as playType, play_text as playText, stat_yardage as statYardage,
        home_score as homeScore, away_score as awayScore, scoring_play as scoringPlay,
        turnover from nfl_event_plays where data_scope = ?1 order by sequence_number desc limit 200`,
    ).bind(scope).all(),
  ]);
  const players = playerRows.results.map((row) => {
    const value = row as { displayName?: string; position?: string; team?: string; statsJson?: string };
    return { displayName: value.displayName, position: value.position, team: value.team, stats: safeJson(value.statsJson, {}) };
  });
  const games = gameRows.results.map((row) => {
    const value = row as Record<string, unknown>;
    return { ...value, completed: Boolean(value.completed), situation: safeJson(String(value.situationJson ?? ""), null), situationJson: undefined };
  });
  return { games, players, plays: playRows.results, currentPlay: playRows.results[0] ?? null };
}

function safeJson(value: string | undefined, fallback: unknown): unknown {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}
