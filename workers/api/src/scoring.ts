import type {
  ApplyScoringDraftRequest,
  SaveScoringRulesRequest,
  ScoringCalculationType,
  ScoringCatalogResponse,
  ScoringConfiguration,
  ScoringEffectiveScope,
  ScoringPreviewRequest,
  ScoringPreviewResponse,
  ScoringPresetKey,
  ScoringRule,
  ScoringRuleDifference,
  ScoringStatisticDefinition,
  ScoringVersionSummary,
  StartScoringDraftRequest,
  LeagueRole,
} from "@myffl/api-contracts";
import { authenticate, type HandlerResult } from "./auth";
import { ApiException, readJson } from "./http";
import { getLeagueRow, requireLeagueRole } from "./league";
import { newId, type AccessTokenPrincipal } from "./security";

const commissionerRoles = ["commissioner", "co-commissioner"] as const;
const allLeagueRoles = ["commissioner", "co-commissioner", "manager"] as const;
const calculationTypes = new Set<ScoringCalculationType>([
  "points-per-unit",
  "flat-per-event",
  "one-time-threshold",
  "repeating-threshold",
  "range-based",
  "tiered",
  "position-specific",
  "minimum-requirement",
  "maximum-award",
]);
const effectiveScopes = new Set<ScoringEffectiveScope>([
  "next-week",
  "unstarted-weeks",
  "selected-future-weeks",
  "retroactive-current-season",
  "entire-season",
  "next-season",
]);

interface VersionRow {
  scoring_version_id: string;
  league_season_id: string;
  version_number: number;
  status: ScoringVersionSummary["status"];
  effective_at_utc: string;
  created_by_user_id: string;
  created_at_utc: string;
  source_preset_key: ScoringVersionSummary["sourcePresetKey"] | null;
  revision_number: number;
  effective_scope: ScoringEffectiveScope | null;
  effective_from_week: number | null;
  effective_to_week: number | null;
  change_reason: string | null;
  is_current: number;
  applied_at_utc: string | null;
}

interface RuleRow {
  scoring_rule_id: string;
  scoring_version_id: string;
  statistic_key: string;
  enabled: number;
  calculation_type: ScoringCalculationType;
  point_value_milli: number;
  increment_value: string | null;
  threshold_value: string | null;
  position_filter: string | null;
  max_awards: number | null;
  display_order: number;
  display_name: string;
  description: string;
  category: string;
  positions_json: string;
  tiers_json: string;
}

interface PresetRuleRow extends RuleRow {
  preset_key: ScoringPresetKey;
}

interface SeasonContext {
  db: D1Database;
  leagueId: string;
  seasonId: string;
  seasonYear: number;
  role: LeagueRole;
}

export async function handleScoringRequest(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
  correlationId: string,
): Promise<HandlerResult<unknown> | undefined> {
  const match = url.pathname.match(
    /^\/api\/leagues\/([^/]+)\/scoring(?:\/(catalog|versions|draft|preset|rules|preview|apply))?(?:\/([^/]+))?$/,
  );
  if (!match) return undefined;

  const principal = await authenticate(request, env);
  const leagueId = match[1];
  const action = match[2];
  const itemId = match[3];

  if (request.method === "GET" && action === "catalog") {
    await getContext(principal, leagueId, env, false);
    return { data: await getCatalog(env.NFL_DB) };
  }
  if (request.method === "GET" && action === "versions" && !itemId) {
    const context = await getContext(principal, leagueId, env, false);
    await ensureCurrentConfiguration(context, principal, env);
    return { data: await listVersions(context) };
  }
  if (request.method === "GET" && action === "versions" && itemId) {
    const context = await getContext(principal, leagueId, env, false);
    return { data: await getConfigurationById(context, itemId) };
  }
  if (request.method === "GET" && !action) {
    const context = await getContext(principal, leagueId, env, false);
    await ensureCurrentConfiguration(context, principal, env);
    return { data: await getWorkingConfiguration(context) };
  }
  if (request.method === "POST" && (action === "draft" || action === "preset")) {
    const context = await getContext(principal, leagueId, env, true);
    const body = action === "preset"
      ? { source: "preset", presetKey: (await readJson<{ presetKey?: StartScoringDraftRequest["presetKey"] }>(request)).presetKey } as StartScoringDraftRequest
      : await readJson<StartScoringDraftRequest>(request);
    return { status: 201, data: await startDraft(context, principal, body, env) };
  }
  if (request.method === "POST" && action === "rules" && !itemId) {
    const context = await getContext(principal, leagueId, env, true);
    return { data: await saveRules(context, principal, await readJson<SaveScoringRulesRequest>(request), env) };
  }
  if (request.method === "PUT" && action === "rules" && itemId) {
    const context = await getContext(principal, leagueId, env, true);
    const body = await readJson<{ revisionNumber: number; rule: ScoringRule }>(request);
    const current = await getWorkingConfiguration(context);
    const rules = current.rules.map((rule) => rule.scoringRuleId === itemId ? body.rule : rule);
    return { data: await saveRules(context, principal, { revisionNumber: body.revisionNumber, rules }, env) };
  }
  if (request.method === "DELETE" && action === "rules" && itemId) {
    const context = await getContext(principal, leagueId, env, true);
    const body = await readJson<{ revisionNumber: number }>(request);
    const current = await getWorkingConfiguration(context);
    return {
      data: await saveRules(context, principal, {
        revisionNumber: body.revisionNumber,
        rules: current.rules.filter((rule) => rule.scoringRuleId !== itemId),
      }, env),
    };
  }
  if (request.method === "POST" && action === "preview") {
    const context = await getContext(principal, leagueId, env, true);
    return { data: await previewDraft(context, await readJson<ScoringPreviewRequest>(request)) };
  }
  if (request.method === "POST" && action === "apply") {
    const context = await getContext(principal, leagueId, env, true);
    return {
      data: await applyDraft(
        context,
        principal,
        await readJson<ApplyScoringDraftRequest>(request),
        env,
        ctx,
        correlationId,
      ),
    };
  }
  return undefined;
}

