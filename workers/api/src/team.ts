import type { LeaguePlayerSearchItem, LineupOptimizationResponse, PlayerProfileResponse, SaveLineupRequest, TeamLineupResponse } from "@myffl/api-contracts";
import { authenticate, type HandlerResult } from "./auth";
import { ApiException, readJson } from "./http";
import { getLeagueRow, requireLeagueRole } from "./league";
import { getProviderRuntime } from "./game-feed";
import { newId, type AccessTokenPrincipal } from "./security";
import { rankingContext, rankingsForPlayers } from "./fantasypros";
import { espnAthleteHeadshotUrl, providerAssetUrl } from "./assets";
import { loadRemainingAverageProjectionPoints, loadUpcomingProjectionWeek, loadWeeklyProjectionPoints } from "./projections";
import { fantasyPositionSql, isFantasyPosition } from "./player-eligibility";

interface RosterRow { fantasy_roster_player_id: string; nfl_player_id: string; position: string; }
interface AssignmentRow extends RosterRow { slot_type: string; slot_index: number; }
interface SlotRow { slot_type: string; display_name: string; slot_count: number; eligible_positions_json: string; contributes_points: number; }
interface ProfileRow { nfl_player_id: string; display_name: string; position: string | null; abbreviation: string | null; current_team_id: string | null; headshot_object_key: string | null; logo_object_key: string | null; season_outlook?: string | null; }

export async function handleTeamRequest(request: Request, url: URL, env: Env, correlationId: string): Promise<HandlerResult<unknown> | undefined> {
  const match = url.pathname.match(/^\/api\/leagues\/([^/]+)\/(team|players)(?:\/([^/]+))?$/);
  if (!match) return undefined;
  const principal = await authenticate(request, env);
  const leagueId = match[1];
  const resource = match[2];
  const itemId = match[3];
  const access = await requireLeagueRole(principal, leagueId, env, ["commissioner", "co-commissioner", "manager"]);
  const league = await getLeagueRow(access.db, leagueId);

  if (resource === "team" && request.method === "GET" && !itemId) {
    const week = requireWeek(url.searchParams.get("week"));
    return { data: await getTeamLineup(principal, access.db, leagueId, league.league_season_id, week, env) };
  }
  if (resource === "team" && request.method === "PUT" && itemId === "lineup") {
    const body = await readJson<SaveLineupRequest>(request);
    return { data: await saveLineup(principal, access.db, leagueId, league.league_season_id, body, env, correlationId) };
  }
  if (resource === "team" && request.method === "POST" && itemId === "optimize") {
    const body = await readJson<{ weekNumber?: number }>(request);
    return { data: await optimizeLineup(principal, access.db, leagueId, league.league_season_id, requireWeek(body.weekNumber), env) };
  }
  if (resource === "players" && request.method === "GET" && itemId) {
    return { data: await getPlayerProfile(principal, access.db, leagueId, league.league_season_id, itemId, env) };
  }
  if (resource === "players" && request.method === "GET" && !itemId) {
    return { data: await searchPlayers(principal, access.db, league.league_season_id, url, env) };
  }
  if (resource === "players" && request.method === "POST" && itemId) {
    const body = await readJson<{ watched?: boolean }>(request);
    await setWatched(access.db, league.league_season_id, principal.userId, itemId, Boolean(body.watched));
    return { data: await getPlayerProfile(principal, access.db, leagueId, league.league_season_id, itemId, env) };
  }
  return undefined;
}

