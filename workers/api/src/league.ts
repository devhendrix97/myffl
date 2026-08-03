import type {
  CreateLeagueRequest,
  CreateLeagueResponse,
  CursorPage,
  JoinLeagueRequest,
  JoinLeagueResponse,
  LeagueDetail,
  LeagueFormat,
  LeagueInvitationResponse,
  LeagueMemberView,
  LeaguePrivacy,
  LeagueRole,
  LeagueScheduleInput,
  LeagueStatus,
  LeagueSummary,
  RosterSlotInput,
  UpdateLeagueSettingsRequest,
} from "@myffl/api-contracts";
import { authenticate, type HandlerResult } from "./auth";
import { ApiException, readJson } from "./http";
import { newId, sha256Base64Url, type AccessTokenPrincipal } from "./security";

const invitationAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const invitationLifetimeMs = 30 * 24 * 60 * 60 * 1000;
const supportedShardBinding = "LEAGUE_DB_001";

interface DirectoryRow {
  league_id: string;
  league_name: string;
  current_season_id: string;
  shard_binding_name: string;
  league_status: LeagueStatus;
  privacy: LeaguePrivacy;
  season_year: number;
  max_teams: number;
  member_count: number;
  revision_number: number;
  role: LeagueRole;
  fantasy_team_id: string | null;
  joined_at_utc: string;
}

interface LeagueRow {
  league_id: string;
  league_name: string;
  description: string | null;
  privacy: LeaguePrivacy;
  league_format: LeagueFormat;
  time_zone: string;
  max_teams: number;
  commissioner_user_id: string;
  maintenance_mode: number;
  archived_at_utc: string | null;
  revision_number: number;
  league_season_id: string;
  season_year: number;
}

interface MembershipRow {
  league_member_id: string;
  user_id: string;
  role: LeagueRole;
  joined_at_utc: string;
  fantasy_team_id: string | null;
  team_name: string | null;
}

export async function handleLeagueRequest(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
  correlationId: string,
): Promise<HandlerResult<unknown> | undefined> {
  if (!url.pathname.startsWith("/api/leagues")) return undefined;
  const principal = await authenticate(request, env);

  if (request.method === "GET" && url.pathname === "/api/leagues") {
    return listLeagues(principal, url, env);
  }
  if (request.method === "POST" && url.pathname === "/api/leagues") {
    return createLeague(
      principal,
      await readJson<CreateLeagueRequest>(request),
      env,
      ctx,
      correlationId,
    );
  }
  if (request.method === "POST" && url.pathname === "/api/leagues/join") {
    return joinLeague(
      principal,
      await readJson<JoinLeagueRequest>(request),
      env,
      ctx,
      correlationId,
    );
  }

  const match = url.pathname.match(/^\/api\/leagues\/([^/]+)(?:\/(settings|invitations|archive|restore))?$/);
  if (!match) return undefined;
  const leagueId = match[1];
  const action = match[2];

  if (request.method === "GET" && !action) {
    return { data: await getLeagueDetail(principal, leagueId, env) };
  }
  if (request.method === "PATCH" && action === "settings") {
    return updateLeagueSettings(
      principal,
      leagueId,
      await readJson<UpdateLeagueSettingsRequest>(request),
      env,
      ctx,
      correlationId,
    );
  }
  if (request.method === "POST" && action === "invitations") {
    return createInvitation(principal, leagueId, env, ctx, correlationId);
  }
  if (request.method === "POST" && (action === "archive" || action === "restore")) {
    const body = await readJson<{ revisionNumber: number }>(request);
    return setLeagueArchived(
      principal,
      leagueId,
      action === "archive",
      body.revisionNumber,
      env,
      ctx,
      correlationId,
    );
  }
  return undefined;
}

async function listLeagues(
  principal: AccessTokenPrincipal,
  url: URL,
  env: Env,
): Promise<HandlerResult<CursorPage<LeagueSummary>>> {
  const limit = parseLimit(url.searchParams.get("limit"));
  const cursor = decodeCursor(url.searchParams.get("cursor"));
  const whereCursor = cursor
    ? "and (membership.joined_at_utc < ?2 or (membership.joined_at_utc = ?2 and membership.league_id < ?3))"
    : "";
  const statement = env.CORE_DB.prepare(
    `select directory.league_id, directory.league_name, directory.current_season_id,
            directory.shard_binding_name, directory.league_status, directory.privacy,
            directory.season_year, directory.max_teams, directory.member_count,
            directory.revision_number, membership.role, membership.fantasy_team_id,
            membership.joined_at_utc
     from user_league_directory membership
     join league_directory directory on directory.league_id = membership.league_id
     where membership.user_id = ?1 and membership.removed_at_utc is null
       ${whereCursor}
     order by membership.joined_at_utc desc, membership.league_id desc
     limit ?${cursor ? 4 : 2}`,
  );
  const result = cursor
    ? await statement.bind(principal.userId, cursor.joinedAtUtc, cursor.leagueId, limit + 1).all<DirectoryRow>()
    : await statement.bind(principal.userId, limit + 1).all<DirectoryRow>();
  const rows = result.results ?? [];
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    data: {
      items: page.map(directoryToSummary),
      nextCursor: hasMore && last ? encodeCursor(last.joined_at_utc, last.league_id) : undefined,
    },
  };
}

