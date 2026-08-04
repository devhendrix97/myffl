import type {
  CreateLeagueMessageRequest,
  CursorPage,
  LeagueActivityView,
  LeagueChatResponse,
  LeagueMessageView,
  WeeklyReportMetric,
  WeeklyReportResponse,
} from "@myffl/api-contracts";
import { isAllowedAttachmentUrl, requireWeek } from "./communication-rules";
import { authenticate, type HandlerResult } from "./auth";
import { ApiException, corsHeaders } from "./http";
import { getLeagueRow, requireLeagueRole } from "./league";
import { enqueueNotification } from "./notifications";
import { publishRealtimeEvent } from "./realtime";
import { newId } from "./security";

type LeagueRole = "commissioner" | "co-commissioner" | "manager";
interface MessageRow {
  league_message_id: string; league_id: string; channel: "league"|"draft"; author_user_id: string;
  message_type: LeagueMessageView["messageType"]; body: string; attachment_key: string|null; attachment_url: string|null;
  reply_to_message_id: string|null; pinned: number; revision_number: number; created_at_utc: string;
  edited_at_utc: string|null; deleted_at_utc: string|null;
}

export async function handleCommunicationRequest(request: Request, url: URL, env: Env, correlationId: string): Promise<HandlerResult<unknown> | Response | undefined> {
  const match = url.pathname.match(/^\/api\/leagues\/([^/]+)\/(chat|activity|reports)(?:\/(.+))?$/);
  if (!match) return undefined;
  const leagueId = match[1]; const resource = match[2]; const suffix = match[3] ?? "";
  const principal = await authenticate(request, env);
  const access = await requireLeagueRole(principal, leagueId, env, ["commissioner","co-commissioner","manager"]);
  const league = await getLeagueRow(access.db, leagueId);
  const role = access.role as LeagueRole;
  if (resource === "activity" && request.method === "GET") return { data: await activityPage(access.db, env.CORE_DB, leagueId, url.searchParams.get("cursor")) };
  if (resource === "reports" && request.method === "GET") {
    const week = requireWeek(suffix || url.searchParams.get("week"));
    return { data: await weeklyReport(access.db, env.NFL_DB, leagueId, league.league_season_id, week) };
  }
  if (resource !== "chat") return undefined;
  const channel = requireChannel(url.searchParams.get("channel"));
  if (!suffix && request.method === "GET") return { data: await chatPage(access.db, env.CORE_DB, leagueId, principal.userId, channel, url.searchParams.get("cursor"), role) };
  if (!suffix && request.method === "POST") return { data: await createMessage(request, access.db, env, leagueId, league.league_season_id, principal.userId, principal.displayName, role, correlationId) };
  if (suffix === "read" && request.method === "POST") {
    const body = await request.json<{ channel?: string; messageId?: string }>(); const readChannel = requireChannel(body.channel);
    await markRead(access.db, leagueId, readChannel, principal.userId, body.messageId);
    return { data: { read: true } };
  }
  if (suffix === "assets" && request.method === "POST") return { data: await uploadAsset(request, env, leagueId) };
  const assetMatch = suffix.match(/^assets\/([^/]+)$/);
  if (assetMatch && request.method === "GET") return downloadAsset(request, env, leagueId, assetMatch[1]);
  const command = suffix.match(/^([^/]+)(?:\/(reactions|votes))?$/);
  if (!command) return undefined;
  if (!command[2] && request.method === "PATCH") return { data: await updateMessage(request, access.db, env, leagueId, command[1], principal.userId, role, correlationId) };
  if (!command[2] && request.method === "DELETE") return { data: await deleteMessage(access.db, env, leagueId, command[1], principal.userId, role, correlationId) };
  if (command[2] === "reactions" && (request.method === "POST" || request.method === "DELETE")) return { data: await reactToMessage(request, access.db, env, leagueId, command[1], principal.userId, request.method === "POST") };
  if (command[2] === "votes" && request.method === "POST") return { data: await voteInPoll(request, access.db, env, leagueId, command[1], principal.userId) };
  return undefined;
}

