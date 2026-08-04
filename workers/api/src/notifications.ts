import type { NotificationCenterResponse, NotificationPreferenceView, NotificationView } from "@myffl/api-contracts";
import { authenticate, type HandlerResult } from "./auth";
import { sendNotificationEmail } from "./email";
import { ApiException } from "./http";
import { newId } from "./security";
import webpush from "web-push";

export interface NotificationJob {
  deliveryId?: string;
  recipientUserIds: string[];
  leagueId?: string;
  notificationType: string;
  title: string;
  body: string;
  entityType?: string;
  entityId?: string;
  actionUrl?: string;
  createdAtUtc?: string;
}

export async function handleNotificationRequest(request: Request, url: URL, env: Env): Promise<HandlerResult<unknown> | undefined> {
  if (!url.pathname.startsWith("/api/notifications")) return undefined;
  const principal = await authenticate(request, env);
  const suffix = url.pathname.slice("/api/notifications".length);
  if (request.method === "GET" && !suffix) return { data: await notificationCenter(env.CORE_DB, principal.userId, url.searchParams.get("cursor")) };
  if (request.method === "POST" && suffix === "/read-all") {
    await env.CORE_DB.prepare("update notifications set read_at_utc=coalesce(read_at_utc,?1) where user_id=?2").bind(new Date().toISOString(), principal.userId).run();
    return { data: await notificationCenter(env.CORE_DB, principal.userId, null) };
  }
  const readMatch = suffix.match(/^\/([^/]+)\/read$/);
  if (request.method === "POST" && readMatch) {
    await env.CORE_DB.prepare("update notifications set read_at_utc=coalesce(read_at_utc,?1) where notification_id=?2 and user_id=?3").bind(new Date().toISOString(), readMatch[1], principal.userId).run();
    return { data: { notificationId: readMatch[1], read: true } };
  }
  if (suffix === "/preferences" && request.method === "GET") {
    const leagueId = url.searchParams.get("leagueId") ?? "";
    return { data: await loadPreferences(env.CORE_DB, principal.userId, leagueId) };
  }
  if (suffix === "/push-key" && request.method === "GET") return { data: { publicKey: env.VAPID_PUBLIC_KEY } };
  if (suffix === "/preferences" && request.method === "PUT") {
    const body = await request.json<{ preferences?: NotificationPreferenceView[] }>();
    if (!Array.isArray(body.preferences) || body.preferences.length > 50) throw new ApiException(400, "invalid_preferences", "Provide notification preferences.");
    const now = new Date().toISOString();
    await env.CORE_DB.batch(body.preferences.map((item) => env.CORE_DB.prepare("insert into notification_preferences (user_id,league_id,notification_type,in_app_enabled,email_enabled,desktop_enabled,browser_push_enabled,updated_at_utc) values (?1,?2,?3,?4,?5,?6,?7,?8) on conflict(user_id,league_id,notification_type) do update set in_app_enabled=excluded.in_app_enabled,email_enabled=excluded.email_enabled,desktop_enabled=excluded.desktop_enabled,browser_push_enabled=excluded.browser_push_enabled,updated_at_utc=excluded.updated_at_utc").bind(principal.userId, item.leagueId ?? "", item.notificationType || "*", Number(item.inAppEnabled), Number(item.emailEnabled), Number(item.desktopEnabled), Number(item.browserPushEnabled), now)));
    return { data: await loadPreferences(env.CORE_DB, principal.userId, body.preferences[0]?.leagueId ?? "") };
  }
  if (suffix === "/push-subscriptions" && request.method === "POST") {
    const body = await request.json<{ endpoint?: string; keys?: { p256dh?: string; auth?: string } }>();
    if (!body.endpoint || !body.keys?.p256dh || !body.keys.auth) throw new ApiException(400, "invalid_push_subscription", "The browser push subscription is incomplete.");
    const now = new Date().toISOString();
    await env.CORE_DB.prepare("insert into push_subscriptions (push_subscription_id,user_id,endpoint,p256dh,auth_secret,user_agent,created_at_utc,last_used_at_utc) values (?1,?2,?3,?4,?5,?6,?7,?7) on conflict(endpoint) do update set user_id=excluded.user_id,p256dh=excluded.p256dh,auth_secret=excluded.auth_secret,user_agent=excluded.user_agent,last_used_at_utc=excluded.last_used_at_utc,revoked_at_utc=null").bind(newId("psu"), principal.userId, body.endpoint, body.keys.p256dh, body.keys.auth, request.headers.get("user-agent"), now).run();
    return { data: { subscribed: true } };
  }
  if (suffix === "/push-subscriptions" && request.method === "DELETE") {
    const body = await request.json<{ endpoint?: string }>();
    if (body.endpoint) await env.CORE_DB.prepare("update push_subscriptions set revoked_at_utc=?1 where user_id=?2 and endpoint=?3").bind(new Date().toISOString(), principal.userId, body.endpoint).run();
    return { data: { subscribed: false } };
  }
  return undefined;
}