async function createLeague(
  principal: AccessTokenPrincipal,
  rawBody: CreateLeagueRequest,
  env: Env,
  ctx: ExecutionContext,
  correlationId: string,
): Promise<HandlerResult<CreateLeagueResponse>> {
  const body = validateCreateLeagueRequest(rawBody);
  const replay = await env.CORE_DB.prepare(
    "select response_json from league_creation_requests where request_id = ?1 and user_id = ?2",
  ).bind(body.requestId, principal.userId).first<{ response_json: string }>();
  if (replay) return { status: 200, data: JSON.parse(replay.response_json) as CreateLeagueResponse };

  const shard = await selectShard(env);
  const db = getShardDatabase(env, shard.binding_name);
  const now = new Date();
  const nowIso = now.toISOString();
  const leagueId = newId("lg");
  const seasonId = newId("lgs");
  const memberId = newId("lgm");
  const teamId = newId("ftm");
  const teamSeasonId = newId("fts");
  const teamManagerId = newId("ftg");
  const invitationId = newId("lgi");
  const invitationCode = newInvitationCode();
  const invitationHash = await sha256Base64Url(normalizeInvitationCode(invitationCode));
  const invitationExpiresAt = new Date(now.getTime() + invitationLifetimeMs).toISOString();
  const rosterDefinitionId = newId("rsd");
  const scheduleId = newId("sch");

  const statements: D1PreparedStatement[] = [
    db.prepare(
      `insert into leagues (
        league_id, league_name, description, privacy, created_at_utc, updated_at_utc,
        archived_at_utc, revision_number, league_format, time_zone, max_teams,
        commissioner_user_id, maintenance_mode
      ) values (?1, ?2, ?3, ?4, ?5, ?5, null, 1, ?6, ?7, ?8, ?9, 0)`,
    ).bind(
      leagueId, body.leagueName, body.description, body.privacy, nowIso,
      body.format, body.timeZone, body.teamCount, principal.userId,
    ),
    db.prepare(
      `insert into league_seasons (
        league_season_id, league_id, season_year, status, scoring_version_id,
        created_at_utc, updated_at_utc, regular_season_weeks,
        playoff_team_count, playoff_start_week, revision_number
      ) values (?1, ?2, ?3, 'setup', null, ?4, ?4, ?5, ?6, ?7, 1)`,
    ).bind(
      seasonId, leagueId, body.seasonYear, nowIso,
      body.schedule.regularSeasonEndWeek - body.schedule.regularSeasonStartWeek + 1,
      body.schedule.playoffTeamCount,
      body.schedule.playoffStartWeek,
    ),
    db.prepare(
      `insert into league_members (
        league_member_id, league_id, user_id, role, joined_at_utc, removed_at_utc,
        status, invited_by_user_id, updated_at_utc, revision_number
      ) values (?1, ?2, ?3, 'commissioner', ?4, null, 'active', null, ?4, 1)`,
    ).bind(memberId, leagueId, principal.userId, nowIso),
    db.prepare(
      `insert into fantasy_teams (
        fantasy_team_id, league_season_id, manager_user_id, team_name,
        created_at_utc, updated_at_utc, abbreviation, revision_number
      ) values (?1, ?2, ?3, ?4, ?5, ?5, ?6, 1)`,
    ).bind(teamId, seasonId, principal.userId, body.commissionerTeamName, nowIso, teamAbbreviation(body.commissionerTeamName)),
    db.prepare(
      `insert into fantasy_team_seasons (
        fantasy_team_season_id, fantasy_team_id, league_season_id, status, created_at_utc
      ) values (?1, ?2, ?3, 'active', ?4)`,
    ).bind(teamSeasonId, teamId, seasonId, nowIso),
    db.prepare(
      `insert into fantasy_team_managers (
        fantasy_team_manager_id, fantasy_team_id, user_id, manager_role,
        assigned_at_utc, removed_at_utc
      ) values (?1, ?2, ?3, 'primary', ?4, null)`,
    ).bind(teamManagerId, teamId, principal.userId, nowIso),
    db.prepare(
      `insert into league_invitations (
        league_invitation_id, league_id, code_hash, created_by_user_id,
        created_at_utc, expires_at_utc, revoked_at_utc, max_uses, use_count
      ) values (?1, ?2, ?3, ?4, ?5, ?6, null, ?7, 0)`,
    ).bind(invitationId, leagueId, invitationHash, principal.userId, nowIso, invitationExpiresAt, body.teamCount - 1),
    db.prepare(
      `insert into league_settings (
        league_setting_id, league_id, setting_key, value_json, revision_number,
        updated_by_user_id, updated_at_utc
      ) values (?1, ?2, 'scoring_preset', ?3, 1, ?4, ?5)`,
    ).bind(newId("lst"), leagueId, JSON.stringify(body.scoringPreset), principal.userId, nowIso),
    db.prepare(
      `insert into roster_definitions (
        roster_definition_id, league_season_id, name, revision_number,
        created_at_utc, updated_at_utc
      ) values (?1, ?2, 'Active roster', 1, ?3, ?3)`,
    ).bind(rosterDefinitionId, seasonId, nowIso),
    db.prepare(
      `insert into schedule_settings (
        schedule_setting_id, league_season_id, regular_season_start_week,
        regular_season_end_week, schedule_method, rivalry_weeks_json,
        playoff_team_count, playoff_start_week, playoff_round_length, reseed,
        consolation_bracket, third_place_matchup, tiebreakers_json,
        revision_number, updated_at_utc
      ) values (?1, ?2, ?3, ?4, ?5, '[]', ?6, ?7, ?8, ?9, ?10, ?11,
                '["head-to-head","points-for"]', 1, ?12)`,
    ).bind(
      scheduleId, seasonId, body.schedule.regularSeasonStartWeek,
      body.schedule.regularSeasonEndWeek, body.schedule.scheduleMethod,
      body.schedule.playoffTeamCount, body.schedule.playoffStartWeek,
      body.schedule.playoffRoundLength, boolInt(body.schedule.reseed),
      boolInt(body.schedule.consolationBracket), boolInt(body.schedule.thirdPlaceMatchup), nowIso,
    ),
    leagueAuditStatement(db, leagueId, principal.userId, "league.created", "league", leagueId, correlationId, nowIso, body),
    leagueActivityStatement(db, leagueId, principal.userId, "league.created", `${principal.displayName} created the league.`, nowIso),
  ];
  statements.push(...rosterSlotStatements(db, rosterDefinitionId, body.rosterSlots));
  await db.batch(statements);

  const response = createResponseFromInput(
    body, principal, leagueId, seasonId, teamId, invitationCode,
    invitationLink(env, invitationCode), nowIso,
  );
  try {
    await env.CORE_DB.batch([
      env.CORE_DB.prepare(
        `insert into league_directory (
          league_id, league_name, current_season_id, shard_key, shard_binding_name,
          league_status, created_at_utc, archived_at_utc, revision_number,
          commissioner_user_id, privacy, season_year, max_teams, member_count, updated_at_utc
        ) values (?1, ?2, ?3, ?4, ?5, 'active', ?6, null, 1, ?7, ?8, ?9, ?10, 1, ?6)`,
      ).bind(
        leagueId, body.leagueName, seasonId, shard.shard_key, shard.binding_name,
        nowIso, principal.userId, body.privacy, body.seasonYear, body.teamCount,
      ),
      env.CORE_DB.prepare(
        `insert into user_league_directory (
          user_id, league_id, role, fantasy_team_id, joined_at_utc, removed_at_utc
        ) values (?1, ?2, 'commissioner', ?3, ?4, null)`,
      ).bind(principal.userId, leagueId, teamId, nowIso),
      env.CORE_DB.prepare(
        `insert into league_invitation_directory (
          invitation_id, league_id, code_hash, shard_binding_name,
          expires_at_utc, revoked_at_utc, created_at_utc
        ) values (?1, ?2, ?3, ?4, ?5, null, ?6)`,
      ).bind(invitationId, leagueId, invitationHash, shard.binding_name, invitationExpiresAt, nowIso),
      env.CORE_DB.prepare(
        `insert into league_creation_requests (
          request_id, user_id, league_id, response_json, created_at_utc
        ) values (?1, ?2, ?3, ?4, ?5)`,
      ).bind(body.requestId, principal.userId, leagueId, JSON.stringify(response), nowIso),
      env.CORE_DB.prepare(
        `update database_shards
         set league_count = league_count + 1, schema_version = max(schema_version, 2), updated_at_utc = ?1
         where binding_name = ?2`,
      ).bind(nowIso, shard.binding_name),
      coreAuditStatement(env.CORE_DB, principal.userId, "league.created", leagueId, correlationId, nowIso),
    ]);
  } catch (error) {
    await cleanupCreatedLeague(db, leagueId, seasonId);
    throw error;
  }
  queueLeagueAudit(ctx, env, principal.userId, "league.created", leagueId, correlationId);
  return { status: 201, data: response };
}

