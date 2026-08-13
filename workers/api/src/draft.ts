import type {
  DraftPickView,
  DraftPlayerView,
  DraftQueueUpdateRequest,
  DraftRoomResponse,
  DraftSetupRequest,
  DraftTeamView,
  DraftType,
  MakeDraftPickRequest,
} from "@myffl/api-contracts";
import { authenticate, type HandlerResult } from "./auth";
import { ApiException, readJson } from "./http";
import { getLeagueRow, requireLeagueRole } from "./league";
import { newId, type AccessTokenPrincipal } from "./security";
import { enqueueLeagueNotification } from "./notifications";
import { rankingContext, rankingsForPlayers, type FantasyProsRanking } from "./fantasypros";
import { espnAthleteHeadshotUrl, providerAssetUrl } from "./assets";

const managerRoles = ["commissioner", "co-commissioner", "manager"] as const;
const commissionerRoles = ["commissioner", "co-commissioner"] as const;

interface DraftRow {
  draft_id: string; league_season_id: string; draft_type: DraftType;
  status: DraftRoomResponse["status"]; scheduled_at_utc: string | null;
  rounds: number; pick_seconds: number; autopick_enabled: number;
  current_overall_pick: number; pick_deadline_utc: string | null; revision_number: number;
}

interface TeamRow {
  fantasy_team_id: string; team_name: string; manager_user_id: string; slot_number: number;
}

interface PickRow {
  draft_pick_id: string; overall_pick: number; round_number: number; slot_number: number;
  fantasy_team_id: string; team_name: string; nfl_player_id: string | null;
  selection_source: DraftPickView["selectionSource"]; status: "active" | "skipped";
  made_at_utc: string;
}

interface PlayerRow {
  nfl_player_id: string; display_name: string; position: string | null; abbreviation: string | null; headshot_object_key: string | null; logo_object_key: string | null;
}

interface DraftContext {
  principal: AccessTokenPrincipal; db: D1Database; leagueId: string; seasonId: string;
  role: "commissioner" | "co-commissioner" | "manager";
  draft: DraftRow;
}

export async function handleDraftRequest(
  request: Request,
  url: URL,
  env: Env,
  _ctx: ExecutionContext,
  correlationId: string,
): Promise<HandlerResult<unknown> | undefined> {
  const match = url.pathname.match(/^\/api\/leagues\/([^/]+)\/draft(?:\/(setup|players|queue|pick|start|pause|resume|undo|skip|time|reset|complete))?$/);
  if (!match) return undefined;
  const principal = await authenticate(request, env);
  const leagueId = match[1];
  const action = match[2];
  const context = await getDraftContext(principal, leagueId, env);

  if (request.method === "GET" && !action) {
    await advanceExpiredDraft(context, env, correlationId);
    return { data: await getDraftRoom(context, env) };
  }
  if (request.method === "GET" && action === "players") {
    return { data: await searchDraftPlayers(context, env, url) };
  }
  if (request.method === "PUT" && action === "setup") {
    requireCommissioner(context);
    await saveSetup(context, env, await readJson<DraftSetupRequest>(request), correlationId);
    return { data: await getDraftRoom(await refreshContext(context), env) };
  }
  if (request.method === "PUT" && action === "queue") {
    await saveQueue(context, await readJson<DraftQueueUpdateRequest>(request));
    return { data: await getDraftRoom(await refreshContext(context), env) };
  }
  if (request.method === "POST" && action === "pick") {
    await makeDraftPick(context, env, await readJson<MakeDraftPickRequest>(request), correlationId);
    return { data: await getDraftRoom(await refreshContext(context), env) };
  }
  if (request.method === "POST" && ["start", "pause", "resume", "undo", "skip", "reset", "complete"].includes(action ?? "")) {
    requireCommissioner(context);
    const body = await readJson<{ revisionNumber?: number }>(request);
    await commissionerAction(context, env, action!, body.revisionNumber, correlationId);
    return { data: await getDraftRoom(await refreshContext(context), env) };
  }
  if (request.method === "POST" && action === "time") {
    requireCommissioner(context);
    const body = await readJson<{ revisionNumber?: number; seconds?: number }>(request);
    await adjustTime(context, body.revisionNumber, Number(body.seconds), correlationId);
    return { data: await getDraftRoom(await refreshContext(context), env) };
  }
  return undefined;
}

async function getDraftContext(principal: AccessTokenPrincipal, leagueId: string, env: Env): Promise<DraftContext> {
  const access = await requireLeagueRole(principal, leagueId, env, [...managerRoles]);
  const league = await getLeagueRow(access.db, leagueId);
  let draft = await access.db.prepare("select * from drafts where league_season_id = ?1").bind(league.league_season_id).first<DraftRow>();
  if (!draft) {
    await createDefaultDraft(access.db, league.league_season_id, principal.userId);
    draft = await access.db.prepare("select * from drafts where league_season_id = ?1").bind(league.league_season_id).first<DraftRow>();
  }
  if (!draft) throw new ApiException(500, "draft_initialization_failed", "The draft could not be initialized.");
  if (draft.status === "setup" || draft.status === "scheduled") await syncDraftSlots(access.db, draft.draft_id, league.league_season_id);
  return { principal, db: access.db, leagueId, seasonId: league.league_season_id, role: access.role, draft };
}

