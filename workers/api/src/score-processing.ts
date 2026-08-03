import type { ScoringCalculationType } from "@myffl/api-contracts";
import {
  calculatePlayerScore,
  SCORING_CALCULATION_VERSION,
  type EngineRule,
  type EngineTier,
  type ScoreCalculation,
} from "./scoring-engine";

export type ScoringJob =
  | { type: "score-event"; eventId: string; dataScope: string; sourceUpdatedAtUtc: string }
  | {
      type: "scoring.configuration.applied";
      leagueId: string;
      seasonId: string;
      scoringVersionId: string;
      effectiveScope: string;
      affectedWeeks: number[];
      recalculationRequired: boolean;
      requestedAtUtc: string;
    };

interface EventRow {
  season_year: number;
  week: number;
  completed: number;
}

interface PlayerStatRow {
  nfl_player_id: string;
  position: string | null;
  stats_json: string;
  source_updated_at_utc: string;
}

interface SeasonRow {
  league_id: string;
  league_season_id: string;
  scoring_version_id: string;
}

interface ScoreRow {
  total_points_milli: number;
  input_hash: string;
  revision_number: number;
}

interface RuleRow {
  scoring_rule_id: string;
  statistic_key: string;
  display_name: string;
  enabled: number;
  calculation_type: ScoringCalculationType;
  point_value_milli: number;
  increment_value: string | null;
  threshold_value: string | null;
  position_filter: string | null;
  positions_json: string;
  max_awards: number | null;
  tiers_json: string;
  display_order: number;
}

export async function processScoringQueue(batch: MessageBatch<ScoringJob>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      await processScoringJob(env, message.body);
      message.ack();
    } catch (error) {
      console.error(JSON.stringify({
        level: "error",
        event: "scoring_job_failed",
        messageId: message.id,
        job: message.body,
        error: error instanceof Error ? error.message : String(error),
      }));
      message.retry({ delaySeconds: 20 });
    }
  }
}

export async function processScoringJob(env: Env, job: ScoringJob): Promise<void> {
  if (job.type === "score-event") {
    const event = await getEvent(env.NFL_DB, job.eventId, job.dataScope);
    if (!event) return;
    const seasons = await env.LEAGUE_DB_001.prepare(
      `select leagues.league_id, seasons.league_season_id, seasons.scoring_version_id
       from league_seasons seasons join leagues on leagues.league_id = seasons.league_id
       where seasons.season_year = ?1 and seasons.scoring_version_id is not null
         and seasons.status in ('setup', 'active') and leagues.archived_at_utc is null`,
    ).bind(event.season_year).all<SeasonRow>();
    const receiptKey = await sha256(`event|${job.eventId}|${job.dataScope}|${job.sourceUpdatedAtUtc}`);
    await withReceipt(env.LEAGUE_DB_001, receiptKey, job.type, async () => {
      let players = 0;
      for (const season of seasons.results ?? []) {
        players += await scoreEventForSeason(env, season, job.eventId, job.dataScope, event.completed === 1);
      }
      return { events: 1, players };
    });
    return;
  }

  const season = await env.LEAGUE_DB_001.prepare(
    `select leagues.league_id, seasons.league_season_id, ?3 as scoring_version_id
     from league_seasons seasons join leagues on leagues.league_id = seasons.league_id
     where leagues.league_id = ?1 and seasons.league_season_id = ?2`,
  ).bind(job.leagueId, job.seasonId, job.scoringVersionId).first<SeasonRow>();
  if (!season) return;
  const receiptKey = await sha256(`configuration|${job.scoringVersionId}|${job.requestedAtUtc}`);
  if (job.affectedWeeks.length === 0) {
    await withReceipt(env.LEAGUE_DB_001, receiptKey, job.type, async () => ({ events: 0, players: 0 }));
    return;
  }
  const seasonYear = await env.LEAGUE_DB_001.prepare(
    "select season_year from league_seasons where league_season_id = ?1",
  ).bind(job.seasonId).first<{ season_year: number }>();
  const weeks = job.affectedWeeks;
  const placeholders = weeks.map((_, index) => `?${index + 2}`).join(",");
  const events = await env.NFL_DB.prepare(
    `select distinct events.nfl_event_id as eventId, stats.data_scope as dataScope,
            snapshots.completed as completed
     from nfl_events events
     join nfl_player_game_stats stats on stats.nfl_event_id = events.nfl_event_id
     left join nfl_event_snapshots snapshots on snapshots.nfl_event_id = events.nfl_event_id and snapshots.data_scope = stats.data_scope
     where events.season_year = ?1 and events.week in (${placeholders})`,
  ).bind(seasonYear?.season_year ?? 0, ...weeks).all<{ eventId: string; dataScope: string; completed: number }>();
  await withReceipt(env.LEAGUE_DB_001, receiptKey, job.type, async () => {
    let players = 0;
    for (const event of events.results ?? []) {
      players += await scoreEventForSeason(env, season, event.eventId, event.dataScope, event.completed === 1);
    }
    return { events: events.results?.length ?? 0, players };
  });
}

