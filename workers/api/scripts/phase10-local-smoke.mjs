import { readFileSync } from "node:fs";
import { SignJWT } from "jose";

const baseUrl = process.env.MYFFL_SMOKE_API ?? "http://127.0.0.1:8787";
const leagueId = process.env.MYFFL_SMOKE_LEAGUE ?? "lg_53b36c07-69e4-4e59-a1fe-b6e93a0b658d";
const userId = process.env.MYFFL_SMOKE_USER ?? "usr_953e7f69-c253-4ccc-8466-addcc19b119b";
const sessionId = process.env.MYFFL_SMOKE_SESSION ?? "rft_b297c8f1-9a38-4829-8418-655e46e97163";
const mentionedUserId = process.env.MYFFL_SMOKE_MENTION ?? "usr_9be3b301-491a-4320-8fff-523875b53d38";
const vars = Object.fromEntries(readFileSync(".dev.vars", "utf8").split(/\r?\n/).filter(Boolean).map((line) => {
  const separator = line.indexOf("=");
  return [line.slice(0, separator).trim(), line.slice(separator + 1).trim().replace(/^"|"$/g, "")];
}));
const now = Math.floor(Date.now() / 1000);
const token = await new SignJWT({
  sid: sessionId,
  name: "Phase Two Commissioner",
  email: "phase2-commissioner-1785753015959@example.com",
  email_verified: true,
}).setProtectedHeader({ alg: "HS256", typ: "JWT" })
  .setIssuer("https://api.myfflapp.com")
  .setAudience("myffl-clients")
  .setSubject(userId)
  .setIssuedAt(now)
  .setExpirationTime(now + 600)
  .setJti(crypto.randomUUID())
  .sign(new TextEncoder().encode(vars.ACCESS_TOKEN_SIGNING_SECRET));

async function api(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: { authorization: `Bearer ${token}`, origin: "http://localhost:5173", ...(options.body ? { "content-type": "application/json" } : {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) throw new Error(`${path}: ${payload.error?.message ?? response.status}`);
  return payload.data;
}

const announcement = await api(`/api/leagues/${leagueId}/chat`, { method: "POST", body: { channel: "league", messageType: "announcement", body: "Phase 10 local announcement test.", mentionedUserIds: [mentionedUserId] } });
const poll = await api(`/api/leagues/${leagueId}/chat`, { method: "POST", body: { channel: "league", messageType: "poll", body: "Vote now", poll: { question: "Which draft night works?", options: ["Thursday", "Friday"], allowsMultiple: false } } });
const vote = await api(`/api/leagues/${leagueId}/chat/${poll.messageId}/votes`, { method: "POST", body: { optionIds: [poll.poll.options[0].pollOptionId] } });
const reaction = await api(`/api/leagues/${leagueId}/chat/${announcement.messageId}/reactions`, { method: "POST", body: { reaction: "Like" } });
const chat = await api(`/api/leagues/${leagueId}/chat?channel=league`);
const activity = await api(`/api/leagues/${leagueId}/activity`);
const preferences = await api(`/api/notifications/preferences?leagueId=${leagueId}`);

console.log(JSON.stringify({
  announcement: announcement.messageType,
  pollOptions: poll.poll.options.length,
  voted: vote.voted,
  reactionActive: reaction.active,
  messageCount: chat.messages.length,
  activityCount: activity.items.length,
  preferenceCount: preferences.length,
}, null, 2));