async function createDefaultDraft(db: D1Database, seasonId: string, userId: string): Promise<void> {
  const roster = await db.prepare(
    `select coalesce(sum(slots.slot_count), 16) as rounds from roster_slots slots
     join roster_definitions definitions on definitions.roster_definition_id = slots.roster_definition_id
     where definitions.league_season_id = ?1 and slots.slot_type not in ('IR','PUP','TAXI')`,
  ).bind(seasonId).first<{ rounds: number }>();
  const now = new Date().toISOString();
  const draftId = newId("drf");
  try {
    await db.prepare(
      `insert into drafts (draft_id, league_season_id, draft_type, status, rounds, pick_seconds,
       autopick_enabled, current_overall_pick, revision_number, created_by_user_id, created_at_utc, updated_at_utc)
       values (?1, ?2, 'snake', 'setup', ?3, 90, 1, 1, 1, ?4, ?5, ?5)`,
    ).bind(draftId, seasonId, Math.max(1, roster?.rounds ?? 16), userId, now).run();
  } catch (error) {
    const existing = await db.prepare("select draft_id from drafts where league_season_id = ?1").bind(seasonId).first();
    if (!existing) throw error;
  }
  const current = await db.prepare("select draft_id from drafts where league_season_id = ?1").bind(seasonId).first<{ draft_id: string }>();
  if (current) await syncDraftSlots(db, current.draft_id, seasonId);
}

async function syncDraftSlots(db: D1Database, draftId: string, seasonId: string): Promise<void> {
  const teams = await db.prepare(
    `select fantasy_team_id, created_at_utc from fantasy_teams where league_season_id = ?1 order by created_at_utc, fantasy_team_id`,
  ).bind(seasonId).all<{ fantasy_team_id: string; created_at_utc: string }>();
  const existing = await db.prepare("select fantasy_team_id from draft_slots where draft_id = ?1").bind(draftId).all<{ fantasy_team_id: string }>();
  const seen = new Set((existing.results ?? []).map((row) => row.fantasy_team_id));
  let slot = (existing.results?.length ?? 0) + 1;
  for (const team of teams.results ?? []) {
    if (seen.has(team.fantasy_team_id)) continue;
    await db.prepare(
      `insert into draft_slots (draft_slot_id, draft_id, slot_number, fantasy_team_id, original_fantasy_team_id, created_at_utc)
       values (?1, ?2, ?3, ?4, ?4, ?5)`,
    ).bind(newId("dsl"), draftId, slot++, team.fantasy_team_id, new Date().toISOString()).run();
  }
}

async function getDraftRoom(context: DraftContext, env: Env): Promise<DraftRoomResponse> {
  const [teamsResult, picksResult, queueRows] = await Promise.all([
    context.db.prepare(
      `select teams.fantasy_team_id, teams.team_name, teams.manager_user_id, slots.slot_number
       from draft_slots slots join fantasy_teams teams on teams.fantasy_team_id = slots.fantasy_team_id
       where slots.draft_id = ?1 order by slots.slot_number`,
    ).bind(context.draft.draft_id).all<TeamRow>(),
    context.db.prepare(
      `select picks.draft_pick_id, picks.overall_pick, picks.round_number, picks.slot_number,
              picks.fantasy_team_id, teams.team_name, picks.nfl_player_id, picks.selection_source,
              picks.status, picks.made_at_utc
       from draft_picks picks join fantasy_teams teams on teams.fantasy_team_id = picks.fantasy_team_id
       where picks.draft_id = ?1 and picks.status in ('active','skipped') order by picks.overall_pick`,
    ).bind(context.draft.draft_id).all<PickRow>(),
    loadQueuePlayerIds(context),
  ]);
  const teams = (teamsResult.results ?? []).map(teamView);
  const pickRows = picksResult.results ?? [];
  const playerIds = [...new Set(pickRows.flatMap((pick) => pick.nfl_player_id ? [pick.nfl_player_id] : []))];
  const profiles = await loadPlayerProfiles(env.NFL_DB, playerIds);
  const picks = pickRows.map((pick) => pickView(pick, profiles.get(pick.nfl_player_id ?? "")));
  const queueProfiles = await loadPlayerProfiles(env.NFL_DB, queueRows.map((row) => row.nfl_player_id));
  const drafted = new Set(playerIds);
  const queue = queueRows.flatMap((row, index) => {
    const profile = queueProfiles.get(row.nfl_player_id);
    return profile ? [playerView(profile, index + 1, true, drafted.has(row.nfl_player_id), undefined, env)] : [];
  });
  const slotNumber = draftSlotForPick(context.draft.draft_type, context.draft.current_overall_pick, teams.length);
  const currentTeam = teams.find((team) => team.slotNumber === slotNumber);
  const totalPicks = teams.length * context.draft.rounds;
  return {
    draftId: context.draft.draft_id, leagueId: context.leagueId, seasonId: context.seasonId,
    draftType: context.draft.draft_type, status: context.draft.status,
    scheduledAtUtc: context.draft.scheduled_at_utc ?? undefined, rounds: context.draft.rounds,
    pickSeconds: context.draft.pick_seconds, autopickEnabled: Boolean(context.draft.autopick_enabled),
    currentOverallPick: context.draft.current_overall_pick, totalPicks,
    currentRound: teams.length ? Math.ceil(context.draft.current_overall_pick / teams.length) : 1,
    currentSlotNumber: slotNumber, currentTeamId: currentTeam?.fantasyTeamId,
    currentTeamName: currentTeam?.teamName, pickDeadlineUtc: context.draft.pick_deadline_utc ?? undefined,
    revisionNumber: context.draft.revision_number,
    canManage: commissionerRoles.includes(context.role as typeof commissionerRoles[number]),
    canPick: context.draft.status === "active" && currentTeam?.managerUserId === context.principal.userId,
    teams, picks, queue,
  };
}

