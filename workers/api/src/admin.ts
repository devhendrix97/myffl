import type { HandlerResult } from "./auth";
import { authenticate } from "./auth";
import { ApiException, readJson } from "./http";
import { ingestReplayFrame, runProviderJob, type ProviderJob } from "./provider";
import { fullGameReplayFrames, replayScenarioId, replayScenarioName } from "./replay-scenario";
import { getProviderRuntime } from "./game-feed";
import { handlePlatformAdminRequest } from "./admin-platform";
import { handleAdminInvestigationRequest } from "./admin-investigation";

interface AdminPrincipal { userId: string; role: string }
interface SimulationRow {
  simulation_run_id: string;
  simulation_scenario_id: string;
  status: "ready" | "playing" | "paused" | "completed" | "stopped";
  speed_multiplier: number;
  current_frame: number;
  simulated_at_utc: string | null;
  created_at_utc: string;
  updated_at_utc: string;
}

export async function handleAdminRequest(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
  correlationId: string,
): Promise<HandlerResult<unknown> | Response | undefined> {
  if (!url.pathname.startsWith("/api/admin/")) return undefined;
  const admin = await requirePlatformAdmin(request, env);

  const platformResult = await handlePlatformAdminRequest(request, url, env, admin, correlationId);
  if (platformResult) return platformResult;
  const investigationResult = await handleAdminInvestigationRequest(request, url, env, ctx, admin, correlationId);
  if (investigationResult) return investigationResult;

  if (request.method === "GET" && url.pathname === "/api/admin/provider/dashboard") {
    return { data: await providerDashboard(env) };
  }
  if (request.method === "POST" && url.pathname === "/api/admin/provider/sync") {
    const body = await readJson<{ resource?: string }>(request);
    const job = providerJob(body.resource);
    ctx.waitUntil(runProviderJob(env, job));
    await audit(env, admin.userId, "provider.sync.requested", "provider", body.resource ?? "scoreboard", correlationId, { job });
    return { data: { accepted: true, job }, status: 202 };
  }
  if (request.method === "GET" && url.pathname === "/api/admin/provider/runtime") {
    return { data: await getProviderRuntime(env) };
  }
  if (request.method === "POST" && url.pathname === "/api/admin/provider/runtime") {
    const body = await readJson<{ mode?: string; runId?: string }>(request);
    const runtime = await setProviderRuntime(env, admin.userId, body.mode, body.runId);
    await audit(env, admin.userId, "provider.runtime.changed", "provider_runtime", "nfl", correlationId, runtime);
    return { data: runtime };
  }
  if (request.method === "GET" && url.pathname === "/api/admin/simulations") {
    return { data: await simulationDashboard(env) };
  }
  if (request.method === "POST" && url.pathname === "/api/admin/simulations") {
    const body = await readJson<{ speedMultiplier?: number }>(request);
    return { data: await createSimulation(env, admin.userId, body.speedMultiplier), status: 201 };
  }
  const match = url.pathname.match(/^\/api\/admin\/simulations\/([^/]+)\/(play|pause|step|reset|stop)$/);
  if (request.method === "POST" && match) {
    const runId = decodeURIComponent(match[1]);
    const action = match[2];
    const result = await actOnSimulation(env, runId, action);
    await audit(env, admin.userId, `simulation.${action}`, "simulation_run", runId, correlationId, result);
    return { data: result };
  }
  return undefined;
}

async function requirePlatformAdmin(request: Request, env: Env): Promise<AdminPrincipal> {
  const principal = await authenticate(request, env);
  const admin = await env.CORE_DB.prepare(
    `select admin_role from platform_admins where user_id = ?1 and active = 1 limit 1`,
  ).bind(principal.userId).first<{ admin_role: string }>();
  if (!admin) throw new ApiException(403, "platform_admin_required", "Platform administrator access is required.");
  return { userId: principal.userId, role: admin.admin_role };
}