async function getContext(
  principal: AccessTokenPrincipal,
  leagueId: string,
  env: Env,
  commissionerOnly: boolean,
): Promise<SeasonContext> {
  const access = await requireLeagueRole(
    principal,
    leagueId,
    env,
    [...(commissionerOnly ? commissionerRoles : allLeagueRoles)],
  );
  const league = await getLeagueRow(access.db, leagueId);
  return {
    db: access.db,
    leagueId,
    seasonId: league.league_season_id,
    seasonYear: league.season_year,
    role: access.role,
  };
}

async function getCatalog(db: D1Database): Promise<ScoringCatalogResponse> {
  const [presetResult, statisticResult] = await Promise.all([
    db.prepare(
      `select preset_key, display_name, description from scoring_presets
       where active = 1 order by display_order`,
    ).all<{ preset_key: ScoringPresetSummaryRow["preset_key"]; display_name: string; description: string }>(),
    db.prepare(
      `select statistic_key, display_name, description, category, unit_label,
              default_calculation_type, allowed_calculation_types_json,
              allowed_positions_json, display_order
       from scoring_statistic_definitions where active = 1 order by display_order`,
    ).all<StatisticRow>(),
  ]);
  return {
    presets: (presetResult.results ?? []).map((row) => ({
      presetKey: row.preset_key,
      displayName: row.display_name,
      description: row.description,
    })),
    statistics: (statisticResult.results ?? []).map(statisticFromRow),
  };
}

interface ScoringPresetSummaryRow {
  preset_key: "standard" | "half-ppr" | "full-ppr" | "superflex" | "te-premium" | "idp";
}

interface StatisticRow {
  statistic_key: string;
  display_name: string;
  description: string;
  category: string;
  unit_label: string;
  default_calculation_type: ScoringCalculationType;
  allowed_calculation_types_json: string;
  allowed_positions_json: string;
  display_order: number;
}

function statisticFromRow(row: StatisticRow): ScoringStatisticDefinition {
  return {
    statisticKey: row.statistic_key,
    displayName: row.display_name,
    description: row.description,
    category: row.category,
    unitLabel: row.unit_label,
    defaultCalculationType: row.default_calculation_type,
    allowedCalculationTypes: parseJsonArray<ScoringCalculationType>(row.allowed_calculation_types_json),
    allowedPositions: parseJsonArray<string>(row.allowed_positions_json),
    displayOrder: row.display_order,
  };
}

async function ensureCurrentConfiguration(
  context: SeasonContext,
  principal: AccessTokenPrincipal,
  env: Env,
): Promise<void> {
  await ensureSeasonScoringConfiguration(
    context.db,
    context.leagueId,
    context.seasonId,
    principal.userId,
    env,
  );
}