async function searchDraftPlayers(context: DraftContext, env: Env, url: URL): Promise<DraftPlayerView[]> {
  const query = String(url.searchParams.get("query") ?? "").trim().slice(0, 60);
  const position = String(url.searchParams.get("position") ?? "").trim().toUpperCase();
  const limit = Math.min(200, Math.max(10, Number(url.searchParams.get("limit") ?? 100)));
  const pickedRows = await context.db.prepare(
    "select nfl_player_id from draft_picks where draft_id = ?1 and status = 'active' and nfl_player_id is not null",
  ).bind(context.draft.draft_id).all<{ nfl_player_id: string }>();
  const drafted = new Set((pickedRows.results ?? []).map((row) => row.nfl_player_id));
  const queue = new Set((await loadQueuePlayerIds(context)).map((row) => row.nfl_player_id));
  const conditions = ["players.position is not null"];
  const bindings: unknown[] = [];
  if (query) { bindings.push(`%${query.replaceAll("%", "")}%`); conditions.push(`players.display_name like ?${bindings.length}`); }
  if (position) { bindings.push(position); conditions.push(`players.position = ?${bindings.length}`); }
  const ranking = await rankingContext(context.db, context.leagueId, context.seasonId);
  const result = await env.NFL_DB.prepare(
    `select players.nfl_player_id, players.display_name, players.position, teams.abbreviation,
      players.headshot_object_key, teams.logo_object_key
     from nfl_players players left join nfl_teams teams on teams.nfl_team_id = players.current_team_id
     left join fantasypros_rankings rankings on rankings.nfl_player_id = players.nfl_player_id
      and rankings.season_year = ?${bindings.length + 1} and rankings.scoring = ?${bindings.length + 2}
     where ${conditions.join(" and ")}
     order by coalesce(rankings.overall_rank, 99999), players.display_name limit ${Math.max(limit * 3, 300)}`,
  ).bind(...bindings, ranking.seasonYear, ranking.scoring).all<PlayerRow>();
  const profiles = result.results ?? [];
  const [weights, rankings] = await Promise.all([
    positionWeights(context.db, context.seasonId),
    rankingsForPlayers(env.NFL_DB, ranking.seasonYear, ranking.scoring, profiles.map((player) => player.nfl_player_id)),
  ]);
  return profiles.map((player) => ({ player, ranking: rankings.get(player.nfl_player_id), score: weights.get(player.position ?? "") ?? 0 }))
    .sort((left, right) => (left.ranking?.overallRank ?? 99999) - (right.ranking?.overallRank ?? 99999) || right.score - left.score || left.player.display_name.localeCompare(right.player.display_name))
    .slice(0, limit)
    .map((item, index) => playerView(item.player, item.ranking?.overallRank ?? index + 1, queue.has(item.player.nfl_player_id), drafted.has(item.player.nfl_player_id), item.ranking, env));
}

async function saveSetup(context: DraftContext, env: Env, body: DraftSetupRequest, correlationId: string): Promise<void> {
  requireRevision(context.draft, body.revisionNumber);
  if (!(["setup", "scheduled"] as string[]).includes(context.draft.status)) throw new ApiException(409, "draft_setup_locked", "Pause or reset the draft before changing setup.");
  if (!(["snake", "linear", "third-round-reversal", "offline"] as string[]).includes(body.draftType)) throw new ApiException(400, "invalid_draft_type", "Choose a supported draft type.");
  if (!Number.isInteger(body.rounds) || body.rounds < 1 || body.rounds > 60) throw new ApiException(400, "invalid_draft_rounds", "Draft rounds must be between 1 and 60.");
  if (!Number.isInteger(body.pickSeconds) || body.pickSeconds < 15 || body.pickSeconds > 600) throw new ApiException(400, "invalid_pick_timer", "Pick time must be between 15 and 600 seconds.");
  const teams = await loadTeams(context.db, context.draft.draft_id);
  if (body.teamOrder.length !== teams.length || new Set(body.teamOrder).size !== teams.length || body.teamOrder.some((id) => !teams.some((team) => team.fantasy_team_id === id))) {
    throw new ApiException(400, "invalid_draft_order", "Draft order must contain every league team exactly once.");
  }
  const scheduled = body.scheduledAtUtc ? new Date(body.scheduledAtUtc) : null;
  if (scheduled && Number.isNaN(scheduled.getTime())) throw new ApiException(400, "invalid_draft_date", "Choose a valid draft date and time.");
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    context.db.prepare(
      `update drafts set draft_type = ?1, status = ?2, scheduled_at_utc = ?3, rounds = ?4,
       pick_seconds = ?5, autopick_enabled = ?6, revision_number = revision_number + 1, updated_at_utc = ?7
       where draft_id = ?8 and revision_number = ?9`,
    ).bind(body.draftType, scheduled ? "scheduled" : "setup", scheduled?.toISOString() ?? null, body.rounds, body.pickSeconds, body.autopickEnabled ? 1 : 0, now, context.draft.draft_id, body.revisionNumber),
  ];
  body.teamOrder.forEach((teamId, index) => statements.push(context.db.prepare(
    "update draft_slots set slot_number = ?1 where draft_id = ?2 and fantasy_team_id = ?3",
  ).bind(-(index + 1), context.draft.draft_id, teamId)));
  body.teamOrder.forEach((teamId, index) => statements.push(context.db.prepare(
    "update draft_slots set slot_number = ?1 where draft_id = ?2 and fantasy_team_id = ?3",
  ).bind(index + 1, context.draft.draft_id, teamId)));
  statements.push(audit(context, "draft.setup.updated", "draft", context.draft.draft_id, correlationId, context.draft, body));
  if (scheduled) statements.push(context.db.prepare("insert into league_activity (league_activity_id,league_id,actor_user_id,activity_type,message,created_at_utc,metadata_json) values (?1,?2,?3,'draft.scheduled',?4,?5,?6)").bind(newId("lga"),context.leagueId,context.principal.userId,`The draft was scheduled for ${scheduled.toISOString()}.`,now,JSON.stringify({draftId:context.draft.draft_id,scheduledAtUtc:scheduled.toISOString()})));
  await context.db.batch(statements);
  if (scheduled) await enqueueLeagueNotification(env,context.leagueId,{notificationType:"draft-scheduled",title:"Draft scheduled",body:`Your league draft is scheduled for ${scheduled.toLocaleString()}.`,entityType:"draft",entityId:context.draft.draft_id,actionUrl:`/?league=${context.leagueId}&tab=draft`},{excludeUserIds:[context.principal.userId]});
}