function providerJob(resource: string | undefined): ProviderJob {
  if (!resource || resource === "scoreboard") return { type: "sync-scoreboard" };
  if (resource === "teams") return { type: "sync-teams" };
  if (resource === "injuries") return { type: "sync-injuries" };
  throw new ApiException(400, "invalid_provider_resource", "Resource must be scoreboard, teams, or injuries.");
}

async function providerDashboard(env: Env): Promise<unknown> {
  const [states, runs, counts, runtime] = await Promise.all([
    env.NFL_DB.prepare(
      `select provider, resource, data_scope as dataScope, last_success_at_utc as lastSuccessAtUtc,
        last_attempt_at_utc as lastAttemptAtUtc, last_status as lastStatus,
        last_run_id as lastRunId, last_error as lastError
       from provider_sync_state where data_scope = 'production' order by resource`,
    ).all(),
    env.NFL_DB.prepare(
      `select provider_sync_run_id as runId, resource, data_scope as dataScope, status,
        records_seen as recordsSeen, records_written as recordsWritten, warning_count as warningCount,
        error_message as errorMessage, started_at_utc as startedAtUtc, completed_at_utc as completedAtUtc
       from provider_sync_runs order by started_at_utc desc limit 20`,
    ).all(),
    env.NFL_DB.prepare(
      `select
        (select count(*) from nfl_teams) as teams,
        (select count(*) from nfl_players) as players,
        (select count(*) from nfl_events) as events,
        (select count(*) from nfl_player_injuries where data_scope = 'production') as injuries,
        (select count(*) from provider_raw_archives) as archives`,
    ).first(),
    getProviderRuntime(env),
  ]);
  return { provider: "espn", parserVersion: "espn-nfl-1.0.0", runtime, counts, states: states.results, recentRuns: runs.results };
}

async function setProviderRuntime(env: Env, userId: string, requestedMode?: string, requestedRunId?: string): Promise<unknown> {
  if (requestedMode !== "live" && requestedMode !== "replay") {
    throw new ApiException(400, "invalid_provider_mode", "Provider mode must be live or replay.");
  }
  let runId: string | null = null;
  if (requestedMode === "replay") {
    if (!requestedRunId) throw new ApiException(400, "simulation_run_required", "Start or select a simulation run first.");
    const run = await env.NFL_DB.prepare(
      `select simulation_run_id from simulation_runs where simulation_run_id = ?1 and status != 'stopped'`,
    ).bind(requestedRunId).first<{ simulation_run_id: string }>();
    if (!run) throw new ApiException(409, "simulation_run_unavailable", "The selected simulation run is not available.");
    runId = run.simulation_run_id;
  }
  await env.NFL_DB.prepare(
    `update provider_runtime_mode set mode = ?1, active_simulation_run_id = ?2,
      revision_number = revision_number + 1, updated_by_user_id = ?3, updated_at_utc = ?4
     where sport_key = 'nfl'`,
  ).bind(requestedMode, runId, userId, new Date().toISOString()).run();
  return await getProviderRuntime(env);
}

