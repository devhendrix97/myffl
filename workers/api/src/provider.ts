import { ApiException } from "./http";
import type { ScoringJob } from "./score-processing";

const PROVIDER = "espn";
const PARSER_VERSION = "espn-nfl-1.0.0";
const PRODUCTION_SCOPE = "production";
const MAX_PAYLOAD_BYTES = 20 * 1024 * 1024;
const PROVIDER_ASSET_PREFIX = "provider-assets/espn/nfl";

export type ProviderJob =
  | { type: "sync-teams" }
  | { type: "sync-scoreboard"; date?: string }
  | { type: "sync-injuries" }
  | { type: "sync-summary"; eventId: string; dataScope?: string }
  | { type: "sync-projections"; seasonYear?: number };

type JsonObject = Record<string, unknown>;

interface FetchResult {
  payload: JsonObject;
  raw: string;
  sourceUrl: string;
}

interface SyncContext {
  env: Env;
  runId: string;
  resource: string;
  scope: string;
  now: string;
  seen: number;
  written: number;
  warnings: number;
  warningWrites: Promise<unknown>[];
}

export async function enqueueScheduledProviderWork(env: Env): Promise<void> {
  const now = new Date();
  const jobs: ProviderJob[] = [];
  const poll = await env.NFL_DB.prepare(
    `select state.last_success_at_utc as lastSuccessAtUtc,
      (select count(*) from nfl_event_snapshots where data_scope = 'production' and status = 'in') as liveGames,
      (select count(*) from nfl_event_snapshots where data_scope = 'production' and status = 'pre'
        and updated_at_utc >= datetime('now', '-1 day')) as scheduledGames
     from provider_sync_state state
     where state.provider = 'espn' and state.resource = 'scoreboard' and state.data_scope = 'production'`,
  ).first<{ lastSuccessAtUtc: string | null; liveGames: number; scheduledGames: number }>();
  const intervalMinutes = (poll?.liveGames ?? 0) > 0 ? 1 : (poll?.scheduledGames ?? 0) > 0 ? 3 : 15;
  const lastPoll = poll?.lastSuccessAtUtc ? Date.parse(poll.lastSuccessAtUtc) : 0;
  if (now.getTime() - lastPoll >= intervalMinutes * 60_000) jobs.push({ type: "sync-scoreboard" });
  const bootstrap = await env.NFL_DB.prepare(
    `select
      (select count(*) from nfl_teams) as teamCount,
      (select count(*) from nfl_teams where logo_object_key is null) as teamsMissingLogos,
      (select count(*) from nfl_player_injuries where data_scope = 'production') as injuryCount,
      (select count(*) from player_projections where provider = 'espn' and season_year = ?1) as projectionCount`,
  ).bind(now.getUTCFullYear()).first<{ teamCount: number; teamsMissingLogos: number; injuryCount: number; projectionCount: number }>();
  if ((bootstrap?.teamCount ?? 0) < 32 || (bootstrap?.teamsMissingLogos ?? 0) > 0) jobs.push({ type: "sync-teams" });
  if ((bootstrap?.injuryCount ?? 0) === 0) jobs.push({ type: "sync-injuries" });
  if ((bootstrap?.projectionCount ?? 0) < 100) {
    const lastProjectionAttempt = await env.NFL_DB.prepare(
      "select last_attempt_at_utc from provider_sync_state where provider = 'espn' and resource = 'projections' and data_scope = 'production'",
    ).first<{ last_attempt_at_utc: string | null }>();
    const lastAttempt = lastProjectionAttempt?.last_attempt_at_utc ? Date.parse(lastProjectionAttempt.last_attempt_at_utc) : 0;
    if (now.getTime() - lastAttempt >= 24 * 60 * 60_000) jobs.push({ type: "sync-projections", seasonYear: now.getUTCFullYear() });
  }
  if (now.getUTCHours() === 8 && now.getUTCMinutes() === 0) jobs.push({ type: "sync-injuries" });
  if (now.getUTCDay() === 2 && now.getUTCHours() === 9 && now.getUTCMinutes() === 0) {
    jobs.push({ type: "sync-teams" });
  }
  if (now.getUTCDay() === 2 && now.getUTCHours() === 15 && now.getUTCMinutes() === 0) {
    jobs.push({ type: "sync-projections", seasonYear: now.getUTCFullYear() });
  }
  const uniqueJobs = jobs.filter((job, index) => jobs.findIndex((candidate) => candidate.type === job.type) === index);
  if (uniqueJobs.length) await env.ESPN_UPDATES_QUEUE.sendBatch(uniqueJobs.map((body) => ({ body })));
}