async function getEvent(db: D1Database, eventId: string, scope: string): Promise<EventRow | null> {
  return db.prepare(
    `select events.season_year, events.week, snapshots.completed
     from nfl_events events join nfl_event_snapshots snapshots on snapshots.nfl_event_id = events.nfl_event_id
     where events.nfl_event_id = ?1 and snapshots.data_scope = ?2`,
  ).bind(eventId, scope).first<EventRow>();
}

async function scoreEventForSeason(
  env: Env,
  season: SeasonRow,
  eventId: string,
  scope: string,
  completed: boolean,
): Promise<number> {
  const [rules, stats] = await Promise.all([
    loadRules(env.LEAGUE_DB_001, season.scoring_version_id),
    env.NFL_DB.prepare(
      `select nfl_player_id, position, stats_json, source_updated_at_utc
       from nfl_player_game_stats where nfl_event_id = ?1 and data_scope = ?2`,
    ).bind(eventId, scope).all<PlayerStatRow>(),
  ]);
  let changed = 0;
  for (const player of stats.results ?? []) {
    const providerStats = parseObject(player.stats_json);
    const calculation = calculatePlayerScore(providerStats, player.position, rules);
    const inputHash = await sha256(stableJson({
      version: SCORING_CALCULATION_VERSION,
      scoringVersionId: season.scoring_version_id,
      position: player.position,
      stats: providerStats,
    }));
    const existing = await env.LEAGUE_DB_001.prepare(
      `select total_points_milli, input_hash, revision_number from player_event_scores
       where league_season_id = ?1 and nfl_event_id = ?2 and nfl_player_id = ?3 and data_scope = ?4`,
    ).bind(season.league_season_id, eventId, player.nfl_player_id, scope).first<ScoreRow>();
    if (existing?.input_hash === inputHash) continue;
    await persistPlayerScore(env.LEAGUE_DB_001, season, eventId, scope, player, calculation, inputHash, existing, completed);
    changed++;
  }
  return changed;
}

async function persistPlayerScore(
  db: D1Database,
  season: SeasonRow,
  eventId: string,
  scope: string,
  player: PlayerStatRow,
  calculation: ScoreCalculation,
  inputHash: string,
  existing: ScoreRow | null,
  completed: boolean,
): Promise<void> {
  const now = new Date().toISOString();
  const revision = (existing?.revision_number ?? 0) + 1;
  const reason = existing ? (completed ? "official-stat-correction" : "provider-update") : "initial-calculation";
  const statements: D1PreparedStatement[] = [
    db.prepare(
      `insert into player_event_scores (
        league_season_id, nfl_event_id, nfl_player_id, data_scope, scoring_version_id,
        position, total_points_milli, input_hash, calculation_version, revision_number,
        source_updated_at_utc, calculated_at_utc
       ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
       on conflict(league_season_id, nfl_event_id, nfl_player_id, data_scope) do update set
        scoring_version_id = excluded.scoring_version_id, position = excluded.position,
        total_points_milli = excluded.total_points_milli, input_hash = excluded.input_hash,
        calculation_version = excluded.calculation_version, revision_number = excluded.revision_number,
        source_updated_at_utc = excluded.source_updated_at_utc, calculated_at_utc = excluded.calculated_at_utc`,
    ).bind(
      season.league_season_id, eventId, player.nfl_player_id, scope, season.scoring_version_id,
      player.position, calculation.totalPointsMilli, inputHash, SCORING_CALCULATION_VERSION,
      revision, player.source_updated_at_utc, now,
    ),
    db.prepare(
      `delete from player_event_score_components
       where league_season_id = ?1 and nfl_event_id = ?2 and nfl_player_id = ?3 and data_scope = ?4`,
    ).bind(season.league_season_id, eventId, player.nfl_player_id, scope),
    db.prepare(
      `insert into player_event_score_revisions (
        player_event_score_revision_id, league_season_id, nfl_event_id, nfl_player_id,
        data_scope, scoring_version_id, revision_number, previous_points_milli,
        total_points_milli, input_hash, reason, breakdown_json, created_at_utc
       ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
    ).bind(
      crypto.randomUUID(), season.league_season_id, eventId, player.nfl_player_id, scope,
      season.scoring_version_id, revision, existing?.total_points_milli ?? null,
      calculation.totalPointsMilli, inputHash, reason, JSON.stringify(calculation.components), now,
    ),
  ];
  for (const component of calculation.components) {
    statements.push(db.prepare(
      `insert into player_event_score_components (
        player_event_score_component_id, league_season_id, nfl_event_id, nfl_player_id,
        data_scope, scoring_version_id, scoring_rule_id, statistic_key, display_name,
        raw_value_json, points_milli, explanation, display_order, calculated_at_utc
       ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
    ).bind(
      crypto.randomUUID(), season.league_season_id, eventId, player.nfl_player_id, scope,
      season.scoring_version_id, component.scoringRuleId, component.statisticKey,
      component.displayName, JSON.stringify(component.rawValue), component.pointsMilli,
      component.explanation, component.displayOrder, now,
    ));
  }
  await db.batch(statements);
}