async function makeDraftPick(context: DraftContext, env: Env, body: MakeDraftPickRequest, correlationId: string, source?: DraftPickView["selectionSource"]): Promise<void> {
  requireRevision(context.draft, body.revisionNumber);
  if (context.draft.status !== "active") throw new ApiException(409, "draft_not_active", "The draft is not active.");
  if (body.expectedOverallPick !== context.draft.current_overall_pick) throw new ApiException(409, "draft_pick_advanced", "The draft advanced. Reload the current pick.");
  const teams = await loadTeams(context.db, context.draft.draft_id);
  const slotNumber = draftSlotForPick(context.draft.draft_type, context.draft.current_overall_pick, teams.length);
  const team = teams.find((candidate) => candidate.slot_number === slotNumber);
  if (!team) throw new ApiException(409, "draft_order_incomplete", "The current draft slot has no team.");
  const commissioner = commissionerRoles.includes(context.role as typeof commissionerRoles[number]);
  if (!source && !commissioner && team.manager_user_id !== context.principal.userId) throw new ApiException(403, "not_on_clock", "Your team is not on the clock.");
  const player = await env.NFL_DB.prepare(
    "select nfl_player_id, display_name, position from nfl_players where nfl_player_id = ?1",
  ).bind(body.playerId).first<{ nfl_player_id: string; display_name: string; position: string | null }>();
  if (!player) throw new ApiException(404, "player_not_found", "Player not found.");
  await requireRosterLegal(context.db, context.seasonId, team.fantasy_team_id, player.position ?? "");
  const now = new Date().toISOString();
  const pickId = newId("dpk");
  const next = nextDraftState(context.draft.current_overall_pick, context.draft.rounds, teams.length, context.draft.pick_seconds, now);
  const selectionSource = source ?? (commissioner && team.manager_user_id !== context.principal.userId ? "commissioner" : "manager");
  try {
    await context.db.batch([
      context.db.prepare(
        `insert into draft_picks (draft_pick_id, draft_id, overall_pick, round_number, slot_number,
         fantasy_team_id, nfl_player_id, selection_source, selected_by_user_id, status, made_at_utc, updated_at_utc)
         values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'active', ?10, ?10)`,
      ).bind(pickId, context.draft.draft_id, context.draft.current_overall_pick, Math.ceil(context.draft.current_overall_pick / teams.length), slotNumber, team.fantasy_team_id, player.nfl_player_id, selectionSource, context.principal.userId, now),
      context.db.prepare(
        `insert into fantasy_roster_players (fantasy_roster_player_id, league_season_id, fantasy_team_id,
         nfl_player_id, position, roster_status, acquisition_type, acquisition_id, acquired_at_utc)
         values (?1, ?2, ?3, ?4, ?5, 'active', 'draft', ?6, ?7)`,
      ).bind(newId("frp"), context.seasonId, team.fantasy_team_id, player.nfl_player_id, player.position ?? "UNK", pickId, now),
      context.db.prepare(
        `update drafts set current_overall_pick = ?1, status = ?2, pick_deadline_utc = ?3,
         completed_at_utc = ?4, revision_number = revision_number + 1, updated_at_utc = ?5
         where draft_id = ?6 and revision_number = ?7`,
      ).bind(next.overallPick, next.status, next.deadline, next.status === "completed" ? now : null, now, context.draft.draft_id, body.revisionNumber),
      audit(context, "draft.pick.made", "draft_pick", pickId, correlationId, null, { playerId: player.nfl_player_id, playerName: player.display_name, teamId: team.fantasy_team_id, overallPick: context.draft.current_overall_pick, source: selectionSource }),
      context.db.prepare("insert into league_activity (league_activity_id,league_id,actor_user_id,activity_type,message,created_at_utc,metadata_json) values (?1,?2,?3,'draft.pick',?4,?5,?6)").bind(newId("lga"),context.leagueId,context.principal.userId,`${team.team_name} drafted ${player.display_name} at pick ${context.draft.current_overall_pick}.`,now,JSON.stringify({draftId:context.draft.draft_id,pickId,teamId:team.fantasy_team_id,playerId:player.nfl_player_id})),
    ]);
  } catch (error) {
    throw new ApiException(409, "draft_pick_conflict", "That pick or player was selected by another request. Reload the draft room.", { cause: error instanceof Error ? error.message : String(error) });
  }
  await enqueueLeagueNotification(env,context.leagueId,{notificationType:"draft-pick",title:`${team.team_name} selected ${player.display_name}`,body:`Pick ${context.draft.current_overall_pick} is complete.`,entityType:"draft-pick",entityId:pickId,actionUrl:`/?league=${context.leagueId}&tab=draft`},{excludeUserIds:[context.principal.userId]});
  if (next.status === "active") {
    const nextSlot=draftSlotForPick(context.draft.draft_type,next.overallPick,teams.length);const nextTeam=teams.find((candidate)=>candidate.slot_number===nextSlot);
    if(nextTeam)await enqueueLeagueNotification(env,context.leagueId,{notificationType:"on-the-clock",title:"You are on the clock",body:`${nextTeam.team_name} has pick ${next.overallPick}.`,entityType:"draft",entityId:context.draft.draft_id,actionUrl:`/?league=${context.leagueId}&tab=draft`},{recipientUserIds:[nextTeam.manager_user_id]});
  }
}