export async function processProviderQueue(batch: MessageBatch<ProviderJob>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      await runProviderJob(env, message.body);
      message.ack();
    } catch (error) {
      console.error(JSON.stringify({
        level: "error",
        event: "provider_job_failed",
        messageId: message.id,
        job: message.body,
        error: error instanceof Error ? error.message : String(error),
      }));
      message.retry({ delaySeconds: 30 });
    }
  }
}

export async function runProviderJob(env: Env, job: ProviderJob): Promise<void> {
  if (job.type === "sync-teams") {
    await withSyncRun(env, "teams", PRODUCTION_SCOPE, async (context) => {
      const result = await fetchEspn("https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams?limit=100");
      await archive(context, result.raw, "all");
      await ingestTeams(context, result.payload);
    });
    return;
  }
  if (job.type === "sync-injuries") {
    await withSyncRun(env, "injuries", PRODUCTION_SCOPE, async (context) => {
      const result = await fetchEspn("https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries?limit=100");
      await archive(context, result.raw, "current");
      await ingestInjuries(context, result.payload);
    });
    return;
  }
  if (job.type === "sync-summary") {
    const scope = job.dataScope ?? PRODUCTION_SCOPE;
    await withSyncRun(env, "summary", scope, async (context) => {
      const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${encodeURIComponent(job.eventId)}`;
      const result = await fetchEspn(url);
      await archive(context, result.raw, job.eventId);
      await ingestSummary(context, result.payload, job.eventId);
    });
    return;
  }
  if (job.type === "sync-projections") {
    await withSyncRun(env, "projections", PRODUCTION_SCOPE, async (context) => {
      const seasonYear = job.seasonYear ?? new Date().getUTCFullYear();
      const result = await fetchEspnFantasyPlayers(seasonYear);
      await archive(context, result.raw, String(seasonYear));
      await ingestPlayerProjections(context, result.payload, seasonYear);
    });
    return;
  }
  await withSyncRun(env, "scoreboard", PRODUCTION_SCOPE, async (context) => {
    const suffix = job.date ? `?dates=${encodeURIComponent(job.date)}&limit=100` : "?limit=100";
    const result = await fetchEspn(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard${suffix}`);
    await archive(context, result.raw, job.date ?? "current");
    const summaries = await ingestScoreboard(context, result.payload);
    if (summaries.length) {
      await env.ESPN_UPDATES_QUEUE.sendBatch(summaries.map((eventId) => ({
        body: { type: "sync-summary", eventId } satisfies ProviderJob,
      })));
    }
  });
}

