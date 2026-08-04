import type {
  AddDropRequest,
  ProposeTradeRequest,
  SubmitWaiverClaimRequest,
  TradeAssetInput,
  TradeView,
  TransactionSettingsResponse,
  TransactionsDashboardResponse,
} from "@myffl/api-contracts";
import { authenticate, type HandlerResult } from "./auth";
import { getProviderRuntime } from "./game-feed";
import { ApiException, readJson } from "./http";
import { getLeagueRow, requireLeagueRole } from "./league";
import { newId, type AccessTokenPrincipal } from "./security";
import { enqueueLeagueNotification } from "./notifications";

export type WaiverJob = { type: "process-waiver-period"; leagueId: string; seasonId: string; waiverPeriodId: string };

interface TeamRow { fantasy_team_id: string; team_name: string; }
interface SettingsRow { acquisition_mode: TransactionSettingsResponse["acquisitionMode"]; faab_budget_milli: number; minimum_bid_milli: number; waiver_period_hours: number; waiver_tiebreaker: TransactionSettingsResponse["waiverTiebreaker"]; trade_deadline_week: number; trade_review_mode: TransactionSettingsResponse["tradeReviewMode"]; trade_review_hours: number; veto_threshold: number; draft_pick_trading_enabled: number; faab_trading_enabled: number; revision_number: number; }
interface PlayerRow { nfl_player_id: string; display_name: string; position: string | null; abbreviation: string | null; current_team_id: string | null; }
interface ClaimRow { waiver_claim_id: string; waiver_claim_group_id: string; fantasy_team_id: string; user_id: string; add_nfl_player_id: string; conditional_drop_roster_player_id: string | null; bid_milli: number; claim_order: number; priority_snapshot: number; submitted_at_utc: string; }

export async function handleTransactionRequest(request: Request, url: URL, env: Env, correlationId: string): Promise<HandlerResult<unknown> | undefined> {
  const match = url.pathname.match(/^\/api\/leagues\/([^/]+)\/(transactions|waivers|trades)(?:\/([^/]+))?(?:\/([^/]+))?$/);
  if (!match) return undefined;
  const principal = await authenticate(request, env);
  const leagueId = match[1]; const resource = match[2]; const itemId = match[3]; const action = match[4];
  const access = await requireLeagueRole(principal, leagueId, env, ["commissioner", "co-commissioner", "manager"]);
  const league = await getLeagueRow(access.db, leagueId);
  await ensureTransactionState(access.db, league.league_season_id, principal.userId);

  if (resource === "transactions" && request.method === "GET" && !itemId) return { data: await getDashboard(principal, access.db, leagueId, league.league_season_id, env) };
  if (resource === "transactions" && request.method === "PUT" && itemId === "settings") {
    await requireLeagueRole(principal, leagueId, env, ["commissioner", "co-commissioner"]);
    return { data: await updateSettings(principal, access.db, league.league_season_id, await readJson<Partial<TransactionSettingsResponse>>(request)) };
  }
  if (resource === "transactions" && request.method === "POST" && itemId === "add-drop") return { data: await addDrop(principal, access.db, leagueId, league.league_season_id, await readJson<AddDropRequest>(request), env, correlationId) };
  if (resource === "waivers" && request.method === "POST" && !itemId) return { data: await submitClaim(principal, access.db, league.league_season_id, await readJson<SubmitWaiverClaimRequest>(request), env) };
  if (resource === "waivers" && request.method === "PUT" && itemId === "reorder") return { data: await reorderClaims(principal, access.db, league.league_season_id, await readJson<{ claimIds?: string[]; revisionNumber?: number }>(request), env) };
  if (resource === "waivers" && request.method === "DELETE" && itemId) return { data: await cancelClaim(principal, access.db, league.league_season_id, itemId, env) };
  if (resource === "waivers" && request.method === "POST" && itemId === "process") {
    await requireLeagueRole(principal, leagueId, env, ["commissioner", "co-commissioner"]);
    const period = await currentWaiverPeriod(access.db, league.league_season_id, principal.userId);
    await processWaiverPeriod(env, leagueId, league.league_season_id, period.waiver_period_id, correlationId);
    return { data: await getDashboard(principal, access.db, leagueId, league.league_season_id, env) };
  }
  if (resource === "trades" && request.method === "POST" && !itemId) return { data: await proposeTrade(principal, access.db, leagueId, league.league_season_id, await readJson<ProposeTradeRequest>(request), env, correlationId) };
  if (resource === "trades" && request.method === "POST" && itemId && action) return { data: await tradeAction(principal, access.db, leagueId, league.league_season_id, itemId, action, request, env, correlationId) };
  return undefined;
}

async function ensureTransactionState(db: D1Database, seasonId: string, userId: string): Promise<void> {
  const existing = await db.prepare("select transaction_setting_id from transaction_settings where league_season_id = ?1").bind(seasonId).first();
  if (!existing) {
    const now = new Date().toISOString();
    try { await db.prepare("insert into transaction_settings (transaction_setting_id, league_season_id, updated_by_user_id, updated_at_utc) values (?1, ?2, ?3, ?4)").bind(newId("txs"), seasonId, userId, now).run(); } catch { /* Another request initialized settings. */ }
  }
  const settings = await loadSettings(db, seasonId);
  const teams = await db.prepare("select fantasy_team_id from fantasy_teams where league_season_id = ?1 order by created_at_utc").bind(seasonId).all<{ fantasy_team_id: string }>();
  const now = new Date().toISOString();
  for (const [index, team] of (teams.results ?? []).entries()) {
    await db.prepare("insert into team_transaction_balances (team_transaction_balance_id, league_season_id, fantasy_team_id, faab_remaining_milli, waiver_priority, updated_at_utc) values (?1, ?2, ?3, ?4, ?5, ?6) on conflict(league_season_id, fantasy_team_id) do nothing").bind(newId("txb"), seasonId, team.fantasy_team_id, settings.faab_budget_milli, index + 1, now).run();
  }
}

async function getDashboard(principal: AccessTokenPrincipal, db: D1Database, leagueId: string, seasonId: string, env: Env): Promise<TransactionsDashboardResponse> {
  const team = await requireManagedTeam(db, seasonId, principal.userId);
  const period = await currentWaiverPeriod(db, seasonId, principal.userId);
  const [settings, balance, claims, claimGroup, activity, trades] = await Promise.all([
    loadSettings(db, seasonId),
    db.prepare("select faab_remaining_milli, waiver_priority from team_transaction_balances where league_season_id = ?1 and fantasy_team_id = ?2").bind(seasonId, team.fantasy_team_id).first<{ faab_remaining_milli: number; waiver_priority: number }>(),
    loadClaims(db, env.NFL_DB, period.waiver_period_id, team.fantasy_team_id),
    db.prepare("select revision_number from waiver_claim_groups where waiver_period_id=?1 and fantasy_team_id=?2").bind(period.waiver_period_id, team.fantasy_team_id).first<{ revision_number: number }>(),
    db.prepare("select transactions.transaction_id, transactions.transaction_type, transactions.status, teams.team_name, transactions.failure_reason, transactions.metadata_json, transactions.created_at_utc, transactions.processed_at_utc from transactions left join fantasy_teams teams on teams.fantasy_team_id = transactions.fantasy_team_id where transactions.league_season_id = ?1 order by transactions.created_at_utc desc limit 50").bind(seasonId).all<{ transaction_id: string; transaction_type: string; status: string; team_name: string | null; failure_reason: string | null; metadata_json: string; created_at_utc: string; processed_at_utc: string | null }>(),
    loadTrades(principal, db, leagueId, seasonId, env),
  ]);
  return { seasonId, teamId: team.fantasy_team_id, settings: settingsView(settings), faabRemaining: (balance?.faab_remaining_milli ?? settings.faab_budget_milli) / 1000, waiverPriority: balance?.waiver_priority ?? 1, claimGroupRevisionNumber: claimGroup?.revision_number, waiverPeriod: { waiverPeriodId: period.waiver_period_id, processesAtUtc: period.processes_at_utc, status: period.status }, claims, trades, activity: (activity.results ?? []).map((row) => ({ transactionId: row.transaction_id, transactionType: row.transaction_type, status: row.status, teamName: row.team_name ?? undefined, summary: metadataSummary(row.metadata_json, row.transaction_type), failureReason: row.failure_reason ?? undefined, createdAtUtc: row.created_at_utc, processedAtUtc: row.processed_at_utc ?? undefined })) };
}