async function chatPage(db: D1Database, coreDb: D1Database, leagueId: string, userId: string, channel: "league"|"draft", cursor: string|null, role: LeagueRole): Promise<LeagueChatResponse> {
  const before = decodeCursor(cursor);
  const result = await db.prepare("select * from league_messages where league_id=?1 and channel=?2 and (?3 is null or created_at_utc<?3) order by pinned desc,created_at_utc desc limit 51").bind(leagueId, channel, before).all<MessageRow>();
  const rows = result.results ?? []; const page = rows.slice(0, 50);
  const messages = await hydrateMessages(db, coreDb, page, userId, role);
  const pinnedRows = await db.prepare("select * from league_messages where league_id=?1 and channel=?2 and pinned=1 and deleted_at_utc is null order by created_at_utc desc limit 10").bind(leagueId, channel).all<MessageRow>();
  const read = await db.prepare("select read_at_utc from message_read_state where league_id=?1 and channel=?2 and user_id=?3").bind(leagueId, channel, userId).first<{ read_at_utc: string }>();
  const unread = await db.prepare("select count(*) as count from league_messages where league_id=?1 and channel=?2 and author_user_id!=?3 and deleted_at_utc is null and created_at_utc>?4").bind(leagueId, channel, userId, read?.read_at_utc ?? "").first<{ count: number }>();
  return { messages: messages.reverse(), pinnedMessages: await hydrateMessages(db, coreDb, pinnedRows.results ?? [], userId, role), unreadCount: unread?.count ?? 0, nextCursor: rows.length > 50 ? encodeCursor(page.at(-1)!.created_at_utc) : undefined };
}

async function createMessage(request: Request, db: D1Database, env: Env, leagueId: string, seasonId: string, userId: string, displayName: string, role: LeagueRole, correlationId: string): Promise<LeagueMessageView> {
  const body = await request.json<CreateLeagueMessageRequest>();
  const channel = requireChannel(body.channel); const type = body.messageType ?? "text"; const text = String(body.body ?? "").trim();
  if (!["text","image","gif","poll","announcement"].includes(type)) throw new ApiException(400, "invalid_message_type", "Choose a supported message type.");
  if (type === "announcement" && !canManage(role)) throw new ApiException(403, "commissioner_required", "Only commissioners can post announcements.");
  if (text.length > 2000 || (!text && !body.attachmentUrl && type !== "poll")) throw new ApiException(400, "invalid_message", "Messages require content and may contain up to 2,000 characters.");
  if (body.attachmentUrl && !isAllowedAttachmentUrl(body.attachmentUrl, env.API_BASE_URL, leagueId)) throw new ApiException(400, "invalid_attachment", "Use an uploaded league image or a secure GIF URL.");
  const poll = body.poll;
  if (type === "poll" && (!poll || poll.question.trim().length < 2 || poll.options.length < 2 || poll.options.length > 10)) throw new ApiException(400, "invalid_poll", "Polls require a question and 2 to 10 options.");
  if (body.replyToMessageId) await requireMessage(db, leagueId, body.replyToMessageId);
  const messageId = newId("msg"); const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    db.prepare("insert into league_messages (league_message_id,league_id,league_season_id,channel,author_user_id,message_type,body,attachment_key,attachment_url,reply_to_message_id,created_at_utc) values (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)").bind(messageId, leagueId, seasonId, channel, userId, type, text, body.attachmentKey ?? null, body.attachmentUrl ?? null, body.replyToMessageId ?? null, now),
  ];
  if (poll) {
    const pollId = newId("pol");
    statements.push(db.prepare("insert into polls (poll_id,league_message_id,question,allows_multiple,closes_at_utc,created_at_utc) values (?1,?2,?3,?4,?5,?6)").bind(pollId, messageId, poll.question.trim().slice(0, 300), Number(Boolean(poll.allowsMultiple)), poll.closesAtUtc ?? null, now));
    poll.options.map((option, index) => option.trim()).filter(Boolean).forEach((option, index) => statements.push(db.prepare("insert into poll_options (poll_option_id,poll_id,display_text,display_order) values (?1,?2,?3,?4)").bind(newId("pop"), pollId, option.slice(0, 150), index)));
  }
  const members = await db.prepare("select user_id from league_members where league_id=?1 and status='active'").bind(leagueId).all<{ user_id: string }>();
  const memberIds = new Set((members.results ?? []).map((member) => member.user_id));
  const mentions = [...new Set(body.mentionedUserIds ?? [])].filter((id) => id !== userId && memberIds.has(id)).slice(0, 25);
  mentions.forEach((id) => statements.push(db.prepare("insert into message_mentions (league_message_id,mentioned_user_id,created_at_utc) values (?1,?2,?3)").bind(messageId, id, now)));
  if (type === "announcement") statements.push(db.prepare("insert into league_activity (league_activity_id,league_id,actor_user_id,activity_type,message,created_at_utc,metadata_json) values (?1,?2,?3,'announcement.posted',?4,?5,?6)").bind(newId("lga"), leagueId, userId, `${displayName} posted an announcement.`, now, JSON.stringify({ messageId })));
  await db.batch(statements);
  const recipients = type === "announcement" ? [...memberIds].filter((id) => id !== userId) : mentions;
  await Promise.all([
    publishRealtimeEvent(env, "league", leagueId, { eventType: type === "announcement" ? "AnnouncementPosted" : "LeagueMessageCreated", entityId: messageId, sourceRevision: 1, dataScope: "production", payload: { leagueId, messageId, channel, messageType: type, authorUserId: userId } }),
    enqueueNotification(env, { recipientUserIds: recipients, leagueId, notificationType: type === "announcement" ? "announcement" : "mention", title: type === "announcement" ? "League announcement" : `${displayName} mentioned you`, body: text || poll?.question || "Open league chat", entityType: "league-message", entityId: messageId, actionUrl: `/?league=${leagueId}&tab=chat` }),
  ]);
  void correlationId;
  return (await hydrateMessages(db, env.CORE_DB, [await requireMessage(db, leagueId, messageId)], userId, role))[0];
}