async function getTeamLineup(principal: AccessTokenPrincipal, db: D1Database, leagueId: string, seasonId: string, week: number, env: Env): Promise<TeamLineupResponse> {
  const team = await requireManagedTeam(db, seasonId, principal.userId);
  let period = await db.prepare("select lineup_period_id, revision_number from lineup_periods where league_season_id = ?1 and fantasy_team_id = ?2 and week_number = ?3").bind(seasonId, team.fantasy_team_id, week).first<{ lineup_period_id: string; revision_number: number }>();
  if (!period) {
    await initializeLineup(db, seasonId, team.fantasy_team_id, principal.userId, week);
    period = await db.prepare("select lineup_period_id, revision_number from lineup_periods where league_season_id = ?1 and fantasy_team_id = ?2 and week_number = ?3").bind(seasonId, team.fantasy_team_id, week).first<{ lineup_period_id: string; revision_number: number }>();
  }
  if (!period) throw new ApiException(500, "lineup_initialization_failed", "The lineup could not be initialized.");
  await syncLineupRoster(db, period.lineup_period_id, seasonId, team.fantasy_team_id, principal.userId);
  period = await db.prepare("select lineup_period_id, revision_number from lineup_periods where lineup_period_id = ?1").bind(period.lineup_period_id).first<{ lineup_period_id: string; revision_number: number }>() ?? period;
  const [assignments, slots] = await Promise.all([
    db.prepare(`select roster.fantasy_roster_player_id, roster.nfl_player_id, roster.position, assignments.slot_type, assignments.slot_index from lineup_assignments assignments join fantasy_roster_players roster on roster.fantasy_roster_player_id = assignments.fantasy_roster_player_id where assignments.lineup_period_id = ?1 order by assignments.slot_type, assignments.slot_index`).bind(period.lineup_period_id).all<AssignmentRow>(),
    loadSlots(db, seasonId),
  ]);
  const rows = assignments.results ?? [];
  const runtime = await getProviderRuntime(env);
  const profiles = await loadProfiles(env.NFL_DB, rows.map((row) => row.nfl_player_id));
  const locks = await loadLocks(env.NFL_DB, rows.map((row) => row.nfl_player_id), week, runtime.dataScope);
  const injuries = await loadInjuries(env.NFL_DB, rows.map((row) => row.nfl_player_id), runtime.dataScope);
  const points = await loadFantasyPoints(db, env.NFL_DB, seasonId, rows.map((row) => row.nfl_player_id), week, runtime.dataScope);
  const projectedPoints = await loadWeeklyProjectionPoints(db, env.NFL_DB, seasonId, rows.map((row) => row.nfl_player_id), week);
  const eligible = slotEligibility(slots);
  const occupied = new Set(rows.map((row) => `${row.slot_type}:${row.slot_index}`));
  const emptySlots = expandSlots(slots).filter((slot) => !occupied.has(`${slot.slotType}:${slot.slotIndex}`)).map(({ slotType, slotIndex, displayName }) => ({ slotType, slotIndex, displayName }));
  return {
    leagueId, seasonId, fantasyTeamId: team.fantasy_team_id, teamName: team.team_name, weekNumber: week,
    revisionNumber: period.revision_number,
    players: rows.map((row) => {
      const profile = profiles.get(row.nfl_player_id);
      const lock = locks.get(row.nfl_player_id);
      return {
        rosterPlayerId: row.fantasy_roster_player_id, playerId: row.nfl_player_id,
        displayName: profile?.display_name ?? "NFL player", position: row.position,
        nflTeam: profile?.abbreviation ?? undefined, headshotUrl: espnAthleteHeadshotUrl(env, row.nfl_player_id, profile?.headshot_object_key), nflTeamLogoUrl: providerAssetUrl(env, profile?.logo_object_key), injuryStatus: injuries.get(row.nfl_player_id),
        slotType: row.slot_type, slotIndex: row.slot_index,
        eligibleSlots: [...(eligible.get(row.position) ?? []), "BENCH", "IR"].filter((value, index, array) => array.indexOf(value) === index),
        locked: Boolean(lock?.locked), locksAtUtc: lock?.startsAt,
        fantasyPoints: points.get(row.nfl_player_id),
        projectedPoints: projectedPoints.get(row.nfl_player_id),
      };
    }),
    emptySlots,
  };
}

async function searchPlayers(principal: AccessTokenPrincipal, db: D1Database, seasonId: string, url: URL, env: Env): Promise<LeaguePlayerSearchItem[]> {
  const query = (url.searchParams.get("query") ?? "").trim().slice(0, 80);
  const position = (url.searchParams.get("position") ?? "").trim().toUpperCase().slice(0, 12);
  const team = (url.searchParams.get("team") ?? "").trim().toUpperCase().slice(0, 8);
  const availableOnly = url.searchParams.get("available") === "true";
  const watchedOnly = url.searchParams.get("watched") === "true";
  const sort = (url.searchParams.get("sort") ?? "rank").trim().toLowerCase();
  const limit = Math.min(250, Math.max(1, Number(url.searchParams.get("limit") ?? 120) || 120));
  const league = await db.prepare("select league_id from league_seasons where league_season_id=?1").bind(seasonId).first<{ league_id: string }>();
  const ranking = await rankingContext(db, league?.league_id ?? "", seasonId);
  const orderClause = sort === "rank"
    ? "order by players.current_team_id is null, coalesce(rankings.overall_rank, 99999), players.display_name"
    : "order by players.display_name";
  const result = await env.NFL_DB.prepare(
    `select players.nfl_player_id, players.display_name, players.position, teams.abbreviation, players.current_team_id,
      players.headshot_object_key, teams.logo_object_key
     from nfl_players players left join nfl_teams teams on teams.nfl_team_id = players.current_team_id
     left join fantasypros_rankings rankings on rankings.nfl_player_id = players.nfl_player_id
      and rankings.season_year = ?6 and rankings.scoring = ?7
     where ${fantasyPositionSql()} and (?1 = '' or players.display_name like ?2) and (?3 = '' or players.position = ?3)
       and (?4 = '' or teams.abbreviation = ?4)
     ${orderClause} limit ?5`,
  ).bind(query, `%${query}%`, position, team, 1200, ranking.seasonYear, ranking.scoring).all<ProfileRow>();
  const allProfiles = result.results ?? [];
  const rankings = await rankingsForPlayers(env.NFL_DB, ranking.seasonYear, ranking.scoring, allProfiles.map((profile) => profile.nfl_player_id));
  if (!allProfiles.length) return [];
  const ids = allProfiles.map((profile) => profile.nfl_player_id);
  const runtime = await getProviderRuntime(env);
  const projectionWeek = await loadUpcomingProjectionWeek(env.NFL_DB, ranking.seasonYear);
  const [owners, watches, injuries, weeklyProjectionPoints, remainingAverageProjectionPoints] = await Promise.all([
    loadOwners(db, seasonId, ids),
    loadWatches(db, seasonId, principal.userId, ids),
    loadInjuries(env.NFL_DB, ids, runtime.dataScope),
    loadWeeklyProjectionPoints(db, env.NFL_DB, seasonId, ids, projectionWeek),
    loadRemainingAverageProjectionPoints(db, env.NFL_DB, seasonId, ids, projectionWeek),
  ]);
  const ownerMap = new Map(owners.map((owner) => [owner.nfl_player_id, owner]));
  const watched = new Set(watches);
  const profiles = allProfiles
    .filter((profile) => !watchedOnly || watched.has(profile.nfl_player_id))
    .filter((profile) => !availableOnly || !ownerMap.has(profile.nfl_player_id))
    .sort((left, right) => comparePlayers(left, right, sort, rankings, weeklyProjectionPoints, remainingAverageProjectionPoints))
    .slice(0, limit);
  return profiles.map((profile) => {
    const owner = ownerMap.get(profile.nfl_player_id);
    const expert = rankings.get(profile.nfl_player_id);
    return { playerId: profile.nfl_player_id, displayName: profile.display_name, position: profile.position ?? "UNK", nflTeam: profile.abbreviation ?? undefined, headshotUrl: espnAthleteHeadshotUrl(env, profile.nfl_player_id, profile.headshot_object_key), nflTeamLogoUrl: providerAssetUrl(env, profile.logo_object_key), injuryStatus: injuries.get(profile.nfl_player_id), rosteredByTeamId: owner?.fantasy_team_id, rosteredByTeamName: owner?.team_name, watched: watched.has(profile.nfl_player_id), expertConsensusRank: expert?.overallRank, positionRank: expert?.positionRank, tier: expert?.tier, byeWeek: expert?.byeWeek, rankingUpdatedAt: expert?.sourceUpdatedAt ?? expert?.fetchedAtUtc, projectedPoints: weeklyProjectionPoints.get(profile.nfl_player_id), remainingAverageProjectedPoints: remainingAverageProjectionPoints.get(profile.nfl_player_id) };
  });
}