async function simulationDashboard(env: Env): Promise<unknown> {
  const runs = await env.NFL_DB.prepare(
    `select simulation_run_id as runId, simulation_scenario_id as scenarioId, status,
      speed_multiplier as speedMultiplier, current_frame as currentFrame,
      simulated_at_utc as simulatedAtUtc, created_at_utc as createdAtUtc, updated_at_utc as updatedAtUtc
     from simulation_runs order by created_at_utc desc limit 10`,
  ).all();
  const active = runs.results[0] as Record<string, unknown> | undefined;
  let events: unknown[] = [];
  let games: unknown[] = [];
  let players: unknown[] = [];
  let plays: unknown[] = [];
  if (active?.runId) {
    const scope = `simulation:${active.runId}`;
    const [eventRows, gameRows, playerRows, playRows] = await Promise.all([
      env.NFL_DB.prepare(
        `select frame_number as frameNumber, event_type as eventType, message, created_at_utc as createdAtUtc
         from simulation_event_log where simulation_run_id = ?1 order by created_at_utc desc limit 20`,
      ).bind(active.runId).all(),
      env.NFL_DB.prepare(
        `select events.provider_event_id as eventId, snapshots.status, snapshots.status_detail as statusDetail,
          snapshots.period, snapshots.clock, snapshots.home_score as homeScore, snapshots.away_score as awayScore,
          home.abbreviation as homeTeam, away.abbreviation as awayTeam
         from nfl_event_snapshots snapshots
         join nfl_events events on events.nfl_event_id = snapshots.nfl_event_id
         left join nfl_team_snapshots home on home.nfl_team_id = snapshots.home_team_id and home.data_scope = snapshots.data_scope
         left join nfl_team_snapshots away on away.nfl_team_id = snapshots.away_team_id and away.data_scope = snapshots.data_scope
         where snapshots.data_scope = ?1 order by snapshots.updated_at_utc desc`,
      ).bind(scope).all(),
      env.NFL_DB.prepare(
        `select players.display_name as displayName, stats.position, stats.stats_json as statsJson
         from nfl_player_game_stats stats join nfl_players players on players.nfl_player_id = stats.nfl_player_id
         where stats.data_scope = ?1 order by players.display_name limit 30`,
      ).bind(scope).all(),
      env.NFL_DB.prepare(
        `select provider_play_id as playId, sequence_number as sequenceNumber, drive_id as driveId,
          period, clock, play_type as playType, play_text as playText, stat_yardage as statYardage,
          home_score as homeScore, away_score as awayScore, scoring_play as scoringPlay,
          turnover from nfl_event_plays where data_scope = ?1 order by sequence_number desc limit 80`,
      ).bind(scope).all(),
    ]);
    events = eventRows.results;
    games = gameRows.results;
    players = playerRows.results.map((row) => {
      const value = row as { displayName?: string; position?: string; statsJson?: string };
      return { displayName: value.displayName, position: value.position, stats: safeJson(value.statsJson, {}) };
    });
    plays = playRows.results;
  }
  return {
    scenario: { id: replayScenarioId, name: replayScenarioName, frameCount: fullGameReplayFrames.length },
    runs: runs.results,
    active: active ?? null,
    events,
    games,
    players,
    plays,
    currentPlay: plays[0] ?? null,
  };
}

async function createSimulation(env: Env, userId: string, requestedSpeed?: number): Promise<unknown> {
  const speed = [1, 2, 4].includes(requestedSpeed ?? 1) ? requestedSpeed ?? 1 : 1;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.NFL_DB.batch([
    env.NFL_DB.prepare(
      `insert into simulation_scenarios
        (simulation_scenario_id, name, description, frame_count, fixture_prefix, created_at_utc)
       values (?1, ?2, 'Deterministic full-game ESPN-shaped play, drive, score, and box-score progression.', ?3,
        'built-in/full-sunday-game', ?4)
       on conflict(simulation_scenario_id) do update set frame_count = excluded.frame_count`,
    ).bind(replayScenarioId, replayScenarioName, fullGameReplayFrames.length, now),
    env.NFL_DB.prepare(
      `insert into simulation_runs
        (simulation_run_id, simulation_scenario_id, created_by_user_id, status,
         speed_multiplier, current_frame, created_at_utc, updated_at_utc)
       values (?1, ?2, ?3, 'ready', ?4, -1, ?5, ?5)`,
    ).bind(id, replayScenarioId, userId, speed, now),
  ]);
  return await actOnSimulation(env, id, "step");
}