async function joinLeague(
  principal: AccessTokenPrincipal,
  rawBody: JoinLeagueRequest,
  env: Env,
  ctx: ExecutionContext,
  correlationId: string,
): Promise<HandlerResult<JoinLeagueResponse>> {
  const invitationCode = requireInvitationCode(rawBody.invitationCode);
  const teamName = requireTeamName(rawBody.teamName);
  const codeHash = await sha256Base64Url(invitationCode);
  const nowIso = new Date().toISOString();
  const route = await env.CORE_DB.prepare(
    `select invitation.league_id, invitation.shard_binding_name
     from league_invitation_directory invitation
     join league_directory directory on directory.league_id = invitation.league_id
     where invitation.code_hash = ?1 and invitation.revoked_at_utc is null
       and (invitation.expires_at_utc is null or invitation.expires_at_utc > ?2)
       and directory.league_status = 'active'
     limit 1`,
  ).bind(codeHash, nowIso).first<{ league_id: string; shard_binding_name: string }>();
  if (!route) throw new ApiException(404, "invitation_not_found", "This invitation code is invalid or expired.");

  const existing = await env.CORE_DB.prepare(
    `select league_id from user_league_directory
     where user_id = ?1 and league_id = ?2 and removed_at_utc is null`,
  ).bind(principal.userId, route.league_id).first<{ league_id: string }>();
  if (existing) {
    return { data: { league: await getLeagueDetail(principal, route.league_id, env) } };
  }

  const db = getShardDatabase(env, route.shard_binding_name);
  const league = await db.prepare(
    `select leagues.league_id, leagues.max_teams, leagues.maintenance_mode,
            leagues.archived_at_utc, seasons.league_season_id
     from leagues
     join league_seasons seasons on seasons.league_id = leagues.league_id
     where leagues.league_id = ?1
     order by seasons.season_year desc limit 1`,
  ).bind(route.league_id).first<{
    league_id: string;
    max_teams: number;
    maintenance_mode: number;
    archived_at_utc: string | null;
    league_season_id: string;
  }>();
  if (!league || league.archived_at_utc) throw new ApiException(404, "league_not_found", "This league is unavailable.");
  if (league.maintenance_mode) throw new ApiException(503, "league_maintenance", "This league is temporarily in maintenance mode.");

  const memberCount = await db.prepare(
    "select count(*) as count from league_members where league_id = ?1 and status = 'active' and removed_at_utc is null",
  ).bind(route.league_id).first<{ count: number }>();
  if ((memberCount?.count ?? 0) >= league.max_teams) {
    throw new ApiException(409, "league_full", "This league has no open teams.");
  }
  const duplicateTeam = await db.prepare(
    "select fantasy_team_id from fantasy_teams where league_season_id = ?1 and lower(team_name) = lower(?2) limit 1",
  ).bind(league.league_season_id, teamName).first<{ fantasy_team_id: string }>();
  if (duplicateTeam) throw new ApiException(409, "team_name_exists", "Choose a different team name for this league.");

  const invitation = await db.prepare(
    `select league_invitation_id, max_uses, use_count from league_invitations
     where league_id = ?1 and code_hash = ?2 and revoked_at_utc is null
       and (expires_at_utc is null or expires_at_utc > ?3) limit 1`,
  ).bind(route.league_id, codeHash, nowIso).first<{
    league_invitation_id: string;
    max_uses: number | null;
    use_count: number;
  }>();
  if (!invitation || (invitation.max_uses !== null && invitation.use_count >= invitation.max_uses)) {
    throw new ApiException(404, "invitation_not_found", "This invitation code is invalid or expired.");
  }

  const memberId = newId("lgm");
  const teamId = newId("ftm");
  await db.batch([
    db.prepare(
      `insert into league_members (
        league_member_id, league_id, user_id, role, joined_at_utc, removed_at_utc,
        status, invited_by_user_id, updated_at_utc, revision_number
      ) values (?1, ?2, ?3, 'manager', ?4, null, 'active', null, ?4, 1)`,
    ).bind(memberId, route.league_id, principal.userId, nowIso),
    db.prepare(
      `insert into fantasy_teams (
        fantasy_team_id, league_season_id, manager_user_id, team_name,
        created_at_utc, updated_at_utc, abbreviation, revision_number
      ) values (?1, ?2, ?3, ?4, ?5, ?5, ?6, 1)`,
    ).bind(teamId, league.league_season_id, principal.userId, teamName, nowIso, teamAbbreviation(teamName)),
    db.prepare(
      `insert into fantasy_team_seasons (
        fantasy_team_season_id, fantasy_team_id, league_season_id, status, created_at_utc
      ) values (?1, ?2, ?3, 'active', ?4)`,
    ).bind(newId("fts"), teamId, league.league_season_id, nowIso),
    db.prepare(
      `insert into fantasy_team_managers (
        fantasy_team_manager_id, fantasy_team_id, user_id, manager_role,
        assigned_at_utc, removed_at_utc
      ) values (?1, ?2, ?3, 'primary', ?4, null)`,
    ).bind(newId("ftg"), teamId, principal.userId, nowIso),
    db.prepare(
      "update league_invitations set use_count = use_count + 1 where league_invitation_id = ?1",
    ).bind(invitation.league_invitation_id),
    leagueAuditStatement(db, route.league_id, principal.userId, "league.member_joined", "member", memberId, correlationId, nowIso, { teamName }),
    leagueActivityStatement(db, route.league_id, principal.userId, "member.joined", `${principal.displayName} joined with ${teamName}.`, nowIso),
  ]);

  try {
    await env.CORE_DB.batch([
      env.CORE_DB.prepare(
        `insert into user_league_directory (
          user_id, league_id, role, fantasy_team_id, joined_at_utc, removed_at_utc
        ) values (?1, ?2, 'manager', ?3, ?4, null)`,
      ).bind(principal.userId, route.league_id, teamId, nowIso),
      env.CORE_DB.prepare(
        `update league_directory
         set member_count = member_count + 1, updated_at_utc = ?1
         where league_id = ?2`,
      ).bind(nowIso, route.league_id),
      coreAuditStatement(env.CORE_DB, principal.userId, "league.member_joined", route.league_id, correlationId, nowIso),
    ]);
  } catch (error) {
    await cleanupJoinedMember(
      db,
      route.league_id,
      memberId,
      teamId,
      invitation.league_invitation_id,
      correlationId,
    );
    throw error;
  }
  queueLeagueAudit(ctx, env, principal.userId, "league.member_joined", route.league_id, correlationId);
  return { status: 201, data: { league: await getLeagueDetail(principal, route.league_id, env) } };
}