function comparePlayers(left: ProfileRow, right: ProfileRow, sort: string, rankings: Map<string, { overallRank?: number }>, weeklyProjectionPoints: Map<string, number>, remainingAverageProjectionPoints: Map<string, number>): number {
  const signed = compareSignedPlayers(left, right);
  if (signed !== 0) return signed;
  if (sort === "name-desc") return right.display_name.localeCompare(left.display_name);
  if (sort === "team") return (left.abbreviation ?? "ZZZ").localeCompare(right.abbreviation ?? "ZZZ") || left.display_name.localeCompare(right.display_name);
  if (sort === "position") return (left.position ?? "ZZZ").localeCompare(right.position ?? "ZZZ") || (rankings.get(left.nfl_player_id)?.overallRank ?? 99999) - (rankings.get(right.nfl_player_id)?.overallRank ?? 99999) || left.display_name.localeCompare(right.display_name);
  if (sort === "rank") return (rankings.get(left.nfl_player_id)?.overallRank ?? 99999) - (rankings.get(right.nfl_player_id)?.overallRank ?? 99999) || left.display_name.localeCompare(right.display_name);
  if (sort === "projected-week") return (weeklyProjectionPoints.get(right.nfl_player_id) ?? -9999) - (weeklyProjectionPoints.get(left.nfl_player_id) ?? -9999) || left.display_name.localeCompare(right.display_name);
  if (sort === "projected-remaining-average") return (remainingAverageProjectionPoints.get(right.nfl_player_id) ?? -9999) - (remainingAverageProjectionPoints.get(left.nfl_player_id) ?? -9999) || left.display_name.localeCompare(right.display_name);
  return left.display_name.localeCompare(right.display_name);
}

function compareSignedPlayers(left: ProfileRow, right: ProfileRow): number {
  if (left.current_team_id && !right.current_team_id) return -1;
  if (!left.current_team_id && right.current_team_id) return 1;
  return 0;
}

async function loadFantasyPoints(db: D1Database, nflDb: D1Database, seasonId: string, playerIds: string[], week: number, dataScope: string): Promise<Map<string, number>> {
  if (!playerIds.length) return new Map();
  const events = await nflDb.prepare("select nfl_event_id from nfl_events where week = ?1 and season_year = (select max(season_year) from nfl_events)").bind(week).all<{ nfl_event_id: string }>();
  const eventIds = (events.results ?? []).map((event) => event.nfl_event_id);
  if (!eventIds.length) return new Map();
  const eventPlaceholders = eventIds.map((_, index) => `?${index + 3}`).join(",");
  const playerPlaceholders = playerIds.map((_, index) => `?${index + eventIds.length + 3}`).join(",");
  const scores = await db.prepare(`select nfl_player_id, sum(total_points_milli) as points from player_event_scores where league_season_id = ?1 and data_scope = ?2 and nfl_event_id in (${eventPlaceholders}) and nfl_player_id in (${playerPlaceholders}) group by nfl_player_id`).bind(seasonId, dataScope, ...eventIds, ...playerIds).all<{ nfl_player_id: string; points: number }>();
  return new Map((scores.results ?? []).map((score) => [score.nfl_player_id, score.points / 1000]));
}

