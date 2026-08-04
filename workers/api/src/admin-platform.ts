import type { HandlerResult } from "./auth";
import { ApiException, readJson } from "./http";
import type { ScoringJob } from "./score-processing";
import { requiredReason } from "./admin-rules";

export interface AdminPrincipal { userId: string; role: string }

export async function handlePlatformAdminRequest(
  request: Request,
  url: URL,
  env: Env,
  admin: AdminPrincipal,
  correlationId: string,
): Promise<HandlerResult<unknown> | undefined> {
  if (request.method === "GET" && url.pathname === "/api/admin/dashboard") return { data: await dashboard(env) };
  if (request.method === "GET" && url.pathname === "/api/admin/monitoring") return { data: await monitoring(env) };
  if (request.method === "GET" && url.pathname === "/api/admin/audit") return { data: await auditPage(env, url) };
  if (request.method === "GET" && url.pathname === "/api/admin/users") return { data: await usersPage(env, url) };
  if (request.method === "GET" && url.pathname === "/api/admin/leagues") return { data: await leaguesPage(env, url) };

  const userMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)(?:\/(status|sessions|role))?$/);
  if (userMatch) {
    const userId = decodeURIComponent(userMatch[1]);
    const action = userMatch[2];
    if (request.method === "GET" && !action) return { data: await userDetail(env, userId) };
    if (request.method === "POST" && action === "status") {
      requireRole(admin, ["owner", "operator"]);
      return { data: await setUserStatus(request, env, admin, userId, correlationId) };
    }
    if (request.method === "POST" && action === "sessions") {
      requireRole(admin, ["owner", "operator", "support"]);
      return { data: await revokeUserSessions(env, admin, userId, correlationId) };
    }
    if (request.method === "POST" && action === "role") {
      requireRole(admin, ["owner"]);
      return { data: await setAdminRole(request, env, admin, userId, correlationId) };
    }
  }

  const leagueMatch = url.pathname.match(/^\/api\/admin\/leagues\/([^/]+)(?:\/(archive|restore|recalculate))?$/);
  if (leagueMatch) {
    const leagueId = decodeURIComponent(leagueMatch[1]);
    const action = leagueMatch[2];
    if (request.method === "GET" && !action) return { data: await leagueDetail(env, leagueId) };
    if (request.method === "POST" && (action === "archive" || action === "restore")) {
      requireRole(admin, ["owner", "operator"]);
      return { data: await setLeagueArchive(request, env, admin, leagueId, action, correlationId) };
    }
    if (request.method === "POST" && action === "recalculate") {
      requireRole(admin, ["owner", "operator"]);
      return { data: await recalculateLeague(request, env, admin, leagueId, correlationId), status: 202 };
    }
  }
  return undefined;
}

async function dashboard(env: Env): Promise<unknown> {
  const [core, nfl, provider, jobs, audits] = await Promise.all([
    env.CORE_DB.prepare(`select
      (select count(*) from users where status='active') activeUsers,
      (select count(*) from users where last_login_at_utc >= datetime('now','-24 hours')) dailyUsers,
      (select count(*) from league_directory where league_status='active') activeLeagues,
      (select count(*) from refresh_tokens where revoked_at_utc is null and expires_at_utc > datetime('now')) activeSessions`).first(),
    env.NFL_DB.prepare(`select
      (select count(*) from nfl_event_snapshots where data_scope='production' and completed=0 and period>0) liveGames,
      (select max(last_success_at_utc) from provider_sync_state where data_scope='production') lastSyncAtUtc,
      (select count(*) from provider_sync_runs where status='failed' and started_at_utc >= datetime('now','-24 hours')) failedRequests`).first(),
    env.NFL_DB.prepare(`select resource,last_status as status,last_success_at_utc as lastSuccessAtUtc,last_error as error from provider_sync_state where data_scope='production' order by resource`).all(),
    env.CORE_DB.prepare(`select status,count(*) count from admin_jobs group by status`).all(),
    env.CORE_DB.prepare(`select action,entity_type as entityType,entity_id as entityId,correlation_id as correlationId,created_at_utc as createdAtUtc from audit_events order by created_at_utc desc limit 12`).all(),
  ]);
  return { counts: { ...(core ?? {}), ...(nfl ?? {}) }, provider: provider.results ?? [], jobs: jobs.results ?? [], recentActions: audits.results ?? [], generatedAtUtc: new Date().toISOString() };
}