async function updateMessage(request: Request, db: D1Database, env: Env, leagueId: string, messageId: string, userId: string, role: LeagueRole, correlationId: string): Promise<LeagueMessageView> {
  const current = await requireMessage(db, leagueId, messageId);
  const body = await request.json<{ body?: string; pinned?: boolean; revisionNumber?: number }>();
  if (body.revisionNumber !== current.revision_number) throw new ApiException(409, "message_changed", "This message changed. Reload it before editing.");
  const editingText = typeof body.body === "string";
  if (editingText && current.author_user_id !== userId && !canManage(role)) throw new ApiException(403, "message_edit_forbidden", "You cannot edit this message.");
  if (typeof body.pinned === "boolean" && !canManage(role)) throw new ApiException(403, "commissioner_required", "Only commissioners can pin messages.");
  const text = editingText ? body.body!.trim().slice(0, 2000) : current.body;
  if (editingText && !text && !current.attachment_url) throw new ApiException(400, "invalid_message", "The message cannot be empty.");
  const now = new Date().toISOString();
  await db.prepare("update league_messages set body=?1,pinned=?2,revision_number=revision_number+1,edited_at_utc=?3 where league_message_id=?4 and league_id=?5").bind(text, typeof body.pinned === "boolean" ? Number(body.pinned) : current.pinned, editingText ? now : current.edited_at_utc, messageId, leagueId).run();
  const updated = await requireMessage(db, leagueId, messageId);
  await publishRealtimeEvent(env, "league", leagueId, { eventType: "LeagueMessageUpdated", entityId: messageId, sourceRevision: updated.revision_number, dataScope: "production", payload: { leagueId, messageId, pinned: Boolean(updated.pinned) } });
  void correlationId;
  return (await hydrateMessages(db, env.CORE_DB, [updated], userId, role))[0];
}

async function deleteMessage(db: D1Database, env: Env, leagueId: string, messageId: string, userId: string, role: LeagueRole, correlationId: string): Promise<{ messageId: string; deleted: boolean }> {
  const current = await requireMessage(db, leagueId, messageId);
  if (current.author_user_id !== userId && !canManage(role)) throw new ApiException(403, "message_delete_forbidden", "You cannot remove this message.");
  await db.prepare("update league_messages set body='',attachment_key=null,attachment_url=null,deleted_at_utc=?1,revision_number=revision_number+1 where league_message_id=?2 and league_id=?3").bind(new Date().toISOString(), messageId, leagueId).run();
  await publishRealtimeEvent(env, "league", leagueId, { eventType: "LeagueMessageDeleted", entityId: messageId, sourceRevision: current.revision_number + 1, dataScope: "production", payload: { leagueId, messageId } });
  void correlationId;
  return { messageId, deleted: true };
}