async function syncLineupRoster(db: D1Database, periodId: string, seasonId: string, teamId: string, userId: string): Promise<void> {
  const [rosterResult, assignmentResult, slots] = await Promise.all([
    db.prepare("select fantasy_roster_player_id, nfl_player_id, position from fantasy_roster_players where league_season_id = ?1 and fantasy_team_id = ?2 and released_at_utc is null order by acquired_at_utc").bind(seasonId, teamId).all<RosterRow>(),
    db.prepare("select fantasy_roster_player_id, slot_type, slot_index from lineup_assignments where lineup_period_id = ?1").bind(periodId).all<{ fantasy_roster_player_id: string; slot_type: string; slot_index: number }>(),
    loadSlots(db, seasonId),
  ]);
  const active = new Set((rosterResult.results ?? []).map((row) => row.fantasy_roster_player_id));
  const existing = assignmentResult.results ?? [];
  const removed = existing.filter((row) => !active.has(row.fantasy_roster_player_id));
  const available = expandSlots(slots).filter((slot) => !existing.some((row) => active.has(row.fantasy_roster_player_id) && row.slot_type === slot.slotType && row.slot_index === slot.slotIndex));
  const missing = (rosterResult.results ?? []).filter((row) => !existing.some((item) => item.fantasy_roster_player_id === row.fantasy_roster_player_id));
  if (!removed.length && !missing.length) return;
  const additions: Array<RosterRow & { slotType: string; slotIndex: number }> = [];
  for (const player of missing) {
    let index = available.findIndex((slot) => slot.slotType === "BENCH" && slot.eligiblePositions.includes(player.position));
    if (index < 0) index = available.findIndex((slot) => slot.eligiblePositions.includes(player.position));
    if (index < 0) continue;
    const [slot] = available.splice(index, 1);
    additions.push({ ...player, slotType: slot.slotType, slotIndex: slot.slotIndex });
  }
  const now = new Date().toISOString();
  const period = await db.prepare("select revision_number from lineup_periods where lineup_period_id = ?1").bind(periodId).first<{ revision_number: number }>();
  const nextRevision = (period?.revision_number ?? 1) + 1;
  const statements: D1PreparedStatement[] = removed.map((row) => db.prepare("delete from lineup_assignments where lineup_period_id = ?1 and fantasy_roster_player_id = ?2").bind(periodId, row.fantasy_roster_player_id));
  additions.forEach((assignment) => statements.push(db.prepare("insert into lineup_assignments (lineup_assignment_id, lineup_period_id, fantasy_roster_player_id, slot_type, slot_index, assigned_at_utc) values (?1, ?2, ?3, ?4, ?5, ?6)").bind(newId("lna"), periodId, assignment.fantasy_roster_player_id, assignment.slotType, assignment.slotIndex, now)));
  statements.push(db.prepare("update lineup_periods set revision_number = ?1, updated_by_user_id = ?2, updated_at_utc = ?3 where lineup_period_id = ?4 and revision_number = ?5").bind(nextRevision, userId, now, periodId, period?.revision_number ?? 1));
  statements.push(db.prepare("insert into lineup_revisions (lineup_revision_id, lineup_period_id, revision_number, actor_user_id, reason, assignments_json, created_at_utc) values (?1, ?2, ?3, ?4, 'roster-sync', ?5, ?6)").bind(newId("lnr"), periodId, nextRevision, userId, JSON.stringify({ removed, additions }), now));
  try { await db.batch(statements); } catch { /* Another request may have synchronized the same roster. */ }
}