async function updateSettings(principal: AccessTokenPrincipal, db: D1Database, seasonId: string, body: Partial<TransactionSettingsResponse>): Promise<TransactionSettingsResponse> {
  const current = await loadSettings(db, seasonId);
  if (body.revisionNumber !== current.revision_number) throw new ApiException(409, "transaction_settings_conflict", "Transaction settings changed. Reload before saving.");
  const next = {
    acquisitionMode: ["free-agent", "waivers", "faab"].includes(String(body.acquisitionMode)) ? body.acquisitionMode! : current.acquisition_mode,
    faabBudget: bounded(body.faabBudget, current.faab_budget_milli / 1000, 0, 100000), minimumBid: bounded(body.minimumBid, current.minimum_bid_milli / 1000, 0, 100000),
    waiverPeriodHours: bounded(body.waiverPeriodHours, current.waiver_period_hours, 1, 168), waiverTiebreaker: ["rolling-priority","reverse-standings","submission-time"].includes(String(body.waiverTiebreaker)) ? body.waiverTiebreaker! : current.waiver_tiebreaker,
    tradeDeadlineWeek: bounded(body.tradeDeadlineWeek, current.trade_deadline_week, 1, 18), tradeReviewMode: ["none","commissioner","league-vote"].includes(String(body.tradeReviewMode)) ? body.tradeReviewMode! : current.trade_review_mode,
    tradeReviewHours: bounded(body.tradeReviewHours, current.trade_review_hours, 0, 168), vetoThreshold: bounded(body.vetoThreshold, current.veto_threshold, 1, 32),
    draftPickTradingEnabled: body.draftPickTradingEnabled ?? Boolean(current.draft_pick_trading_enabled), faabTradingEnabled: body.faabTradingEnabled ?? Boolean(current.faab_trading_enabled),
  };
  if (next.minimumBid > next.faabBudget) throw new ApiException(400, "invalid_faab_settings", "The minimum bid cannot exceed the FAAB budget.");
  const now = new Date().toISOString(); const budgetMilli = Math.round(next.faabBudget*1000); const budgetDelta = budgetMilli-current.faab_budget_milli;
  await db.batch([
    db.prepare("update transaction_settings set acquisition_mode=?1, faab_budget_milli=?2, minimum_bid_milli=?3, waiver_period_hours=?4, waiver_tiebreaker=?5, trade_deadline_week=?6, trade_review_mode=?7, trade_review_hours=?8, veto_threshold=?9, draft_pick_trading_enabled=?10, faab_trading_enabled=?11, revision_number=revision_number+1, updated_by_user_id=?12, updated_at_utc=?13 where league_season_id=?14 and revision_number=?15").bind(next.acquisitionMode, budgetMilli, Math.round(next.minimumBid*1000), next.waiverPeriodHours, next.waiverTiebreaker, next.tradeDeadlineWeek, next.tradeReviewMode, next.tradeReviewHours, next.vetoThreshold, Number(next.draftPickTradingEnabled), Number(next.faabTradingEnabled), principal.userId, now, seasonId, current.revision_number),
    db.prepare("update team_transaction_balances set faab_remaining_milli=max(0,faab_remaining_milli+?1), revision_number=revision_number+1, updated_at_utc=?2 where league_season_id=?3").bind(budgetDelta, now, seasonId),
  ]);
  return settingsView(await loadSettings(db, seasonId));
}

async function addDrop(principal: AccessTokenPrincipal, db: D1Database, leagueId: string, seasonId: string, body: AddDropRequest, env: Env, correlationId: string): Promise<TransactionsDashboardResponse> {
  const settings = await loadSettings(db, seasonId);
  if (settings.acquisition_mode !== "free-agent") throw new ApiException(409, "waiver_claim_required", "This league requires a waiver claim for player acquisitions.");
  const team = await requireManagedTeam(db, seasonId, principal.userId);
  await executePlayerMove(db, env, leagueId, seasonId, team.fantasy_team_id, principal.userId, body.addPlayerId, body.dropRosterPlayerId, "add-drop", undefined, correlationId);
  return getDashboard(principal, db, leagueId, seasonId, env);
}

async function submitClaim(principal: AccessTokenPrincipal, db: D1Database, seasonId: string, body: SubmitWaiverClaimRequest, env: Env): Promise<TransactionsDashboardResponse> {
  const team = await requireManagedTeam(db, seasonId, principal.userId); const settings = await loadSettings(db, seasonId); const period = await currentWaiverPeriod(db, seasonId, principal.userId);
  if (period.status !== "open") throw new ApiException(409, "waivers_processing", "Waiver claims are temporarily locked while this period processes.");
  const bidMilli = Math.round(Number(body.bid ?? 0) * 1000);
  const balance = await db.prepare("select faab_remaining_milli, waiver_priority from team_transaction_balances where league_season_id=?1 and fantasy_team_id=?2").bind(seasonId, team.fantasy_team_id).first<{ faab_remaining_milli: number; waiver_priority: number }>();
  if (!body.addPlayerId) throw new ApiException(400, "player_required", "Choose a player to claim.");
  if (bidMilli < (settings.acquisition_mode === "faab" ? settings.minimum_bid_milli : 0) || bidMilli > (balance?.faab_remaining_milli ?? 0)) throw new ApiException(400, "invalid_faab_bid", "The FAAB bid is outside the allowed balance.");
  if (settings.acquisition_mode !== "faab" && bidMilli !== 0) throw new ApiException(400, "faab_disabled", "FAAB bids are not enabled in this league.");
  await requireAvailablePlayer(db, env.NFL_DB, seasonId, body.addPlayerId);
  if (body.dropRosterPlayerId) await requireOwnedRosterPlayer(db, team.fantasy_team_id, body.dropRosterPlayerId);
  let group = await db.prepare("select waiver_claim_group_id, revision_number from waiver_claim_groups where waiver_period_id=?1 and fantasy_team_id=?2").bind(period.waiver_period_id, team.fantasy_team_id).first<{ waiver_claim_group_id: string; revision_number: number }>();
  const now = new Date().toISOString();
  if (!group) { const id = newId("wcg"); await db.prepare("insert into waiver_claim_groups (waiver_claim_group_id, waiver_period_id, fantasy_team_id, user_id, submitted_at_utc) values (?1,?2,?3,?4,?5)").bind(id, period.waiver_period_id, team.fantasy_team_id, principal.userId, now).run(); group = { waiver_claim_group_id: id, revision_number: 1 }; }
  const order = await db.prepare("select coalesce(max(claim_order),0)+1 as next_order from waiver_claims where waiver_claim_group_id=?1 and status='pending'").bind(group.waiver_claim_group_id).first<{ next_order: number }>();
  const prioritySnapshot = settings.waiver_tiebreaker === "reverse-standings" ? await reverseStandingsPriority(db, seasonId, team.fantasy_team_id, (await getProviderRuntime(env)).dataScope) : settings.waiver_tiebreaker === "submission-time" ? 0 : balance?.waiver_priority ?? 1;
  await db.prepare("insert into waiver_claims (waiver_claim_id, waiver_claim_group_id, add_nfl_player_id, conditional_drop_roster_player_id, bid_milli, claim_order, priority_snapshot, status, submitted_at_utc) values (?1,?2,?3,?4,?5,?6,?7,'pending',?8)").bind(newId("wcl"), group.waiver_claim_group_id, body.addPlayerId, body.dropRosterPlayerId ?? null, bidMilli, order?.next_order ?? 1, prioritySnapshot, now).run();
  return getDashboard(principal, db, "", seasonId, env);
}

async function reorderClaims(principal: AccessTokenPrincipal, db: D1Database, seasonId: string, body: { claimIds?: string[]; revisionNumber?: number }, env: Env): Promise<TransactionsDashboardResponse> {
  const team = await requireManagedTeam(db, seasonId, principal.userId); const period = await currentWaiverPeriod(db, seasonId, principal.userId);
  if (period.status !== "open") throw new ApiException(409, "waivers_processing", "Waiver claims are temporarily locked while this period processes.");
  const group = await db.prepare("select waiver_claim_group_id, revision_number from waiver_claim_groups where waiver_period_id=?1 and fantasy_team_id=?2").bind(period.waiver_period_id, team.fantasy_team_id).first<{ waiver_claim_group_id: string; revision_number: number }>();
  if (!group || body.revisionNumber !== group.revision_number) throw new ApiException(409, "waiver_revision_conflict", "Waiver claims changed. Reload before reordering.");
  const current = await db.prepare("select waiver_claim_id from waiver_claims where waiver_claim_group_id=?1 and status='pending'").bind(group.waiver_claim_group_id).all<{ waiver_claim_id: string }>();
  const ids = body.claimIds ?? []; if (ids.length !== (current.results ?? []).length || new Set(ids).size !== ids.length || ids.some((id) => !(current.results ?? []).some((row) => row.waiver_claim_id === id))) throw new ApiException(400, "invalid_claim_order", "The claim order must contain every pending claim once.");
  const statements = ids.map((id, index) => db.prepare("update waiver_claims set claim_order=?1, revision_number=revision_number+1 where waiver_claim_id=?2").bind(-(index + 1), id));
  ids.forEach((id, index) => statements.push(db.prepare("update waiver_claims set claim_order=?1 where waiver_claim_id=?2").bind(index + 1, id)));
  statements.push(db.prepare("update waiver_claim_groups set revision_number=revision_number+1, submitted_at_utc=?1 where waiver_claim_group_id=?2 and revision_number=?3").bind(new Date().toISOString(), group.waiver_claim_group_id, group.revision_number));
  await db.batch(statements); return getDashboard(principal, db, "", seasonId, env);
}