export async function ensureSeasonScoringConfiguration(
  db: D1Database,
  leagueId: string,
  seasonId: string,
  userId: string,
  env: Env,
): Promise<void> {
  const season = await db.prepare(
    "select scoring_version_id from league_seasons where league_season_id = ?1",
  ).bind(seasonId).first<{ scoring_version_id: string | null }>();
  if (season?.scoring_version_id) return;

  const setting = await db.prepare(
    "select value_json from league_settings where league_id = ?1 and setting_key = 'scoring_preset'",
  ).bind(leagueId).first<{ value_json: string }>();
  const presetKey = normalizePresetKey(setting ? JSON.parse(setting.value_json) : "standard");
  const presetRules = await getPresetRules(env.NFL_DB, presetKey);
  const now = new Date().toISOString();
  const versionId = newId("scv");
  const statements = configurationInsertStatements(
    db,
    versionId,
    seasonId,
    1,
    "active",
    presetKey,
    userId,
    now,
    presetRules.map((row) => ruleFromRow(row)),
    true,
  );
  statements.push(
    db.prepare(
      "update league_seasons set scoring_version_id = ?1, updated_at_utc = ?2 where league_season_id = ?3 and scoring_version_id is null",
    ).bind(versionId, now, seasonId),
  );
  try {
    await db.batch(statements);
  } catch (error) {
    const existing = await db.prepare(
      "select scoring_version_id from league_seasons where league_season_id = ?1",
    ).bind(seasonId).first<{ scoring_version_id: string | null }>();
    if (!existing?.scoring_version_id) throw error;
  }
}

async function getPresetRules(db: D1Database, presetKey: string): Promise<PresetRuleRow[]> {
  const result = await db.prepare(
    `select preset.preset_key, '' as scoring_rule_id, '' as scoring_version_id,
            preset.statistic_key, preset.enabled, preset.calculation_type,
            preset.point_value_milli, preset.increment_value, preset.threshold_value,
            preset.positions_json as position_filter, preset.max_awards, preset.display_order,
            definition.display_name, definition.description, definition.category,
            preset.positions_json, preset.tiers_json
     from scoring_preset_rules preset
     join scoring_statistic_definitions definition on definition.statistic_key = preset.statistic_key
     where preset.preset_key = ?1 order by preset.display_order`,
  ).bind(presetKey).all<PresetRuleRow>();
  const rows = result.results ?? [];
  if (!rows.length) throw new ApiException(400, "invalid_scoring_preset", "Choose a supported scoring preset.");
  return rows;
}

async function getWorkingConfiguration(context: SeasonContext): Promise<ScoringConfiguration> {
  if (context.role !== "manager") {
    const draft = await context.db.prepare(
      `${versionSelect()} where versions.league_season_id = ?1 and versions.status = 'draft'
       order by versions.version_number desc limit 1`,
    ).bind(context.seasonId).first<VersionRow>();
    if (draft) return configurationFromRow(context, draft, await getRules(context.db, draft.scoring_version_id));
  }

  const active = await context.db.prepare(
    `${versionSelect()} where versions.league_season_id = ?1 and versions.status = 'active'
     order by versions.version_number desc limit 1`,
  ).bind(context.seasonId).first<VersionRow>();
  if (!active) throw new ApiException(409, "scoring_not_initialized", "Scoring has not been initialized for this season.");
  return configurationFromRow(context, active, await getRules(context.db, active.scoring_version_id));
}

async function getConfigurationById(context: SeasonContext, versionId: string): Promise<ScoringConfiguration> {
  const row = await context.db.prepare(
    `${versionSelect()} where versions.league_season_id = ?1 and versions.scoring_version_id = ?2 limit 1`,
  ).bind(context.seasonId, versionId).first<VersionRow>();
  if (!row) throw new ApiException(404, "scoring_version_not_found", "Scoring version not found.");
  return configurationFromRow(context, row, await getRules(context.db, versionId));
}

async function listVersions(context: SeasonContext): Promise<ScoringVersionSummary[]> {
  const result = await context.db.prepare(
    `${versionSelect()} where versions.league_season_id = ?1 order by versions.version_number desc`,
  ).bind(context.seasonId).all<VersionRow>();
  return (result.results ?? []).map(versionFromRow);
}

function versionSelect(): string {
  return `select versions.scoring_version_id, versions.league_season_id, versions.version_number,
                 versions.status, versions.effective_at_utc, versions.created_by_user_id,
                 versions.created_at_utc, details.source_preset_key, details.revision_number,
                 details.effective_scope, details.effective_from_week, details.effective_to_week,
                 details.change_reason, details.is_current, details.applied_at_utc
          from scoring_versions versions
          join scoring_version_details details on details.scoring_version_id = versions.scoring_version_id`;
}

