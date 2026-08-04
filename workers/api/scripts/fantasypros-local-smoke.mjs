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

async function api(path) {
  const response = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}`, origin: "http://localhost:5173" } });
  const payload = await response.json();
  if (!response.ok || !payload.ok) throw new Error(`${path}: ${payload.error?.message ?? response.status}`);
  return payload.data;
}

const leagues = await api("/api/admin/leagues");
const leagueId = leagues.items[0]?.leagueId;
if (!leagueId) throw new Error("No local league is available for rankings smoke testing.");
const [rankings, players, draftPlayers] = await Promise.all([
  api(`/api/leagues/${leagueId}/rankings`),
  api(`/api/leagues/${leagueId}/players?limit=20`),
  api(`/api/leagues/${leagueId}/draft/players?limit=20`),
]);
const rankedPlayers = players.filter((player) => player.expertConsensusRank);
const rankedDraftPlayers = draftPlayers.filter((player) => player.expertConsensusRank);
if (!rankedPlayers.length || !rankedDraftPlayers.length) throw new Error("The local ranking snapshot was not applied to both player lists.");
if (rankedDraftPlayers.some((player, index, items) => index > 0 && player.expertConsensusRank < items[index - 1].expertConsensusRank)) {
  throw new Error("Draft players are not ordered by Expert Consensus Rank.");
}

console.log(JSON.stringify({
  leagueId,
  source: rankings.sourceName,
  scoring: rankings.scoring,
  snapshotPlayers: rankings.players.length,
  playerDirectoryTop: rankedPlayers.slice(0, 4).map((player) => `${player.expertConsensusRank}. ${player.displayName}`),
  draftBoardTop: rankedDraftPlayers.slice(0, 4).map((player) => `${player.expertConsensusRank}. ${player.displayName}`),
}, null, 2));