async function updateLeagueSettings(
  principal: AccessTokenPrincipal,
  leagueId: string,
  rawBody: UpdateLeagueSettingsRequest,
  env: Env,
  ctx: ExecutionContext,
  correlationId: string,
): Promise<HandlerResult<LeagueDetail>> {
  const body = validateUpdateLeagueSettingsRequest(rawBody);
  const { db } = await requireLeagueRole(principal, leagueId, env, ["commissioner", "co-commissioner"]);
  const current = await getLeagueRow(db, leagueId);
  if (current.revision_number !== body.revisionNumber) {
    throw new ApiException(409, "revision_conflict", "League settings changed elsewhere. Reload before saving.", {
      currentRevision: current.revision_number,
    });
  }
  const members = await db.prepare(
    "select count(*) as count from league_members where league_id = ?1 and status = 'active' and removed_at_utc is null",
  ).bind(leagueId).first<{ count: number }>();
  if (body.teamCount < (members?.count ?? 0)) {
    throw new ApiException(400, "team_count_too_small", "Team count cannot be lower than the current member count.");
  }

  const nowIso = new Date().toISOString();
  const update = await db.prepare(
    `update leagues set league_name = ?1, description = ?2, privacy = ?3,
            time_zone = ?4, max_teams = ?5, updated_at_utc = ?6,
            revision_number = revision_number + 1
     where league_id = ?7 and revision_number = ?8`,
  ).bind(
    body.leagueName, body.description, body.privacy, body.timeZone,
    body.teamCount, nowIso, leagueId, body.revisionNumber,
  ).run();
  if (!update.meta.changes) {
    throw new ApiException(409, "revision_conflict", "League settings changed elsewhere. Reload before saving.");
  }

  const roster = await db.prepare(
    `select definitions.roster_definition_id
     from roster_definitions definitions
     join league_seasons seasons on seasons.league_season_id = definitions.league_season_id
     where seasons.league_id = ?1 order by seasons.season_year desc limit 1`,
  ).bind(leagueId).first<{ roster_definition_id: string }>();
  const season = await db.prepare(
    "select league_season_id from league_seasons where league_id = ?1 order by season_year desc limit 1",
  ).bind(leagueId).first<{ league_season_id: string }>();
  if (!roster || !season) throw new ApiException(500, "league_configuration_missing", "League configuration is incomplete.");

  await db.batch([
    db.prepare("delete from roster_slots where roster_definition_id = ?1").bind(roster.roster_definition_id),
    ...rosterSlotStatements(db, roster.roster_definition_id, body.rosterSlots),
    db.prepare(
      `update roster_definitions set revision_number = revision_number + 1, updated_at_utc = ?1
       where roster_definition_id = ?2`,
    ).bind(nowIso, roster.roster_definition_id),
    db.prepare(
      `update schedule_settings set regular_season_start_week = ?1,
              regular_season_end_week = ?2, schedule_method = ?3,
              playoff_team_count = ?4, playoff_start_week = ?5,
              playoff_round_length = ?6, reseed = ?7, consolation_bracket = ?8,
              third_place_matchup = ?9, revision_number = revision_number + 1,
              updated_at_utc = ?10
       where league_season_id = ?11`,
    ).bind(
      body.schedule.regularSeasonStartWeek, body.schedule.regularSeasonEndWeek,
      body.schedule.scheduleMethod, body.schedule.playoffTeamCount,
      body.schedule.playoffStartWeek, body.schedule.playoffRoundLength,
      boolInt(body.schedule.reseed), boolInt(body.schedule.consolationBracket),
      boolInt(body.schedule.thirdPlaceMatchup), nowIso, season.league_season_id,
    ),
    leagueAuditStatement(db, leagueId, principal.userId, "league.settings_updated", "league", leagueId, correlationId, nowIso, {
      previousRevision: body.revisionNumber,
      nextRevision: body.revisionNumber + 1,
    }),
    leagueActivityStatement(db, leagueId, principal.userId, "settings.updated", `${principal.displayName} updated league settings.`, nowIso),
  ]);
  await env.CORE_DB.batch([
    env.CORE_DB.prepare(
      `update league_directory set league_name = ?1, privacy = ?2, max_teams = ?3,
              revision_number = revision_number + 1, updated_at_utc = ?4
       where league_id = ?5 and revision_number = ?6`,
    ).bind(body.leagueName, body.privacy, body.teamCount, nowIso, leagueId, body.revisionNumber),
    coreAuditStatement(env.CORE_DB, principal.userId, "league.settings_updated", leagueId, correlationId, nowIso),
  ]);
  queueLeagueAudit(ctx, env, principal.userId, "league.settings_updated", leagueId, correlationId);
  return { data: await getLeagueDetail(principal, leagueId, env) };
}

async function createInvitation(
  principal: AccessTokenPrincipal,
  leagueId: string,
  env: Env,
  ctx: ExecutionContext,
  correlationId: string,
): Promise<HandlerResult<LeagueInvitationResponse>> {
  const { db, route } = await requireLeagueRole(principal, leagueId, env, ["commissioner", "co-commissioner"]);
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAtUtc = new Date(now.getTime() + invitationLifetimeMs).toISOString();
  const code = newInvitationCode();
  const codeHash = await sha256Base64Url(normalizeInvitationCode(code));
  const invitationId = newId("lgi");
  const league = await getLeagueRow(db, leagueId);

  await db.batch([
    db.prepare("update league_invitations set revoked_at_utc = ?1 where league_id = ?2 and revoked_at_utc is null").bind(nowIso, leagueId),
    db.prepare(
      `insert into league_invitations (
        league_invitation_id, league_id, code_hash, created_by_user_id,
        created_at_utc, expires_at_utc, revoked_at_utc, max_uses, use_count
      ) values (?1, ?2, ?3, ?4, ?5, ?6, null, ?7, 0)`,
    ).bind(invitationId, leagueId, codeHash, principal.userId, nowIso, expiresAtUtc, league.max_teams),
    leagueAuditStatement(db, leagueId, principal.userId, "league.invitation_rotated", "invitation", invitationId, correlationId, nowIso, {}),
  ]);
  await env.CORE_DB.batch([
    env.CORE_DB.prepare("update league_invitation_directory set revoked_at_utc = ?1 where league_id = ?2 and revoked_at_utc is null").bind(nowIso, leagueId),
    env.CORE_DB.prepare(
      `insert into league_invitation_directory (
        invitation_id, league_id, code_hash, shard_binding_name,
        expires_at_utc, revoked_at_utc, created_at_utc
      ) values (?1, ?2, ?3, ?4, ?5, null, ?6)`,
    ).bind(invitationId, leagueId, codeHash, route.shard_binding_name, expiresAtUtc, nowIso),
  ]);
  queueLeagueAudit(ctx, env, principal.userId, "league.invitation_rotated", leagueId, correlationId);
  return {
    status: 201,
    data: { invitationCode: code, invitationLink: invitationLink(env, code), expiresAtUtc },
  };
}