async function fetchEspnFantasyPlayers(seasonYear: number): Promise<FetchResult> {
  const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${encodeURIComponent(String(seasonYear))}/players?view=kona_player_info`;
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "myFFL/0.5 provider-ingestion (+https://myfflapp.com)",
      "x-fantasy-filter": JSON.stringify({
        players: {
          limit: 2000,
          sortPercOwned: { sortPriority: 1, sortAsc: false },
        },
      }),
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`ESPN fantasy players returned ${response.status} for ${url}`);
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_PAYLOAD_BYTES) throw new Error(`ESPN fantasy players payload exceeded ${MAX_PAYLOAD_BYTES} bytes`);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_PAYLOAD_BYTES) throw new Error(`ESPN fantasy players payload exceeded ${MAX_PAYLOAD_BYTES} bytes`);
  const raw = new TextDecoder().decode(bytes);
  const parsed: unknown = JSON.parse(raw);
  return { payload: Array.isArray(parsed) ? { players: parsed } : object(parsed), raw, sourceUrl: url };
}

async function fetchEspn(url: string): Promise<FetchResult> {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "myFFL/0.5 provider-ingestion (+https://myfflapp.com)",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`ESPN returned ${response.status} for ${url}`);
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_PAYLOAD_BYTES) throw new Error(`ESPN payload exceeded ${MAX_PAYLOAD_BYTES} bytes`);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_PAYLOAD_BYTES) throw new Error(`ESPN payload exceeded ${MAX_PAYLOAD_BYTES} bytes`);
  const raw = new TextDecoder().decode(bytes);
  const parsed: unknown = JSON.parse(raw);
  if (!isObject(parsed)) throw new Error("ESPN returned a non-object JSON payload");
  return { payload: parsed, raw, sourceUrl: url };
}

async function withSyncRun(
  env: Env,
  resource: string,
  scope: string,
  work: (context: SyncContext) => Promise<void>,
): Promise<void> {
  const runId = crypto.randomUUID();
  const now = new Date().toISOString();
  const context: SyncContext = { env, runId, resource, scope, now, seen: 0, written: 0, warnings: 0, warningWrites: [] };
  await env.NFL_DB.prepare(
    `insert into provider_sync_runs
      (provider_sync_run_id, provider, resource, data_scope, status, started_at_utc)
     values (?1, ?2, ?3, ?4, 'running', ?5)`,
  ).bind(runId, PROVIDER, resource, scope, now).run();
  try {
    await work(context);
    await Promise.all(context.warningWrites);
    const completed = new Date().toISOString();
    await env.NFL_DB.batch([
      env.NFL_DB.prepare(
        `update provider_sync_runs set status = 'succeeded', records_seen = ?2,
          records_written = ?3, warning_count = ?4, completed_at_utc = ?5
         where provider_sync_run_id = ?1`,
      ).bind(runId, context.seen, context.written, context.warnings, completed),
      env.NFL_DB.prepare(
        `insert into provider_sync_state
          (provider, resource, data_scope, last_success_at_utc, last_attempt_at_utc, last_status, last_run_id, last_error)
         values (?1, ?2, ?3, ?4, ?4, 'succeeded', ?5, null)
         on conflict(provider, resource, data_scope) do update set
          last_success_at_utc = excluded.last_success_at_utc,
          last_attempt_at_utc = excluded.last_attempt_at_utc,
          last_status = excluded.last_status, last_run_id = excluded.last_run_id, last_error = null`,
      ).bind(PROVIDER, resource, scope, completed, runId),
    ]);
    console.log(JSON.stringify({ level: "info", event: "provider_sync_completed", runId, resource, scope, seen: context.seen, written: context.written }));
  } catch (error) {
    const completed = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    await env.NFL_DB.batch([
      env.NFL_DB.prepare(
        `update provider_sync_runs set status = 'failed', records_seen = ?2,
          records_written = ?3, warning_count = ?4, error_message = ?5, completed_at_utc = ?6
         where provider_sync_run_id = ?1`,
      ).bind(runId, context.seen, context.written, context.warnings, message.slice(0, 1000), completed),
      env.NFL_DB.prepare(
        `insert into provider_sync_state
          (provider, resource, data_scope, last_attempt_at_utc, last_status, last_run_id, last_error)
         values (?1, ?2, ?3, ?4, 'failed', ?5, ?6)
         on conflict(provider, resource, data_scope) do update set
          last_attempt_at_utc = excluded.last_attempt_at_utc,
          last_status = excluded.last_status, last_run_id = excluded.last_run_id, last_error = excluded.last_error`,
      ).bind(PROVIDER, resource, scope, completed, runId, message.slice(0, 1000)),
    ]);
    throw error;
  }
}

async function archive(context: SyncContext, raw: string, resourceId: string): Promise<void> {
  const archiveId = crypto.randomUUID();
  const safeTime = context.now.replaceAll(":", "-");
  const prefix = context.scope === PRODUCTION_SCOPE ? "production" : `simulations/${context.scope.slice(11)}`;
  const key = `${prefix}/${context.resource}/${safeTime}-${archiveId}.json`;
  await context.env.PROVIDER_ARCHIVE_BUCKET.put(key, raw, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { provider: PROVIDER, parserVersion: PARSER_VERSION, dataScope: context.scope },
  });
  await context.env.NFL_DB.prepare(
    `insert into provider_raw_archives
      (provider_raw_archive_id, provider, provider_resource, provider_resource_id,
       r2_object_key, parser_version, captured_at_utc)
     values (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  ).bind(archiveId, PROVIDER, context.resource, resourceId, key, PARSER_VERSION, context.now).run();
}

async function ingestTeams(context: SyncContext, payload: JsonObject): Promise<void> {
  const sports = array(payload.sports);
  const leagues = sports.flatMap((sport) => array(object(sport).leagues));
  const entries = leagues.flatMap((league) => array(object(league).teams));
  for (const entry of entries) await upsertTeam(context, object(object(entry).team));
}