async function commissionerAction(context: DraftContext, env: Env, action: string, revision: number | undefined, correlationId: string): Promise<void> {
  requireRevision(context.draft, revision);
  const now = new Date().toISOString();
  if (action === "start") {
    const teams = await loadTeams(context.db, context.draft.draft_id);
    if (!teams.length) throw new ApiException(409, "draft_teams_required", "Add a league team before starting the draft.");
    await setDraftState(context, "active", deadline(now, context.draft.pick_seconds), action, correlationId, now, { started_at_utc: now });
    await enqueueLeagueNotification(env,context.leagueId,{notificationType:"draft-starting",title:"Draft started",body:"Your league draft is now live.",entityType:"draft",entityId:context.draft.draft_id,actionUrl:`/?league=${context.leagueId}&tab=draft`});
    return;
  }
  if (action === "pause") { await setDraftState(context, "paused", null, action, correlationId, now); return; }
  if (action === "resume") { await setDraftState(context, "active", deadline(now, context.draft.pick_seconds), action, correlationId, now); return; }
  if (action === "complete") { await setDraftState(context, "completed", null, action, correlationId, now, { completed_at_utc: now }); return; }
  if (action === "skip") { await skipPick(context, correlationId); return; }
  if (action === "undo") { await undoPick(context, correlationId); return; }
  if (action === "reset") {
    const teams = await loadTeams(context.db, context.draft.draft_id);
    const allTeams = await context.db.prepare("select fantasy_team_id from fantasy_teams where league_season_id = ?1 order by created_at_utc, fantasy_team_id").bind(context.seasonId).all<{ fantasy_team_id: string }>();
    const statements: D1PreparedStatement[] = [
      context.db.prepare("delete from fantasy_roster_players where league_season_id = ?1 and acquisition_type = 'draft'").bind(context.seasonId),
      context.db.prepare("delete from draft_queue_players where draft_queue_id in (select draft_queue_id from draft_queues where draft_id = ?1)").bind(context.draft.draft_id),
      context.db.prepare("delete from draft_rankings where draft_id = ?1").bind(context.draft.draft_id),
      context.db.prepare("delete from draft_queues where draft_id = ?1").bind(context.draft.draft_id),
      context.db.prepare("delete from draft_picks where draft_id = ?1").bind(context.draft.draft_id),
      context.db.prepare("delete from draft_slots where draft_id = ?1").bind(context.draft.draft_id),
      context.db.prepare("update drafts set status = 'setup', current_overall_pick = 1, pick_deadline_utc = null, started_at_utc = null, completed_at_utc = null, revision_number = revision_number + 1, updated_at_utc = ?1 where draft_id = ?2 and revision_number = ?3").bind(now, context.draft.draft_id, revision),
      audit(context, "draft.reset", "draft", context.draft.draft_id, correlationId, context.draft, { status: "setup" }),
    ];
    (allTeams.results?.length ? allTeams.results : teams).forEach((team, index) => statements.push(context.db.prepare("insert into draft_slots (draft_slot_id, draft_id, slot_number, fantasy_team_id, original_fantasy_team_id, created_at_utc) values (?1, ?2, ?3, ?4, ?4, ?5)").bind(newId("dsl"), context.draft.draft_id, index + 1, team.fantasy_team_id, now)));
    await context.db.batch(statements);
    return;
  }
  throw new ApiException(400, "invalid_draft_action", "Unsupported draft action.");
}

async function setDraftState(context: DraftContext, status: DraftRoomResponse["status"], pickDeadline: string | null, action: string, correlationId: string, now: string, extra: { started_at_utc?: string; completed_at_utc?: string } = {}): Promise<void> {
  await context.db.batch([
    context.db.prepare(
      `update drafts set status = ?1, pick_deadline_utc = ?2,
       started_at_utc = coalesce(started_at_utc, ?3), completed_at_utc = coalesce(?4, completed_at_utc),
       revision_number = revision_number + 1, updated_at_utc = ?5 where draft_id = ?6 and revision_number = ?7`,
    ).bind(status, pickDeadline, extra.started_at_utc ?? null, extra.completed_at_utc ?? null, now, context.draft.draft_id, context.draft.revision_number),
    audit(context, `draft.${action}`, "draft", context.draft.draft_id, correlationId, context.draft, { status }),
  ]);
}

async function skipPick(context: DraftContext, correlationId: string): Promise<void> {
  if (context.draft.status !== "active") throw new ApiException(409, "draft_not_active", "The draft is not active.");
  const teams = await loadTeams(context.db, context.draft.draft_id);
  const slot = draftSlotForPick(context.draft.draft_type, context.draft.current_overall_pick, teams.length);
  const team = teams.find((item) => item.slot_number === slot);
  if (!team) throw new ApiException(409, "draft_order_incomplete", "The current draft slot has no team.");
  const now = new Date().toISOString();
  const next = nextDraftState(context.draft.current_overall_pick, context.draft.rounds, teams.length, context.draft.pick_seconds, now);
  await context.db.batch([
    context.db.prepare(
      `insert into draft_picks (draft_pick_id, draft_id, overall_pick, round_number, slot_number, fantasy_team_id,
       selection_source, selected_by_user_id, status, made_at_utc, updated_at_utc)
       values (?1, ?2, ?3, ?4, ?5, ?6, 'skip', ?7, 'skipped', ?8, ?8)`,
    ).bind(newId("dpk"), context.draft.draft_id, context.draft.current_overall_pick, Math.ceil(context.draft.current_overall_pick / teams.length), slot, team.fantasy_team_id, context.principal.userId, now),
    context.db.prepare("update drafts set current_overall_pick = ?1, status = ?2, pick_deadline_utc = ?3, revision_number = revision_number + 1, updated_at_utc = ?4 where draft_id = ?5 and revision_number = ?6").bind(next.overallPick, next.status, next.deadline, now, context.draft.draft_id, context.draft.revision_number),
    audit(context, "draft.pick.skipped", "draft", context.draft.draft_id, correlationId, null, { overallPick: context.draft.current_overall_pick }),
  ]);
}