async function setLeagueArchived(
  principal: AccessTokenPrincipal,
  leagueId: string,
  archived: boolean,
  revisionNumber: number,
  env: Env,
  ctx: ExecutionContext,
  correlationId: string,
): Promise<HandlerResult<LeagueDetail>> {
  if (!Number.isInteger(revisionNumber) || revisionNumber < 1) {
    throw new ApiException(400, "invalid_revision", "A valid league revision is required.");
  }
  const { db } = await requireLeagueRole(principal, leagueId, env, ["commissioner"]);
  const nowIso = new Date().toISOString();
  const result = await db.prepare(
    `update leagues set archived_at_utc = ?1, updated_at_utc = ?2,
            revision_number = revision_number + 1
     where league_id = ?3 and revision_number = ?4`,
  ).bind(archived ? nowIso : null, nowIso, leagueId, revisionNumber).run();
  if (!result.meta.changes) {
    throw new ApiException(409, "revision_conflict", "League settings changed elsewhere. Reload before continuing.");
  }
  const action = archived ? "league.archived" : "league.restored";
  await db.batch([
    leagueAuditStatement(db, leagueId, principal.userId, action, "league", leagueId, correlationId, nowIso, {}),
    leagueActivityStatement(db, leagueId, principal.userId, action, `${principal.displayName} ${archived ? "archived" : "restored"} the league.`, nowIso),
  ]);
  await env.CORE_DB.batch([
    env.CORE_DB.prepare(
      `update league_directory set league_status = ?1, archived_at_utc = ?2,
              revision_number = revision_number + 1, updated_at_utc = ?3
       where league_id = ?4 and revision_number = ?5`,
    ).bind(archived ? "archived" : "active", archived ? nowIso : null, nowIso, leagueId, revisionNumber),
    coreAuditStatement(env.CORE_DB, principal.userId, action, leagueId, correlationId, nowIso),
  ]);
  queueLeagueAudit(ctx, env, principal.userId, action, leagueId, correlationId);
  return { data: await getLeagueDetail(principal, leagueId, env) };
}

async function getLeagueDetail(
  principal: AccessTokenPrincipal,
  leagueId: string,
  env: Env,
): Promise<LeagueDetail> {
  const { db } = await requireLeagueRole(principal, leagueId, env, ["commissioner", "co-commissioner", "manager"]);
  const league = await getLeagueRow(db, leagueId);
  const [membershipResult, rosterResult, schedule, scoringSetting, activityResult] = await Promise.all([
    db.prepare(
      `select members.league_member_id, members.user_id, members.role,
              members.joined_at_utc, teams.fantasy_team_id, teams.team_name
       from league_members members
       left join fantasy_teams teams
         on teams.manager_user_id = members.user_id
        and teams.league_season_id = ?2
       where members.league_id = ?1 and members.status = 'active'
         and members.removed_at_utc is null
       order by members.joined_at_utc`,
    ).bind(leagueId, league.league_season_id).all<MembershipRow>(),
    db.prepare(
      `select slots.slot_type, slots.display_name, slots.slot_count,
              slots.eligible_positions_json, slots.contributes_points
       from roster_slots slots
       join roster_definitions definitions on definitions.roster_definition_id = slots.roster_definition_id
       where definitions.league_season_id = ?1 order by slots.display_order`,
    ).bind(league.league_season_id).all<{
      slot_type: string;
      display_name: string;
      slot_count: number;
      eligible_positions_json: string;
      contributes_points: number;
    }>(),
    db.prepare(
      `select regular_season_start_week, regular_season_end_week, schedule_method,
              playoff_team_count, playoff_start_week, playoff_round_length,
              reseed, consolation_bracket, third_place_matchup
       from schedule_settings where league_season_id = ?1`,
    ).bind(league.league_season_id).first<{
      regular_season_start_week: number;
      regular_season_end_week: number;
      schedule_method: "round-robin" | "random";
      playoff_team_count: number;
      playoff_start_week: number;
      playoff_round_length: number;
      reseed: number;
      consolation_bracket: number;
      third_place_matchup: number;
    }>(),
    db.prepare(
      "select value_json from league_settings where league_id = ?1 and setting_key = 'scoring_preset'",
    ).bind(leagueId).first<{ value_json: string }>(),
    db.prepare(
      `select league_activity_id, message, created_at_utc from league_activity
       where league_id = ?1 order by created_at_utc desc limit 12`,
    ).bind(leagueId).all<{ league_activity_id: string; message: string; created_at_utc: string }>(),
  ]);
  if (!schedule) throw new ApiException(500, "league_configuration_missing", "League schedule configuration is incomplete.");
  const memberships = membershipResult.results ?? [];
  const profiles = await getProfiles(env.CORE_DB, memberships.map((membership) => membership.user_id));
  const members: LeagueMemberView[] = memberships.map((membership) => ({
    userId: membership.user_id,
    displayName: profiles.get(membership.user_id) ?? "League member",
    role: membership.role,
    teamId: membership.fantasy_team_id ?? undefined,
    teamName: membership.team_name ?? undefined,
    joinedAtUtc: membership.joined_at_utc,
  }));
  const self = members.find((member) => member.userId === principal.userId);
  if (!self) throw new ApiException(403, "league_access_denied", "You are not an active member of this league.");
  const status: LeagueStatus = league.archived_at_utc
    ? "archived"
    : league.maintenance_mode
      ? "maintenance"
      : "active";
  return {
    leagueId,
    leagueName: league.league_name,
    description: league.description ?? "",
    seasonId: league.league_season_id,
    seasonYear: league.season_year,
    privacy: league.privacy,
    role: self.role,
    status,
    teamCount: members.length,
    maxTeams: league.max_teams,
    fantasyTeamId: self.teamId,
    joinedAtUtc: self.joinedAtUtc,
    revisionNumber: league.revision_number,
    format: league.league_format,
    timeZone: league.time_zone,
    commissionerUserId: league.commissioner_user_id,
    maintenanceMode: Boolean(league.maintenance_mode),
    scoringPreset: scoringSetting ? String(JSON.parse(scoringSetting.value_json)) : "standard",
    rosterSlots: (rosterResult.results ?? []).map((slot) => ({
      slotType: slot.slot_type,
      displayName: slot.display_name,
      count: slot.slot_count,
      eligiblePositions: JSON.parse(slot.eligible_positions_json) as string[],
      contributesPoints: Boolean(slot.contributes_points),
    })),
    schedule: {
      regularSeasonStartWeek: schedule.regular_season_start_week,
      regularSeasonEndWeek: schedule.regular_season_end_week,
      scheduleMethod: schedule.schedule_method,
      playoffTeamCount: schedule.playoff_team_count,
      playoffStartWeek: schedule.playoff_start_week,
      playoffRoundLength: schedule.playoff_round_length,
      reseed: Boolean(schedule.reseed),
      consolationBracket: Boolean(schedule.consolation_bracket),
      thirdPlaceMatchup: Boolean(schedule.third_place_matchup),
    },
    members,
    recentActivity: (activityResult.results ?? []).map((activity) => ({
      activityId: activity.league_activity_id,
      message: activity.message,
      createdAtUtc: activity.created_at_utc,
    })),
  };
}