async function upsertTeam(context: SyncContext, team: JsonObject): Promise<string | undefined> {
  const providerId = string(team.id);
  if (!providerId) return warn(context, "team.id", "Team did not include an id");
  const id = `espn-team-${providerId}`;
  const abbreviation = string(team.abbreviation) ?? "UNK";
  const displayName = string(team.displayName) ?? string(team.name) ?? abbreviation;
  const logo = imageUrl(team.logos) ?? imageUrl(team.logo);
  const logoKey = logo ? `provider-assets/espn/nfl/teams/${providerId}/logo` : null;
  if (logo && logoKey) await cacheProviderImage(context, logoKey, logo);
  await context.env.NFL_DB.batch([
    context.env.NFL_DB.prepare(
      `insert into nfl_teams
        (nfl_team_id, provider, provider_team_id, abbreviation, display_name,
         logo_object_key, logo_source_url, created_at_utc, updated_at_utc)
       values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
       on conflict(provider, provider_team_id) do update set abbreviation = excluded.abbreviation,
        display_name = excluded.display_name,
        logo_object_key = coalesce(excluded.logo_object_key, nfl_teams.logo_object_key),
        logo_source_url = coalesce(excluded.logo_source_url, nfl_teams.logo_source_url),
        updated_at_utc = excluded.updated_at_utc`,
    ).bind(id, PROVIDER, providerId, abbreviation, displayName, logoKey, logo ?? null, context.now),
    context.env.NFL_DB.prepare(
      `insert into nfl_team_snapshots
        (nfl_team_id, data_scope, abbreviation, display_name, logo_url, color_hex,
         alternate_color_hex, active, updated_at_utc)
       values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
       on conflict(nfl_team_id, data_scope) do update set abbreviation = excluded.abbreviation,
        display_name = excluded.display_name, logo_url = excluded.logo_url,
        color_hex = excluded.color_hex, alternate_color_hex = excluded.alternate_color_hex,
        active = excluded.active, updated_at_utc = excluded.updated_at_utc`,
    ).bind(id, context.scope, abbreviation, displayName, logo ?? null, string(team.color) ?? null,
      string(team.alternateColor) ?? null, team.isActive === false ? 0 : 1, context.now),
  ]);
  context.seen++;
  context.written++;
  return id;
}

async function ingestScoreboard(context: SyncContext, payload: JsonObject): Promise<string[]> {
  const summaries: string[] = [];
  for (const rawEvent of array(payload.events)) {
    const event = object(rawEvent);
    const providerId = string(event.id);
    if (!providerId) { warn(context, "events[].id", "Event did not include an id"); continue; }
    const competition = object(array(event.competitions)[0]);
    const status = object(event.status);
    const statusType = object(status.type);
    const competitors = array(competition.competitors).map(object);
    const home = competitors.find((item) => string(item.homeAway) === "home") ?? {};
    const away = competitors.find((item) => string(item.homeAway) === "away") ?? {};
    const homeTeamId = await upsertTeam(context, object(home.team));
    const awayTeamId = await upsertTeam(context, object(away.team));
    const season = object(event.season);
    const week = object(event.week);
    const id = `espn-event-${providerId}`;
    const state = string(statusType.state) ?? "pre";
    await context.env.NFL_DB.batch([
      context.env.NFL_DB.prepare(
        `insert into nfl_events
          (nfl_event_id, provider, provider_event_id, season_year, season_type, week,
           starts_at_utc, status, created_at_utc, updated_at_utc)
         values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
         on conflict(provider, provider_event_id) do update set starts_at_utc = excluded.starts_at_utc,
          status = excluded.status, updated_at_utc = excluded.updated_at_utc`,
      ).bind(id, PROVIDER, providerId, integer(season.year), integer(season.type), integer(week.number),
        string(event.date) ?? context.now, state, context.now),
      context.env.NFL_DB.prepare(
        `insert into nfl_event_snapshots
          (nfl_event_id, data_scope, status, status_detail, period, clock, completed,
           home_team_id, away_team_id, home_score, away_score, situation_json, updated_at_utc)
         values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         on conflict(nfl_event_id, data_scope) do update set status = excluded.status,
          status_detail = excluded.status_detail, period = excluded.period, clock = excluded.clock,
          completed = excluded.completed, home_team_id = excluded.home_team_id,
          away_team_id = excluded.away_team_id, home_score = excluded.home_score,
          away_score = excluded.away_score, situation_json = excluded.situation_json,
          updated_at_utc = excluded.updated_at_utc`,
      ).bind(id, context.scope, state, string(statusType.detail) ?? string(statusType.description) ?? null,
        integer(status.period), string(status.displayClock) ?? null, statusType.completed === true ? 1 : 0,
        homeTeamId ?? null, awayTeamId ?? null, integer(home.score), integer(away.score),
        JSON.stringify(competition.situation ?? null), context.now),
    ]);
    context.seen++;
    context.written++;
    if (context.scope === PRODUCTION_SCOPE && (state === "in" || state === "post")) summaries.push(providerId);
  }
  return summaries;
}