async function undoPick(context: DraftContext, correlationId: string): Promise<void> {
  const pick = await context.db.prepare(
    "select draft_pick_id, overall_pick from draft_picks where draft_id = ?1 and status in ('active','skipped') order by overall_pick desc limit 1",
  ).bind(context.draft.draft_id).first<{ draft_pick_id: string; overall_pick: number }>();
  if (!pick) throw new ApiException(409, "draft_pick_missing", "There is no pick to undo.");
  const now = new Date().toISOString();
  await context.db.batch([
    context.db.prepare("update draft_picks set status = 'undone', updated_at_utc = ?1, revision_number = revision_number + 1 where draft_pick_id = ?2").bind(now, pick.draft_pick_id),
    context.db.prepare("update fantasy_roster_players set released_at_utc = ?1, revision_number = revision_number + 1 where acquisition_type = 'draft' and acquisition_id = ?2 and released_at_utc is null").bind(now, pick.draft_pick_id),
    context.db.prepare("update drafts set status = 'paused', current_overall_pick = ?1, pick_deadline_utc = null, completed_at_utc = null, revision_number = revision_number + 1, updated_at_utc = ?2 where draft_id = ?3 and revision_number = ?4").bind(pick.overall_pick, now, context.draft.draft_id, context.draft.revision_number),
    audit(context, "draft.pick.undone", "draft_pick", pick.draft_pick_id, correlationId, null, { overallPick: pick.overall_pick }),
  ]);
}

async function adjustTime(context: DraftContext, revision: number | undefined, seconds: number, correlationId: string): Promise<void> {
  requireRevision(context.draft, revision);
  if (context.draft.status !== "active" || !context.draft.pick_deadline_utc) throw new ApiException(409, "draft_clock_inactive", "The draft clock is not active.");
  if (!Number.isInteger(seconds) || seconds < -300 || seconds > 300 || seconds === 0) throw new ApiException(400, "invalid_time_adjustment", "Adjust the clock by 1 to 300 seconds.");
  const next = new Date(Math.max(Date.now(), Date.parse(context.draft.pick_deadline_utc) + seconds * 1000)).toISOString();
  const now = new Date().toISOString();
  await context.db.batch([
    context.db.prepare("update drafts set pick_deadline_utc = ?1, revision_number = revision_number + 1, updated_at_utc = ?2 where draft_id = ?3 and revision_number = ?4").bind(next, now, context.draft.draft_id, revision),
    audit(context, "draft.clock.adjusted", "draft", context.draft.draft_id, correlationId, { deadline: context.draft.pick_deadline_utc }, { deadline: next, seconds }),
  ]);
}

async function saveQueue(context: DraftContext, body: DraftQueueUpdateRequest): Promise<void> {
  const team = (await loadTeams(context.db, context.draft.draft_id)).find((item) => item.manager_user_id === context.principal.userId);
  if (!team) throw new ApiException(403, "draft_team_required", "A managed fantasy team is required for a draft queue.");
  const playerIds = [...new Set(Array.isArray(body.playerIds) ? body.playerIds.filter((value): value is string => typeof value === "string").slice(0, 200) : [])];
  const now = new Date().toISOString();
  let queue = await context.db.prepare("select draft_queue_id from draft_queues where draft_id = ?1 and fantasy_team_id = ?2 and user_id = ?3").bind(context.draft.draft_id, team.fantasy_team_id, context.principal.userId).first<{ draft_queue_id: string }>();
  if (!queue) {
    queue = { draft_queue_id: newId("dqu") };
    await context.db.prepare("insert into draft_queues (draft_queue_id, draft_id, fantasy_team_id, user_id, autopick_enabled, updated_at_utc) values (?1, ?2, ?3, ?4, ?5, ?6)").bind(queue.draft_queue_id, context.draft.draft_id, team.fantasy_team_id, context.principal.userId, body.autopickEnabled ? 1 : 0, now).run();
  }
  const statements: D1PreparedStatement[] = [
    context.db.prepare("delete from draft_queue_players where draft_queue_id = ?1").bind(queue.draft_queue_id),
    context.db.prepare("update draft_queues set autopick_enabled = ?1, revision_number = revision_number + 1, updated_at_utc = ?2 where draft_queue_id = ?3").bind(body.autopickEnabled ? 1 : 0, now, queue.draft_queue_id),
  ];
  playerIds.forEach((playerId, index) => statements.push(context.db.prepare("insert into draft_queue_players (draft_queue_player_id, draft_queue_id, nfl_player_id, priority, created_at_utc) values (?1, ?2, ?3, ?4, ?5)").bind(newId("dqp"), queue!.draft_queue_id, playerId, index + 1, now)));
  await context.db.batch(statements);
}

async function advanceExpiredDraft(context: DraftContext, env: Env, correlationId: string): Promise<void> {
  if (context.draft.status !== "active" || !context.draft.pick_deadline_utc || Date.parse(context.draft.pick_deadline_utc) > Date.now()) return;
  if (!context.draft.autopick_enabled) { await commissionerAction(context, env, "pause", context.draft.revision_number, correlationId); return; }
  const player = await chooseAutopick(context, env);
  if (!player) { await commissionerAction(context, env, "pause", context.draft.revision_number, correlationId); return; }
  await makeDraftPick(context, env, { playerId: player, expectedOverallPick: context.draft.current_overall_pick, revisionNumber: context.draft.revision_number }, correlationId, "autopick");
}