async function getRules(db: D1Database, versionId: string): Promise<ScoringRule[]> {
  const result = await db.prepare(
    `select rules.scoring_rule_id, rules.scoring_version_id, rules.statistic_key,
            rules.enabled, rules.calculation_type, rules.point_value_milli,
            rules.increment_value, rules.threshold_value, rules.position_filter,
            rules.max_awards, rules.display_order, details.display_name,
            details.description, details.category, details.positions_json, details.tiers_json
     from scoring_rules rules
     join scoring_rule_details details on details.scoring_rule_id = rules.scoring_rule_id
     where rules.scoring_version_id = ?1 order by rules.display_order`,
  ).bind(versionId).all<RuleRow>();
  return (result.results ?? []).map(ruleFromRow);
}

async function startDraft(
  context: SeasonContext,
  principal: AccessTokenPrincipal,
  body: StartScoringDraftRequest,
  env: Env,
): Promise<ScoringConfiguration> {
  await ensureCurrentConfiguration(context, principal, env);
  if (body.source !== "current" && body.source !== "preset") {
    throw new ApiException(400, "invalid_draft_source", "Choose the current rules or a preset as the draft starting point.");
  }
  let sourcePresetKey: ScoringVersionSummary["sourcePresetKey"];
  let rules: ScoringRule[];
  if (body.source === "preset") {
    sourcePresetKey = normalizePresetKey(body.presetKey);
    rules = (await getPresetRules(env.NFL_DB, sourcePresetKey)).map(ruleFromRow);
  } else {
    const active = await getActiveConfiguration(context);
    sourcePresetKey = active.sourcePresetKey;
    rules = active.rules;
  }

  const maximum = await context.db.prepare(
    "select coalesce(max(version_number), 0) as version_number from scoring_versions where league_season_id = ?1",
  ).bind(context.seasonId).first<{ version_number: number }>();
  const versionId = newId("scv");
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    context.db.prepare(
      "update scoring_versions set status = 'abandoned' where league_season_id = ?1 and status = 'draft'",
    ).bind(context.seasonId),
    ...configurationInsertStatements(
      context.db,
      versionId,
      context.seasonId,
      (maximum?.version_number ?? 0) + 1,
      "draft",
      sourcePresetKey,
      principal.userId,
      now,
      rules,
      false,
    ),
  ];
  await context.db.batch(statements);
  return getConfigurationById(context, versionId);
}

async function saveRules(
  context: SeasonContext,
  principal: AccessTokenPrincipal,
  body: SaveScoringRulesRequest,
  env: Env,
): Promise<ScoringConfiguration> {
  if (!Number.isInteger(body.revisionNumber) || body.revisionNumber < 1) {
    throw new ApiException(400, "invalid_revision", "A valid scoring revision is required.");
  }
  if (!Array.isArray(body.rules) || body.rules.length < 1 || body.rules.length > 100) {
    throw new ApiException(400, "invalid_scoring_rules", "Scoring must contain between 1 and 100 rules.");
  }
  const draft = await requireDraft(context);
  if (draft.revision_number !== body.revisionNumber) {
    throw new ApiException(409, "scoring_revision_conflict", "Scoring changed in another session. Reload before saving.", {
      currentRevisionNumber: draft.revision_number,
    });
  }
  const catalog = await getCatalog(env.NFL_DB);
  const definitions = new Map(catalog.statistics.map((definition) => [definition.statisticKey, definition]));
  const seen = new Set<string>();
  const rules = body.rules.map((rule, index) => validateRule(rule, definitions, seen, index));
  const previous = await getRules(context.db, draft.scoring_version_id);
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    context.db.prepare("delete from scoring_rule_details where scoring_rule_id in (select scoring_rule_id from scoring_rules where scoring_version_id = ?1)").bind(draft.scoring_version_id),
    context.db.prepare("delete from scoring_rules where scoring_version_id = ?1").bind(draft.scoring_version_id),
    context.db.prepare(
      "update scoring_version_details set revision_number = revision_number + 1, source_preset_key = null where scoring_version_id = ?1 and revision_number = ?2",
    ).bind(draft.scoring_version_id, body.revisionNumber),
  ];
  for (const rule of rules) {
    const ruleId = rule.scoringRuleId || newId("scr");
    statements.push(...ruleInsertStatements(context.db, draft.scoring_version_id, { ...rule, scoringRuleId: ruleId }));
    statements.push(context.db.prepare(
      `insert into scoring_rule_history (
        scoring_rule_history_id, scoring_version_id, scoring_rule_id, actor_user_id,
        action, before_json, after_json, created_at_utc
      ) values (?1, ?2, ?3, ?4, 'saved', ?5, ?6, ?7)`,
    ).bind(
      newId("srh"), draft.scoring_version_id, ruleId, principal.userId,
      JSON.stringify(previous.find((item) => item.statisticKey === rule.statisticKey) ?? null),
      JSON.stringify(rule), now,
    ));
  }
  await context.db.batch(statements);
  return getConfigurationById(context, draft.scoring_version_id);
}