async function requireLeagueRole(
  principal: AccessTokenPrincipal,
  leagueId: string,
  env: Env,
  allowedRoles: LeagueRole[],
): Promise<{ db: D1Database; route: { shard_binding_name: string }; role: LeagueRole }> {
  const route = await env.CORE_DB.prepare(
    `select directory.shard_binding_name, membership.role
     from league_directory directory
     join user_league_directory membership on membership.league_id = directory.league_id
     where directory.league_id = ?1 and membership.user_id = ?2
       and membership.removed_at_utc is null limit 1`,
  ).bind(leagueId, principal.userId).first<{ shard_binding_name: string; role: LeagueRole }>();
  if (!route) throw new ApiException(404, "league_not_found", "League not found or access denied.");
  if (!allowedRoles.includes(route.role)) {
    throw new ApiException(403, "league_role_required", "Your league role does not allow this action.");
  }
  const db = getShardDatabase(env, route.shard_binding_name);
  const membership = await db.prepare(
    `select role from league_members where league_id = ?1 and user_id = ?2
     and status = 'active' and removed_at_utc is null limit 1`,
  ).bind(leagueId, principal.userId).first<{ role: LeagueRole }>();
  if (!membership || !allowedRoles.includes(membership.role)) {
    throw new ApiException(403, "league_role_required", "Your league role does not allow this action.");
  }
  return { db, route, role: membership.role };
}

async function getLeagueRow(db: D1Database, leagueId: string): Promise<LeagueRow> {
  const row = await db.prepare(
    `select leagues.league_id, leagues.league_name, leagues.description, leagues.privacy,
            leagues.league_format, leagues.time_zone, leagues.max_teams,
            leagues.commissioner_user_id, leagues.maintenance_mode,
            leagues.archived_at_utc, leagues.revision_number,
            seasons.league_season_id, seasons.season_year
     from leagues
     join league_seasons seasons on seasons.league_id = leagues.league_id
     where leagues.league_id = ?1 order by seasons.season_year desc limit 1`,
  ).bind(leagueId).first<LeagueRow>();
  if (!row) throw new ApiException(404, "league_not_found", "League not found.");
  return row;
}

async function getProfiles(db: D1Database, userIds: string[]): Promise<Map<string, string>> {
  if (!userIds.length) return new Map();
  const placeholders = userIds.map((_, index) => `?${index + 1}`).join(",");
  const result = await db.prepare(
    `select user_id, display_name from user_profiles where user_id in (${placeholders})`,
  ).bind(...userIds).all<{ user_id: string; display_name: string }>();
  return new Map((result.results ?? []).map((row) => [row.user_id, row.display_name]));
}

async function selectShard(env: Env): Promise<{
  shard_key: string;
  binding_name: string;
}> {
  const shard = await env.CORE_DB.prepare(
    `select shard_key, binding_name from database_shards
     where shard_type = 'league' and status = 'active' and accepts_new_leagues = 1
     order by league_count asc, created_at_utc asc limit 1`,
  ).first<{ shard_key: string; binding_name: string }>();
  if (!shard) throw new ApiException(503, "league_capacity_unavailable", "League creation is temporarily unavailable.");
  return shard;
}

function getShardDatabase(env: Env, bindingName: string): D1Database {
  if (bindingName !== supportedShardBinding) {
    throw new ApiException(503, "league_shard_unavailable", "This league shard is not available in the current deployment.");
  }
  return env.LEAGUE_DB_001;
}

export function validateCreateLeagueRequest(body: CreateLeagueRequest): CreateLeagueRequest {
  const requestId = requireString(body.requestId, "Request ID").trim();
  if (requestId.length < 8 || requestId.length > 100) throw new ApiException(400, "invalid_request_id", "Restart league creation and try again.");
  const leagueName = requireLeagueName(body.leagueName);
  const description = optionalDescription(body.description);
  const privacy = requirePrivacy(body.privacy);
  const teamCount = requireTeamCount(body.teamCount);
  const seasonYear = requireSeasonYear(body.seasonYear);
  const timeZone = requireTimeZone(body.timeZone);
  const format = requireFormat(body.format);
  const scoringPreset = requireScoringPreset(body.scoringPreset);
  const commissionerTeamName = requireTeamName(body.commissionerTeamName);
  const rosterSlots = validateRosterSlots(body.rosterSlots);
  const schedule = validateSchedule(body.schedule, teamCount);
  return {
    requestId, leagueName, description, privacy, teamCount, seasonYear,
    timeZone, format, scoringPreset, commissionerTeamName, rosterSlots, schedule,
  };
}

export function validateUpdateLeagueSettingsRequest(
  body: UpdateLeagueSettingsRequest,
): UpdateLeagueSettingsRequest {
  if (!Number.isInteger(body.revisionNumber) || body.revisionNumber < 1) {
    throw new ApiException(400, "invalid_revision", "A valid league revision is required.");
  }
  const teamCount = requireTeamCount(body.teamCount);
  return {
    revisionNumber: body.revisionNumber,
    leagueName: requireLeagueName(body.leagueName),
    description: optionalDescription(body.description),
    privacy: requirePrivacy(body.privacy),
    timeZone: requireTimeZone(body.timeZone),
    teamCount,
    rosterSlots: validateRosterSlots(body.rosterSlots),
    schedule: validateSchedule(body.schedule, teamCount),
  };
}

export function normalizeInvitationCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function requireInvitationCode(value: unknown): string {
  const code = normalizeInvitationCode(requireString(value, "Invitation code"));
  if (code.length !== 10) throw new ApiException(400, "invalid_invitation_code", "Enter the 10-character invitation code.");
  return code;
}

function requireLeagueName(value: unknown): string {
  const name = requireString(value, "League name").trim();
  if (name.length < 3 || name.length > 60) throw new ApiException(400, "invalid_league_name", "League name must be between 3 and 60 characters.");
  return name;
}

function requireTeamName(value: unknown): string {
  const name = requireString(value, "Team name").trim();
  if (name.length < 2 || name.length > 40) throw new ApiException(400, "invalid_team_name", "Team name must be between 2 and 40 characters.");
  return name;
}

function optionalDescription(value: unknown): string {
  if (value === undefined || value === null) return "";
  const description = requireString(value, "Description").trim();
  if (description.length > 500) throw new ApiException(400, "invalid_description", "Description cannot exceed 500 characters.");
  return description;
}

function requirePrivacy(value: unknown): LeaguePrivacy {
  if (value !== "private" && value !== "public") throw new ApiException(400, "invalid_privacy", "Choose a valid league privacy setting.");
  return value;
}

function requireFormat(value: unknown): LeagueFormat {
  if (value !== "redraft" && value !== "keeper" && value !== "dynasty" && value !== "best-ball") {
    throw new ApiException(400, "invalid_league_format", "Choose a supported league format.");
  }
  return value;
}

function requireScoringPreset(value: unknown): CreateLeagueRequest["scoringPreset"] {
  const presets = ["standard", "half-ppr", "full-ppr", "superflex", "te-premium", "idp"];
  if (!presets.includes(String(value))) throw new ApiException(400, "invalid_scoring_preset", "Choose a supported scoring preset.");
  return value as CreateLeagueRequest["scoringPreset"];
}