async function cancelClaim(principal: AccessTokenPrincipal, db: D1Database, seasonId: string, claimId: string, env: Env): Promise<TransactionsDashboardResponse> {
  const team = await requireManagedTeam(db, seasonId, principal.userId);
  const result = await db.prepare("update waiver_claims set status='cancelled', processed_at_utc=?1, revision_number=revision_number+1 where waiver_claim_id=?2 and status='pending' and waiver_claim_group_id in (select groups.waiver_claim_group_id from waiver_claim_groups groups join waiver_periods periods on periods.waiver_period_id=groups.waiver_period_id where groups.fantasy_team_id=?3 and periods.status='open')").bind(new Date().toISOString(), claimId, team.fantasy_team_id).run();
  if (!result.meta.changes) throw new ApiException(404, "waiver_claim_not_found", "Pending waiver claim not found.");
  return getDashboard(principal, db, "", seasonId, env);
}

export async function enqueueDueWaivers(env: Env): Promise<void> {
  const due = await env.LEAGUE_DB_001.prepare("select waiver_period_id, league_season_id, leagues.league_id from waiver_periods join league_seasons on league_seasons.league_season_id=waiver_periods.league_season_id join leagues on leagues.league_id=league_seasons.league_id where waiver_periods.status='open' and waiver_periods.processes_at_utc<=?1 limit 50").bind(new Date().toISOString()).all<{ waiver_period_id: string; league_season_id: string; league_id: string }>();
  for (const period of due.results ?? []) await env.WAIVERS_QUEUE.send({ type: "process-waiver-period", leagueId: period.league_id, seasonId: period.league_season_id, waiverPeriodId: period.waiver_period_id } satisfies WaiverJob);
}

export async function processWaiverQueue(batch: MessageBatch<WaiverJob>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try { await processWaiverPeriod(env, message.body.leagueId, message.body.seasonId, message.body.waiverPeriodId, message.id); message.ack(); }
    catch (error) { console.error(JSON.stringify({ level: "error", event: "waiver_processing_failed", messageId: message.id, error: error instanceof Error ? error.message : String(error) })); message.retry(); }
  }
}

export async function processDueTrades(env: Env): Promise<void> {
  const db = env.LEAGUE_DB_001; const now = new Date().toISOString();
  await db.prepare("update trades set status='expired', revision_number=revision_number+1, updated_at_utc=?1 where status in ('draft','proposed') and expires_at_utc<=?1").bind(now).run();
  const due = await db.prepare("select trades.trade_id, trades.league_season_id, leagues.league_id from trades join league_seasons on league_seasons.league_season_id=trades.league_season_id join leagues on leagues.league_id=league_seasons.league_id join transaction_settings on transaction_settings.league_season_id=trades.league_season_id where trades.status='under-review' and trades.review_ends_at_utc<=?1 and transaction_settings.trade_review_mode='league-vote' limit 25").bind(now).all<{ trade_id: string; league_season_id: string; league_id: string }>();
  for (const trade of due.results ?? []) {
    const settings = await loadSettings(db, trade.league_season_id); const vetoes = await db.prepare("select count(*) as count from trade_votes where trade_id=?1 and vote='veto'").bind(trade.trade_id).first<{ count: number }>();
    if ((vetoes?.count ?? 0) >= settings.veto_threshold) await db.prepare("update trades set status='vetoed', revision_number=revision_number+1, updated_at_utc=?1 where trade_id=?2 and status='under-review'").bind(now, trade.trade_id).run();
    else { await db.prepare("update trades set status='approved', revision_number=revision_number+1, updated_at_utc=?1 where trade_id=?2 and status='under-review'").bind(now, trade.trade_id).run(); try { await settleTrade(db, env, trade.league_id, trade.league_season_id, trade.trade_id, "system", `trade-review:${trade.trade_id}`); } catch { /* settleTrade records the failure. */ } }
  }
}

async function processWaiverPeriod(env: Env, leagueId: string, seasonId: string, periodId: string, correlationId: string): Promise<void> {
  const db = env.LEAGUE_DB_001;
  const period = await db.prepare("select status from waiver_periods where waiver_period_id=?1 and league_season_id=?2").bind(periodId, seasonId).first<{ status: string }>();
  if (!period || period.status === "processed" || period.status === "cancelled") return;
  await db.prepare("update waiver_periods set status='processing', revision_number=revision_number+1 where waiver_period_id=?1 and status='open'").bind(periodId).run();
  const settings = await loadSettings(db, seasonId);
  const claims = await db.prepare("select claims.waiver_claim_id, claims.waiver_claim_group_id, groups.fantasy_team_id, groups.user_id, claims.add_nfl_player_id, claims.conditional_drop_roster_player_id, claims.bid_milli, claims.claim_order, claims.priority_snapshot, claims.submitted_at_utc from waiver_claims claims join waiver_claim_groups groups on groups.waiver_claim_group_id=claims.waiver_claim_group_id where groups.waiver_period_id=?1 and claims.status='pending'").bind(periodId).all<ClaimRow>();
  const remaining = [...(claims.results ?? [])];
  while (remaining.length) {
    const candidates = selectWaiverCandidates(remaining, settings.acquisition_mode, settings.waiver_tiebreaker);
    if (!candidates.length) break;
    for (const claim of candidates) {
      const index = remaining.findIndex((item) => item.waiver_claim_id === claim.waiver_claim_id); if (index >= 0) remaining.splice(index, 1);
      const stillPending = await db.prepare("select status from waiver_claims where waiver_claim_id=?1").bind(claim.waiver_claim_id).first<{ status: string }>();
      if (stillPending?.status !== "pending") continue;
      try {
        await executePlayerMove(db, env, leagueId, seasonId, claim.fantasy_team_id, claim.user_id, claim.add_nfl_player_id, claim.conditional_drop_roster_player_id ?? undefined, "waiver", { claimId: claim.waiver_claim_id, bidMilli: claim.bid_milli }, correlationId);
      } catch (error) {
        const reason = error instanceof ApiException ? error.message : "The waiver claim could not be processed.";
        await db.prepare("update waiver_claims set status='failed', failure_reason=?1, processed_at_utc=?2, revision_number=revision_number+1 where waiver_claim_id=?3 and status='pending'").bind(reason, new Date().toISOString(), claim.waiver_claim_id).run();
        await notifySafely(env,leagueId,{notificationType:"waiver-failed",title:"Waiver claim failed",body:reason,entityType:"waiver-claim",entityId:claim.waiver_claim_id,actionUrl:`/?league=${leagueId}&tab=transactions`},{recipientUserIds:[claim.user_id]});
      }
    }
  }
  const now = new Date().toISOString();
  await db.batch([
    db.prepare("update waiver_periods set status='processed', processed_at_utc=?1, revision_number=revision_number+1 where waiver_period_id=?2").bind(now, periodId),
    db.prepare("insert into waiver_periods (waiver_period_id, league_season_id, period_number, opens_at_utc, processes_at_utc, status, created_at_utc) select ?1, league_season_id, period_number+1, ?2, ?3, 'open', ?2 from waiver_periods where waiver_period_id=?4").bind(newId("wpr"), now, new Date(Date.now() + settings.waiver_period_hours * 3600000).toISOString(), periodId),
  ]);
}

export function selectWaiverCandidates(claims: ClaimRow[], acquisitionMode: string, tiebreaker = "rolling-priority"): ClaimRow[] {
  const firstByTeam = new Map<string, ClaimRow>();
  for (const claim of claims) { const current = firstByTeam.get(claim.fantasy_team_id); if (!current || claim.claim_order < current.claim_order) firstByTeam.set(claim.fantasy_team_id, claim); }
  return [...firstByTeam.values()].sort((left, right) => (acquisitionMode === "faab" ? right.bid_milli - left.bid_milli : 0) || (tiebreaker === "submission-time" ? 0 : left.priority_snapshot - right.priority_snapshot) || left.submitted_at_utc.localeCompare(right.submitted_at_utc));
}