async function ingestSummary(context: SyncContext, payload: JsonObject, eventProviderId: string): Promise<void> {
  const eventId = `espn-event-${eventProviderId}`;
  const boxscore = object(payload.boxscore);
  let statements: D1PreparedStatement[] = [];
  for (const rawTeamGroup of array(boxscore.players)) {
    const teamGroup = object(rawTeamGroup);
    const teamId = await upsertTeam(context, object(teamGroup.team));
    for (const rawCategory of array(teamGroup.statistics)) {
      const category = object(rawCategory);
      const categoryName = string(category.name) ?? "unknown";
      const labels = array(category.labels).map((value) => string(value) ?? "");
      for (const rawAthlete of array(category.athletes)) {
        const athleteEntry = object(rawAthlete);
        const athlete = object(athleteEntry.athlete);
        const providerPlayerId = string(athlete.id);
        if (!providerPlayerId) { warn(context, "boxscore.players[].athlete.id", "Athlete did not include an id"); continue; }
        const playerId = `espn-player-${providerPlayerId}`;
        const position = string(object(athlete.position).abbreviation) ?? null;
        const displayName = string(athlete.displayName) ?? `ESPN Player ${providerPlayerId}`;
        const headshot = imageUrl(athlete.headshot) ?? imageUrl(athlete.headshots);
        const headshotKey = headshot ? `${PROVIDER_ASSET_PREFIX}/athletes/${providerPlayerId}/headshot` : null;
        if (headshot && headshotKey) await cacheProviderImage(context, headshotKey, headshot);
        const stats = array(athleteEntry.stats);
        const normalized = normalizeCategoryStats(categoryName, labels, stats);
        statements.push(
          context.env.NFL_DB.prepare(
            `insert into nfl_players
              (nfl_player_id, display_name, position, current_team_id,
               headshot_object_key, headshot_source_url, created_at_utc, updated_at_utc)
             values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
             on conflict(nfl_player_id) do update set display_name = excluded.display_name,
              position = coalesce(excluded.position, nfl_players.position),
              current_team_id = coalesce(excluded.current_team_id, nfl_players.current_team_id),
              headshot_object_key = coalesce(excluded.headshot_object_key, nfl_players.headshot_object_key),
              headshot_source_url = coalesce(excluded.headshot_source_url, nfl_players.headshot_source_url),
              updated_at_utc = excluded.updated_at_utc`,
          ).bind(playerId, displayName, position, teamId ?? null, headshotKey, headshot ?? null, context.now),
          context.env.NFL_DB.prepare(
            `insert into provider_player_mappings
              (provider, provider_player_id, nfl_player_id, created_at_utc)
             values (?1, ?2, ?3, ?4) on conflict(provider, provider_player_id) do nothing`,
          ).bind(PROVIDER, providerPlayerId, playerId, context.now),
          context.env.NFL_DB.prepare(
            `insert into nfl_player_game_stats
              (nfl_event_id, nfl_player_id, data_scope, team_id, position, stats_json, source_updated_at_utc)
             values (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             on conflict(nfl_event_id, nfl_player_id, data_scope) do update set
              team_id = excluded.team_id, position = excluded.position,
              stats_json = json_patch(nfl_player_game_stats.stats_json, excluded.stats_json),
              source_updated_at_utc = excluded.source_updated_at_utc`,
          ).bind(eventId, playerId, context.scope, teamId ?? null, position, JSON.stringify(normalized), context.now),
        );
        if (statements.length >= 75) {
          await context.env.NFL_DB.batch(statements);
          statements = [];
        }
        context.seen++;
        context.written++;
      }
    }
  }
  if (statements.length) await context.env.NFL_DB.batch(statements);
  await ingestPlays(context, payload, eventId);
  await context.env.SCORING_QUEUE.send({
    type: "score-event",
    eventId,
    dataScope: context.scope,
    sourceUpdatedAtUtc: context.now,
  } satisfies ScoringJob);
}

async function ingestPlays(context: SyncContext, payload: JsonObject, eventId: string): Promise<void> {
  const drives = object(payload.drives);
  const currentDrives = isObject(drives.current) ? [drives.current] : array(drives.current);
  const driveRows = [...array(drives.previous), ...currentDrives];
  const unique = new Map<string, { driveId?: string; play: JsonObject }>();
  for (const rawDrive of driveRows) {
    const drive = object(rawDrive);
    for (const rawPlay of array(drive.plays)) {
      const play = object(rawPlay);
      const id = string(play.id);
      if (id) unique.set(id, { driveId: string(drive.id), play });
    }
  }
  let statements: D1PreparedStatement[] = [];
  for (const [playId, value] of unique) {
    const play = value.play;
    const participant = object(array(play.teamParticipants)[0]);
    const providerTeamId = string(object(participant.team).id) ?? string(object(object(play.start).team).id);
    const period = integer(object(play.period).number);
    const clock = string(object(play.clock).displayValue) ?? "0:00";
    statements.push(context.env.NFL_DB.prepare(
      `insert into nfl_event_plays
        (nfl_event_id, provider_play_id, data_scope, sequence_number, drive_id, team_id,
         period, clock, play_type, play_text, stat_yardage, home_score, away_score,
         scoring_play, turnover, start_json, end_json, participants_json, updated_at_utc)
       values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)
       on conflict(nfl_event_id, provider_play_id, data_scope) do update set
        sequence_number = excluded.sequence_number, drive_id = excluded.drive_id, team_id = excluded.team_id,
        period = excluded.period, clock = excluded.clock, play_type = excluded.play_type,
        play_text = excluded.play_text, stat_yardage = excluded.stat_yardage,
        home_score = excluded.home_score, away_score = excluded.away_score,
        scoring_play = excluded.scoring_play, turnover = excluded.turnover,
        start_json = excluded.start_json, end_json = excluded.end_json,
        participants_json = excluded.participants_json, updated_at_utc = excluded.updated_at_utc`,
    ).bind(eventId, playId, context.scope, integer(play.sequenceNumber), value.driveId ?? null,
      providerTeamId ? `espn-team-${providerTeamId}` : null, period, clock,
      string(object(play.type).text) ?? "Play", string(play.text) ?? "Play update", integer(play.statYardage),
      integer(play.homeScore), integer(play.awayScore), play.scoringPlay === true ? 1 : 0,
      play.isTurnover === true ? 1 : 0, JSON.stringify(play.start ?? null), JSON.stringify(play.end ?? null),
      JSON.stringify(play.teamParticipants ?? []), context.now));
    if (statements.length >= 75) {
      await context.env.NFL_DB.batch(statements);
      statements = [];
    }
  }
  if (statements.length) await context.env.NFL_DB.batch(statements);
  context.seen += unique.size;
  context.written += unique.size;
}

