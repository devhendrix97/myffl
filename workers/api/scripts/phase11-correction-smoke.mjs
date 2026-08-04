import { readFileSync } from "node:fs";
import { SignJWT } from "jose";

const baseUrl = "http://127.0.0.1:8787";
const userId = "usr_953e7f69-c253-4ccc-8466-addcc19b119b";
const sessionId = "rft_b297c8f1-9a38-4829-8418-655e46e97163";
const vars = Object.fromEntries(readFileSync(".dev.vars", "utf8").split(/\r?\n/).filter(Boolean).map((line) => {
  const separator = line.indexOf("=");
  return [line.slice(0, separator).trim(), line.slice(separator + 1).trim().replace(/^"|"$/g, "")];
}));
const now = Math.floor(Date.now() / 1000);
const token = await new SignJWT({ sid: sessionId, name: "Phase Two Commissioner", email: "phase2-commissioner-1785753015959@example.com", email_verified: true })
  .setProtectedHeader({ alg: "HS256", typ: "JWT" }).setIssuer("https://api.myfflapp.com").setAudience("myffl-clients").setSubject(userId).setIssuedAt(now).setExpirationTime(now + 600).setJti(crypto.randomUUID()).sign(new TextEncoder().encode(vars.ACCESS_TOKEN_SIGNING_SECRET));

async function api(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, { method: options.method ?? "GET", headers: { authorization: `Bearer ${token}`, ...(options.body ? { "content-type": "application/json" } : {}) }, body: options.body ? JSON.stringify(options.body) : undefined });
  const payload = await response.json();
  if (!response.ok || !payload.ok) throw new Error(`${path}: ${payload.error?.message ?? response.status}`);
  return payload.data;
}

const input = {
  leagueId: "lg_53b36c07-69e4-4e59-a1fe-b6e93a0b658d",
  seasonId: "lgs_c1be59cd-dc82-43a9-884b-8e7d3ce87505",
  eventId: "espn-event-myffl-test-2026-001",
  playerId: "espn-player-99001",
  dataScope: "simulation:d5a472bb-f29d-4bd7-bd10-240c147ca552",
};
const query = new URLSearchParams(input).toString();
const investigation = await api(`/api/admin/scoring/investigation?${query}`);
const preview = await api("/api/admin/corrections/preview", { method: "POST", body: { ...input, correctedPoints: 15.25 } });
const applied = await api("/api/admin/corrections/apply", { method: "POST", body: { ...input, correctedPoints: 15.25, expectedRevision: preview.preview.expectedRevision, reason: "Phase 11 local correction validation" } });
const reverted = await api(`/api/admin/corrections/${applied.correctionId}/revert`, { method: "POST", body: { reason: "Phase 11 local reversal validation" } });
const final = await api(`/api/admin/scoring/investigation?${query}`);

console.log(JSON.stringify({
  initialPointsMilli: investigation.score.totalPointsMilli,
  previewDeltaMilli: preview.preview.deltaPointsMilli,
  appliedStatus: applied.status,
  revertedStatus: reverted.status,
  finalPointsMilli: final.score.totalPointsMilli,
  revisionCount: final.revisionHistory.length,
  correctionCount: final.corrections.length,
}, null, 2));