async function monitoring(env: Env): Promise<unknown> {
  const [shards, provider, jobs, notifications, receipts] = await Promise.all([
    env.CORE_DB.prepare(`select shard_key as shardKey,binding_name as bindingName,status,accepts_new_leagues as acceptsNewLeagues,schema_version as schemaVersion,estimated_storage_bytes as estimatedStorageBytes,league_count as leagueCount,updated_at_utc as updatedAtUtc from database_shards order by shard_key`).all(),
    env.NFL_DB.prepare(`select resource,last_status as status,last_attempt_at_utc as lastAttemptAtUtc,last_success_at_utc as lastSuccessAtUtc,last_error as error from provider_sync_state where data_scope='production' order by resource`).all(),
    env.CORE_DB.prepare(`select admin_job_id as jobId,job_type as jobType,entity_type as entityType,entity_id as entityId,status,error_message as errorMessage,correlation_id as correlationId,created_at_utc as createdAtUtc,completed_at_utc as completedAtUtc from admin_jobs order by created_at_utc desc limit 30`).all(),
    env.CORE_DB.prepare(`select
      (select count(*) from notifications where created_at_utc >= datetime('now','-24 hours')) created24h,
      (select count(*) from notifications where browser_push_delivered_at_utc is not null and created_at_utc >= datetime('now','-24 hours')) pushed24h,
      (select count(*) from push_subscriptions where revoked_at_utc is null) activePushDevices`).first(),
    env.LEAGUE_DB_001.prepare(`select status,count(*) count,max(completed_at_utc) lastCompletedAtUtc from scoring_job_receipts group by status`).all(),
  ]);
  return { resources: [
    health("Worker API", "healthy", new Date().toISOString()),
    health("Core D1", "healthy", new Date().toISOString()),
    health("NFL D1", "healthy", new Date().toISOString()),
    health("League shard", "healthy", new Date().toISOString()),
    ...((provider.results ?? []) as Array<Record<string, unknown>>).map((row) => health(`ESPN ${row.resource}`, String(row.status), String(row.lastSuccessAtUtc ?? row.lastAttemptAtUtc ?? ""), row.error)),
  ], shards: shards.results ?? [], jobs: jobs.results ?? [], notifications, scoringReceipts: receipts.results ?? [] };
}

async function usersPage(env: Env, url: URL): Promise<unknown> {
  const q = `%${(url.searchParams.get("q") ?? "").trim().toLowerCase()}%`;
  const rows = await env.CORE_DB.prepare(`select users.user_id as userId,profiles.display_name as displayName,users.email,users.status,users.email_verified_at_utc as emailVerifiedAtUtc,users.last_login_at_utc as lastLoginAtUtc,users.created_at_utc as createdAtUtc,admins.admin_role as adminRole,
    (select count(*) from user_league_directory memberships where memberships.user_id=users.user_id and memberships.removed_at_utc is null) leagueCount
    from users join user_profiles profiles on profiles.user_id=users.user_id left join platform_admins admins on admins.user_id=users.user_id and admins.active=1
    where lower(users.email) like ?1 or lower(profiles.display_name) like ?1 order by users.created_at_utc desc limit 100`).bind(q).all();
  return { items: rows.results ?? [], hasMore: false };
}

async function userDetail(env: Env, userId: string): Promise<unknown> {
  const [user, leagues, sessions, logins, devices] = await Promise.all([
    env.CORE_DB.prepare(`select users.user_id as userId,profiles.display_name as displayName,users.email,users.status,users.email_verified_at_utc as emailVerifiedAtUtc,users.last_login_at_utc as lastLoginAtUtc,users.created_at_utc as createdAtUtc,admins.admin_role as adminRole,admins.active as adminActive from users join user_profiles profiles on profiles.user_id=users.user_id left join platform_admins admins on admins.user_id=users.user_id where users.user_id=?1`).bind(userId).first(),
    env.CORE_DB.prepare(`select directory.league_id as leagueId,directory.league_name as leagueName,directory.league_status as status,memberships.role,memberships.joined_at_utc as joinedAtUtc from user_league_directory memberships join league_directory directory on directory.league_id=memberships.league_id where memberships.user_id=?1 order by memberships.joined_at_utc desc`).bind(userId).all(),
    env.CORE_DB.prepare(`select refresh_token_id as sessionId,created_at_utc as createdAtUtc,expires_at_utc as expiresAtUtc,revoked_at_utc as revokedAtUtc from refresh_tokens where user_id=?1 order by created_at_utc desc limit 30`).bind(userId).all(),
    env.CORE_DB.prepare(`select client_type as clientType,ip_address as ipAddress,user_agent as userAgent,succeeded,created_at_utc as createdAtUtc from user_login_events where user_id=?1 order by created_at_utc desc limit 30`).bind(userId).all(),
    env.CORE_DB.prepare(`select push_subscription_id as deviceId,endpoint,user_agent as userAgent,created_at_utc as createdAtUtc,last_used_at_utc as lastUsedAtUtc,revoked_at_utc as revokedAtUtc from push_subscriptions where user_id=?1 order by last_used_at_utc desc`).bind(userId).all(),
  ]);
  if (!user) throw new ApiException(404, "user_not_found", "User not found.");
  return { user, leagues: leagues.results ?? [], sessions: sessions.results ?? [], loginHistory: logins.results ?? [], notificationDevices: devices.results ?? [] };
}