export async function processExpiredDrafts(env: Env): Promise<void> {
  const now = new Date().toISOString();
  const due = await env.LEAGUE_DB_001.prepare(
    `select draft_id from drafts
     where (status = 'active' and pick_deadline_utc <= ?1)
        or (status = 'scheduled' and scheduled_at_utc <= ?1)
     order by coalesce(pick_deadline_utc, scheduled_at_utc) limit 10`,
  ).bind(now).all<{ draft_id: string }>();
  for (const row of due.results ?? []) {
    const draft = await env.LEAGUE_DB_001.prepare("select * from drafts where draft_id = ?1").bind(row.draft_id).first<DraftRow>();
    if (!draft) continue;
    const league = await env.LEAGUE_DB_001.prepare("select league_id from league_seasons where league_season_id = ?1").bind(draft.league_season_id).first<{ league_id: string }>();
    const commissioner = league ? await env.LEAGUE_DB_001.prepare("select commissioner_user_id from leagues where league_id = ?1").bind(league.league_id).first<{ commissioner_user_id: string }>() : null;
    if (!league || !commissioner) continue;
    const principal: AccessTokenPrincipal = { userId: commissioner.commissioner_user_id, sessionId: "draft-timer", displayName: "Draft timer", email: "", emailVerified: true, expiresAtUtc: new Date(Date.now() + 60_000).toISOString() };
    const context: DraftContext = { principal, db: env.LEAGUE_DB_001, leagueId: league.league_id, seasonId: draft.league_season_id, role: "commissioner", draft };
    if (draft.status === "scheduled") {
      await setDraftState(context, "active", deadline(now, draft.pick_seconds), "started", crypto.randomUUID(), now, { started_at_utc: now });
    } else {
      await advanceExpiredDraft(context, env, crypto.randomUUID());
    }
  }
}

async function chooseAutopick(context: DraftContext, env: Env): Promise<string | null> {
  const teams = await loadTeams(context.db, context.draft.draft_id);
  const slot = draftSlotForPick(context.draft.draft_type, context.draft.current_overall_pick, teams.length);
  const team = teams.find((item) => item.slot_number === slot);
  if (!team) return null;
  const picked = await context.db.prepare("select nfl_player_id from draft_picks where draft_id = ?1 and status = 'active' and nfl_player_id is not null").bind(context.draft.draft_id).all<{ nfl_player_id: string }>();
  const unavailable = new Set((picked.results ?? []).map((row) => row.nfl_player_id));
  const queued = await context.db.prepare(
    `select players.nfl_player_id from draft_queue_players players join draft_queues queues on queues.draft_queue_id = players.draft_queue_id
     where queues.draft_id = ?1 and queues.fantasy_team_id = ?2 order by players.priority`,
  ).bind(context.draft.draft_id, team.fantasy_team_id).all<{ nfl_player_id: string }>();
  const fallback = await env.NFL_DB.prepare("select nfl_player_id, display_name, position, null as abbreviation, headshot_object_key, null as logo_object_key from nfl_players where position is not null order by display_name limit 800").all<PlayerRow>();
  const profiles = fallback.results ?? [];
  const ranking = await rankingContext(context.db, context.leagueId, context.seasonId);
  const [weights, rankings] = await Promise.all([
    positionWeights(context.db, context.seasonId),
    rankingsForPlayers(env.NFL_DB, ranking.seasonYear, ranking.scoring, profiles.map((player) => player.nfl_player_id)),
  ]);
  const candidates = [...(queued.results ?? []).map((row) => row.nfl_player_id), ...profiles.sort((a, b) => (rankings.get(a.nfl_player_id)?.overallRank ?? 99999) - (rankings.get(b.nfl_player_id)?.overallRank ?? 99999) || (weights.get(b.position ?? "") ?? 0) - (weights.get(a.position ?? "") ?? 0) || a.display_name.localeCompare(b.display_name)).map((row) => row.nfl_player_id)];
  for (const playerId of candidates) {
    if (unavailable.has(playerId)) continue;
    const player = await env.NFL_DB.prepare("select position from nfl_players where nfl_player_id = ?1").bind(playerId).first<{ position: string | null }>();
    try { await requireRosterLegal(context.db, context.seasonId, team.fantasy_team_id, player?.position ?? ""); return playerId; } catch { continue; }
  }
  return null;
}

async function requireRosterLegal(db: D1Database, seasonId: string, teamId: string, position: string): Promise<void> {
  const [limit, count, rosterSize, rosterCount] = await Promise.all([
    db.prepare(`select limits.maximum_count from roster_position_limits limits join roster_definitions definitions on definitions.roster_definition_id = limits.roster_definition_id where definitions.league_season_id = ?1 and limits.position = ?2`).bind(seasonId, position).first<{ maximum_count: number }>(),
    db.prepare(`select count(*) as count from fantasy_roster_players where league_season_id = ?1 and fantasy_team_id = ?2 and position = ?3 and released_at_utc is null`).bind(seasonId, teamId, position).first<{ count: number }>(),
    db.prepare(`select sum(slots.slot_count) as size from roster_slots slots join roster_definitions definitions on definitions.roster_definition_id = slots.roster_definition_id where definitions.league_season_id = ?1 and slots.slot_type not in ('IR','PUP','TAXI')`).bind(seasonId).first<{ size: number }>(),
    db.prepare("select count(*) as count from fantasy_roster_players where league_season_id = ?1 and fantasy_team_id = ?2 and released_at_utc is null").bind(seasonId, teamId).first<{ count: number }>(),
  ]);
  if (limit && (count?.count ?? 0) >= limit.maximum_count) throw new ApiException(409, "roster_position_full", `The ${position} roster limit has been reached.`);
  if ((rosterCount?.count ?? 0) >= (rosterSize?.size ?? 60)) throw new ApiException(409, "roster_full", "The team roster is full.");
}

export function draftSlotForPick(type: DraftType, overallPick: number, teamCount: number): number {
  if (teamCount < 1) return 0;
  const round = Math.ceil(overallPick / teamCount);
  const index = (overallPick - 1) % teamCount;
  const reversed = type === "snake" ? round % 2 === 0 : type === "third-round-reversal" ? round === 2 || (round >= 3 && round % 2 === 1) : false;
  return reversed ? teamCount - index : index + 1;
}

export function nextDraftState(overallPick: number, rounds: number, teams: number, pickSeconds: number, nowIso: string): { overallPick: number; status: "active" | "completed"; deadline: string | null } {
  const next = overallPick + 1;
  const completed = next > rounds * teams;
  return { overallPick: completed ? overallPick : next, status: completed ? "completed" : "active", deadline: completed ? null : deadline(nowIso, pickSeconds) };
}

