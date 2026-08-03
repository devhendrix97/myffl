import type { HandlerResult } from "./auth";
import { authenticate } from "./auth";
import { requireLeagueRole } from "./league";
import { ensureSeasonScoringConfiguration } from "./scoring";

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
  const principal = await authenticate(request, env);
  const runtime = await getProviderRuntime(env);
  const leagueId = url.searchParams.get("leagueId");
  let scoring: ScoringContext | undefined;
  if (leagueId) {
    const access = await requireLeagueRole(principal, leagueId, env, ["commissioner", "co-commissioner", "manager"]);
    let row = await access.db.prepare(
      `select leagues.league_id as leagueId, leagues.league_name as leagueName,
              seasons.league_season_id as seasonId, seasons.scoring_version_id as scoringVersionId,
              versions.version_number as versionNumber
       from leagues join league_seasons seasons on seasons.league_id = leagues.league_id
       left join scoring_versions versions on versions.scoring_version_id = seasons.scoring_version_id
       where leagues.league_id = ?1 order by seasons.season_year desc limit 1`,
    ).bind(leagueId).first<ScoringContext>();
    if (row && !row.scoringVersionId) {
      await ensureSeasonScoringConfiguration(access.db, leagueId, row.seasonId, principal.userId, env);
      row = await access.db.prepare(
        `select leagues.league_id as leagueId, leagues.league_name as leagueName,
                seasons.league_season_id as seasonId, seasons.scoring_version_id as scoringVersionId,
                versions.version_number as versionNumber
         from leagues join league_seasons seasons on seasons.league_id = leagues.league_id
         left join scoring_versions versions on versions.scoring_version_id = seasons.scoring_version_id
         where leagues.league_id = ?1 order by seasons.season_year desc limit 1`,
      ).bind(leagueId).first<ScoringContext>();
    }
    if (row?.scoringVersionId) scoring = row;
  }
  return { data: await readGameFeed(env, runtime.dataScope, scoring) };
}

interface ScoringContext {
  leagueId: string;
  leagueName: string;
  seasonId: string;
  scoringVersionId: string | null;
  versionNumber: number | null;
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

export async function readGameFeed(env: Env, scope: string, scoring?: ScoringContext): Promise<{
  games: unknown[];
  players: unknown[];
  plays: unknown[];
  currentPlay: unknown | null;
  scoring: { leagueId: string; leagueName: string; versionNumber: number } | null;
}> {
  const [gameRows, playerRows, playRows] = await Promise.all([
    env.NFL_DB.prepare(
      `select events.nfl_event_id as nflEventId, events.provider_event_id as eventId,
        snapshots.status, snapshots.status_detail as statusDetail,
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
      `select stats.nfl_event_id as eventId, stats.nfl_player_id as playerId,
        players.display_name as displayName, stats.position, stats.stats_json as statsJson,
        teams.abbreviation as team
       from nfl_player_game_stats stats
       join nfl_players players on players.nfl_player_id = stats.nfl_player_id
       left join nfl_team_snapshots teams on teams.nfl_team_id = stats.team_id and teams.data_scope = stats.data_scope
       where stats.data_scope = ?1 and stats.nfl_event_id in (
         select nfl_event_id from nfl_event_snapshots where data_scope = ?1
         order by updated_at_utc desc limit 16
       ) order by teams.abbreviation, players.display_name limit 300`,
    ).bind(scope).all(),
    env.NFL_DB.prepare(
      `select provider_play_id as playId, sequence_number as sequenceNumber, drive_id as driveId,
        period, clock, play_type as playType, play_text as playText, stat_yardage as statYardage,
        home_score as homeScore, away_score as awayScore, scoring_play as scoringPlay,
        turnover from nfl_event_plays where data_scope = ?1 and nfl_event_id in (
          select nfl_event_id from nfl_event_snapshots where data_scope = ?1
          order by updated_at_utc desc limit 16
        ) order by sequence_number desc limit 200`,
    ).bind(scope).all(),
  ]);
  const eventIds = gameRows.results.map((row) => String((row as { nflEventId: string }).nflEventId));
  const eventPlaceholders = eventIds.map((_, index) => `?${index + 3}`).join(",");
  const [scoreRows, componentRows] = scoring && eventIds.length ? await Promise.all([
    env.LEAGUE_DB_001.prepare(
      `select nfl_event_id as eventId, nfl_player_id as playerId, total_points_milli as totalPointsMilli,
              revision_number as scoreRevision
       from player_event_scores where league_season_id = ?1 and data_scope = ?2
        and nfl_event_id in (${eventPlaceholders})`,
    ).bind(scoring.seasonId, scope, ...eventIds).all(),
    env.LEAGUE_DB_001.prepare(
      `select nfl_event_id as eventId, nfl_player_id as playerId, display_name as displayName,
              raw_value_json as rawValueJson, points_milli as pointsMilli, explanation
       from player_event_score_components
       where league_season_id = ?1 and data_scope = ?2
        and nfl_event_id in (${eventPlaceholders}) order by display_order`,
    ).bind(scoring.seasonId, scope, ...eventIds).all(),
  ]) : [{ results: [] }, { results: [] }];
  const scores = new Map<string, { eventId: string; playerId: string; totalPointsMilli: number; scoreRevision: number }>(scoreRows.results.map((row) => {
    const value = row as { eventId: string; playerId: string; totalPointsMilli: number; scoreRevision: number };
    return [`${value.eventId}:${value.playerId}`, value] as const;
  }));
  const components = new Map<string, unknown[]>();
  for (const row of componentRows.results) {
    const value = row as { eventId: string; playerId: string; displayName: string; rawValueJson: string; pointsMilli: number; explanation: string };
    const key = `${value.eventId}:${value.playerId}`;
    const current = components.get(key) ?? [];
    current.push({
      displayName: value.displayName,
      rawValue: safeJson(value.rawValueJson, 0),
      points: value.pointsMilli / 1000,
      explanation: value.explanation,
    });
    components.set(key, current);
  }
  const players = playerRows.results.map((row) => {
    const value = row as { eventId: string; playerId: string; displayName?: string; position?: string; team?: string; statsJson?: string };
    const key = `${value.eventId}:${value.playerId}`;
    const score = scores.get(key);
    return {
      eventId: value.eventId,
      playerId: value.playerId,
      displayName: value.displayName,
      position: value.position,
      team: value.team,
      stats: safeJson(value.statsJson, {}),
      fantasyPoints: score ? score.totalPointsMilli / 1000 : undefined,
      scoreRevision: score?.scoreRevision,
      scoringBreakdown: components.get(key) ?? [],
    };
  });
  const games = gameRows.results.map((row) => {
    const value = row as Record<string, unknown>;
    return { ...value, completed: Boolean(value.completed), situation: safeJson(String(value.situationJson ?? ""), null), situationJson: undefined };
  });
  return {
    games,
    players,
    plays: playRows.results,
    currentPlay: playRows.results[0] ?? null,
    scoring: scoring ? {
      leagueId: scoring.leagueId,
      leagueName: scoring.leagueName,
      versionNumber: scoring.versionNumber ?? 1,
    } : null,
  };
}

function safeJson(value: string | undefined, fallback: unknown): unknown {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}