function requireTeamCount(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 4 || Number(value) > 32) {
    throw new ApiException(400, "invalid_team_count", "League size must be between 4 and 32 teams.");
  }
  return Number(value);
}

function requireSeasonYear(value: unknown): number {
  const currentYear = new Date().getUTCFullYear();
  if (!Number.isInteger(value) || Number(value) < currentYear - 1 || Number(value) > currentYear + 2) {
    throw new ApiException(400, "invalid_season_year", "Choose a current or upcoming season year.");
  }
  return Number(value);
}

function requireTimeZone(value: unknown): string {
  const timeZone = requireString(value, "Time zone").trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
  } catch {
    throw new ApiException(400, "invalid_time_zone", "Choose a valid time zone.");
  }
  return timeZone;
}

function validateRosterSlots(value: unknown): RosterSlotInput[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 30) {
    throw new ApiException(400, "invalid_roster", "Add at least one valid roster slot.");
  }
  const slots = value.map((raw, index) => {
    const slot = raw as Partial<RosterSlotInput>;
    const slotType = requireString(slot.slotType, `Roster slot ${index + 1}`).trim().toUpperCase();
    const displayName = requireString(slot.displayName, `Roster slot ${index + 1} name`).trim();
    const count = Number(slot.count);
    if (!/^[A-Z0-9_-]{1,20}$/.test(slotType) || displayName.length < 1 || displayName.length > 30) {
      throw new ApiException(400, "invalid_roster_slot", "A roster slot has an invalid name or type.");
    }
    if (!Number.isInteger(count) || count < 0 || count > 20) {
      throw new ApiException(400, "invalid_roster_slot_count", "Roster slot counts must be between 0 and 20.");
    }
    if (!Array.isArray(slot.eligiblePositions) || slot.eligiblePositions.some((position) => typeof position !== "string")) {
      throw new ApiException(400, "invalid_roster_positions", "Roster slot positions are invalid.");
    }
    return {
      slotType,
      displayName,
      count,
      eligiblePositions: slot.eligiblePositions.map((position) => position.toUpperCase()),
      contributesPoints: Boolean(slot.contributesPoints),
    };
  });
  const total = slots.reduce((sum, slot) => sum + slot.count, 0);
  if (total < 5 || total > 60) throw new ApiException(400, "invalid_roster_size", "Total roster size must be between 5 and 60 players.");
  return slots;
}

function validateSchedule(value: unknown, teamCount: number): LeagueScheduleInput {
  const schedule = value as Partial<LeagueScheduleInput> | null;
  if (!schedule) throw new ApiException(400, "invalid_schedule", "Schedule settings are required.");
  const integers = [
    schedule.regularSeasonStartWeek,
    schedule.regularSeasonEndWeek,
    schedule.playoffTeamCount,
    schedule.playoffStartWeek,
    schedule.playoffRoundLength,
  ];
  if (integers.some((item) => !Number.isInteger(item))) throw new ApiException(400, "invalid_schedule", "Schedule weeks must be whole numbers.");
  if (
    Number(schedule.regularSeasonStartWeek) < 1 ||
    Number(schedule.regularSeasonEndWeek) > 18 ||
    Number(schedule.regularSeasonEndWeek) < Number(schedule.regularSeasonStartWeek) ||
    Number(schedule.playoffStartWeek) <= Number(schedule.regularSeasonEndWeek) ||
    Number(schedule.playoffStartWeek) > 18
  ) {
    throw new ApiException(400, "invalid_schedule_weeks", "Regular-season and playoff weeks do not fit the NFL season.");
  }
  if (Number(schedule.playoffTeamCount) < 2 || Number(schedule.playoffTeamCount) > teamCount) {
    throw new ApiException(400, "invalid_playoff_size", "Playoff team count must fit the league size.");
  }
  if (Number(schedule.playoffRoundLength) < 1 || Number(schedule.playoffRoundLength) > 2) {
    throw new ApiException(400, "invalid_playoff_round", "Playoff rounds must be one or two weeks long.");
  }
  if (schedule.scheduleMethod !== "round-robin" && schedule.scheduleMethod !== "random") {
    throw new ApiException(400, "invalid_schedule_method", "Choose a valid schedule method.");
  }
  return {
    regularSeasonStartWeek: Number(schedule.regularSeasonStartWeek),
    regularSeasonEndWeek: Number(schedule.regularSeasonEndWeek),
    scheduleMethod: schedule.scheduleMethod,
    playoffTeamCount: Number(schedule.playoffTeamCount),
    playoffStartWeek: Number(schedule.playoffStartWeek),
    playoffRoundLength: Number(schedule.playoffRoundLength),
    reseed: Boolean(schedule.reseed),
    consolationBracket: Boolean(schedule.consolationBracket),
    thirdPlaceMatchup: Boolean(schedule.thirdPlaceMatchup),
  };
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ApiException(400, "required_field", `${label} is required.`);
  return value;
}

function newInvitationCode(): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  const raw = Array.from(bytes, (byte) => invitationAlphabet[byte & 31]).join("");
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

function teamAbbreviation(teamName: string): string {
  const words = teamName.match(/[A-Za-z0-9]+/g) ?? [];
  const abbreviation = words.length > 1
    ? words.slice(0, 4).map((word) => word[0]).join("")
    : (words[0] ?? "TEAM").slice(0, 4);
  return abbreviation.toUpperCase();
}

function boolInt(value: boolean): number {
  return value ? 1 : 0;
}

function parseLimit(value: string | null): number {
  if (!value) return 20;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new ApiException(400, "invalid_page_size", "Page size must be between 1 and 50.");
  return limit;
}

function encodeCursor(joinedAtUtc: string, leagueId: string): string {
  return btoa(JSON.stringify({ joinedAtUtc, leagueId })).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeCursor(value: string | null): { joinedAtUtc: string; leagueId: string } | undefined {
  if (!value) return undefined;
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const parsed = JSON.parse(atob(padded)) as { joinedAtUtc?: unknown; leagueId?: unknown };
    if (typeof parsed.joinedAtUtc !== "string" || typeof parsed.leagueId !== "string") throw new Error("invalid");
    return { joinedAtUtc: parsed.joinedAtUtc, leagueId: parsed.leagueId };
  } catch {
    throw new ApiException(400, "invalid_cursor", "The pagination cursor is invalid.");
  }
}

function directoryToSummary(row: DirectoryRow): LeagueSummary {
  return {
    leagueId: row.league_id,
    leagueName: row.league_name,
    seasonId: row.current_season_id,
    seasonYear: row.season_year,
    privacy: row.privacy,
    role: row.role,
    status: row.league_status,
    teamCount: row.member_count,
    maxTeams: row.max_teams,
    fantasyTeamId: row.fantasy_team_id ?? undefined,
    joinedAtUtc: row.joined_at_utc,
    revisionNumber: row.revision_number,
  };
}