async function previewDraft(
  context: SeasonContext,
  body: ScoringPreviewRequest,
): Promise<ScoringPreviewResponse> {
  const draft = await requireDraft(context);
  requireMatchingRevision(draft, body.revisionNumber);
  const scope = requireEffectiveScope(body.effectiveScope);
  const [active, proposed, schedule] = await Promise.all([
    getActiveConfiguration(context),
    getConfigurationById(context, draft.scoring_version_id),
    context.db.prepare(
      "select regular_season_start_week, playoff_start_week, playoff_round_length from schedule_settings where league_season_id = ?1",
    ).bind(context.seasonId).first<{ regular_season_start_week: number; playoff_start_week: number; playoff_round_length: number }>(),
  ]);
  const lastWeek = Math.min(18, (schedule?.playoff_start_week ?? 15) + ((schedule?.playoff_round_length ?? 1) * 3) - 1);
  const affectedWeeks = calculateAffectedWeeks(scope, body.effectiveFromWeek, body.effectiveToWeek, schedule?.regular_season_start_week ?? 1, lastWeek);
  const differences = compareRules(active.rules, proposed.rules);
  return {
    currentVersionNumber: active.versionNumber,
    proposedVersionNumber: proposed.versionNumber,
    effectiveScope: scope,
    affectedWeeks,
    changedRuleCount: differences.length,
    differences,
    recalculationRequired: scope === "retroactive-current-season" || scope === "entire-season",
    sampleStatus: "Player and matchup examples will appear once weekly NFL statistics and league matchups are available.",
  };
}

async function applyDraft(
  context: SeasonContext,
  principal: AccessTokenPrincipal,
  body: ApplyScoringDraftRequest,
  env: Env,
  ctx: ExecutionContext,
  correlationId: string,
): Promise<ScoringConfiguration> {
  const preview = await previewDraft(context, body);
  const draft = await requireDraft(context);
  const reason = String(body.changeReason ?? "").trim();
  if (reason.length < 3 || reason.length > 300) {
    throw new ApiException(400, "invalid_change_reason", "Describe the scoring change in 3 to 300 characters.");
  }
  const now = new Date().toISOString();
  const sourceValue = draft.source_preset_key ? JSON.stringify(draft.source_preset_key) : JSON.stringify("custom");
  await context.db.batch([
    context.db.prepare(
      "update scoring_versions set status = 'superseded' where league_season_id = ?1 and status = 'active'",
    ).bind(context.seasonId),
    context.db.prepare(
      "update scoring_version_details set is_current = 0 where scoring_version_id in (select scoring_version_id from scoring_versions where league_season_id = ?1)",
    ).bind(context.seasonId),
    context.db.prepare(
      "update scoring_versions set status = 'active', effective_at_utc = ?1 where scoring_version_id = ?2 and status = 'draft'",
    ).bind(now, draft.scoring_version_id),
    context.db.prepare(
      `update scoring_version_details
       set is_current = 1, effective_scope = ?1, effective_from_week = ?2,
           effective_to_week = ?3, change_reason = ?4, applied_at_utc = ?5,
           revision_number = revision_number + 1
       where scoring_version_id = ?6 and revision_number = ?7`,
    ).bind(
      preview.effectiveScope,
      body.effectiveFromWeek ?? null,
      body.effectiveToWeek ?? null,
      reason,
      now,
      draft.scoring_version_id,
      body.revisionNumber,
    ),
    context.db.prepare(
      "update league_seasons set scoring_version_id = ?1, revision_number = revision_number + 1, updated_at_utc = ?2 where league_season_id = ?3",
    ).bind(draft.scoring_version_id, now, context.seasonId),
    context.db.prepare(
      "update league_settings set value_json = ?1, revision_number = revision_number + 1, updated_by_user_id = ?2, updated_at_utc = ?3 where league_id = ?4 and setting_key = 'scoring_preset'",
    ).bind(sourceValue, principal.userId, now, context.leagueId),
    context.db.prepare(
      `insert into league_audit_events (
        league_audit_event_id, league_id, actor_user_id, action, entity_type,
        entity_id, correlation_id, created_at_utc, metadata_json
      ) values (?1, ?2, ?3, 'scoring.applied', 'scoring_version', ?4, ?5, ?6, ?7)`,
    ).bind(newId("lae"), context.leagueId, principal.userId, draft.scoring_version_id, correlationId, now, JSON.stringify({ reason, preview })),
    context.db.prepare(
      `insert into league_activity (
        league_activity_id, league_id, actor_user_id, activity_type, message,
        created_at_utc, metadata_json
      ) values (?1, ?2, ?3, 'scoring.applied', ?4, ?5, ?6)`,
    ).bind(newId("lac"), context.leagueId, principal.userId, `Scoring version ${draft.version_number} was applied.`, now, JSON.stringify({ reason })),
  ]);

  ctx.waitUntil(env.SCORING_QUEUE.send({
    type: "scoring.configuration.applied",
    leagueId: context.leagueId,
    seasonId: context.seasonId,
    scoringVersionId: draft.scoring_version_id,
    effectiveScope: preview.effectiveScope,
    affectedWeeks: preview.affectedWeeks,
    recalculationRequired: preview.recalculationRequired,
    requestedAtUtc: now,
  }));
  return getConfigurationById(context, draft.scoring_version_id);
}