async function optimizeLineup(principal: AccessTokenPrincipal, db: D1Database, leagueId: string, seasonId: string, week: number, env: Env): Promise<LineupOptimizationResponse> {
  const lineup = await getTeamLineup(principal, db, leagueId, seasonId, week, env);
  const slots = expandSlots(await loadSlots(db, seasonId));
  const occupied = new Set<string>();
  const assigned = new Map<string, { slotType: string; slotIndex: number }>();
  for (const player of lineup.players.filter((item) => item.locked)) {
    assigned.set(player.rosterPlayerId, { slotType: player.slotType, slotIndex: player.slotIndex });
    occupied.add(`${player.slotType}:${player.slotIndex}`);
  }
  const availableSlots = slots.filter((slot) => !occupied.has(`${slot.slotType}:${slot.slotIndex}`));
  const unlocked = lineup.players.filter((player) => !player.locked).sort((left, right) => (right.projectedPoints ?? right.fantasyPoints ?? 0) - (left.projectedPoints ?? left.fantasyPoints ?? 0) || left.displayName.localeCompare(right.displayName));
  const scoringSlots = availableSlots.filter((slot) => slot.contributesPoints);
  for (const slot of scoringSlots) {
    const playerIndex = unlocked.findIndex((player) => !assigned.has(player.rosterPlayerId) && slot.eligiblePositions.includes(player.position));
    if (playerIndex < 0) continue;
    const player = unlocked[playerIndex];
    assigned.set(player.rosterPlayerId, { slotType: slot.slotType, slotIndex: slot.slotIndex });
    occupied.add(`${slot.slotType}:${slot.slotIndex}`);
  }
  const reserveSlots = availableSlots.filter((slot) => !occupied.has(`${slot.slotType}:${slot.slotIndex}`));
  for (const player of unlocked.filter((item) => !assigned.has(item.rosterPlayerId))) {
    let slotIndex = reserveSlots.findIndex((slot) => slot.slotType === "BENCH" && slot.eligiblePositions.includes(player.position));
    if (slotIndex < 0) slotIndex = reserveSlots.findIndex((slot) => slot.eligiblePositions.includes(player.position));
    if (slotIndex < 0) throw new ApiException(409, "optimizer_no_legal_slot", `No legal roster slot is available for ${player.displayName}.`);
    const [slot] = reserveSlots.splice(slotIndex, 1);
    assigned.set(player.rosterPlayerId, { slotType: slot.slotType, slotIndex: slot.slotIndex });
  }
  const assignments = lineup.players.map((player) => ({ rosterPlayerId: player.rosterPlayerId, ...(assigned.get(player.rosterPlayerId) ?? { slotType: player.slotType, slotIndex: player.slotIndex }) }));
  const changes = lineup.players.flatMap((player) => {
    const next = assigned.get(player.rosterPlayerId);
    if (!next || (next.slotType === player.slotType && next.slotIndex === player.slotIndex)) return [];
    return [{ rosterPlayerId: player.rosterPlayerId, displayName: player.displayName, fromSlot: `${player.slotType} ${player.slotIndex}`, toSlot: `${next.slotType} ${next.slotIndex}` }];
  });
  return { weekNumber: week, revisionNumber: lineup.revisionNumber, assignments, changes };
}

async function initializeLineup(db: D1Database, seasonId: string, teamId: string, userId: string, week: number): Promise<void> {
  const [rosterResult, slots] = await Promise.all([
    db.prepare("select fantasy_roster_player_id, nfl_player_id, position from fantasy_roster_players where league_season_id = ?1 and fantasy_team_id = ?2 and released_at_utc is null order by acquired_at_utc").bind(seasonId, teamId).all<RosterRow>(),
    loadSlots(db, seasonId),
  ]);
  const available = expandSlots(slots);
  const assignments: Array<RosterRow & { slotType: string; slotIndex: number }> = [];
  for (const player of rosterResult.results ?? []) {
    let index = available.findIndex((slot) => slot.contributesPoints && slot.eligiblePositions.includes(player.position));
    if (index < 0) index = available.findIndex((slot) => slot.slotType === "BENCH" && slot.eligiblePositions.includes(player.position));
    if (index < 0) index = available.findIndex((slot) => slot.slotType === "IR");
    if (index < 0) continue;
    const [slot] = available.splice(index, 1);
    assignments.push({ ...player, slotType: slot.slotType, slotIndex: slot.slotIndex });
  }
  const now = new Date().toISOString();
  const periodId = newId("lnp");
  const statements: D1PreparedStatement[] = [db.prepare("insert into lineup_periods (lineup_period_id, league_season_id, fantasy_team_id, week_number, revision_number, updated_by_user_id, updated_at_utc) values (?1, ?2, ?3, ?4, 1, ?5, ?6)").bind(periodId, seasonId, teamId, week, userId, now)];
  for (const assignment of assignments) statements.push(db.prepare("insert into lineup_assignments (lineup_assignment_id, lineup_period_id, fantasy_roster_player_id, slot_type, slot_index, assigned_at_utc) values (?1, ?2, ?3, ?4, ?5, ?6)").bind(newId("lna"), periodId, assignment.fantasy_roster_player_id, assignment.slotType, assignment.slotIndex, now));
  statements.push(db.prepare("insert into lineup_revisions (lineup_revision_id, lineup_period_id, revision_number, actor_user_id, reason, assignments_json, created_at_utc) values (?1, ?2, 1, ?3, 'initial-lineup', ?4, ?5)").bind(newId("lnr"), periodId, userId, JSON.stringify(assignments), now));
  try { await db.batch(statements); } catch (error) { const existing = await db.prepare("select lineup_period_id from lineup_periods where league_season_id = ?1 and fantasy_team_id = ?2 and week_number = ?3").bind(seasonId, teamId, week).first(); if (!existing) throw error; }
}

export async function ensureTeamLineupPeriod(db: D1Database, seasonId: string, teamId: string, userId: string, week: number): Promise<string> {
  let period = await db.prepare("select lineup_period_id from lineup_periods where league_season_id=?1 and fantasy_team_id=?2 and week_number=?3").bind(seasonId, teamId, week).first<{ lineup_period_id: string }>();
  if (!period) { await initializeLineup(db, seasonId, teamId, userId, week); period = await db.prepare("select lineup_period_id from lineup_periods where league_season_id=?1 and fantasy_team_id=?2 and week_number=?3").bind(seasonId, teamId, week).first<{ lineup_period_id: string }>(); }
  if (!period) throw new ApiException(500, "lineup_initialization_failed", "The lineup could not be initialized.");
  await syncLineupRoster(db, period.lineup_period_id, seasonId, teamId, userId);
  return period.lineup_period_id;
}