async function executePlayerMove(db: D1Database, env: Env, leagueId: string, seasonId: string, teamId: string, actorUserId: string, addPlayerId: string, dropRosterPlayerId: string | undefined, source: "add-drop" | "waiver", waiver: { claimId: string; bidMilli: number } | undefined, correlationId: string): Promise<string> {
  const player = await requireAvailablePlayer(db, env.NFL_DB, seasonId, addPlayerId);
  let drop = dropRosterPlayerId ? await requireOwnedRosterPlayer(db, teamId, dropRosterPlayerId) : null;
  if (drop) { const profile = (await loadPlayerProfiles(env.NFL_DB, [drop.nfl_player_id])).get(drop.nfl_player_id); if (profile) drop = { ...drop, display_name: profile.display_name }; }
  if (drop && await isPlayerLocked(env, drop.nfl_player_id)) throw new ApiException(409, "player_locked", "The dropped player is locked because the NFL game has started.");
  const [rosterSize, activeLimit, positionLimit, positionCount] = await Promise.all([
    db.prepare("select count(*) as count from fantasy_roster_players where league_season_id=?1 and fantasy_team_id=?2 and released_at_utc is null").bind(seasonId, teamId).first<{ count: number }>(),
    db.prepare("select sum(slots.slot_count) as count from roster_slots slots join roster_definitions definitions on definitions.roster_definition_id=slots.roster_definition_id where definitions.league_season_id=?1 and slots.slot_type not in ('IR','PUP','TAXI')").bind(seasonId).first<{ count: number }>(),
    db.prepare("select limits.maximum_count from roster_position_limits limits join roster_definitions definitions on definitions.roster_definition_id=limits.roster_definition_id where definitions.league_season_id=?1 and limits.position=?2").bind(seasonId, player.position ?? "UNK").first<{ maximum_count: number }>(),
    db.prepare("select count(*) as count from fantasy_roster_players where league_season_id=?1 and fantasy_team_id=?2 and position=?3 and released_at_utc is null").bind(seasonId, teamId, player.position ?? "UNK").first<{ count: number }>(),
  ]);
  const sizeAfter = (rosterSize?.count ?? 0) + 1 - (drop ? 1 : 0);
  if (sizeAfter > (activeLimit?.count ?? 0)) throw new ApiException(409, "roster_full", "Choose a player to drop before adding this player.");
  const samePositionDrop = drop?.position === player.position ? 1 : 0;
  if ((positionCount?.count ?? 0) + 1 - samePositionDrop > (positionLimit?.maximum_count ?? activeLimit?.count ?? 0)) throw new ApiException(409, "position_limit", `The roster limit for ${player.position ?? "this position"} would be exceeded.`);
  const now = new Date().toISOString(); const transactionId = newId("txn"); const rosterId = newId("frp");
  const metadata = { addedPlayerId: addPlayerId, addedPlayerName: player.display_name, droppedPlayerId: drop?.nfl_player_id, droppedPlayerName: drop?.display_name, bid: waiver ? waiver.bidMilli / 1000 : undefined };
  const statements: D1PreparedStatement[] = [
    db.prepare("insert into transactions (transaction_id, league_season_id, fantasy_team_id, transaction_type, status, source_entity_type, source_entity_id, actor_user_id, metadata_json, created_at_utc, processed_at_utc) values (?1,?2,?3,?4,'succeeded',?5,?6,?7,?8,?9,?9)").bind(transactionId, seasonId, teamId, drop ? "add-drop" : "add", source, waiver?.claimId ?? null, actorUserId, JSON.stringify(metadata), now),
    db.prepare("insert into fantasy_roster_players (fantasy_roster_player_id, league_season_id, fantasy_team_id, nfl_player_id, position, roster_status, acquisition_type, acquisition_id, acquired_at_utc) values (?1,?2,?3,?4,?5,'active',?6,?7,?8)").bind(rosterId, seasonId, teamId, addPlayerId, player.position ?? "UNK", source, transactionId, now),
    db.prepare("insert into transaction_assets (transaction_asset_id, transaction_id, fantasy_team_id, asset_type, asset_id, direction, metadata_json) values (?1,?2,?3,'player',?4,'acquired',?5)").bind(newId("txa"), transactionId, teamId, addPlayerId, JSON.stringify({ displayName: player.display_name })),
    db.prepare("insert into league_audit_events (league_audit_event_id, league_id, actor_user_id, action, entity_type, entity_id, correlation_id, created_at_utc, metadata_json) values (?1,?2,?3,'transaction.player-move','transaction',?4,?5,?6,?7)").bind(newId("lae"), leagueId, actorUserId, transactionId, correlationId, now, JSON.stringify(metadata)),
    db.prepare("insert into league_activity (league_activity_id, league_id, actor_user_id, activity_type, message, created_at_utc, metadata_json) values (?1,?2,?3,'transaction',?4,?5,?6)").bind(newId("lac"), leagueId, actorUserId, `${player.display_name} was added${drop ? ` and ${drop.display_name} was dropped` : ""}.`, now, JSON.stringify(metadata)),
  ];
  if (drop) {
    statements.push(db.prepare("update fantasy_roster_players set released_at_utc=?1, revision_number=revision_number+1 where fantasy_roster_player_id=?2 and released_at_utc is null").bind(now, drop.fantasy_roster_player_id));
    statements.push(db.prepare("insert into transaction_assets (transaction_asset_id, transaction_id, fantasy_team_id, asset_type, asset_id, direction, metadata_json) values (?1,?2,?3,'player',?4,'released',?5)").bind(newId("txa"), transactionId, teamId, drop.nfl_player_id, JSON.stringify({ displayName: drop.display_name })));
  }
  if (waiver) {
    const balance = await db.prepare("select waiver_priority from team_transaction_balances where league_season_id=?1 and fantasy_team_id=?2").bind(seasonId, teamId).first<{ waiver_priority: number }>();
    const maximum = await db.prepare("select max(waiver_priority) as maximum from team_transaction_balances where league_season_id=?1").bind(seasonId).first<{ maximum: number }>();
    statements.push(db.prepare("update waiver_claims set status='succeeded', transaction_id=?1, processed_at_utc=?2, revision_number=revision_number+1 where waiver_claim_id=?3 and status='pending'").bind(transactionId, now, waiver.claimId));
    statements.push(db.prepare("update team_transaction_balances set waiver_priority=waiver_priority-1, revision_number=revision_number+1, updated_at_utc=?1 where league_season_id=?2 and waiver_priority>?3").bind(now, seasonId, balance?.waiver_priority ?? 1));
    statements.push(db.prepare("update team_transaction_balances set faab_remaining_milli=faab_remaining_milli-?1, waiver_priority=?2, revision_number=revision_number+1, updated_at_utc=?3 where league_season_id=?4 and fantasy_team_id=?5 and faab_remaining_milli>=?1").bind(waiver.bidMilli, maximum?.maximum ?? 1, now, seasonId, teamId));
  }
  try { await db.batch(statements); } catch { throw new ApiException(409, "player_unavailable", "The player is no longer available or the roster changed while processing."); }
  await notifySafely(env,leagueId,{notificationType:source==="waiver"?"waiver-succeeded":"add-drop",title:source==="waiver"?"Waiver claim succeeded":"Roster move completed",body:`${player.display_name} was added${drop?` and ${drop.display_name} was dropped`:""}.`,entityType:"transaction",entityId:transactionId,actionUrl:`/?league=${leagueId}&tab=transactions`},{recipientUserIds:[actorUserId]});
  return transactionId;
}

async function proposeTrade(principal: AccessTokenPrincipal, db: D1Database, leagueId: string, seasonId: string, body: ProposeTradeRequest, env: Env, correlationId: string): Promise<TradeView> {
  const proposer = await requireManagedTeam(db, seasonId, principal.userId); const settings = await loadSettings(db, seasonId);
  const currentWeek = await currentNflWeek(env.NFL_DB);
  if (currentWeek > settings.trade_deadline_week) throw new ApiException(409, "trade_deadline_passed", "The league trade deadline has passed.");
  const recipients = [...new Set(body.recipientTeamIds ?? [])].filter((id) => id !== proposer.fantasy_team_id);
  if (!recipients.length || recipients.length > 4) throw new ApiException(400, "trade_recipients_required", "Choose at least one other team for the trade.");
  const teams = await db.prepare(`select fantasy_team_id from fantasy_teams where league_season_id=?1 and fantasy_team_id in (${recipients.map((_, index) => `?${index + 2}`).join(",")})`).bind(seasonId, ...recipients).all<{ fantasy_team_id: string }>();
  if ((teams.results ?? []).length !== recipients.length) throw new ApiException(400, "invalid_trade_team", "A trade team does not belong to this league season.");
  if (!Array.isArray(body.assets) || !body.assets.length) throw new ApiException(400, "trade_assets_required", "Add at least one player, pick, or FAAB asset.");
  await validateTradeAssetSet(db, seasonId, body.assets);
  const participantIds = new Set([proposer.fantasy_team_id, ...recipients]);
  for (const asset of body.assets) {
    if (!participantIds.has(asset.fromFantasyTeamId) || !participantIds.has(asset.toFantasyTeamId) || asset.fromFantasyTeamId === asset.toFantasyTeamId) throw new ApiException(400, "invalid_trade_asset_route", "Every asset must move between participating teams.");
    await validateTradeAsset(db, seasonId, asset, settings);
    if (asset.assetType === "player" && asset.assetId && await isPlayerLocked(env, asset.assetId)) throw new ApiException(409, "trade_player_locked", "A player in this proposal is currently locked in an NFL game.");
  }
  await validateTradeRosterOutcomes(db, seasonId, body.assets);
  const expiresAt = new Date(body.expiresAtUtc); if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now() || expiresAt.getTime() > Date.now() + 14 * 86400000) throw new ApiException(400, "invalid_trade_expiration", "Trade expiration must be within the next 14 days.");
  const now = new Date().toISOString(); const tradeId = newId("trd");
  const statements: D1PreparedStatement[] = [db.prepare("insert into trades (trade_id, league_season_id, parent_trade_id, proposed_by_team_id, status, message, expires_at_utc, created_by_user_id, created_at_utc, updated_at_utc) values (?1,?2,?3,?4,'proposed',?5,?6,?7,?8,?8)").bind(tradeId, seasonId, body.parentTradeId ?? null, proposer.fantasy_team_id, body.message?.trim().slice(0, 500) || null, expiresAt.toISOString(), principal.userId, now)];
  for (const teamId of participantIds) statements.push(db.prepare("insert into trade_teams (trade_team_id, trade_id, fantasy_team_id, response_status, responded_by_user_id, responded_at_utc) values (?1,?2,?3,?4,?5,?6)").bind(newId("trt"), tradeId, teamId, teamId === proposer.fantasy_team_id ? "accepted" : "pending", teamId === proposer.fantasy_team_id ? principal.userId : null, teamId === proposer.fantasy_team_id ? now : null));
  for (const asset of body.assets) statements.push(db.prepare("insert into trade_assets (trade_asset_id, trade_id, from_fantasy_team_id, to_fantasy_team_id, asset_type, asset_id, amount_milli, metadata_json) values (?1,?2,?3,?4,?5,?6,?7,?8)").bind(newId("tra"), tradeId, asset.fromFantasyTeamId, asset.toFantasyTeamId, asset.assetType, asset.assetId ?? null, asset.amount === undefined ? null : Math.round(asset.amount * 1000), JSON.stringify({ draftSeasonYear: asset.draftSeasonYear, roundNumber: asset.roundNumber, originalFantasyTeamId: asset.originalFantasyTeamId })));
  statements.push(db.prepare("insert into league_audit_events (league_audit_event_id, league_id, actor_user_id, action, entity_type, entity_id, correlation_id, created_at_utc, metadata_json) values (?1,?2,?3,'trade.proposed','trade',?4,?5,?6,?7)").bind(newId("lae"), leagueId, principal.userId, tradeId, correlationId, now, JSON.stringify({ recipients, assetCount: body.assets.length })));
  await db.batch(statements);
  const recipientUsers=await db.prepare(`select manager_user_id from fantasy_teams where league_season_id=?1 and fantasy_team_id in (${recipients.map((_,index)=>`?${index+2}`).join(",")})`).bind(seasonId,...recipients).all<{manager_user_id:string}>();
  await notifySafely(env,leagueId,{notificationType:"trade-received",title:"New trade offer",body:"A team sent you a trade proposal.",entityType:"trade",entityId:tradeId,actionUrl:`/?league=${leagueId}&tab=transactions`},{recipientUserIds:(recipientUsers.results??[]).map(row=>row.manager_user_id)});
  return requireTradeView(principal, db, leagueId, seasonId, tradeId, env);
}