async function reactToMessage(request: Request, db: D1Database, env: Env, leagueId: string, messageId: string, userId: string, add: boolean): Promise<{ messageId: string; reaction: string; active: boolean }> {
  await requireMessage(db, leagueId, messageId);
  const body = await request.json<{ reaction?: string }>(); const reaction = String(body.reaction ?? "").trim();
  if (!/^[\p{L}\p{N}\p{Emoji_Presentation}\p{Extended_Pictographic}_+-]{1,24}$/u.test(reaction)) throw new ApiException(400, "invalid_reaction", "Choose a valid reaction.");
  if (add) await db.prepare("insert or ignore into message_reactions (league_message_id,user_id,reaction,created_at_utc) values (?1,?2,?3,?4)").bind(messageId, userId, reaction, new Date().toISOString()).run();
  else await db.prepare("delete from message_reactions where league_message_id=?1 and user_id=?2 and reaction=?3").bind(messageId, userId, reaction).run();
  await publishRealtimeEvent(env, "league", leagueId, { eventType: "MessageReactionUpdated", entityId: messageId, sourceRevision: Date.now(), dataScope: "production", payload: { leagueId, messageId, reaction, active: add } });
  return { messageId, reaction, active: add };
}

async function voteInPoll(request: Request, db: D1Database, env: Env, leagueId: string, messageId: string, userId: string): Promise<{ messageId: string; voted: boolean }> {
  await requireMessage(db, leagueId, messageId);
  const poll = await db.prepare("select poll_id,allows_multiple,closes_at_utc from polls where league_message_id=?1").bind(messageId).first<{ poll_id: string; allows_multiple: number; closes_at_utc: string|null }>();
  if (!poll) throw new ApiException(404, "poll_not_found", "This message does not contain a poll.");
  if (poll.closes_at_utc && poll.closes_at_utc <= new Date().toISOString()) throw new ApiException(409, "poll_closed", "This poll is closed.");
  const body = await request.json<{ optionIds?: string[] }>(); const ids = [...new Set(body.optionIds ?? [])];
  if (!ids.length || (!poll.allows_multiple && ids.length > 1)) throw new ApiException(400, "invalid_vote", "Choose a valid poll option.");
  const valid = await db.prepare(`select poll_option_id from poll_options where poll_id=?1 and poll_option_id in (${ids.map((_, index) => `?${index + 2}`).join(",")})`).bind(poll.poll_id, ...ids).all<{ poll_option_id: string }>();
  if ((valid.results ?? []).length !== ids.length) throw new ApiException(400, "invalid_vote", "Choose an option from this poll.");
  await db.batch([db.prepare("delete from poll_votes where user_id=?1 and poll_option_id in (select poll_option_id from poll_options where poll_id=?2)").bind(userId, poll.poll_id), ...ids.map((id) => db.prepare("insert into poll_votes (poll_option_id,user_id,created_at_utc) values (?1,?2,?3)").bind(id, userId, new Date().toISOString()))]);
  await publishRealtimeEvent(env, "league", leagueId, { eventType: "PollVoteUpdated", entityId: messageId, sourceRevision: Date.now(), dataScope: "production", payload: { leagueId, messageId } });
  return { messageId, voted: true };
}

async function uploadAsset(request: Request, env: Env, leagueId: string): Promise<{ assetId: string; attachmentKey: string; attachmentUrl: string }> {
  const type = (request.headers.get("content-type") ?? "").split(";")[0].toLowerCase();
  if (!["image/jpeg","image/png","image/webp","image/gif"].includes(type)) throw new ApiException(415, "invalid_attachment_type", "Upload a JPEG, PNG, WebP, or GIF image.");
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > 5_242_880) throw new ApiException(413, "attachment_too_large", "Chat images may be up to 5 MB.");
  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > 5_242_880) throw new ApiException(413, "attachment_too_large", "Chat images may be up to 5 MB.");
  const assetId = crypto.randomUUID(); const key = `league-chat/${leagueId}/${assetId}`;
  await env.ASSETS_BUCKET.put(key, bytes, { httpMetadata: { contentType: type, cacheControl: "private, max-age=3600" }, customMetadata: { leagueId } });
  return { assetId, attachmentKey: key, attachmentUrl: `${env.API_BASE_URL}/api/leagues/${leagueId}/chat/assets/${assetId}` };
}