async function ingestInjuries(context: SyncContext, payload: JsonObject): Promise<void> {
  let statements: D1PreparedStatement[] = [];
  for (const rawGroup of array(payload.injuries)) {
    const group = object(rawGroup);
    const providerTeamId = string(group.id);
    const teamId = providerTeamId ? `espn-team-${providerTeamId}` : undefined;
    for (const rawInjury of array(group.injuries)) {
      const injury = object(rawInjury);
      const athlete = object(injury.athlete);
      const providerPlayerId = providerAthleteId(athlete);
      const injuryId = string(injury.id);
      if (!providerPlayerId || !injuryId) { warn(context, "injuries[].injuries[]", "Injury did not include athlete and injury ids"); continue; }
      const playerId = `espn-player-${providerPlayerId}`;
      const displayName = string(athlete.displayName) ?? `ESPN Player ${providerPlayerId}`;
      const position = string(object(athlete.position).abbreviation) ?? null;
      const headshot = imageUrl(athlete.headshot) ?? imageUrl(athlete.headshots);
      const headshotKey = headshot ? `${PROVIDER_ASSET_PREFIX}/athletes/${providerPlayerId}/headshot` : null;
      if (headshot && headshotKey) await cacheProviderImage(context, headshotKey, headshot);
      statements.push(
        context.env.NFL_DB.prepare(
          `insert into nfl_players
            (nfl_player_id, display_name, position, current_team_id,
             headshot_object_key, headshot_source_url, created_at_utc, updated_at_utc)
           values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
           on conflict(nfl_player_id) do update set display_name = excluded.display_name,
            position = coalesce(excluded.position, nfl_players.position),
            current_team_id = coalesce(excluded.current_team_id, nfl_players.current_team_id),
            headshot_object_key = coalesce(excluded.headshot_object_key, nfl_players.headshot_object_key),
            headshot_source_url = coalesce(excluded.headshot_source_url, nfl_players.headshot_source_url),
            updated_at_utc = excluded.updated_at_utc`,
        ).bind(playerId, displayName, position, teamId ?? null, headshotKey, headshot ?? null, context.now),
        context.env.NFL_DB.prepare(
          `insert into provider_player_mappings
            (provider, provider_player_id, nfl_player_id, created_at_utc)
           values (?1, ?2, ?3, ?4) on conflict(provider, provider_player_id) do nothing`,
        ).bind(PROVIDER, providerPlayerId, playerId, context.now),
        context.env.NFL_DB.prepare(
          `insert into nfl_player_injuries
            (provider_injury_id, data_scope, nfl_player_id, team_id, status, injury_type,
             short_comment, long_comment, injury_date_utc, updated_at_utc)
           values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
           on conflict(provider_injury_id, data_scope) do update set status = excluded.status,
            injury_type = excluded.injury_type, short_comment = excluded.short_comment,
            long_comment = excluded.long_comment, injury_date_utc = excluded.injury_date_utc,
            updated_at_utc = excluded.updated_at_utc`,
        ).bind(injuryId, context.scope, playerId, teamId ?? null, string(injury.status) ?? null,
          string(object(injury.type).description) ?? string(object(injury.type).name) ?? null,
          string(injury.shortComment) ?? null, string(injury.longComment) ?? null,
          string(injury.date) ?? null, context.now),
      );
      if (statements.length >= 75) {
        await context.env.NFL_DB.batch(statements);
        statements = [];
      }
      context.seen++;
      context.written++;
    }
  }
  if (statements.length) await context.env.NFL_DB.batch(statements);
}

