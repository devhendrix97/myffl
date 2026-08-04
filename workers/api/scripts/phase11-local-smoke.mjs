import { readFileSync } from "node:fs";
import { SignJWT } from "jose";

const baseUrl = process.env.MYFFL_SMOKE_API ?? "http://127.0.0.1:8787";
const userId = process.env.MYFFL_SMOKE_USER ?? "usr_953e7f69-c253-4ccc-8466-addcc19b119b";
const sessionId = process.env.MYFFL_SMOKE_SESSION ?? "rft_b297c8f1-9a38-4829-8418-655e46e97163";
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

const dashboard = await api("/api/admin/dashboard");
const users = await api("/api/admin/users");
const leagues = await api("/api/admin/leagues");
let players = await api("/api/admin/players?q=");
let events = await api("/api/admin/events");
if (!players.items.length) {
  await api("/api/admin/simulations", { method: "POST", body: { speedMultiplier: 1 } });
  players = await api("/api/admin/players?q=");
  events = await api("/api/admin/events");
}
const monitoring = await api("/api/admin/monitoring");
const audit = await api("/api/admin/audit");
const user = users.items[0] ? await api(`/api/admin/users/${users.items[0].userId}`) : null;
const league = leagues.items[0] ? await api(`/api/admin/leagues/${leagues.items[0].leagueId}`) : null;
const player = players.items[0] ? await api(`/api/admin/players/${players.items[0].playerId}`) : null;
const event = events.items[0] ? await api(`/api/admin/events/${events.items[0].eventId}`) : null;

console.log(JSON.stringify({
  activeUsers: dashboard.counts.activeUsers,
  users: users.items.length,
  leagues: leagues.items.length,
  players: players.items.length,
  events: events.items.length,
  resources: monitoring.resources.length,
  audits: audit.items.length,
  userDetail: Boolean(user?.user),
  leagueDetail: Boolean(league?.league),
  playerDetail: Boolean(player?.player),
  eventDetail: Boolean(event?.event),
}, null, 2));