async function saveLineup(principal: AccessTokenPrincipal, db: D1Database, leagueId: string, seasonId: string, body: SaveLineupRequest, env: Env, correlationId: string): Promise<TeamLineupResponse> {
  const week = requireWeek(body.weekNumber);
  const current = await getTeamLineup(principal, db, leagueId, seasonId, week, env);
  if (body.revisionNumber !== current.revisionNumber) throw new ApiException(409, "lineup_revision_conflict", "The lineup changed. Reload before saving.", { currentRevisionNumber: current.revisionNumber });
  if (!Array.isArray(body.assignments) || body.assignments.length !== current.players.length) throw new ApiException(400, "invalid_lineup", "Every rostered player must have one lineup assignment.");
  const playerMap = new Map(current.players.map((player) => [player.rosterPlayerId, player]));
  const slots = expandSlots(await loadSlots(db, seasonId));
  const slotMap = new Map(slots.map((slot) => [`${slot.slotType}:${slot.slotIndex}`, slot]));
  const usedPlayers = new Set<string>(); const usedSlots = new Set<string>();
  for (const assignment of body.assignments) {
    const player = playerMap.get(assignment.rosterPlayerId); const key = `${assignment.slotType}:${assignment.slotIndex}`; const slot = slotMap.get(key);
    if (!player || usedPlayers.has(player.rosterPlayerId) || !slot || usedSlots.has(key) || !slot.eligiblePositions.includes(player.position)) throw new ApiException(400, "invalid_lineup_assignment", "A player is duplicated or in an ineligible slot.");
    const before = `${player.slotType}:${player.slotIndex}`;
    if (player.locked && before !== key) throw new ApiException(409, "player_locked", `${player.displayName} is locked because the NFL game has started.`);
    usedPlayers.add(player.rosterPlayerId); usedSlots.add(key);
  }
  const period = await db.prepare("select lineup_period_id from lineup_periods where league_season_id = ?1 and fantasy_team_id = ?2 and week_number = ?3").bind(seasonId, current.fantasyTeamId, week).first<{ lineup_period_id: string }>();
  if (!period) throw new ApiException(409, "lineup_missing", "Reload the lineup before saving.");
  const now = new Date().toISOString(); const nextRevision = current.revisionNumber + 1;
  const statements: D1PreparedStatement[] = [db.prepare("delete from lineup_assignments where lineup_period_id = ?1").bind(period.lineup_period_id)];
  for (const assignment of body.assignments) statements.push(db.prepare("insert into lineup_assignments (lineup_assignment_id, lineup_period_id, fantasy_roster_player_id, slot_type, slot_index, assigned_at_utc) values (?1, ?2, ?3, ?4, ?5, ?6)").bind(newId("lna"), period.lineup_period_id, assignment.rosterPlayerId, assignment.slotType, assignment.slotIndex, now));
  statements.push(db.prepare("update lineup_periods set revision_number = ?1, updated_by_user_id = ?2, updated_at_utc = ?3 where lineup_period_id = ?4 and revision_number = ?5").bind(nextRevision, principal.userId, now, period.lineup_period_id, current.revisionNumber));
  statements.push(db.prepare("insert into lineup_revisions (lineup_revision_id, lineup_period_id, revision_number, actor_user_id, reason, assignments_json, created_at_utc) values (?1, ?2, ?3, ?4, 'manager-save', ?5, ?6)").bind(newId("lnr"), period.lineup_period_id, nextRevision, principal.userId, JSON.stringify(body.assignments), now));
  statements.push(db.prepare("insert into league_audit_events (league_audit_event_id, league_id, actor_user_id, action, entity_type, entity_id, correlation_id, created_at_utc, metadata_json) values (?1, ?2, ?3, 'lineup.saved', 'lineup_period', ?4, ?5, ?6, ?7)").bind(newId("lae"), leagueId, principal.userId, period.lineup_period_id, correlationId, now, JSON.stringify({ week, revisionNumber: nextRevision })));
  await db.batch(statements);
  return getTeamLineup(principal, db, leagueId, seasonId, week, env);
}