async function tradeAction(principal: AccessTokenPrincipal, db: D1Database, leagueId: string, seasonId: string, tradeId: string, action: string, request: Request, env: Env, correlationId: string): Promise<TradeView> {
  const trade = await db.prepare("select status, proposed_by_team_id, revision_number, expires_at_utc from trades where trade_id=?1 and league_season_id=?2").bind(tradeId, seasonId).first<{ status: string; proposed_by_team_id: string; revision_number: number; expires_at_utc: string }>();
  if (!trade) throw new ApiException(404, "trade_not_found", "Trade not found.");
  const team = await requireManagedTeam(db, seasonId, principal.userId); const body = await readJson<{ revisionNumber?: number; vote?: "approve" | "veto"; proposal?: ProposeTradeRequest }>(request);
  if (body.revisionNumber !== trade.revision_number) throw new ApiException(409, "trade_revision_conflict", "The trade changed. Reload before responding.");
  const participant = await db.prepare("select response_status from trade_teams where trade_id=?1 and fantasy_team_id=?2").bind(tradeId, team.fantasy_team_id).first<{ response_status: string }>();
  const now = new Date().toISOString();
  if (action === "accept") {
    if (!participant || trade.status !== "proposed" || Date.parse(trade.expires_at_utc) <= Date.now()) throw new ApiException(409, "trade_not_actionable", "This trade cannot be accepted.");
    await db.prepare("update trade_teams set response_status='accepted', responded_by_user_id=?1, responded_at_utc=?2 where trade_id=?3 and fantasy_team_id=?4").bind(principal.userId, now, tradeId, team.fantasy_team_id).run();
    const pending = await db.prepare("select count(*) as count from trade_teams where trade_id=?1 and response_status!='accepted'").bind(tradeId).first<{ count: number }>();
    if ((pending?.count ?? 0) === 0) {
      const settings = await loadSettings(db, seasonId); const status = settings.trade_review_mode === "none" ? "approved" : "under-review"; const reviewEnds = new Date(Date.now() + settings.trade_review_hours * 3600000).toISOString();
      await db.prepare("update trades set status=?1, review_ends_at_utc=?2, revision_number=revision_number+1, updated_at_utc=?3 where trade_id=?4").bind(status, reviewEnds, now, tradeId).run();
      if (status === "approved") await settleTrade(db, env, leagueId, seasonId, tradeId, principal.userId, correlationId);
    } else await db.prepare("update trades set revision_number=revision_number+1, updated_at_utc=?1 where trade_id=?2").bind(now, tradeId).run();
  } else if (action === "reject") {
    if (!participant) throw new ApiException(403, "trade_participant_required", "Only a participating team may reject this trade.");
    await db.batch([db.prepare("update trade_teams set response_status='rejected', responded_by_user_id=?1, responded_at_utc=?2 where trade_id=?3 and fantasy_team_id=?4").bind(principal.userId, now, tradeId, team.fantasy_team_id), db.prepare("update trades set status='rejected', revision_number=revision_number+1, updated_at_utc=?1 where trade_id=?2 and status in ('proposed','countered')").bind(now, tradeId)]);
  } else if (action === "cancel") {
    if (trade.proposed_by_team_id !== team.fantasy_team_id) throw new ApiException(403, "trade_owner_required", "Only the proposing team may cancel this trade.");
    await db.prepare("update trades set status='cancelled', revision_number=revision_number+1, updated_at_utc=?1 where trade_id=?2 and status in ('draft','proposed','countered')").bind(now, tradeId).run();
  } else if (action === "counter") {
    if (!participant || !body.proposal) throw new ApiException(400, "counteroffer_required", "A participating team and replacement proposal are required.");
    await db.prepare("update trades set status='countered', revision_number=revision_number+1, updated_at_utc=?1 where trade_id=?2 and status='proposed'").bind(now, tradeId).run();
    return proposeTrade(principal, db, leagueId, seasonId, { ...body.proposal, parentTradeId: tradeId }, env, correlationId);
  } else if (action === "vote") {
    const settings = await loadSettings(db, seasonId);
    if (settings.trade_review_mode !== "league-vote" || trade.status !== "under-review" || !body.vote) throw new ApiException(400, "trade_vote_required", "A league team may vote while this trade is under review.");
    await db.prepare("insert into trade_votes (trade_vote_id, trade_id, fantasy_team_id, user_id, vote, created_at_utc) values (?1,?2,?3,?4,?5,?6) on conflict(trade_id, fantasy_team_id) do update set vote=excluded.vote, user_id=excluded.user_id, created_at_utc=excluded.created_at_utc").bind(newId("trv"), tradeId, team.fantasy_team_id, principal.userId, body.vote, now).run();
    const vetoes = await db.prepare("select count(*) as count from trade_votes where trade_id=?1 and vote='veto'").bind(tradeId).first<{ count: number }>();
    if ((vetoes?.count ?? 0) >= settings.veto_threshold) await db.prepare("update trades set status='vetoed', revision_number=revision_number+1, updated_at_utc=?1 where trade_id=?2 and status='under-review'").bind(now, tradeId).run();
  } else if (action === "approve" || action === "veto") {
    await requireLeagueRole(principal, leagueId, env, ["commissioner", "co-commissioner"]);
    if (action === "veto") await db.prepare("update trades set status='vetoed', revision_number=revision_number+1, updated_at_utc=?1 where trade_id=?2 and status='under-review'").bind(now, tradeId).run();
    else { await db.prepare("update trades set status='approved', revision_number=revision_number+1, updated_at_utc=?1 where trade_id=?2 and status='under-review'").bind(now, tradeId).run(); await settleTrade(db, env, leagueId, seasonId, tradeId, principal.userId, correlationId); }
  } else throw new ApiException(404, "trade_action_not_found", "Trade action not found.");
  const view=await requireTradeView(principal, db, leagueId, seasonId, tradeId, env);
  const participantUsers=await db.prepare("select teams.manager_user_id from trade_teams joined join fantasy_teams teams on teams.fantasy_team_id=joined.fantasy_team_id where joined.trade_id=?1").bind(tradeId).all<{manager_user_id:string}>();
  const notificationType=view.status==="rejected"?"trade-rejected":view.status==="processed"?"trade-accepted":"trade-updated";
  await notifySafely(env,leagueId,{notificationType,title:view.status==="processed"?"Trade completed":`Trade ${view.status}`,body:"A trade involving your team was updated.",entityType:"trade",entityId:tradeId,actionUrl:`/?league=${leagueId}&tab=transactions`},{recipientUserIds:(participantUsers.results??[]).map(row=>row.manager_user_id),excludeUserIds:[principal.userId]});
  return view;
}