function rosterSlotStatements(
  db: D1Database,
  rosterDefinitionId: string,
  slots: RosterSlotInput[],
): D1PreparedStatement[] {
  return slots.filter((slot) => slot.count > 0).map((slot, index) => db.prepare(
    `insert into roster_slots (
      roster_slot_id, roster_definition_id, slot_type, display_name, slot_count,
      eligible_positions_json, contributes_points, lock_behavior,
      injury_eligibility, display_order
    ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'game-start', ?8, ?9)`,
  ).bind(
    newId("rss"), rosterDefinitionId, slot.slotType, slot.displayName, slot.count,
    JSON.stringify(slot.eligiblePositions), boolInt(slot.contributesPoints),
    ["IR", "PUP"].includes(slot.slotType) ? "injured" : null, index,
  ));
}

function createResponseFromInput(
  body: CreateLeagueRequest,
  principal: AccessTokenPrincipal,
  leagueId: string,
  seasonId: string,
  teamId: string,
  invitationCode: string,
  link: string,
  nowIso: string,
): CreateLeagueResponse {
  return {
    invitationCode,
    invitationLink: link,
    league: {
      leagueId,
      leagueName: body.leagueName,
      description: body.description ?? "",
      seasonId,
      seasonYear: body.seasonYear,
      privacy: body.privacy,
      role: "commissioner",
      status: "active",
      teamCount: 1,
      maxTeams: body.teamCount,
      fantasyTeamId: teamId,
      joinedAtUtc: nowIso,
      revisionNumber: 1,
      format: body.format,
      timeZone: body.timeZone,
      commissionerUserId: principal.userId,
      maintenanceMode: false,
      scoringPreset: body.scoringPreset,
      rosterSlots: body.rosterSlots.filter((slot) => slot.count > 0),
      schedule: body.schedule,
      members: [{
        userId: principal.userId,
        displayName: principal.displayName,
        role: "commissioner",
        teamId,
        teamName: body.commissionerTeamName,
        joinedAtUtc: nowIso,
      }],
      recentActivity: [],
    },
  };
}

function invitationLink(env: Env, code: string): string {
  return `${env.APPLICATION_BASE_URL}/?join=${encodeURIComponent(code)}`;
}

function leagueAuditStatement(
  db: D1Database,
  leagueId: string,
  userId: string,
  action: string,
  entityType: string,
  entityId: string,
  correlationId: string,
  nowIso: string,
  metadata: unknown,
): D1PreparedStatement {
  return db.prepare(
    `insert into league_audit_events (
      league_audit_event_id, league_id, actor_user_id, action, entity_type,
      entity_id, correlation_id, created_at_utc, metadata_json
    ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  ).bind(newId("lau"), leagueId, userId, action, entityType, entityId, correlationId, nowIso, JSON.stringify(metadata));
}

function leagueActivityStatement(
  db: D1Database,
  leagueId: string,
  userId: string,
  type: string,
  message: string,
  nowIso: string,
): D1PreparedStatement {
  return db.prepare(
    `insert into league_activity (
      league_activity_id, league_id, actor_user_id, activity_type,
      message, created_at_utc, metadata_json
    ) values (?1, ?2, ?3, ?4, ?5, ?6, '{}')`,
  ).bind(newId("lga"), leagueId, userId, type, message, nowIso);
}

function coreAuditStatement(
  db: D1Database,
  userId: string,
  action: string,
  leagueId: string,
  correlationId: string,
  nowIso: string,
): D1PreparedStatement {
  return db.prepare(
    `insert into audit_events (
      audit_event_id, actor_user_id, action, entity_type, entity_id,
      correlation_id, created_at_utc, metadata_json
    ) values (?1, ?2, ?3, 'league', ?4, ?5, ?6, '{}')`,
  ).bind(newId("aud"), userId, action, leagueId, correlationId, nowIso);
}

function queueLeagueAudit(
  ctx: ExecutionContext,
  env: Env,
  userId: string,
  action: string,
  leagueId: string,
  correlationId: string,
): void {
  ctx.waitUntil(env.AUDIT_QUEUE.send({
    userId,
    action,
    leagueId,
    correlationId,
    utc: new Date().toISOString(),
  }).catch((error: unknown) => {
    console.error(JSON.stringify({
      level: "error",
      event: "league_audit_queue_failed",
      action,
      leagueId,
      correlationId,
      error: error instanceof Error ? error.message : String(error),
    }));
  }));
}

async function cleanupCreatedLeague(db: D1Database, leagueId: string, seasonId: string): Promise<void> {
  try {
    await db.batch([
      db.prepare("delete from league_activity where league_id = ?1").bind(leagueId),
      db.prepare("delete from league_audit_events where league_id = ?1").bind(leagueId),
      db.prepare("delete from roster_slots where roster_definition_id in (select roster_definition_id from roster_definitions where league_season_id = ?1)").bind(seasonId),
      db.prepare("delete from roster_definitions where league_season_id = ?1").bind(seasonId),
      db.prepare("delete from schedule_settings where league_season_id = ?1").bind(seasonId),
      db.prepare("delete from league_settings where league_id = ?1").bind(leagueId),
      db.prepare("delete from league_invitations where league_id = ?1").bind(leagueId),
      db.prepare("delete from fantasy_team_managers where fantasy_team_id in (select fantasy_team_id from fantasy_teams where league_season_id = ?1)").bind(seasonId),
      db.prepare("delete from fantasy_team_seasons where league_season_id = ?1").bind(seasonId),
      db.prepare("delete from fantasy_teams where league_season_id = ?1").bind(seasonId),
      db.prepare("delete from league_members where league_id = ?1").bind(leagueId),
      db.prepare("delete from league_seasons where league_id = ?1").bind(leagueId),
      db.prepare("delete from leagues where league_id = ?1").bind(leagueId),
    ]);
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "league_create_cleanup_failed", leagueId, error: String(error) }));
  }
}

async function cleanupJoinedMember(
  db: D1Database,
  leagueId: string,
  memberId: string,
  teamId: string,
  invitationId: string,
  correlationId: string,
): Promise<void> {
  try {
    await db.batch([
      db.prepare(
        `delete from league_activity where league_id = ?1 and activity_type = 'member.joined'
         and actor_user_id = (select user_id from league_members where league_member_id = ?2)`,
      ).bind(leagueId, memberId),
      db.prepare("delete from league_audit_events where correlation_id = ?1").bind(correlationId),
      db.prepare(
        "update league_invitations set use_count = max(0, use_count - 1) where league_invitation_id = ?1",
      ).bind(invitationId),
      db.prepare("delete from fantasy_team_managers where fantasy_team_id = ?1").bind(teamId),
      db.prepare("delete from fantasy_team_seasons where fantasy_team_id = ?1").bind(teamId),
      db.prepare("delete from fantasy_teams where fantasy_team_id = ?1").bind(teamId),
      db.prepare("delete from league_members where league_member_id = ?1").bind(memberId),
    ]);
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "league_join_cleanup_failed", leagueId, memberId, error: String(error) }));
  }
}