async function getPlayerProfile(principal: AccessTokenPrincipal, db: D1Database, _leagueId: string, seasonId: string, playerId: string, env: Env): Promise<PlayerProfileResponse> {
  const profile = await env.NFL_DB.prepare("select players.nfl_player_id, players.display_name, players.position, teams.abbreviation, players.current_team_id, players.headshot_object_key, teams.logo_object_key, players.season_outlook from nfl_players players left join nfl_teams teams on teams.nfl_team_id = players.current_team_id where players.nfl_player_id = ?1").bind(playerId).first<ProfileRow>();
  if (!profile) throw new ApiException(404, "player_not_found", "Player not found.");
  const runtime = await getProviderRuntime(env);
  const [owner, ownTeam, watched, games, yearlyGames, injury, draft] = await Promise.all([
    db.prepare("select roster.fantasy_team_id, teams.team_name from fantasy_roster_players roster join fantasy_teams teams on teams.fantasy_team_id = roster.fantasy_team_id where roster.league_season_id = ?1 and roster.nfl_player_id = ?2 and roster.released_at_utc is null").bind(seasonId, playerId).first<{ fantasy_team_id: string; team_name: string }>(),
    db.prepare("select fantasy_team_id from fantasy_teams where league_season_id = ?1 and manager_user_id = ?2").bind(seasonId, principal.userId).first<{ fantasy_team_id: string }>(),
    db.prepare("select 1 as watched from player_watchlists where league_season_id = ?1 and user_id = ?2 and nfl_player_id = ?3").bind(seasonId, principal.userId, playerId).first(),
    env.NFL_DB.prepare("select nfl_event_id, stats_json from nfl_player_game_stats where nfl_player_id = ?1 and data_scope = ?2 order by source_updated_at_utc desc limit 8").bind(playerId, runtime.dataScope).all<{ nfl_event_id: string; stats_json: string }>(),
    env.NFL_DB.prepare("select season_year, stats_json from player_season_stats where nfl_player_id = ?1 order by season_year desc").bind(playerId).all<{ season_year: number; stats_json: string }>(),
    env.NFL_DB.prepare("select status from nfl_player_injuries where nfl_player_id = ?1 and data_scope = ?2 order by updated_at_utc desc limit 1").bind(playerId, runtime.dataScope).first<{ status: string | null }>(),
    db.prepare("select status from drafts where league_season_id = ?1").bind(seasonId).first<{ status: string }>(),
  ]);
  const isMine = Boolean(owner && ownTeam?.fantasy_team_id === owner.fantasy_team_id);
  const actions: PlayerProfileResponse["availableActions"] = ["watch"];
  if (!owner) {
    if (profile.current_team_id && isFantasyPosition(profile.position)) actions.push("add", "claim");
  } else if (isMine) actions.push("trade-away");
  else actions.push("trade-for");
  if (!draft || ["setup", "scheduled", "active", "paused"].includes(draft.status)) actions.push("draft-queue");
  return { playerId, displayName: profile.display_name, position: profile.position ?? "UNK", nflTeam: profile.abbreviation ?? undefined, headshotUrl: espnAthleteHeadshotUrl(env, profile.nfl_player_id, profile.headshot_object_key), nflTeamLogoUrl: providerAssetUrl(env, profile.logo_object_key), injuryStatus: injury?.status ?? undefined, rosteredByTeamId: owner?.fantasy_team_id, rosteredByTeamName: owner?.team_name, seasonOutlook: profile.season_outlook ?? undefined, watched: Boolean(watched), availableActions: actions, yearlyStats: yearlyStats(yearlyGames.results ?? []), recentGames: (games.results ?? []).map((game) => ({ eventId: game.nfl_event_id, stats: parseObject(game.stats_json) })) };
}