async function downloadAsset(request: Request, env: Env, leagueId: string, assetId: string): Promise<Response> {
  if (!/^[0-9a-f-]{36}$/i.test(assetId)) throw new ApiException(404, "asset_not_found", "Chat image not found.");
  const object = await env.ASSETS_BUCKET.get(`league-chat/${leagueId}/${assetId}`);
  if (!object) throw new ApiException(404, "asset_not_found", "Chat image not found.");
  const headers = new Headers(corsHeaders(request, env)); object.writeHttpMetadata(headers); headers.set("etag", object.httpEtag); headers.set("x-content-type-options", "nosniff");
  return new Response(object.body, { headers });
}

async function markRead(db: D1Database, leagueId: string, channel: "league"|"draft", userId: string, messageId?: string): Promise<void> {
  const message = messageId ? await requireMessage(db, leagueId, messageId) : await db.prepare("select * from league_messages where league_id=?1 and channel=?2 order by created_at_utc desc limit 1").bind(leagueId, channel).first<MessageRow>();
  const now = new Date().toISOString();
  await db.prepare("insert into message_read_state (league_id,channel,user_id,last_read_message_id,read_at_utc) values (?1,?2,?3,?4,?5) on conflict(league_id,channel,user_id) do update set last_read_message_id=excluded.last_read_message_id,read_at_utc=excluded.read_at_utc").bind(leagueId, channel, userId, message?.league_message_id ?? null, now).run();
}

async function activityPage(db: D1Database, coreDb: D1Database, leagueId: string, cursor: string|null): Promise<CursorPage<LeagueActivityView>> {
  const before = decodeCursor(cursor);
  const result = await db.prepare("select league_activity_id,actor_user_id,activity_type,message,metadata_json,created_at_utc from league_activity where league_id=?1 and (?2 is null or created_at_utc<?2) order by created_at_utc desc limit 51").bind(leagueId, before).all<{ league_activity_id: string; actor_user_id: string|null; activity_type: string; message: string; metadata_json: string; created_at_utc: string }>();
  const rows = result.results ?? []; const page = rows.slice(0, 50); const profiles = await userProfiles(coreDb, page.flatMap((row) => row.actor_user_id ? [row.actor_user_id] : []));
  return { items: page.map((row) => ({ activityId: row.league_activity_id, activityType: row.activity_type, message: row.message, actorUserId: row.actor_user_id ?? undefined, actorDisplayName: row.actor_user_id ? profiles.get(row.actor_user_id) : undefined, metadata: parseObject(row.metadata_json), createdAtUtc: row.created_at_utc })), nextCursor: rows.length > 50 ? encodeCursor(page.at(-1)!.created_at_utc) : undefined };
}