async function actOnSimulation(env: Env, runId: string, action: string): Promise<Record<string, unknown>> {
  const run = await env.NFL_DB.prepare(
    `select simulation_run_id, simulation_scenario_id, status, speed_multiplier, current_frame,
      simulated_at_utc, created_at_utc, updated_at_utc from simulation_runs where simulation_run_id = ?1`,
  ).bind(runId).first<SimulationRow>();
  if (!run) throw new ApiException(404, "simulation_not_found", "The simulation run does not exist.");
  if (action === "play" || action === "pause") {
    const status = action === "play" ? "playing" : "paused";
    await updateRunStatus(env, runId, status);
    return { runId, status, currentFrame: run.current_frame, frameCount: fullGameReplayFrames.length };
  }
  if (action === "stop") {
    const now = new Date().toISOString();
    await env.NFL_DB.prepare(
      `update simulation_runs set status = 'stopped', stopped_at_utc = ?2, updated_at_utc = ?2 where simulation_run_id = ?1`,
    ).bind(runId, now).run();
    return { runId, status: "stopped", currentFrame: run.current_frame, frameCount: fullGameReplayFrames.length };
  }
  if (action === "reset") {
    const scope = `simulation:${runId}`;
    await env.NFL_DB.batch([
      env.NFL_DB.prepare(`delete from nfl_player_game_stats where data_scope = ?1`).bind(scope),
      env.NFL_DB.prepare(`delete from nfl_event_plays where data_scope = ?1`).bind(scope),
      env.NFL_DB.prepare(`delete from nfl_event_snapshots where data_scope = ?1`).bind(scope),
      env.NFL_DB.prepare(`delete from nfl_team_snapshots where data_scope = ?1`).bind(scope),
      env.NFL_DB.prepare(`delete from simulation_event_log where simulation_run_id = ?1`).bind(runId),
      env.NFL_DB.prepare(
        `update simulation_runs set status = 'ready', current_frame = -1, simulated_at_utc = null,
          updated_at_utc = ?2, stopped_at_utc = null where simulation_run_id = ?1`,
      ).bind(runId, new Date().toISOString()),
    ]);
    return { runId, status: "ready", currentFrame: -1, frameCount: fullGameReplayFrames.length };
  }
  if (run.status === "stopped") throw new ApiException(409, "simulation_stopped", "Reset a stopped simulation before stepping it.");
  const nextFrame = run.current_frame + 1;
  if (nextFrame >= fullGameReplayFrames.length) {
    await updateRunStatus(env, runId, "completed");
    return { runId, status: "completed", currentFrame: run.current_frame, frameCount: fullGameReplayFrames.length };
  }
  const frame = fullGameReplayFrames[nextFrame];
  await ingestReplayFrame(env, runId, frame);
  const status = nextFrame === fullGameReplayFrames.length - 1 ? "completed" : run.status === "playing" ? "playing" : "paused";
  const now = new Date().toISOString();
  await env.NFL_DB.batch([
    env.NFL_DB.prepare(
      `update simulation_runs set status = ?2, current_frame = ?3, simulated_at_utc = ?4,
        updated_at_utc = ?5 where simulation_run_id = ?1`,
    ).bind(runId, status, nextFrame, String(frame.simulatedAtUtc), now),
    env.NFL_DB.prepare(
      `insert into simulation_event_log
        (simulation_event_id, simulation_run_id, frame_number, event_type, message, payload_json, created_at_utc)
       values (?1, ?2, ?3, 'frame_applied', ?4, ?5, ?6)`,
    ).bind(crypto.randomUUID(), runId, nextFrame, String(frame.message), JSON.stringify(frame), now),
  ]);
  return { runId, status, currentFrame: nextFrame, frameCount: fullGameReplayFrames.length, message: frame.message };
}

async function updateRunStatus(env: Env, runId: string, status: string): Promise<void> {
  await env.NFL_DB.prepare(`update simulation_runs set status = ?2, updated_at_utc = ?3 where simulation_run_id = ?1`)
    .bind(runId, status, new Date().toISOString()).run();
}

async function audit(env: Env, userId: string, action: string, entityType: string, entityId: string, correlationId: string, metadata: unknown): Promise<void> {
  await env.CORE_DB.prepare(
    `insert into audit_events
      (audit_event_id, actor_user_id, action, entity_type, entity_id, correlation_id, created_at_utc, metadata_json)
     values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  ).bind(crypto.randomUUID(), userId, action, entityType, entityId, correlationId, new Date().toISOString(), JSON.stringify(metadata)).run();
}

function safeJson(value: string | undefined, fallback: unknown): unknown {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}