async function getActiveConfiguration(context: SeasonContext): Promise<ScoringConfiguration> {
  const row = await context.db.prepare(
    `${versionSelect()} where versions.league_season_id = ?1 and versions.status = 'active'
     order by versions.version_number desc limit 1`,
  ).bind(context.seasonId).first<VersionRow>();
  if (!row) throw new ApiException(409, "active_scoring_not_found", "No active scoring version exists for this season.");
  return configurationFromRow(context, row, await getRules(context.db, row.scoring_version_id));
}

async function requireDraft(context: SeasonContext): Promise<VersionRow> {
  const row = await context.db.prepare(
    `${versionSelect()} where versions.league_season_id = ?1 and versions.status = 'draft'
     order by versions.version_number desc limit 1`,
  ).bind(context.seasonId).first<VersionRow>();
  if (!row) throw new ApiException(409, "scoring_draft_required", "Create a scoring draft before making changes.");
  return row;
}

function requireMatchingRevision(row: VersionRow, revisionNumber: number): void {
  if (!Number.isInteger(revisionNumber) || row.revision_number !== revisionNumber) {
    throw new ApiException(409, "scoring_revision_conflict", "Scoring changed in another session. Reload before continuing.", {
      currentRevisionNumber: row.revision_number,
    });
  }
}

function configurationInsertStatements(
  db: D1Database,
  versionId: string,
  seasonId: string,
  versionNumber: number,
  status: "draft" | "active",
  sourcePresetKey: ScoringVersionSummary["sourcePresetKey"],
  userId: string,
  now: string,
  rules: ScoringRule[],
  isCurrent: boolean,
): D1PreparedStatement[] {
  const statements = [
    db.prepare(
      `insert into scoring_versions (
        scoring_version_id, league_season_id, version_number, status,
        effective_at_utc, created_by_user_id, created_at_utc
      ) values (?1, ?2, ?3, ?4, ?5, ?6, ?5)`,
    ).bind(versionId, seasonId, versionNumber, status, now, userId),
    db.prepare(
      `insert into scoring_version_details (
        scoring_version_id, source_preset_key, revision_number, effective_scope,
        effective_from_week, effective_to_week, change_reason, is_current, applied_at_utc
      ) values (?1, ?2, 1, null, null, null, null, ?3, ?4)`,
    ).bind(versionId, sourcePresetKey ?? null, isCurrent ? 1 : 0, isCurrent ? now : null),
  ];
  for (const rule of rules) {
    statements.push(...ruleInsertStatements(db, versionId, { ...rule, scoringRuleId: newId("scr") }));
  }
  return statements;
}