async function ingestPlayerProjections(context: SyncContext, payload: JsonObject, seasonYear: number): Promise<void> {
  let statements: D1PreparedStatement[] = [];
  let projections = 0;
  for (const rawPlayer of array(payload.players)) {
    const player = object(rawPlayer);
    const providerPlayerId = string(player.id);
    if (!providerPlayerId) { warn(context, "players[].id", "Projected player did not include an id"); continue; }
    const playerId = `espn-player-${providerPlayerId}`;
    const displayName = string(player.fullName) ?? string(player.displayName) ?? string(player.name) ?? `ESPN Player ${providerPlayerId}`;
    const position = positionFromFantasyPlayer(player);
    const providerTeamId = integer(player.proTeamId);
    const teamId = providerTeamId > 0 ? `espn-team-${providerTeamId}` : null;
    statements.push(
      context.env.NFL_DB.prepare(
        `insert into nfl_players
          (nfl_player_id, display_name, position, current_team_id,
           headshot_object_key, headshot_source_url, created_at_utc, updated_at_utc)
         values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
         on conflict(nfl_player_id) do update set display_name = excluded.display_name,
          position = coalesce(excluded.position, nfl_players.position),
          current_team_id = coalesce(excluded.current_team_id, nfl_players.current_team_id),
          headshot_object_key = coalesce(excluded.headshot_object_key, nfl_players.headshot_object_key),
          headshot_source_url = coalesce(excluded.headshot_source_url, nfl_players.headshot_source_url),
          updated_at_utc = excluded.updated_at_utc`,
      ).bind(playerId, displayName, position, teamId, null, null, context.now),
      context.env.NFL_DB.prepare(
        `insert into provider_player_mappings
          (provider, provider_player_id, nfl_player_id, created_at_utc)
         values (?1, ?2, ?3, ?4) on conflict(provider, provider_player_id) do nothing`,
      ).bind(PROVIDER, providerPlayerId, playerId, context.now),
    );
    for (const rawStat of array(player.stats)) {
      const stat = object(rawStat);
      if (integer(stat.statSourceId) !== 1 || integer(stat.seasonId) !== seasonYear) continue;
      const splitType = integer(stat.statSplitTypeId);
      const scoringPeriod = integer(stat.scoringPeriodId);
      const projectionType = splitType === 0 ? "season" : splitType === 1 ? "weekly" : null;
      if (!projectionType) continue;
      const weekNumber = projectionType === "weekly" ? scoringPeriod : 0;
      if (projectionType === "weekly" && (weekNumber < 1 || weekNumber > 22)) continue;
      const normalized = normalizeEspnProjectionStats(object(stat.stats));
      if (!Object.keys(normalized).length) continue;
      statements.push(context.env.NFL_DB.prepare(
        `insert into player_projections
          (provider, season_year, projection_type, week_number, provider_player_id, nfl_player_id,
           display_name, team_id, position, projected_stats_json, source_updated_at_utc, fetched_at_utc)
         values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         on conflict(provider, season_year, projection_type, week_number, provider_player_id) do update set
          nfl_player_id = excluded.nfl_player_id, display_name = excluded.display_name,
          team_id = excluded.team_id, position = excluded.position,
          projected_stats_json = excluded.projected_stats_json,
          source_updated_at_utc = excluded.source_updated_at_utc,
          fetched_at_utc = excluded.fetched_at_utc`,
      ).bind(PROVIDER, seasonYear, projectionType, weekNumber, providerPlayerId, playerId, displayName,
        teamId, position, JSON.stringify(normalized), context.now, context.now));
      projections++;
    }
    context.seen++;
    if (statements.length >= 90) {
      await context.env.NFL_DB.batch(statements);
      statements = [];
    }
  }
  if (statements.length) await context.env.NFL_DB.batch(statements);
  await context.env.NFL_DB.prepare(
    "delete from player_projections where provider = 'espn' and season_year = ?1 and fetched_at_utc <> ?2",
  ).bind(seasonYear, context.now).run();
  context.written += projections;
}