async function loadRules(db: D1Database, versionId: string): Promise<EngineRule[]> {
  const result = await db.prepare(
    `select rules.scoring_rule_id, rules.statistic_key, details.display_name, rules.enabled,
            rules.calculation_type, rules.point_value_milli, rules.increment_value,
            rules.threshold_value, rules.position_filter, details.positions_json,
            rules.max_awards, details.tiers_json, rules.display_order
     from scoring_rules rules join scoring_rule_details details on details.scoring_rule_id = rules.scoring_rule_id
     where rules.scoring_version_id = ?1 order by rules.display_order`,
  ).bind(versionId).all<RuleRow>();
  return (result.results ?? []).map((row) => ({
    scoringRuleId: row.scoring_rule_id,
    statisticKey: row.statistic_key,
    displayName: row.display_name,
    enabled: Boolean(row.enabled),
    calculationType: row.calculation_type,
    pointValueMilli: row.point_value_milli,
    incrementValue: row.increment_value ?? undefined,
    thresholdValue: row.threshold_value ?? undefined,
    positions: parseArray<string>(row.positions_json || row.position_filter || "[]"),
    maxAwards: row.max_awards ?? undefined,
    tiers: parseArray<EngineTier>(row.tiers_json),
    displayOrder: row.display_order,
  }));
}

async function withReceipt(
  db: D1Database,
  key: string,
  type: string,
  work: () => Promise<{ events: number; players: number }>,
): Promise<void> {
  const existing = await db.prepare(
    "select status from scoring_job_receipts where scoring_job_key = ?1",
  ).bind(key).first<{ status: string }>();
  if (existing?.status === "succeeded") return;
  const now = new Date().toISOString();
  await db.prepare(
    `insert into scoring_job_receipts (scoring_job_key, job_type, status, started_at_utc)
     values (?1, ?2, 'running', ?3)
     on conflict(scoring_job_key) do update set status = 'running',
      attempt_count = scoring_job_receipts.attempt_count + 1, started_at_utc = excluded.started_at_utc,
      completed_at_utc = null, last_error = null`,
  ).bind(key, type, now).run();
  try {
    const result = await work();
    await db.prepare(
      `update scoring_job_receipts set status = 'succeeded', event_count = ?2,
       player_count = ?3, completed_at_utc = ?4 where scoring_job_key = ?1`,
    ).bind(key, result.events, result.players, new Date().toISOString()).run();
  } catch (error) {
    await db.prepare(
      `update scoring_job_receipts set status = 'failed', last_error = ?2,
       completed_at_utc = ?3 where scoring_job_key = ?1`,
    ).bind(key, (error instanceof Error ? error.message : String(error)).slice(0, 1000), new Date().toISOString()).run();
    throw error;
  }
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseArray<T>(value: string): T[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