async function weeklyReport(db: D1Database, nflDb: D1Database, leagueId: string, seasonId: string, week: number): Promise<WeeklyReportResponse> {
  const stored = await db.prepare("select weekly_report_id,report_json,generated_at_utc from weekly_reports where league_season_id=?1 and week_number=?2").bind(seasonId, week).first<{ weekly_report_id: string; report_json: string; generated_at_utc: string }>();
  if (stored) return { reportId: stored.weekly_report_id, weekNumber: week, generatedAtUtc: stored.generated_at_utc, ...parseReport(stored.report_json) };
  const rows = await db.prepare("select matchups.matchup_id,matchups.status,teams.fantasy_team_id,teams.team_name,joined.score_milli,joined.bench_points_milli,joined.result from matchups join matchup_teams joined on joined.matchup_id=matchups.matchup_id join fantasy_teams teams on teams.fantasy_team_id=joined.fantasy_team_id where matchups.league_season_id=?1 and matchups.week_number=?2 order by matchups.matchup_number,joined.side").bind(seasonId, week).all<{ matchup_id: string; status: string; fantasy_team_id: string; team_name: string; score_milli: number; bench_points_milli: number; result: string|null }>();
  const teams = rows.results ?? [];
  if (!teams.length || teams.some((row) => !["final","corrected"].includes(row.status))) throw new ApiException(409, "week_not_final", "The weekly report is available after every matchup is final.");
  const byScore = [...teams].sort((a,b) => b.score_milli-a.score_milli); const pairs = new Map<string, typeof teams>();
  teams.forEach((row) => { const values = pairs.get(row.matchup_id) ?? []; values.push(row); pairs.set(row.matchup_id, values); });
  const completePairs = [...pairs.values()].filter((pair) => pair.length === 2);
  const closest = [...completePairs].sort((a,b) => Math.abs(a[0].score_milli-a[1].score_milli)-Math.abs(b[0].score_milli-b[1].score_milli))[0];
  const blowout = [...completePairs].sort((a,b) => Math.abs(b[0].score_milli-b[1].score_milli)-Math.abs(a[0].score_milli-a[1].score_milli))[0];
  const highestBench = [...teams].sort((a,b) => b.bench_points_milli-a.bench_points_milli)[0];
  const unlucky = byScore.find((team) => team.result === "loss");
  const efficient = [...teams].sort((a,b) => efficiency(b)-efficiency(a))[0];
  const metrics: WeeklyReportMetric[] = [
    metric("Highest score", byScore[0], points(byScore[0].score_milli)),
    metric("Lowest score", byScore.at(-1)!, points(byScore.at(-1)!.score_milli)),
    matchupMetric("Closest matchup", closest),
    matchupMetric("Biggest blowout", blowout),
    metric("Highest bench", highestBench, points(highestBench.bench_points_milli)),
    unlucky ? metric("Unluckiest team", unlucky, `${points(unlucky.score_milli)} in a loss`) : { label: "Unluckiest team", value: "No losing team" },
    metric("Most efficient lineup", efficient, `${(efficiency(efficient)*100).toFixed(1)}%`),
  ];
  const history = await db.prepare("select history.matchup_id,history.matchup_revision_number,history.home_score_milli,history.away_score_milli from matchup_score_history history join matchups on matchups.matchup_id=history.matchup_id where matchups.league_season_id=?1 and matchups.week_number=?2 order by history.matchup_id,history.matchup_revision_number").bind(seasonId, week).all<{ matchup_id:string;matchup_revision_number:number;home_score_milli:number;away_score_milli:number }>();
  const histories = new Map<string, typeof history.results>();
  for (const item of history.results ?? []) { const values=histories.get(item.matchup_id)??[];values.push(item);histories.set(item.matchup_id,values); }
  const comeback = [...histories].map(([matchupId,values]) => ({ matchupId, swing: values.length > 1 ? Math.abs((values.at(-1)!.home_score_milli-values.at(-1)!.away_score_milli)-(values[0].home_score_milli-values[0].away_score_milli)) : 0 })).sort((a,b)=>b.swing-a.swing)[0];
  if (comeback?.swing) {
    const pair = pairs.get(comeback.matchupId);
    metrics.push({ label: "Largest comeback", value: pair?.map((team)=>team.team_name).join(" vs ") ?? "Matchup", detail: `${points(comeback.swing)} point swing` });
  } else metrics.push({ label: "Largest comeback", value: "No lead swing recorded" });
  const season = await db.prepare("select season_year from league_seasons where league_season_id=?1").bind(seasonId).first<{season_year:number}>();
  const eventRows = await nflDb.prepare("select nfl_event_id from nfl_events where season_year=?1 and week=?2").bind(season?.season_year??0,week).all<{nfl_event_id:string}>();
  const eventIds = (eventRows.results??[]).map((event)=>event.nfl_event_id);
  if (eventIds.length) {
    const placeholders=eventIds.map((_,index)=>`?${index+2}`).join(",");
    const best = await db.prepare(`select scores.nfl_player_id,sum(scores.total_points_milli) as points_milli from player_event_scores scores where scores.league_season_id=?1 and scores.nfl_event_id in (${placeholders}) and not exists (select 1 from fantasy_roster_players roster where roster.league_season_id=scores.league_season_id and roster.nfl_player_id=scores.nfl_player_id and roster.released_at_utc is null) group by scores.nfl_player_id order by points_milli desc limit 1`).bind(seasonId,...eventIds).first<{nfl_player_id:string;points_milli:number}>();
    if (best) {
      const profile=await nflDb.prepare("select display_name from nfl_players where nfl_player_id=?1").bind(best.nfl_player_id).first<{display_name:string}>();
      metrics.push({label:"Best free agent",value:profile?.display_name??"Available player",detail:points(best.points_milli),playerId:best.nfl_player_id});
    } else metrics.push({label:"Best free agent",value:"No scored free agent"});
  } else metrics.push({label:"Best free agent",value:"No provider games"});
  const standings = await db.prepare("select standings.rank_number,standings.fantasy_team_id,teams.team_name,standings.wins,standings.losses,standings.points_for_milli from standings join fantasy_teams teams on teams.fantasy_team_id=standings.fantasy_team_id where standings.league_season_id=?1 order by standings.rank_number").bind(seasonId).all<{ rank_number:number; fantasy_team_id:string; team_name:string; wins:number; losses:number; points_for_milli:number }>();
  const powerRankings = (standings.results ?? []).map((row) => ({ rank: row.rank_number, teamId: row.fantasy_team_id, teamName: row.team_name, score: Math.round((row.wins*100 + row.points_for_milli/1000)*10)/10 }));
  const reportId = newId("wkr"); const now = new Date().toISOString(); const reportJson = JSON.stringify({ metrics, powerRankings });
  await db.prepare("insert into weekly_reports (weekly_report_id,league_id,league_season_id,week_number,status,report_json,generated_at_utc,published_at_utc) values (?1,?2,?3,?4,'published',?5,?6,?6)").bind(reportId, leagueId, seasonId, week, reportJson, now).run();
  return { reportId, weekNumber: week, generatedAtUtc: now, metrics, powerRankings };
}