function ruleInsertStatements(db: D1Database, versionId: string, rule: ScoringRule): D1PreparedStatement[] {
  return [
    db.prepare(
      `insert into scoring_rules (
        scoring_rule_id, scoring_version_id, statistic_key, enabled, calculation_type,
        point_value_milli, increment_value, threshold_value, position_filter,
        max_awards, display_order
      ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
    ).bind(
      rule.scoringRuleId,
      versionId,
      rule.statisticKey,
      rule.enabled ? 1 : 0,
      rule.calculationType,
      parsePointValueMilli(rule.pointValue),
      rule.incrementValue ?? null,
      rule.thresholdValue ?? null,
      JSON.stringify(rule.positions),
      rule.maxAwards ?? null,
      rule.displayOrder,
    ),
    db.prepare(
      `insert into scoring_rule_details (
        scoring_rule_id, display_name, description, category, positions_json,
        tiers_json, minimum_value, condition_json
      ) values (?1, ?2, ?3, ?4, ?5, ?6, null, '{}')`,
    ).bind(
      rule.scoringRuleId,
      rule.displayName,
      rule.description,
      rule.category,
      JSON.stringify(rule.positions),
      JSON.stringify(rule.tiers),
    ),
  ];
}

function validateRule(
  raw: ScoringRule,
  definitions: Map<string, ScoringStatisticDefinition>,
  seen: Set<string>,
  index: number,
): ScoringRule {
  const definition = definitions.get(String(raw.statisticKey));
  if (!definition || seen.has(definition.statisticKey)) {
    throw new ApiException(400, "invalid_scoring_rule", "Each scoring statistic must be valid and appear only once.");
  }
  seen.add(definition.statisticKey);
  if (!calculationTypes.has(raw.calculationType) || !definition.allowedCalculationTypes.includes(raw.calculationType)) {
    throw new ApiException(400, "invalid_calculation_type", `${definition.displayName} does not support that calculation type.`);
  }
  parsePointValueMilli(raw.pointValue);
  const positions = Array.isArray(raw.positions)
    ? raw.positions.filter((position): position is string => typeof position === "string" && definition.allowedPositions.includes(position))
    : [];
  const tiers = Array.isArray(raw.tiers) ? raw.tiers.slice(0, 20).map((tier) => ({
    minimum: requireDecimal(tier.minimum, "Tier minimum"),
    maximum: tier.maximum === undefined ? undefined : requireDecimal(tier.maximum, "Tier maximum"),
    points: milliToPointValue(parsePointValueMilli(tier.points)),
  })) : [];
  return {
    scoringRuleId: typeof raw.scoringRuleId === "string" ? raw.scoringRuleId : "",
    statisticKey: definition.statisticKey,
    displayName: definition.displayName,
    description: definition.description,
    category: definition.category,
    enabled: Boolean(raw.enabled),
    calculationType: raw.calculationType,
    pointValue: milliToPointValue(parsePointValueMilli(raw.pointValue)),
    incrementValue: raw.incrementValue === undefined ? undefined : requireDecimal(raw.incrementValue, "Increment"),
    thresholdValue: raw.thresholdValue === undefined ? undefined : requireDecimal(raw.thresholdValue, "Threshold"),
    positions,
    maxAwards: raw.maxAwards === undefined ? undefined : requireOptionalInteger(raw.maxAwards),
    tiers,
    displayOrder: index + 1,
  };
}

export function parsePointValueMilli(value: unknown): number {
  const normalized = requireDecimal(value, "Point value");
  const amount = Number(normalized);
  if (amount < -1000 || amount > 1000) {
    throw new ApiException(400, "invalid_point_value", "Point values must be between -1000 and 1000.");
  }
  return Math.round(amount * 1000);
}

function requireDecimal(value: unknown, label: string): string {
  const normalized = String(value ?? "").trim();
  if (!/^-?\d{1,7}(?:\.\d{1,3})?$/.test(normalized)) {
    throw new ApiException(400, "invalid_decimal", `${label} must be a number with no more than three decimal places.`);
  }
  return normalized;
}

function requireOptionalInteger(value: unknown): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 1000) {
    throw new ApiException(400, "invalid_max_awards", "Maximum awards must be between 1 and 1000.");
  }
  return number;
}

function requireEffectiveScope(value: unknown): ScoringEffectiveScope {
  if (!effectiveScopes.has(value as ScoringEffectiveScope)) {
    throw new ApiException(400, "invalid_effective_scope", "Choose when the scoring changes should take effect.");
  }
  return value as ScoringEffectiveScope;
}

export function calculateAffectedWeeks(
  scope: ScoringEffectiveScope,
  fromWeek: number | undefined,
  toWeek: number | undefined,
  firstWeek = 1,
  lastWeek = 18,
): number[] {
  if (scope === "next-season") return [];
  let start = scope === "entire-season" || scope === "retroactive-current-season" ? firstWeek : (fromWeek ?? firstWeek);
  let end = scope === "next-week" ? start : (scope === "selected-future-weeks" ? (toWeek ?? start) : lastWeek);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < firstWeek || end > lastWeek || start > end) {
    throw new ApiException(400, "invalid_effective_weeks", `Choose weeks between ${firstWeek} and ${lastWeek}.`);
  }
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

export function compareRules(current: ScoringRule[], proposed: ScoringRule[]): ScoringRuleDifference[] {
  const currentMap = new Map(current.map((rule) => [rule.statisticKey, rule]));
  const proposedMap = new Map(proposed.map((rule) => [rule.statisticKey, rule]));
  const keys = new Set([...currentMap.keys(), ...proposedMap.keys()]);
  const differences: ScoringRuleDifference[] = [];
  for (const key of keys) {
    const before = currentMap.get(key);
    const after = proposedMap.get(key);
    if (!before && after) {
      differences.push({ statisticKey: key, displayName: after.displayName, change: "added", proposedValue: describeRule(after) });
    } else if (before && !after) {
      differences.push({ statisticKey: key, displayName: before.displayName, change: "removed", currentValue: describeRule(before) });
    } else if (before && after && comparableRule(before) !== comparableRule(after)) {
      differences.push({ statisticKey: key, displayName: after.displayName, change: "changed", currentValue: describeRule(before), proposedValue: describeRule(after) });
    }
  }
  return differences;
}

function describeRule(rule: ScoringRule): string {
  return rule.enabled ? `${rule.pointValue} points (${rule.calculationType.replaceAll("-", " ")})` : "Disabled";
}

function comparableRule(rule: ScoringRule): string {
  return JSON.stringify({
    enabled: rule.enabled,
    calculationType: rule.calculationType,
    pointValue: rule.pointValue,
    incrementValue: rule.incrementValue,
    thresholdValue: rule.thresholdValue,
    positions: rule.positions,
    maxAwards: rule.maxAwards,
    tiers: rule.tiers,
  });
}

function configurationFromRow(context: SeasonContext, row: VersionRow, rules: ScoringRule[]): ScoringConfiguration {
  return {
    leagueId: context.leagueId,
    seasonId: context.seasonId,
    seasonYear: context.seasonYear,
    ...versionFromRow(row),
    rules,
  };
}

function versionFromRow(row: VersionRow): ScoringVersionSummary {
  return {
    scoringVersionId: row.scoring_version_id,
    versionNumber: row.version_number,
    status: row.status,
    sourcePresetKey: row.source_preset_key ?? undefined,
    revisionNumber: row.revision_number,
    effectiveScope: row.effective_scope ?? undefined,
    effectiveFromWeek: row.effective_from_week ?? undefined,
    effectiveToWeek: row.effective_to_week ?? undefined,
    changeReason: row.change_reason ?? undefined,
    createdByUserId: row.created_by_user_id,
    createdAtUtc: row.created_at_utc,
    appliedAtUtc: row.applied_at_utc ?? undefined,
  };
}

function ruleFromRow(row: RuleRow): ScoringRule {
  return {
    scoringRuleId: row.scoring_rule_id,
    statisticKey: row.statistic_key,
    displayName: row.display_name,
    description: row.description,
    category: row.category,
    enabled: Boolean(row.enabled),
    calculationType: row.calculation_type,
    pointValue: milliToPointValue(row.point_value_milli),
    incrementValue: row.increment_value ?? undefined,
    thresholdValue: row.threshold_value ?? undefined,
    positions: parseJsonArray<string>(row.positions_json || row.position_filter || "[]"),
    maxAwards: row.max_awards ?? undefined,
    tiers: parseJsonArray<{ minimum: string; maximum?: string; points: string }>(row.tiers_json),
    displayOrder: row.display_order,
  };
}

function milliToPointValue(value: number): string {
  const result = (value / 1000).toFixed(3).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
  return result === "-0" ? "0" : result;
}

function parseJsonArray<T>(value: string): T[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function normalizePresetKey(value: unknown): ScoringPresetKey {
  const key = String(value ?? "");
  if (!["standard", "half-ppr", "full-ppr", "superflex", "te-premium", "idp"].includes(key)) {
    throw new ApiException(400, "invalid_scoring_preset", "Choose a supported scoring preset.");
  }
  return key as ScoringPresetKey;
}