async function setUserStatus(request: Request, env: Env, admin: AdminPrincipal, userId: string, correlationId: string): Promise<unknown> {
  if (userId === admin.userId) throw new ApiException(409, "self_lock_forbidden", "You cannot lock your own administrator account.");
  const body = await readJson<{ status?: string; reason?: string }>(request);
  if (body.status !== "active" && body.status !== "disabled") throw new ApiException(400, "invalid_user_status", "Status must be active or disabled.");
  const reason = requiredReason(body.reason);
  const before = await env.CORE_DB.prepare("select status from users where user_id=?1").bind(userId).first<{status:string}>();
  if (!before) throw new ApiException(404, "user_not_found", "User not found.");
  const now = new Date().toISOString();
  const statements = [
    env.CORE_DB.prepare("update users set status=?1,updated_at_utc=?2 where user_id=?3").bind(body.status, now, userId),
    auditStatement(env, admin.userId, "admin.user.status_changed", "user", userId, correlationId, { before: before.status, after: body.status, reason }),
  ];
  if (body.status === "disabled") statements.push(env.CORE_DB.prepare("update refresh_tokens set revoked_at_utc=coalesce(revoked_at_utc,?1) where user_id=?2").bind(now,userId));
  await env.CORE_DB.batch(statements);
  return { userId, status: body.status, sessionsRevoked: body.status === "disabled" };
}

async function revokeUserSessions(env: Env, admin: AdminPrincipal, userId: string, correlationId: string): Promise<unknown> {
  const now = new Date().toISOString();
  const result = await env.CORE_DB.prepare("update refresh_tokens set revoked_at_utc=?1 where user_id=?2 and revoked_at_utc is null").bind(now,userId).run();
  await audit(env, admin.userId, "admin.user.sessions_revoked", "user", userId, correlationId, { count: result.meta.changes });
  return { userId, revokedCount: result.meta.changes };
}

async function setAdminRole(request: Request, env: Env, admin: AdminPrincipal, userId: string, correlationId: string): Promise<unknown> {
  const body = await readJson<{ role?: string | null; reason?: string }>(request);
  const role = body.role ?? null;
  if (role !== null && !["owner","operator","support"].includes(role)) throw new ApiException(400,"invalid_admin_role","Choose owner, operator, support, or no role.");
  const now = new Date().toISOString();
  if (role) await env.CORE_DB.prepare(`insert into platform_admins(user_id,admin_role,active,created_by_user_id,created_at_utc,updated_at_utc) values(?1,?2,1,?3,?4,?4) on conflict(user_id) do update set admin_role=excluded.admin_role,active=1,updated_at_utc=excluded.updated_at_utc`).bind(userId,role,admin.userId,now).run();
  else await env.CORE_DB.prepare("update platform_admins set active=0,updated_at_utc=?1 where user_id=?2").bind(now,userId).run();
  await audit(env,admin.userId,"admin.user.role_changed","user",userId,correlationId,{role,reason:requiredReason(body.reason)});
  return { userId, adminRole: role };
}

async function leaguesPage(env: Env, url: URL): Promise<unknown> {
  const q = `%${(url.searchParams.get("q") ?? "").trim().toLowerCase()}%`;
  const rows = await env.CORE_DB.prepare(`select league_id as leagueId,league_name as leagueName,league_status as status,season_year as seasonYear,max_teams as maxTeams,member_count as memberCount,commissioner_user_id as commissionerUserId,shard_key as shardKey,created_at_utc as createdAtUtc,updated_at_utc as updatedAtUtc from league_directory where lower(league_name) like ?1 or lower(league_id) like ?1 order by created_at_utc desc limit 100`).bind(q).all();
  return { items: rows.results ?? [], hasMore: false };
}