async function hydrateMessages(db: D1Database, coreDb: D1Database, rows: MessageRow[], userId: string, role: LeagueRole): Promise<LeagueMessageView[]> {
  if (!rows.length) return [];
  const messageIds = rows.map((row) => row.league_message_id); const allUserIds = rows.map((row) => row.author_user_id);
  const replies = new Map<string, MessageRow>();
  for (const replyId of [...new Set(rows.flatMap((row) => row.reply_to_message_id ? [row.reply_to_message_id] : []))]) {
    const reply = await db.prepare("select * from league_messages where league_message_id=?1").bind(replyId).first<MessageRow>(); if (reply) { replies.set(replyId, reply); allUserIds.push(reply.author_user_id); }
  }
  const profiles = await userProfiles(coreDb, allUserIds);
  const placeholders = messageIds.map((_, index) => `?${index+1}`).join(",");
  const [reactionRows, pollRows] = await Promise.all([
    db.prepare(`select league_message_id,user_id,reaction from message_reactions where league_message_id in (${placeholders})`).bind(...messageIds).all<{ league_message_id:string;user_id:string;reaction:string }>(),
    db.prepare(`select polls.poll_id,polls.league_message_id,polls.question,polls.allows_multiple,polls.closes_at_utc,options.poll_option_id,options.display_text,options.display_order,votes.user_id from polls join poll_options options on options.poll_id=polls.poll_id left join poll_votes votes on votes.poll_option_id=options.poll_option_id where polls.league_message_id in (${placeholders}) order by options.display_order`).bind(...messageIds).all<{ poll_id:string;league_message_id:string;question:string;allows_multiple:number;closes_at_utc:string|null;poll_option_id:string;display_text:string;display_order:number;user_id:string|null }>(),
  ]);
  const readRows = await db.prepare("select user_id,read_at_utc from message_read_state where league_id=?1").bind(rows[0].league_id).all<{user_id:string;read_at_utc:string}>();
  return rows.map((row) => {
    const grouped = new Map<string,{count:number;mine:boolean}>(); (reactionRows.results ?? []).filter((item) => item.league_message_id===row.league_message_id).forEach((item) => { const current=grouped.get(item.reaction)??{count:0,mine:false};current.count++;current.mine ||= item.user_id===userId;grouped.set(item.reaction,current); });
    const pollData = (pollRows.results ?? []).filter((item) => item.league_message_id===row.league_message_id); const optionMap = new Map<string,{id:string;text:string;users:string[]}>();
    pollData.forEach((item) => { const option=optionMap.get(item.poll_option_id)??{id:item.poll_option_id,text:item.display_text,users:[]};if(item.user_id)option.users.push(item.user_id);optionMap.set(item.poll_option_id,option); });
    const reply = row.reply_to_message_id ? replies.get(row.reply_to_message_id) : undefined;
    return { messageId: row.league_message_id, channel: row.channel, messageType: row.message_type, authorUserId: row.author_user_id, authorDisplayName: profiles.get(row.author_user_id) ?? "League member", body: row.deleted_at_utc ? "Message removed" : row.body, attachmentUrl: row.deleted_at_utc ? undefined : row.attachment_url ?? undefined, replyTo: reply ? { messageId: reply.league_message_id, authorDisplayName: profiles.get(reply.author_user_id) ?? "League member", body: reply.deleted_at_utc ? "Message removed" : reply.body } : undefined, reactions: [...grouped].map(([reaction,value]) => ({ reaction,count:value.count,reactedByMe:value.mine })), poll: pollData[0] ? { pollId: pollData[0].poll_id, question: pollData[0].question, allowsMultiple: Boolean(pollData[0].allows_multiple), closesAtUtc: pollData[0].closes_at_utc ?? undefined, totalVotes: [...optionMap.values()].reduce((sum,item)=>sum+item.users.length,0), options: [...optionMap.values()].map((item)=>({pollOptionId:item.id,displayText:item.text,voteCount:item.users.length,votedByMe:item.users.includes(userId)})) } : undefined, pinned: Boolean(row.pinned), edited: Boolean(row.edited_at_utc), deleted: Boolean(row.deleted_at_utc), readByCount: (readRows.results??[]).filter((item)=>item.user_id!==row.author_user_id&&item.read_at_utc>=row.created_at_utc).length, createdAtUtc: row.created_at_utc, revisionNumber: row.revision_number, canEdit: !row.deleted_at_utc && (row.author_user_id===userId || canManage(role)), canModerate: canManage(role) };
  });
}