export function normalizeEspnProjectionStats(stats: JsonObject): Record<string, number> {
  const normalized: Record<string, number> = {};
  assignProjectionStat(normalized, "passing:ATT", stats["0"]);
  assignProjectionStat(normalized, "passing:CMP", stats["1"]);
  assignProjectionStat(normalized, "passing:YDS", stats["3"]);
  assignProjectionStat(normalized, "passing:TD", stats["4"]);
  assignProjectionStat(normalized, "passing:INT", stats["20"]);
  assignProjectionStat(normalized, "rushing:ATT", stats["23"]);
  assignProjectionStat(normalized, "rushing:YDS", stats["24"]);
  assignProjectionStat(normalized, "rushing:TD", stats["25"]);
  assignProjectionStat(normalized, "receiving:YDS", stats["42"]);
  assignProjectionStat(normalized, "receiving:TD", stats["43"]);
  assignProjectionStat(normalized, "receiving:REC", stats["53"]);
  assignProjectionStat(normalized, "fumbles:LOST", stats["72"]);
  assignProjectionStat(normalized, "kicking:FG", stats["83"]);
  assignProjectionStat(normalized, "kicking:XP", stats["86"]);
  assignProjectionStat(normalized, "defense:SACKS", stats["99"]);
  assignProjectionStat(normalized, "defense:INT", stats["100"]);
  assignProjectionStat(normalized, "defense:FR", stats["101"]);
  assignProjectionStat(normalized, "defense:TD", stats["102"]);
  return normalized;
}

function assignProjectionStat(stats: Record<string, number>, key: string, value: unknown): void {
  const parsed = numberValue(value);
  if (parsed !== undefined) stats[key] = parsed;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value.replaceAll(",", ""));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function positionFromFantasyPlayer(player: JsonObject): string | null {
  const abbreviation = string(object(player.position).abbreviation) ?? string(player.defaultPosition);
  if (abbreviation) return abbreviation.toUpperCase();
  const defaultPositionId = integer(player.defaultPositionId);
  return ({ 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DST" } as Record<number, string>)[defaultPositionId] ?? null;
}

function warn(context: SyncContext, path: string, message: string): undefined {
  context.warnings++;
  context.warningWrites.push(context.env.NFL_DB.prepare(
    `insert into provider_schema_warnings
      (provider_schema_warning_id, provider_sync_run_id, resource, json_path, message, created_at_utc)
     values (?1, ?2, ?3, ?4, ?5, ?6)`,
  ).bind(crypto.randomUUID(), context.runId, context.resource, path, message, context.now).run().catch(() => undefined));
  return undefined;
}

async function cacheProviderImage(context: SyncContext, key: string, sourceUrl: string): Promise<void> {
  try {
    const existing = await context.env.ASSETS_BUCKET.head(key);
    if (existing?.customMetadata?.sourceUrl === sourceUrl) return;
    const response = await fetch(sourceUrl, {
      headers: { accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8,*/*;q=0.5" },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok || !response.body) return;
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (!contentType?.startsWith("image/")) return;
    await context.env.ASSETS_BUCKET.put(key, response.body, {
      httpMetadata: { contentType, cacheControl: "public, max-age=31536000, immutable" },
      customMetadata: { provider: PROVIDER, sourceUrl, fetchedAtUtc: context.now },
    });
  } catch {
    warn(context, "provider.image", `Could not cache provider image ${key}`);
  }
}

function imageUrl(value: unknown): string | undefined {
  if (typeof value === "string" && /^https:\/\//i.test(value)) return value;
  for (const item of array(value)) {
    const found = imageUrl(item);
    if (found) return found;
  }
  const obj = object(value);
  return [string(obj.href), string(obj.url), string(obj.src)].find((item) => item && /^https:\/\//i.test(item));
}

export function normalizeCategoryStats(category: string, labels: string[], stats: unknown[]): Record<string, unknown> {
  return Object.fromEntries(labels.map((label, index) => [`${category}:${label}`, stats[index] ?? null]));
}

export function providerAthleteId(athlete: JsonObject): string | undefined {
  const direct = string(athlete.id);
  if (direct) return direct;
  for (const rawLink of array(athlete.links)) {
    const href = string(object(rawLink).href);
    const match = href?.match(/\/id\/(\d+)(?:\/|$)/);
    if (match) return match[1];
  }
  return undefined;
}

export async function ingestReplayFrame(env: Env, runId: string, frame: JsonObject): Promise<void> {
  const scope = `simulation:${runId}`;
  await withSyncRun(env, "simulation-frame", scope, async (context) => {
    const raw = JSON.stringify(frame);
    await archive(context, raw, `frame-${string(frame.frameNumber) ?? "unknown"}`);
    await ingestScoreboard(context, object(frame.scoreboard));
    const summaries = object(frame.summaries);
    for (const [eventId, summary] of Object.entries(summaries)) {
      await ingestSummary(context, object(summary), eventId);
    }
  });
}

export function requireJsonObject(value: unknown): JsonObject {
  if (!isObject(value)) throw new ApiException(400, "invalid_payload", "A JSON object is required.");
  return value;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function object(value: unknown): JsonObject { return isObject(value) ? value : {}; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function string(value: unknown): string | undefined { return typeof value === "string" && value.length ? value : undefined; }
function integer(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? "0"), 10);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}