async function leagueDetail(env: Env, leagueId: string): Promise<unknown> {
  const directory = await env.CORE_DB.prepare("select * from league_directory where league_id=?1").bind(leagueId).first<Record<string,unknown>>();
  if (!directory) throw new ApiException(404,"league_not_found","League not found.");
  const db = leagueDb(env,directory.shard_binding_name);
  const [league, settings, members, teams, scoring, transactions, matchups, audits] = await Promise.all([
    db.prepare("select * from leagues where league_id=?1").bind(leagueId).first(),
    db.prepare("select setting_key as settingKey,value_json as valueJson,revision_number as revisionNumber,updated_at_utc as updatedAtUtc from league_settings where league_id=?1 order by setting_key").bind(leagueId).all(),
    db.prepare("select members.user_id as userId,members.role,members.status,(select managers.fantasy_team_id from fantasy_team_managers managers join fantasy_teams teams on teams.fantasy_team_id=managers.fantasy_team_id where managers.user_id=members.user_id and managers.removed_at_utc is null and teams.league_season_id=(select league_season_id from league_seasons where league_id=?1 order by season_year desc limit 1) limit 1) as fantasyTeamId,members.joined_at_utc as joinedAtUtc from league_members members where members.league_id=?1 order by members.joined_at_utc").bind(leagueId).all(),
    db.prepare("select fantasy_team_id as fantasyTeamId,team_name as teamName,abbreviation,revision_number as revisionNumber from fantasy_teams where league_season_id=(select league_season_id from league_seasons where league_id=?1 order by season_year desc limit 1) order by team_name").bind(leagueId).all(),
    db.prepare("select versions.scoring_version_id as scoringVersionId,versions.version_number as versionNumber,versions.status,details.effective_scope as effectiveScope,versions.created_at_utc as createdAtUtc from scoring_versions versions left join scoring_version_details details on details.scoring_version_id=versions.scoring_version_id where versions.league_season_id=(select league_season_id from league_seasons where league_id=?1 order by season_year desc limit 1) order by versions.version_number desc").bind(leagueId).all(),
    db.prepare("select transaction_id as transactionId,transaction_type as transactionType,status,created_at_utc as createdAtUtc from transactions where league_season_id=(select league_season_id from league_seasons where league_id=?1 order by season_year desc limit 1) order by created_at_utc desc limit 50").bind(leagueId).all(),
    db.prepare("select matchup_id as matchupId,week_number as weekNumber,status,data_scope as dataScope,revision_number as revisionNumber,updated_at_utc as updatedAtUtc from matchups where league_season_id=(select league_season_id from league_seasons where league_id=?1 order by season_year desc limit 1) order by week_number desc,matchup_number limit 50").bind(leagueId).all(),
    db.prepare("select action,entity_type as entityType,entity_id as entityId,actor_user_id as actorUserId,correlation_id as correlationId,created_at_utc as createdAtUtc,metadata_json as metadataJson from league_audit_events where league_id=?1 order by created_at_utc desc limit 50").bind(leagueId).all(),
  ]);
  return { directory, league, settings: settings.results??[], members: members.results??[], teams: teams.results??[], scoringVersions: scoring.results??[], transactions: transactions.results??[], matchups: matchups.results??[], commissionerActions: audits.results??[] };
}

async function setLeagueArchive(request:Request,env:Env,admin:AdminPrincipal,leagueId:string,action:string,correlationId:string):Promise<unknown>{
  const body=await readJson<{reason?:string}>(request);const reason=requiredReason(body.reason);const now=new Date().toISOString();const directory=await env.CORE_DB.prepare("select shard_binding_name,league_status from league_directory where league_id=?1").bind(leagueId).first<{shard_binding_name:string;league_status:string}>();if(!directory)throw new ApiException(404,"league_not_found","League not found.");const archived=action==="archive";const status=archived?"archived":"active";const db=leagueDb(env,directory.shard_binding_name);
  await db.batch([db.prepare("update leagues set archived_at_utc=?1,updated_at_utc=?2,revision_number=revision_number+1 where league_id=?3").bind(archived?now:null,now,leagueId),db.prepare("insert into league_audit_events(league_audit_event_id,league_id,actor_user_id,action,entity_type,entity_id,correlation_id,created_at_utc,metadata_json) values(?1,?2,?3,?4,'league',?2,?5,?6,?7)").bind(crypto.randomUUID(),leagueId,admin.userId,`admin.league.${action}`,correlationId,now,JSON.stringify({reason}))]);
  await env.CORE_DB.batch([env.CORE_DB.prepare("update league_directory set league_status=?1,archived_at_utc=?2,updated_at_utc=?3,revision_number=revision_number+1 where league_id=?4").bind(status,archived?now:null,now,leagueId),auditStatement(env,admin.userId,`admin.league.${action}`,"league",leagueId,correlationId,{before:directory.league_status,after:status,reason})]);
  return {leagueId,status};
}

