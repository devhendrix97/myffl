import { DurableObject } from "cloudflare:workers";
import type { AccessTokenPrincipal } from "./security";
import { issueAccessToken, verifyAccessToken } from "./security";
import { authenticate, type HandlerResult } from "./auth";
import { ApiException } from "./http";
import { requireLeagueRole } from "./league";
import { enqueueLeagueNotification } from "./notifications";

export interface RealtimeEventInput {
  eventType: string;
  entityId?: string;
  sourceRevision?: number;
  dataScope: string;
  payload: Record<string, unknown>;
  createdAtUtc?: string;
}

interface StoredRealtimeEvent extends RealtimeEventInput { revision: number; createdAtUtc: string; }
interface ConnectionAttachment { userId: string; connectedAtUtc: string; }

abstract class RealtimeRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`create table if not exists events (
        revision integer primary key autoincrement,
        event_type text not null,
        entity_id text,
        source_revision integer,
        data_scope text not null,
        payload_json text not null,
        created_at_utc text not null
      )`);
      this.ctx.storage.sql.exec("create index if not exists idx_events_created on events(created_at_utc desc)");
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket upgrade required", { status: 426 });
    const userId = request.headers.get("x-myffl-user-id");
    if (!userId) return new Response("Realtime identity required", { status: 401 });
    const pair = new WebSocketPair(); const client = pair[0]; const server = pair[1];
    server.serializeAttachment({ userId, connectedAtUtc: new Date().toISOString() } satisfies ConnectionAttachment);
    this.ctx.acceptWebSocket(server);
    const since = Math.max(0, Number(new URL(request.url).searchParams.get("since") ?? 0) || 0);
    const events = this.eventsSince(since);
    server.send(JSON.stringify({ type: "realtime.ready", revision: events.at(-1)?.revision ?? this.latestRevision(), events }));
    return new Response(null, { status: 101, webSocket: client, headers: { "sec-websocket-protocol": "myffl-realtime" } });
  }

  async publish(event: RealtimeEventInput): Promise<number> {
    const createdAtUtc = event.createdAtUtc ?? new Date().toISOString();
    const row = this.ctx.storage.sql.exec<{ revision: number }>("insert into events (event_type, entity_id, source_revision, data_scope, payload_json, created_at_utc) values (?, ?, ?, ?, ?, ?) returning revision", event.eventType, event.entityId ?? null, event.sourceRevision ?? null, event.dataScope, JSON.stringify(event.payload), createdAtUtc).one();
    const envelope: StoredRealtimeEvent = { ...event, revision: row.revision, createdAtUtc };
    const message = JSON.stringify({ type: "realtime.event", event: envelope });
    for (const socket of this.ctx.getWebSockets()) if (socket.readyState === WebSocket.OPEN) socket.send(message);
    this.ctx.storage.sql.exec("delete from events where revision < (select coalesce(max(revision),0)-1000 from events)");
    return row.revision;
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    let parsed: { type?: string; since?: number } = {};
    try { parsed = JSON.parse(message) as typeof parsed; } catch { return; }
    if (parsed.type === "ping") { socket.send(JSON.stringify({ type: "pong", utc: new Date().toISOString() })); return; }
    if (parsed.type === "resync") socket.send(JSON.stringify({ type: "realtime.resync", events: this.eventsSince(Math.max(0, Number(parsed.since ?? 0))) }));
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> { socket.close(code, reason); }
  async webSocketError(_socket: WebSocket, error: unknown): Promise<void> { console.error(JSON.stringify({ level: "error", event: "realtime_socket_error", error: error instanceof Error ? error.message : String(error) })); }

  private latestRevision(): number { return this.ctx.storage.sql.exec<{ revision: number }>("select coalesce(max(revision),0) as revision from events").one().revision; }
  private eventsSince(since: number): StoredRealtimeEvent[] { return this.ctx.storage.sql.exec<{ revision: number; event_type: string; entity_id: string | null; source_revision: number | null; data_scope: string; payload_json: string; created_at_utc: string }>("select revision,event_type,entity_id,source_revision,data_scope,payload_json,created_at_utc from events where revision>? order by revision limit 250", since).toArray().map((row) => ({ revision: row.revision, eventType: row.event_type, entityId: row.entity_id ?? undefined, sourceRevision: row.source_revision ?? undefined, dataScope: row.data_scope, payload: parseObject(row.payload_json), createdAtUtc: row.created_at_utc })); }
}