export async function enqueueNotification(env: Env, job: NotificationJob): Promise<void> {
  if (!job.recipientUserIds.length) return;
  await env.NOTIFICATIONS_QUEUE.send({ ...job, deliveryId: job.deliveryId ?? newId("ndl"), recipientUserIds: [...new Set(job.recipientUserIds)], createdAtUtc: job.createdAtUtc ?? new Date().toISOString() });
}

export async function enqueueLeagueNotification(
  env: Env,
  leagueId: string,
  job: Omit<NotificationJob, "recipientUserIds" | "leagueId">,
  options: { excludeUserIds?: string[]; recipientUserIds?: string[] } = {},
): Promise<void> {
  const recipients = options.recipientUserIds ?? (await env.LEAGUE_DB_001.prepare("select user_id from league_members where league_id=?1 and status='active'").bind(leagueId).all<{ user_id: string }>()).results?.map((row) => row.user_id) ?? [];
  const excluded = new Set(options.excludeUserIds ?? []);
  await enqueueNotification(env, { ...job, leagueId, recipientUserIds: recipients.filter((id) => !excluded.has(id)) });
}

export async function processNotificationQueue(batch: MessageBatch<NotificationJob>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      for (const userId of message.body.recipientUserIds) await deliverNotification(env, userId, message.body);
      message.ack();
    } catch (error) {
      console.error(JSON.stringify({ level: "error", event: "notification_delivery_failed", error: error instanceof Error ? error.message : String(error) }));
      message.retry();
    }
  }
}

async function deliverNotification(env: Env, userId: string, job: NotificationJob): Promise<void> {
  const preference = await effectivePreference(env.CORE_DB, userId, job.leagueId ?? "", job.notificationType);
  const now = job.createdAtUtc ?? new Date().toISOString();
  const deliveryKey = `${job.deliveryId ?? "legacy"}:${userId}`;
  let notification = await env.CORE_DB.prepare("select notification_id,email_delivered_at_utc,browser_push_delivered_at_utc from notifications where delivery_key=?1").bind(deliveryKey).first<{notification_id:string;email_delivered_at_utc:string|null;browser_push_delivered_at_utc:string|null}>();
  if (!notification) {
    const notificationId = newId("not");
    await env.CORE_DB.prepare("insert into notifications (notification_id,user_id,league_id,notification_type,title,body,entity_type,entity_id,action_url,created_at_utc,delivery_key,in_app_visible) values (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)").bind(notificationId, userId, job.leagueId ?? null, job.notificationType, job.title, job.body, job.entityType ?? null, job.entityId ?? null, job.actionUrl ?? null, now, deliveryKey, Number(preference.inAppEnabled)).run();
    notification={notification_id:notificationId,email_delivered_at_utc:null,browser_push_delivered_at_utc:null};
  }
  if (preference.emailEnabled && !notification.email_delivered_at_utc) {
    const user = await env.CORE_DB.prepare("select users.email,profiles.display_name from users join user_profiles profiles on profiles.user_id=users.user_id where users.user_id=?1 and users.status='active'").bind(userId).first<{ email: string; display_name: string }>();
    if (user) {
      await sendNotificationEmail(env, { to: user.email, displayName: user.display_name, title: job.title, body: job.body, actionUrl: job.actionUrl });
      await env.CORE_DB.prepare("update notifications set email_delivered_at_utc=?1 where notification_id=?2").bind(new Date().toISOString(), notification.notification_id).run();
    }
  }
  if (preference.browserPushEnabled && !notification.browser_push_delivered_at_utc) await deliverBrowserPush(env,userId,notification.notification_id,job);
}

async function notificationCenter(db: D1Database, userId: string, cursor: string | null): Promise<NotificationCenterResponse> {
  const before = decodeCursor(cursor);
  const rows = await db.prepare("select notification_id,league_id,notification_type,title,body,action_url,created_at_utc,read_at_utc from notifications where user_id=?1 and in_app_visible=1 and (?2 is null or created_at_utc<?2) order by created_at_utc desc limit 51").bind(userId, before).all<{ notification_id: string; league_id: string | null; notification_type: string; title: string; body: string; action_url: string | null; created_at_utc: string; read_at_utc: string | null }>();
  const values = rows.results ?? []; const page = values.slice(0, 50);
  const unread = await db.prepare("select count(*) as count from notifications where user_id=?1 and in_app_visible=1 and read_at_utc is null").bind(userId).first<{ count: number }>();
  return { notifications: page.map(toNotification), unreadCount: unread?.count ?? 0, nextCursor: values.length > 50 ? encodeCursor(page.at(-1)!.created_at_utc) : undefined };
}