async function recalculateLeague(request:Request,env:Env,admin:AdminPrincipal,leagueId:string,correlationId:string):Promise<unknown>{
  const body=await readJson<{weeks?:number[];reason?:string}>(request);const reason=requiredReason(body.reason);const weeks=(body.weeks??[]).filter((week)=>Number.isInteger(week)&&week>=1&&week<=22);if(!weeks.length)throw new ApiException(400,"weeks_required","Choose at least one week to recalculate.");const season=await env.LEAGUE_DB_001.prepare("select league_season_id,scoring_version_id from league_seasons where league_id=?1 and status in ('setup','active') order by season_year desc limit 1").bind(leagueId).first<{league_season_id:string;scoring_version_id:string}>();if(!season?.scoring_version_id)throw new ApiException(409,"scoring_not_ready","The league does not have an active scoring version.");const jobId=crypto.randomUUID();const now=new Date().toISOString();const job:ScoringJob={type:"scoring.configuration.applied",leagueId,seasonId:season.league_season_id,scoringVersionId:season.scoring_version_id,effectiveScope:"admin-recalculation",affectedWeeks:weeks,recalculationRequired:true,requestedAtUtc:now};await env.CORE_DB.prepare("insert into admin_jobs(admin_job_id,job_type,entity_type,entity_id,status,requested_by_user_id,correlation_id,request_json,created_at_utc) values(?1,'league.recalculate','league',?2,'queued',?3,?4,?5,?6)").bind(jobId,leagueId,admin.userId,correlationId,JSON.stringify({weeks,reason}),now).run();await env.SCORING_QUEUE.send(job);await audit(env,admin.userId,"admin.league.recalculation_requested","league",leagueId,correlationId,{jobId,weeks,reason});return{jobId,status:"queued",leagueId,weeks};
}

async function auditPage(env:Env,url:URL):Promise<unknown>{const q=`%${(url.searchParams.get("q")??"").trim().toLowerCase()}%`;const rows=await env.CORE_DB.prepare("select audit_event_id as auditEventId,actor_user_id as actorUserId,action,entity_type as entityType,entity_id as entityId,correlation_id as correlationId,created_at_utc as createdAtUtc,metadata_json as metadataJson from audit_events where lower(action) like ?1 or lower(coalesce(entity_id,'')) like ?1 or lower(correlation_id) like ?1 order by created_at_utc desc limit 200").bind(q).all();return{items:rows.results??[],hasMore:false};}
function health(resource:string,status:string,lastSuccessAtUtc:string,error?:unknown){return{resource,status:status==="succeeded"?"healthy":status,lastSuccessAtUtc,error:error??null};}
function requireRole(admin:AdminPrincipal,allowed:string[]):void{if(!allowed.includes(admin.role))throw new ApiException(403,"admin_role_required","Your administrator role does not allow this action.");}
function leagueDb(env:Env,binding:unknown):D1Database{if(binding!=="LEAGUE_DB_001")throw new ApiException(503,"league_shard_unavailable","The league shard is not available in this deployment.");return env.LEAGUE_DB_001;}
function auditStatement(env:Env,actor:string,action:string,entityType:string,entityId:string,correlationId:string,metadata:unknown):D1PreparedStatement{return env.CORE_DB.prepare("insert into audit_events(audit_event_id,actor_user_id,action,entity_type,entity_id,correlation_id,created_at_utc,metadata_json) values(?1,?2,?3,?4,?5,?6,?7,?8)").bind(crypto.randomUUID(),actor,action,entityType,entityId,correlationId,new Date().toISOString(),JSON.stringify(metadata));}
async function audit(env:Env,actor:string,action:string,entityType:string,entityId:string,correlationId:string,metadata:unknown):Promise<void>{await auditStatement(env,actor,action,entityType,entityId,correlationId,metadata).run();}