export class LeagueRealtime extends RealtimeRoom {}
export class MatchupRealtime extends RealtimeRoom {}
export class LiveNflEvent extends RealtimeRoom {}

export async function handleRealtimeRequest(request: Request, url: URL, env: Env): Promise<HandlerResult<unknown> | Response | undefined> {
  if (request.method === "POST" && url.pathname === "/api/realtime/ticket") {
    const principal = await authenticate(request, env); const body = await request.json<{ leagueId?: string }>();
    if (!body.leagueId) throw new ApiException(400, "league_required", "Choose a league for realtime access.");
    await requireLeagueRole(principal, body.leagueId, env, ["commissioner","co-commissioner","manager"]);
    const ticket = await issueAccessToken(principalWithoutExpiry(principal), env.ACCESS_TOKEN_SIGNING_SECRET, 60);
    return { data: { ticket: ticket.token, expiresAtUtc: ticket.expiresAtUtc } };
  }
  const match = url.pathname.match(/^\/api\/realtime\/(leagues|matchups|events)\/([^/]+)$/);
  if (!match || request.method !== "GET") return undefined;
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") throw new ApiException(426, "websocket_required", "A WebSocket upgrade is required.");
  const protocols = (request.headers.get("sec-websocket-protocol") ?? "").split(",").map((value) => value.trim());
  const token = protocols.find((value) => value !== "myffl-realtime");
  if (!token) throw new ApiException(401, "realtime_ticket_required", "A realtime ticket is required.");
  let principal: AccessTokenPrincipal; try { principal = await verifyAccessToken(token, env.ACCESS_TOKEN_SIGNING_SECRET); } catch { throw new ApiException(401, "invalid_realtime_ticket", "The realtime ticket expired."); }
  const leagueId = url.searchParams.get("leagueId") ?? (match[1] === "leagues" ? match[2] : "");
  if (!leagueId) throw new ApiException(400, "league_required", "The realtime channel requires a league.");
  await requireLeagueRole(principal, leagueId, env, ["commissioner","co-commissioner","manager"]);
  const namespace = match[1] === "leagues" ? env.LEAGUE_REALTIME : match[1] === "matchups" ? env.MATCHUP_REALTIME : env.LIVE_NFL_EVENT;
  const stub = namespace.getByName(match[2]);
  const headers = new Headers(request.headers); headers.set("x-myffl-user-id", principal.userId); headers.delete("authorization"); headers.set("sec-websocket-protocol", "myffl-realtime");
  return stub.fetch(new Request(request.url, { method: "GET", headers }));
}

export async function publishRealtimeEvent(env: Env, kind: "league" | "matchup" | "event", key: string, event: RealtimeEventInput): Promise<number> {
  const namespace = kind === "league" ? env.LEAGUE_REALTIME : kind === "matchup" ? env.MATCHUP_REALTIME : env.LIVE_NFL_EVENT;
  const revision = await namespace.getByName(key).publish(event);
  if (kind === "league" && event.eventType === "MatchupScoreUpdated" && event.payload.status === "final") {
    try { await enqueueLeagueNotification(env,key,{notificationType:"weekly-result",title:"Matchup final",body:"Your league's matchup results are final.",entityType:"matchup",entityId:event.entityId,actionUrl:`/?league=${key}&tab=gameday`}); }
    catch (error) { console.error(JSON.stringify({level:"error",event:"notification_enqueue_failed",leagueId:key,error:error instanceof Error?error.message:String(error)})); }
  }
  return revision;
}

function principalWithoutExpiry(principal: AccessTokenPrincipal): Omit<AccessTokenPrincipal,"expiresAtUtc"> { return { userId: principal.userId, sessionId: principal.sessionId, displayName: principal.displayName, email: principal.email, emailVerified: principal.emailVerified }; }
function parseObject(value: string): Record<string, unknown> { try { const parsed: unknown = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string,unknown> : {}; } catch { return {}; } }