async function loadPreferences(db: D1Database, userId: string, leagueId: string): Promise<NotificationPreferenceView[]> {
  const rows = await db.prepare("select league_id,notification_type,in_app_enabled,email_enabled,desktop_enabled,browser_push_enabled from notification_preferences where user_id=?1 and league_id in ('',?2) order by league_id,notification_type").bind(userId, leagueId).all<{ league_id: string; notification_type: string; in_app_enabled: number; email_enabled: number; desktop_enabled: number; browser_push_enabled: number }>();
  if (!(rows.results ?? []).length) return [{ leagueId, notificationType: "*", inAppEnabled: true, emailEnabled: false, desktopEnabled: true, browserPushEnabled: false }];
  return (rows.results ?? []).map((row) => ({ leagueId: row.league_id, notificationType: row.notification_type, inAppEnabled: Boolean(row.in_app_enabled), emailEnabled: Boolean(row.email_enabled), desktopEnabled: Boolean(row.desktop_enabled), browserPushEnabled: Boolean(row.browser_push_enabled) }));
}

async function effectivePreference(db: D1Database, userId: string, leagueId: string, type: string): Promise<NotificationPreferenceView> {
  const row = await db.prepare("select league_id,notification_type,in_app_enabled,email_enabled,desktop_enabled,browser_push_enabled from notification_preferences where user_id=?1 and league_id in (?2,'') and notification_type in (?3,'*') order by (league_id=?2) desc,(notification_type=?3) desc limit 1").bind(userId, leagueId, type).first<{ league_id: string; notification_type: string; in_app_enabled: number; email_enabled: number; desktop_enabled: number; browser_push_enabled: number }>();
  return row ? { leagueId: row.league_id, notificationType: row.notification_type, inAppEnabled: Boolean(row.in_app_enabled), emailEnabled: Boolean(row.email_enabled), desktopEnabled: Boolean(row.desktop_enabled), browserPushEnabled: Boolean(row.browser_push_enabled) } : { leagueId, notificationType: type, inAppEnabled: true, emailEnabled: false, desktopEnabled: true, browserPushEnabled: false };
}

function toNotification(row: { notification_id: string; league_id: string | null; notification_type: string; title: string; body: string; action_url: string | null; created_at_utc: string; read_at_utc: string | null }): NotificationView {
  return { notificationId: row.notification_id, leagueId: row.league_id ?? undefined, notificationType: row.notification_type, title: row.title, body: row.body, actionUrl: row.action_url ?? undefined, createdAtUtc: row.created_at_utc, readAtUtc: row.read_at_utc ?? undefined };
}

async function deliverBrowserPush(env:Env,userId:string,notificationId:string,job:NotificationJob):Promise<void>{
  const subscriptions=await env.CORE_DB.prepare("select push_subscription_id,endpoint,p256dh,auth_secret from push_subscriptions where user_id=?1 and revoked_at_utc is null").bind(userId).all<{push_subscription_id:string;endpoint:string;p256dh:string;auth_secret:string}>();
  if (!(subscriptions.results??[]).length) return;
  webpush.setVapidDetails(env.VAPID_SUBJECT,env.VAPID_PUBLIC_KEY,env.VAPID_PRIVATE_KEY);
  let delivered=false;
  for(const subscription of subscriptions.results??[]){
    try{
      await webpush.sendNotification({endpoint:subscription.endpoint,keys:{p256dh:subscription.p256dh,auth:subscription.auth_secret}},JSON.stringify({title:job.title,body:job.body,tag:notificationId,data:{url:job.actionUrl??"/"}}));
      delivered=true;
      await env.CORE_DB.prepare("update push_subscriptions set last_used_at_utc=?1 where push_subscription_id=?2").bind(new Date().toISOString(),subscription.push_subscription_id).run();
    }catch(error){
      const statusCode=error instanceof webpush.WebPushError?error.statusCode:0;
      if(statusCode===404||statusCode===410)await env.CORE_DB.prepare("update push_subscriptions set revoked_at_utc=?1 where push_subscription_id=?2").bind(new Date().toISOString(),subscription.push_subscription_id).run();
      else if(statusCode>=500)throw error;
      else console.error(JSON.stringify({level:"error",event:"browser_push_failed",statusCode,userId}));
    }
  }
  if(delivered)await env.CORE_DB.prepare("update notifications set browser_push_delivered_at_utc=?1 where notification_id=?2").bind(new Date().toISOString(),notificationId).run();
}
function encodeCursor(value: string): string { return btoa(value); }
function decodeCursor(value: string | null): string | null { if (!value) return null; try { return atob(value); } catch { throw new ApiException(400, "invalid_cursor", "The notification cursor is invalid."); } }