async function processTrade(db: D1Database, env: Env, leagueId: string, seasonId: string, tradeId: string, actorUserId: string, correlationId: string): Promise<void> {
  const assets = await db.prepare("select from_fantasy_team_id, to_fantasy_team_id, asset_type, asset_id, amount_milli, metadata_json from trade_assets where trade_id=?1").bind(tradeId).all<{ from_fantasy_team_id: string; to_fantasy_team_id: string; asset_type: TradeAssetInput["assetType"]; asset_id: string | null; amount_milli: number | null; metadata_json: string }>();
  const settings = await loadSettings(db, seasonId); const inputs: TradeAssetInput[] = []; for (const asset of assets.results ?? []) { const metadata = parseObject(asset.metadata_json); const input = { fromFantasyTeamId: asset.from_fantasy_team_id, toFantasyTeamId: asset.to_fantasy_team_id, assetType: asset.asset_type, assetId: asset.asset_id ?? undefined, amount: asset.amount_milli === null ? undefined : asset.amount_milli / 1000, draftSeasonYear: Number(metadata.draftSeasonYear), roundNumber: Number(metadata.roundNumber), originalFantasyTeamId: typeof metadata.originalFantasyTeamId === "string" ? metadata.originalFantasyTeamId : undefined }; inputs.push(input); await validateTradeAsset(db, seasonId, input, settings); if (asset.asset_type === "player" && asset.asset_id && await isPlayerLocked(env, asset.asset_id)) throw new ApiException(409, "trade_player_locked", "A traded player is currently locked in an NFL game."); }
  await validateTradeAssetSet(db, seasonId, inputs);
  await validateTradeRosterOutcomes(db, seasonId, inputs);
  const now = new Date().toISOString(); const transactionId = newId("txn"); const statements: D1PreparedStatement[] = [db.prepare("insert into transactions (transaction_id, league_season_id, transaction_type, status, source_entity_type, source_entity_id, actor_user_id, metadata_json, created_at_utc, processed_at_utc) values (?1,?2,'trade','succeeded','trade',?3,?4,?5,?6,?6)").bind(transactionId, seasonId, tradeId, actorUserId, JSON.stringify({ tradeId }), now)];
  for (const asset of assets.results ?? []) {
    if (asset.asset_type === "player") statements.push(db.prepare("update fantasy_roster_players set fantasy_team_id=?1, acquisition_type='trade', acquisition_id=?2, revision_number=revision_number+1 where league_season_id=?3 and fantasy_team_id=?4 and nfl_player_id=?5 and released_at_utc is null").bind(asset.to_fantasy_team_id, tradeId, seasonId, asset.from_fantasy_team_id, asset.asset_id));
    if (asset.asset_type === "faab") { statements.push(db.prepare("update team_transaction_balances set faab_remaining_milli=faab_remaining_milli-?1, revision_number=revision_number+1, updated_at_utc=?2 where league_season_id=?3 and fantasy_team_id=?4").bind(asset.amount_milli, now, seasonId, asset.from_fantasy_team_id)); statements.push(db.prepare("update team_transaction_balances set faab_remaining_milli=faab_remaining_milli+?1, revision_number=revision_number+1, updated_at_utc=?2 where league_season_id=?3 and fantasy_team_id=?4").bind(asset.amount_milli, now, seasonId, asset.to_fantasy_team_id)); }
    if (asset.asset_type === "draft-pick") { const meta = parseObject(asset.metadata_json); statements.push(db.prepare("insert into traded_draft_picks (traded_draft_pick_id, league_season_id, draft_season_year, round_number, original_fantasy_team_id, current_fantasy_team_id, source_trade_id, updated_at_utc) values (?1,?2,?3,?4,?5,?6,?7,?8) on conflict(league_season_id,draft_season_year,round_number,original_fantasy_team_id) do update set current_fantasy_team_id=excluded.current_fantasy_team_id, source_trade_id=excluded.source_trade_id, revision_number=traded_draft_picks.revision_number+1, updated_at_utc=excluded.updated_at_utc").bind(newId("tdp"), seasonId, Number(meta.draftSeasonYear), Number(meta.roundNumber), String(meta.originalFantasyTeamId), asset.to_fantasy_team_id, tradeId, now)); }
    statements.push(db.prepare("insert into transaction_assets (transaction_asset_id, transaction_id, fantasy_team_id, asset_type, asset_id, direction, amount_milli, metadata_json) values (?1,?2,?3,?4,?5,'released',?6,?7)").bind(newId("txa"), transactionId, asset.from_fantasy_team_id, asset.asset_type, asset.asset_id, asset.amount_milli, asset.metadata_json));
    statements.push(db.prepare("insert into transaction_assets (transaction_asset_id, transaction_id, fantasy_team_id, asset_type, asset_id, direction, amount_milli, metadata_json) values (?1,?2,?3,?4,?5,'acquired',?6,?7)").bind(newId("txa"), transactionId, asset.to_fantasy_team_id, asset.asset_type, asset.asset_id, asset.amount_milli, asset.metadata_json));
  }
  statements.push(db.prepare("update trades set status='processed', processed_at_utc=?1, updated_at_utc=?1, revision_number=revision_number+1 where trade_id=?2 and status='approved'").bind(now, tradeId)); statements.push(db.prepare("insert into league_audit_events (league_audit_event_id, league_id, actor_user_id, action, entity_type, entity_id, correlation_id, created_at_utc, metadata_json) values (?1,?2,?3,'trade.processed','trade',?4,?5,?6,?7)").bind(newId("lae"), leagueId, actorUserId, tradeId, correlationId, now, JSON.stringify({ transactionId }))); statements.push(db.prepare("insert into league_activity (league_activity_id,league_id,actor_user_id,activity_type,message,created_at_utc,metadata_json) values (?1,?2,?3,'trade.processed','A trade was completed.',?4,?5)").bind(newId("lga"),leagueId,actorUserId,now,JSON.stringify({tradeId,transactionId})));
  try { await db.batch(statements); } catch { await db.prepare("update trades set status='failed', failure_reason='Asset ownership or roster state changed before processing.', updated_at_utc=?1, revision_number=revision_number+1 where trade_id=?2").bind(now, tradeId).run(); throw new ApiException(409, "trade_processing_failed", "Trade assets changed before processing."); }
}

async function settleTrade(db: D1Database, env: Env, leagueId: string, seasonId: string, tradeId: string, actorUserId: string, correlationId: string): Promise<void> {
  try { await processTrade(db, env, leagueId, seasonId, tradeId, actorUserId, correlationId); }
  catch (error) { await db.prepare("update trades set status='failed', failure_reason=?1, updated_at_utc=?2, revision_number=revision_number+1 where trade_id=?3 and status!='processed'").bind(error instanceof Error ? error.message : "Trade processing failed.", new Date().toISOString(), tradeId).run(); throw error; }
}

async function notifySafely(env:Env,leagueId:string,job:Parameters<typeof enqueueLeagueNotification>[2],options?:Parameters<typeof enqueueLeagueNotification>[3]):Promise<void>{try{await enqueueLeagueNotification(env,leagueId,job,options);}catch(error){console.error(JSON.stringify({level:"error",event:"notification_enqueue_failed",leagueId,error:error instanceof Error?error.message:String(error)}));}}

async function loadTrades(principal: AccessTokenPrincipal, db: D1Database, leagueId: string, seasonId: string, _env: Env): Promise<TradeView[]> {
  const result = await db.prepare("select trade_id from trades where league_season_id=?1 order by updated_at_utc desc limit 50").bind(seasonId).all<{ trade_id: string }>();
  return Promise.all((result.results ?? []).map((row) => requireTradeView(principal, db, leagueId, seasonId, row.trade_id, _env)));
}