function deadline(nowIso: string, seconds: number): string { return new Date(Date.parse(nowIso) + seconds * 1000).toISOString(); }
function requireCommissioner(context: DraftContext): void { if (!commissionerRoles.includes(context.role as typeof commissionerRoles[number])) throw new ApiException(403, "commissioner_required", "Commissioner access is required."); }
function requireRevision(draft: DraftRow, revision: number | undefined): void { if (!Number.isInteger(revision) || revision !== draft.revision_number) throw new ApiException(409, "draft_revision_conflict", "The draft changed. Reload before continuing.", { currentRevisionNumber: draft.revision_number }); }
async function refreshContext(context: DraftContext): Promise<DraftContext> { const draft = await context.db.prepare("select * from drafts where draft_id = ?1").bind(context.draft.draft_id).first<DraftRow>(); if (!draft) throw new Error("Draft missing"); return { ...context, draft }; }
async function loadTeams(db: D1Database, draftId: string): Promise<TeamRow[]> { const result = await db.prepare(`select teams.fantasy_team_id, teams.team_name, teams.manager_user_id, slots.slot_number from draft_slots slots join fantasy_teams teams on teams.fantasy_team_id = slots.fantasy_team_id where slots.draft_id = ?1 order by slots.slot_number`).bind(draftId).all<TeamRow>(); return result.results ?? []; }
function teamView(row: TeamRow): DraftTeamView { return { fantasyTeamId: row.fantasy_team_id, teamName: row.team_name, managerUserId: row.manager_user_id, slotNumber: row.slot_number }; }
function pickView(row: PickRow, player?: PlayerRow): DraftPickView { return { draftPickId: row.draft_pick_id, overallPick: row.overall_pick, roundNumber: row.round_number, slotNumber: row.slot_number, fantasyTeamId: row.fantasy_team_id, teamName: row.team_name, playerId: row.nfl_player_id ?? undefined, playerName: player?.display_name, position: player?.position ?? undefined, nflTeam: player?.abbreviation ?? undefined, selectionSource: row.selection_source, status: row.status, madeAtUtc: row.made_at_utc }; }
function playerView(row: PlayerRow, rank: number, queued: boolean, drafted: boolean, ranking: FantasyProsRanking | undefined, env: Env): DraftPlayerView { return { playerId: row.nfl_player_id, displayName: row.display_name, position: row.position ?? "UNK", nflTeam: row.abbreviation ?? undefined, headshotUrl: espnAthleteHeadshotUrl(env, row.nfl_player_id, row.headshot_object_key), nflTeamLogoUrl: providerAssetUrl(env, row.logo_object_key), rank, queued, drafted, expertConsensusRank: ranking?.overallRank, positionRank: ranking?.positionRank, tier: ranking?.tier, byeWeek: ranking?.byeWeek, rankingUpdatedAt: ranking?.sourceUpdatedAt ?? ranking?.fetchedAtUtc }; }
async function loadPlayerProfiles(db: D1Database, ids: string[]): Promise<Map<string, PlayerRow>> { if (!ids.length) return new Map(); const placeholders = ids.map((_, index) => `?${index + 1}`).join(","); const result = await db.prepare(`select players.nfl_player_id, players.display_name, players.position, teams.abbreviation, players.headshot_object_key, teams.logo_object_key from nfl_players players left join nfl_teams teams on teams.nfl_team_id = players.current_team_id where players.nfl_player_id in (${placeholders})`).bind(...ids).all<PlayerRow>(); return new Map((result.results ?? []).map((row) => [row.nfl_player_id, row])); }
async function loadQueuePlayerIds(context: DraftContext): Promise<Array<{ nfl_player_id: string }>> { const result = await context.db.prepare(`select players.nfl_player_id from draft_queue_players players join draft_queues queues on queues.draft_queue_id = players.draft_queue_id where queues.draft_id = ?1 and queues.user_id = ?2 order by players.priority`).bind(context.draft.draft_id, context.principal.userId).all<{ nfl_player_id: string }>(); return result.results ?? []; }
async function positionWeights(db: D1Database, seasonId: string): Promise<Map<string, number>> { const weights = new Map(Object.entries({ QB: 90, RB: 82, WR: 80, TE: 70, K: 35, DST: 45, DL: 40, LB: 44, DB: 42 })); const rules = await db.prepare(`select rules.statistic_key, rules.point_value_milli from scoring_rules rules join scoring_versions versions on versions.scoring_version_id = rules.scoring_version_id where versions.league_season_id = ?1 and versions.status = 'active' and rules.enabled = 1`).bind(seasonId).all<{ statistic_key: string; point_value_milli: number }>(); for (const rule of rules.results ?? []) { if (rule.statistic_key === "receptions") { weights.set("RB", (weights.get("RB") ?? 0) + rule.point_value_milli / 1000); weights.set("WR", (weights.get("WR") ?? 0) + rule.point_value_milli / 1000); weights.set("TE", (weights.get("TE") ?? 0) + rule.point_value_milli / 1000); } if (rule.statistic_key === "tight_end_reception_bonus") weights.set("TE", (weights.get("TE") ?? 0) + rule.point_value_milli / 500); if (rule.statistic_key.startsWith("idp_")) ["DL", "LB", "DB"].forEach((position) => weights.set(position, (weights.get(position) ?? 0) + 8)); } return weights; }
function audit(context: DraftContext, action: string, entityType: string, entityId: string, correlationId: string, before: unknown, after: unknown): D1PreparedStatement { return context.db.prepare(`insert into draft_audit_events (draft_audit_event_id, draft_id, actor_user_id, action, entity_type, entity_id, before_json, after_json, correlation_id, created_at_utc) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`).bind(newId("dae"), context.draft.draft_id, context.principal.userId, action, entityType, entityId, before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after), correlationId, new Date().toISOString()); }