async function requireMessage(db:D1Database,leagueId:string,messageId:string):Promise<MessageRow>{const row=await db.prepare("select * from league_messages where league_message_id=?1 and league_id=?2").bind(messageId,leagueId).first<MessageRow>();if(!row)throw new ApiException(404,"message_not_found","Message not found.");return row;}
async function userProfiles(db:D1Database,ids:string[]):Promise<Map<string,string>>{const unique=[...new Set(ids)];if(!unique.length)return new Map();const placeholders=unique.map((_,index)=>`?${index+1}`).join(",");const rows=await db.prepare(`select user_id,display_name from user_profiles where user_id in (${placeholders})`).bind(...unique).all<{user_id:string;display_name:string}>();return new Map((rows.results??[]).map(row=>[row.user_id,row.display_name]));}
function requireChannel(value:unknown):"league"|"draft"{if(value===undefined||value===null||value==="")return "league";if(value!=="league"&&value!=="draft")throw new ApiException(400,"invalid_channel","Choose league or draft chat.");return value;}
function canManage(role:LeagueRole):boolean{return role==="commissioner"||role==="co-commissioner";}
function encodeCursor(value:string):string{return btoa(value);} function decodeCursor(value:string|null):string|null{if(!value)return null;try{return atob(value);}catch{throw new ApiException(400,"invalid_cursor","The communication cursor is invalid.");}}
function parseObject(value:string):Record<string,unknown>{try{const parsed:unknown=JSON.parse(value);return parsed&&typeof parsed==="object"&&!Array.isArray(parsed)?parsed as Record<string,unknown>:{};}catch{return {};}}
function parseReport(value:string):{metrics:WeeklyReportMetric[];powerRankings:WeeklyReportResponse["powerRankings"]}{try{return JSON.parse(value) as {metrics:WeeklyReportMetric[];powerRankings:WeeklyReportResponse["powerRankings"]};}catch{return{metrics:[],powerRankings:[]};}}
function points(value:number):string{return (value/1000).toFixed(1);}
function efficiency(team:{score_milli:number;bench_points_milli:number}):number{return team.score_milli/Math.max(1,team.score_milli+team.bench_points_milli);}
function metric(label:string,team:{fantasy_team_id:string;team_name:string},detail:string):WeeklyReportMetric{return{label,value:team.team_name,detail,teamId:team.fantasy_team_id};}
function matchupMetric(label:string,pair:Array<{fantasy_team_id:string;team_name:string;score_milli:number}>|undefined):WeeklyReportMetric{if(!pair)return{label,value:"No matchup"};return{label,value:`${pair[0].team_name} vs ${pair[1].team_name}`,detail:`${points(pair[0].score_milli)} - ${points(pair[1].score_milli)}`};}