async function requireTradeView(principal: AccessTokenPrincipal, db: D1Database, _leagueId: string, seasonId: string, tradeId: string, env: Env): Promise<TradeView> {
  const trade = await db.prepare("select trade_id, parent_trade_id, proposed_by_team_id, status, message, expires_at_utc, review_ends_at_utc, revision_number from trades where trade_id=?1 and league_season_id=?2").bind(tradeId, seasonId).first<{ trade_id: string; parent_trade_id: string | null; proposed_by_team_id: string; status: string; message: string | null; expires_at_utc: string; review_ends_at_utc: string | null; revision_number: number }>();
  if (!trade) throw new ApiException(404, "trade_not_found", "Trade not found.");
  const [teams, assets, votes, managed, member] = await Promise.all([
    db.prepare("select trade_teams.fantasy_team_id, fantasy_teams.team_name, trade_teams.response_status from trade_teams join fantasy_teams on fantasy_teams.fantasy_team_id=trade_teams.fantasy_team_id where trade_teams.trade_id=?1 order by fantasy_teams.team_name").bind(tradeId).all<{ fantasy_team_id: string; team_name: string; response_status: string }>(),
    db.prepare("select from_fantasy_team_id, to_fantasy_team_id, asset_type, asset_id, amount_milli, metadata_json from trade_assets where trade_id=?1").bind(tradeId).all<{ from_fantasy_team_id: string; to_fantasy_team_id: string; asset_type: TradeAssetInput["assetType"]; asset_id: string | null; amount_milli: number | null; metadata_json: string }>(),
    db.prepare("select fantasy_team_id, vote from trade_votes where trade_id=?1").bind(tradeId).all<{ fantasy_team_id: string; vote: "approve" | "veto" }>(),
    db.prepare("select fantasy_team_id from fantasy_teams where league_season_id=?1 and manager_user_id=?2").bind(seasonId, principal.userId).first<{ fantasy_team_id: string }>(),
    db.prepare("select role from league_members where league_id=(select league_id from league_seasons where league_season_id=?1) and user_id=?2 and removed_at_utc is null").bind(seasonId, principal.userId).first<{ role: string }>(),
  ]);
  const playerProfiles = await loadPlayerProfiles(env.NFL_DB, (assets.results ?? []).filter((asset) => asset.asset_type === "player" && asset.asset_id).map((asset) => asset.asset_id!));
  return { tradeId: trade.trade_id, parentTradeId: trade.parent_trade_id ?? undefined, status: trade.status, message: trade.message ?? undefined, expiresAtUtc: trade.expires_at_utc, reviewEndsAtUtc: trade.review_ends_at_utc ?? undefined, revisionNumber: trade.revision_number, proposedByTeamId: trade.proposed_by_team_id, canRespond: Boolean(managed && (teams.results ?? []).some((team) => team.fantasy_team_id === managed.fantasy_team_id && team.response_status === "pending") && trade.status === "proposed"), canCancel: managed?.fantasy_team_id === trade.proposed_by_team_id && ["draft","proposed"].includes(trade.status), canReview: ["commissioner","co-commissioner"].includes(member?.role ?? "") && trade.status === "under-review", canVote: Boolean(managed && trade.status === "under-review"), teams: (teams.results ?? []).map((team) => ({ fantasyTeamId: team.fantasy_team_id, teamName: team.team_name, responseStatus: team.response_status })), assets: (assets.results ?? []).map((asset) => ({ fromFantasyTeamId: asset.from_fantasy_team_id, toFantasyTeamId: asset.to_fantasy_team_id, assetType: asset.asset_type, assetId: asset.asset_id ?? undefined, amount: asset.amount_milli === null ? undefined : asset.amount_milli / 1000, ...parseObject(asset.metadata_json), displayName: asset.asset_type === "player" && asset.asset_id ? playerProfiles.get(asset.asset_id)?.display_name ?? asset.asset_id : assetDisplayName(asset) })), votes: (votes.results ?? []).map((vote) => ({ fantasyTeamId: vote.fantasy_team_id, vote: vote.vote })) };
}

async function validateTradeAsset(db: D1Database, seasonId: string, asset: TradeAssetInput, settings: SettingsRow): Promise<void> {
  if (asset.assetType === "player") {
    if (!asset.assetId) throw new ApiException(400, "trade_player_required", "A player asset requires a player ID.");
    const owned = await db.prepare("select 1 as owned from fantasy_roster_players where league_season_id=?1 and fantasy_team_id=?2 and nfl_player_id=?3 and released_at_utc is null").bind(seasonId, asset.fromFantasyTeamId, asset.assetId).first();
    if (!owned) throw new ApiException(409, "trade_asset_not_owned", "A player is no longer owned by the offering team.");
  } else if (asset.assetType === "faab") {
    if (!settings.faab_trading_enabled) throw new ApiException(409, "faab_trading_disabled", "FAAB trading is disabled.");
    const amount = Math.round(Number(asset.amount ?? 0) * 1000); const balance = await db.prepare("select faab_remaining_milli from team_transaction_balances where league_season_id=?1 and fantasy_team_id=?2").bind(seasonId, asset.fromFantasyTeamId).first<{ faab_remaining_milli: number }>();
    if (amount <= 0 || amount > (balance?.faab_remaining_milli ?? 0)) throw new ApiException(409, "insufficient_faab", "The offering team does not have enough FAAB.");
  } else {
    if (!settings.draft_pick_trading_enabled) throw new ApiException(409, "pick_trading_disabled", "Draft-pick trading is disabled.");
    if (!asset.draftSeasonYear || !asset.roundNumber || !asset.originalFantasyTeamId) throw new ApiException(400, "draft_pick_details_required", "Draft season, round, and original team are required.");
    const owner = await db.prepare("select current_fantasy_team_id from traded_draft_picks where league_season_id=?1 and draft_season_year=?2 and round_number=?3 and original_fantasy_team_id=?4").bind(seasonId, asset.draftSeasonYear, asset.roundNumber, asset.originalFantasyTeamId).first<{ current_fantasy_team_id: string }>();
    if ((owner?.current_fantasy_team_id ?? asset.originalFantasyTeamId) !== asset.fromFantasyTeamId) throw new ApiException(409, "draft_pick_not_owned", "The offering team does not own that draft pick.");
  }
}

async function validateTradeAssetSet(db: D1Database, seasonId: string, assets: TradeAssetInput[]): Promise<void> {
  const keys = new Set<string>();
  for (const asset of assets) {
    const identity = asset.assetType === "draft-pick" ? `${asset.draftSeasonYear}:${asset.roundNumber}:${asset.originalFantasyTeamId}` : asset.assetId ?? String(asset.amount);
    const key = `${asset.assetType}:${identity}:${asset.fromFantasyTeamId}:${asset.toFantasyTeamId}`;
    if (keys.has(key)) throw new ApiException(400, "duplicate_trade_asset", "The same trade asset cannot be included twice.");
    keys.add(key);
  }
  const faabTeams = [...new Set(assets.filter((asset) => asset.assetType === "faab").map((asset) => asset.fromFantasyTeamId))];
  for (const teamId of faabTeams) {
    const outgoing = assets.filter((asset) => asset.assetType === "faab" && asset.fromFantasyTeamId === teamId).reduce((total, asset) => total + Math.round(Number(asset.amount ?? 0) * 1000), 0);
    const balance = await db.prepare("select faab_remaining_milli from team_transaction_balances where league_season_id=?1 and fantasy_team_id=?2").bind(seasonId, teamId).first<{ faab_remaining_milli: number }>();
    if (outgoing > (balance?.faab_remaining_milli ?? 0)) throw new ApiException(409, "insufficient_faab", "A team does not have enough FAAB for all assets in this trade.");
  }
}

async function validateTradeRosterOutcomes(db: D1Database, seasonId: string, assets: TradeAssetInput[]): Promise<void> {
  const playerAssets = assets.filter((asset) => asset.assetType === "player" && asset.assetId);
  if (!playerAssets.length) return;
  const teamIds = [...new Set(playerAssets.flatMap((asset) => [asset.fromFantasyTeamId, asset.toFantasyTeamId]))];
  const activeLimit = await db.prepare("select sum(slots.slot_count) as count from roster_slots slots join roster_definitions definitions on definitions.roster_definition_id=slots.roster_definition_id where definitions.league_season_id=?1 and slots.slot_type not in ('IR','PUP','TAXI')").bind(seasonId).first<{ count: number }>();
  for (const teamId of teamIds) {
    const [roster, limits] = await Promise.all([
      db.prepare("select nfl_player_id, position from fantasy_roster_players where league_season_id=?1 and fantasy_team_id=?2 and released_at_utc is null").bind(seasonId, teamId).all<{ nfl_player_id: string; position: string }>(),
      db.prepare("select limits.position, limits.maximum_count from roster_position_limits limits join roster_definitions definitions on definitions.roster_definition_id=limits.roster_definition_id where definitions.league_season_id=?1").bind(seasonId).all<{ position: string; maximum_count: number }>(),
    ]);
    const positions = new Map((roster.results ?? []).map((player) => [player.nfl_player_id, player.position]));
    const resulting = new Map(positions);
    for (const asset of playerAssets.filter((item) => item.fromFantasyTeamId === teamId)) resulting.delete(asset.assetId!);
    for (const asset of playerAssets.filter((item) => item.toFantasyTeamId === teamId)) {
      const source = await db.prepare("select position from fantasy_roster_players where league_season_id=?1 and fantasy_team_id=?2 and nfl_player_id=?3 and released_at_utc is null").bind(seasonId, asset.fromFantasyTeamId, asset.assetId).first<{ position: string }>();
      if (source) resulting.set(asset.assetId!, source.position);
    }
    if (resulting.size > (activeLimit?.count ?? 0)) throw new ApiException(409, "trade_roster_full", "A team would exceed its active roster size after this trade.");
    for (const limit of limits.results ?? []) if ([...resulting.values()].filter((position) => position === limit.position).length > limit.maximum_count) throw new ApiException(409, "trade_position_limit", `A team would exceed its ${limit.position} roster limit after this trade.`);
  }
}