async function setWatched(db: D1Database, seasonId: string, userId: string, playerId: string, watched: boolean): Promise<void> { if (watched) await db.prepare("insert into player_watchlists (player_watchlist_id, league_season_id, user_id, nfl_player_id, created_at_utc) values (?1, ?2, ?3, ?4, ?5) on conflict(league_season_id, user_id, nfl_player_id) do nothing").bind(newId("pwl"), seasonId, userId, playerId, new Date().toISOString()).run(); else await db.prepare("delete from player_watchlists where league_season_id = ?1 and user_id = ?2 and nfl_player_id = ?3").bind(seasonId, userId, playerId).run(); }
async function requireManagedTeam(db: D1Database, seasonId: string, userId: string): Promise<{ fantasy_team_id: string; team_name: string }> { const team = await db.prepare("select fantasy_team_id, team_name from fantasy_teams where league_season_id = ?1 and manager_user_id = ?2").bind(seasonId, userId).first<{ fantasy_team_id: string; team_name: string }>(); if (!team) throw new ApiException(403, "fantasy_team_required", "A managed fantasy team is required."); return team; }
async function loadSlots(db: D1Database, seasonId: string): Promise<SlotRow[]> { const result = await db.prepare(`select slots.slot_type, slots.display_name, slots.slot_count, slots.eligible_positions_json, slots.contributes_points from roster_slots slots join roster_definitions definitions on definitions.roster_definition_id = slots.roster_definition_id where definitions.league_season_id = ?1 order by slots.display_order`).bind(seasonId).all<SlotRow>(); return result.results ?? []; }
export function expandSlots(rows: SlotRow[]): Array<{ slotType: string; slotIndex: number; displayName: string; eligiblePositions: string[]; contributesPoints: boolean }> { return rows.flatMap((row) => Array.from({ length: row.slot_count }, (_, index) => ({ slotType: row.slot_type, slotIndex: index + 1, displayName: row.display_name, eligiblePositions: JSON.parse(row.eligible_positions_json) as string[], contributesPoints: Boolean(row.contributes_points) }))); }
function slotEligibility(rows: SlotRow[]): Map<string, string[]> { const result = new Map<string, string[]>(); for (const row of rows) for (const position of JSON.parse(row.eligible_positions_json) as string[]) result.set(position, [...(result.get(position) ?? []), row.slot_type]); return result; }
async function loadProfiles(db: D1Database, ids: string[]): Promise<Map<string, ProfileRow>> { if (!ids.length) return new Map(); const placeholders = ids.map((_, index) => `?${index + 1}`).join(","); const result = await db.prepare(`select players.nfl_player_id, players.display_name, players.position, teams.abbreviation, players.current_team_id, players.headshot_object_key, teams.logo_object_key from nfl_players players left join nfl_teams teams on teams.nfl_team_id = players.current_team_id where players.nfl_player_id in (${placeholders})`).bind(...ids).all<ProfileRow>(); return new Map((result.results ?? []).map((row) => [row.nfl_player_id, row])); }
async function loadOwners(db: D1Database, seasonId: string, ids: string[]): Promise<Array<{ nfl_player_id: string; fantasy_team_id: string; team_name: string }>> {
  const rows: Array<{ nfl_player_id: string; fantasy_team_id: string; team_name: string }> = [];
  for (const chunk of chunks(ids, 75)) {
    const placeholders = chunk.map((_, index) => `?${index + 2}`).join(",");
    const result = await db.prepare(`select roster.nfl_player_id, roster.fantasy_team_id, teams.team_name from fantasy_roster_players roster join fantasy_teams teams on teams.fantasy_team_id = roster.fantasy_team_id where roster.league_season_id = ?1 and roster.released_at_utc is null and roster.nfl_player_id in (${placeholders})`).bind(seasonId, ...chunk).all<{ nfl_player_id: string; fantasy_team_id: string; team_name: string }>();
    rows.push(...(result.results ?? []));
  }
  return rows;
}
async function loadWatches(db: D1Database, seasonId: string, userId: string, ids: string[]): Promise<string[]> {
  const rows: string[] = [];
  for (const chunk of chunks(ids, 75)) {
    const placeholders = chunk.map((_, index) => `?${index + 3}`).join(",");
    const result = await db.prepare(`select nfl_player_id from player_watchlists where league_season_id = ?1 and user_id = ?2 and nfl_player_id in (${placeholders})`).bind(seasonId, userId, ...chunk).all<{ nfl_player_id: string }>();
    rows.push(...(result.results ?? []).map((row) => row.nfl_player_id));
  }
  return rows;
}
async function loadInjuries(db: D1Database, ids: string[], dataScope: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const chunk of chunks(ids, 75)) {
    const placeholders = chunk.map((_, index) => `?${index + 2}`).join(",");
    const result = await db.prepare(`select nfl_player_id, status from nfl_player_injuries where data_scope = ?1 and nfl_player_id in (${placeholders}) order by updated_at_utc desc`).bind(dataScope, ...chunk).all<{ nfl_player_id: string; status: string | null }>();
    for (const row of result.results ?? []) if (row.status && !map.has(row.nfl_player_id)) map.set(row.nfl_player_id, row.status);
  }
  return map;
}
async function loadLocks(db: D1Database, ids: string[], week: number, dataScope: string): Promise<Map<string, { locked: boolean; startsAt: string }>> { if (!ids.length) return new Map(); const placeholders = ids.map((_, index) => `?${index + 3}`).join(","); const result = await db.prepare(`select players.nfl_player_id, events.starts_at_utc, snapshots.status from nfl_players players join nfl_events events on events.week = ?1 and events.season_year = (select max(season_year) from nfl_events) join nfl_event_snapshots snapshots on snapshots.nfl_event_id = events.nfl_event_id and snapshots.data_scope = ?2 where players.nfl_player_id in (${placeholders}) and players.current_team_id in (snapshots.home_team_id, snapshots.away_team_id) order by events.starts_at_utc`).bind(week, dataScope, ...ids).all<{ nfl_player_id: string; starts_at_utc: string; status: string }>(); const map = new Map<string, { locked: boolean; startsAt: string }>(); for (const row of result.results ?? []) if (!map.has(row.nfl_player_id)) map.set(row.nfl_player_id, { locked: row.status !== "pre" || (dataScope === "production" && Date.parse(row.starts_at_utc) <= Date.now()), startsAt: row.starts_at_utc }); return map; }
function requireWeek(value: unknown): number { const week = Number(value ?? 1); if (!Number.isInteger(week) || week < 1 || week > 22) throw new ApiException(400, "invalid_week", "Week must be between 1 and 22."); return week; }
function parseObject(value: string): Record<string, unknown> { try { const parsed: unknown = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; } }
function yearlyStats(rows: Array<{ season_year: number; stats_json: string }>): PlayerProfileResponse["yearlyStats"] {
  const bySeason = new Map<number, { games: number; totals: Record<string, number> }>();
  for (const row of rows) {
    const bucket = bySeason.get(row.season_year) ?? { games: 0, totals: {} };
    bucket.games++;
    for (const [key, value] of Object.entries(parseObject(row.stats_json))) {
      const number = Array.isArray(value) ? Number(value[0]) : Number(value);
      if (Number.isFinite(number)) bucket.totals[key] = (bucket.totals[key] ?? 0) + number;
    }
    bySeason.set(row.season_year, bucket);
  }
  return [...bySeason.entries()].sort((a, b) => b[0] - a[0]).map(([seasonYear, value]) => {
    const games = Number(value.totals["games:GP"] ?? value.games);
    return { seasonYear, games: Number.isFinite(games) ? games : value.games, stats: value.totals };
  });
}
function chunks<T>(values: T[], size: number): T[][] { const result: T[][] = []; for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size)); return result; }