async function loadSettings(db: D1Database, seasonId: string): Promise<SettingsRow> { const row = await db.prepare("select acquisition_mode, faab_budget_milli, minimum_bid_milli, waiver_period_hours, waiver_tiebreaker, trade_deadline_week, trade_review_mode, trade_review_hours, veto_threshold, draft_pick_trading_enabled, faab_trading_enabled, revision_number from transaction_settings where league_season_id=?1").bind(seasonId).first<SettingsRow>(); if (!row) throw new ApiException(500, "transaction_settings_missing", "Transaction settings are unavailable."); return row; }
function settingsView(row: SettingsRow): TransactionSettingsResponse { return { acquisitionMode: row.acquisition_mode, faabBudget: row.faab_budget_milli/1000, minimumBid: row.minimum_bid_milli/1000, waiverPeriodHours: row.waiver_period_hours, waiverTiebreaker: row.waiver_tiebreaker, tradeDeadlineWeek: row.trade_deadline_week, tradeReviewMode: row.trade_review_mode, tradeReviewHours: row.trade_review_hours, vetoThreshold: row.veto_threshold, draftPickTradingEnabled: Boolean(row.draft_pick_trading_enabled), faabTradingEnabled: Boolean(row.faab_trading_enabled), revisionNumber: row.revision_number } }
async function currentWaiverPeriod(db: D1Database, seasonId: string, userId: string): Promise<{ waiver_period_id: string; processes_at_utc: string; status: string }> { let row = await db.prepare("select waiver_period_id, processes_at_utc, status from waiver_periods where league_season_id=?1 and status in ('open','processing') order by period_number desc limit 1").bind(seasonId).first<{ waiver_period_id: string; processes_at_utc: string; status: string }>(); if (row) return row; const settings = await loadSettings(db, seasonId); const now = new Date().toISOString(); const id = newId("wpr"); try { await db.prepare("insert into waiver_periods (waiver_period_id, league_season_id, period_number, opens_at_utc, processes_at_utc, status, created_at_utc) values (?1,?2,coalesce((select max(period_number)+1 from waiver_periods where league_season_id=?2),1),?3,?4,'open',?3)").bind(id, seasonId, now, new Date(Date.now()+settings.waiver_period_hours*3600000).toISOString()).run(); } catch { /* Another request created the period. */ } row = await db.prepare("select waiver_period_id, processes_at_utc, status from waiver_periods where league_season_id=?1 and status in ('open','processing') order by period_number desc limit 1").bind(seasonId).first<{ waiver_period_id: string; processes_at_utc: string; status: string }>(); if (!row) throw new ApiException(500,"waiver_period_missing",`Unable to initialize waivers for ${userId}.`); return row; }
async function loadClaims(db: D1Database, nflDb: D1Database, periodId: string, teamId: string): Promise<TransactionsDashboardResponse["claims"]> { const result = await db.prepare("select claims.waiver_claim_id, claims.add_nfl_player_id, claims.conditional_drop_roster_player_id, claims.bid_milli, claims.claim_order, claims.status, claims.failure_reason, claims.revision_number, periods.processes_at_utc, dropped.nfl_player_id as drop_player_id from waiver_claims claims join waiver_claim_groups groups on groups.waiver_claim_group_id=claims.waiver_claim_group_id join waiver_periods periods on periods.waiver_period_id=groups.waiver_period_id left join fantasy_roster_players dropped on dropped.fantasy_roster_player_id=claims.conditional_drop_roster_player_id where groups.waiver_period_id=?1 and groups.fantasy_team_id=?2 order by claims.claim_order").bind(periodId,teamId).all<{ waiver_claim_id:string;add_nfl_player_id:string;conditional_drop_roster_player_id:string|null;bid_milli:number;claim_order:number;status:string;failure_reason:string|null;revision_number:number;processes_at_utc:string;drop_player_id:string|null }>(); const ids=[...new Set((result.results??[]).flatMap(row=>[row.add_nfl_player_id,row.drop_player_id].filter(Boolean) as string[]))]; const profiles=await loadPlayerProfiles(nflDb,ids); return (result.results??[]).map(row=>{const player=profiles.get(row.add_nfl_player_id);const drop=row.drop_player_id?profiles.get(row.drop_player_id):undefined;return {waiverClaimId:row.waiver_claim_id,playerId:row.add_nfl_player_id,playerName:player?.display_name??"NFL player",position:player?.position??"UNK",nflTeam:player?.abbreviation??undefined,dropRosterPlayerId:row.conditional_drop_roster_player_id??undefined,dropPlayerName:drop?.display_name,bid:row.bid_milli/1000,claimOrder:row.claim_order,status:row.status,failureReason:row.failure_reason??undefined,processesAtUtc:row.processes_at_utc,revisionNumber:row.revision_number};}); }
async function requireAvailablePlayer(db: D1Database, nflDb: D1Database, seasonId: string, playerId: string): Promise<PlayerRow> { const [player, owner]=await Promise.all([nflDb.prepare("select players.nfl_player_id,players.display_name,players.position,teams.abbreviation,players.current_team_id from nfl_players players left join nfl_teams teams on teams.nfl_team_id=players.current_team_id where players.nfl_player_id=?1").bind(playerId).first<PlayerRow>(),db.prepare("select fantasy_team_id from fantasy_roster_players where league_season_id=?1 and nfl_player_id=?2 and released_at_utc is null").bind(seasonId,playerId).first()]); if(!player)throw new ApiException(404,"player_not_found","Player not found.");if(owner)throw new ApiException(409,"player_unavailable","The player is already rostered.");return player; }
async function requireOwnedRosterPlayer(db:D1Database,teamId:string,rosterId:string):Promise<{fantasy_roster_player_id:string;nfl_player_id:string;position:string;display_name:string}>{const row=await db.prepare("select fantasy_roster_player_id,nfl_player_id,position from fantasy_roster_players where fantasy_roster_player_id=?1 and fantasy_team_id=?2 and released_at_utc is null").bind(rosterId,teamId).first<{fantasy_roster_player_id:string;nfl_player_id:string;position:string}>();if(!row)throw new ApiException(409,"drop_player_not_owned","The selected drop is no longer on this roster.");return {...row,display_name:"Roster player"};}
async function requireManagedTeam(db:D1Database,seasonId:string,userId:string):Promise<TeamRow>{const team=await db.prepare("select fantasy_team_id,team_name from fantasy_teams where league_season_id=?1 and manager_user_id=?2").bind(seasonId,userId).first<TeamRow>();if(!team)throw new ApiException(403,"fantasy_team_required","A managed fantasy team is required.");return team;}
async function loadPlayerProfiles(db:D1Database,ids:string[]):Promise<Map<string,PlayerRow>>{if(!ids.length)return new Map();const placeholders=ids.map((_,index)=>`?${index+1}`).join(",");const result=await db.prepare(`select players.nfl_player_id,players.display_name,players.position,teams.abbreviation,players.current_team_id from nfl_players players left join nfl_teams teams on teams.nfl_team_id=players.current_team_id where players.nfl_player_id in (${placeholders})`).bind(...ids).all<PlayerRow>();return new Map((result.results??[]).map(row=>[row.nfl_player_id,row]));}
async function isPlayerLocked(env:Env,playerId:string):Promise<boolean>{const runtime=await getProviderRuntime(env);const row=await env.NFL_DB.prepare("select snapshots.status from nfl_players players join nfl_event_snapshots snapshots on players.current_team_id in (snapshots.home_team_id,snapshots.away_team_id) where players.nfl_player_id=?1 and snapshots.data_scope=?2 order by snapshots.updated_at_utc desc limit 1").bind(playerId,runtime.dataScope).first<{status:string}>();return Boolean(row&&row.status!=="pre");}
function bounded(value:unknown,fallback:number,min:number,max:number):number{const number=Number(value);return Number.isFinite(number)?Math.min(max,Math.max(min,Math.round(number))):fallback;}
function parseObject(value:string):Record<string,unknown>{try{const parsed:unknown=JSON.parse(value);return parsed&&typeof parsed==="object"&&!Array.isArray(parsed)?parsed as Record<string,unknown>:{};}catch{return {};}}
function metadataSummary(value:string,type:string):string{const data=parseObject(value);if(type==="trade")return "Trade processed";const add=typeof data.addedPlayerName==="string"?data.addedPlayerName:"Player";const drop=typeof data.droppedPlayerName==="string"?` for ${data.droppedPlayerName}`:"";return `${add} added${drop}`;}
function assetDisplayName(asset:{asset_type:string;asset_id:string|null;amount_milli:number|null;metadata_json:string}):string{if(asset.asset_type==="faab")return `$${(asset.amount_milli??0)/1000} FAAB`;if(asset.asset_type==="draft-pick"){const meta=parseObject(asset.metadata_json);return `${meta.draftSeasonYear??"Future"} round ${meta.roundNumber??"?"} pick`;}return asset.asset_id??"Player";}
async function currentNflWeek(db:D1Database):Promise<number>{const row=await db.prepare("select coalesce(max(week),1) as week from nfl_events where starts_at_utc<=?1 and season_year=(select max(season_year) from nfl_events)").bind(new Date().toISOString()).first<{week:number}>();return row?.week??1;}
async function reverseStandingsPriority(db:D1Database,seasonId:string,teamId:string,dataScope:string):Promise<number>{const result=await db.prepare("select teams.fantasy_team_id,coalesce(sum(scores.total_points_milli),0) as points from fantasy_teams teams left join fantasy_roster_players roster on roster.fantasy_team_id=teams.fantasy_team_id and roster.released_at_utc is null left join player_event_scores scores on scores.league_season_id=teams.league_season_id and scores.nfl_player_id=roster.nfl_player_id and scores.data_scope=?1 where teams.league_season_id=?2 group by teams.fantasy_team_id order by points asc,teams.created_at_utc desc").bind(dataScope,seasonId).all<{fantasy_team_id:string;points:number}>();const index=(result.results??[]).findIndex(team=>team.fantasy_team_id===teamId);return index<0?1:index+1;}
