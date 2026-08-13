import { readFileSync } from "node:fs";
import { SignJWT } from "jose";

const baseUrl = process.env.MYFFL_SMOKE_API ?? "http://127.0.0.1:8787";
const apiKey = process.env.FANTASYPROS_SMOKE_KEY;
if (!apiKey) throw new Error("FANTASYPROS_SMOKE_KEY is required.");

const userId = "usr_953e7f69-c253-4ccc-8466-addcc19b119b";
const vars = Object.fromEntries(readFileSync(".dev.vars", "utf8").split(/\r?\n/).filter(Boolean).map((line) => {
  const separator = line.indexOf("=");
  return [line.slice(0, separator).trim(), line.slice(separator + 1).trim().replace(/^"|"$/g, "")];
}));
const now = Math.floor(Date.now() / 1000);
const token = await new SignJWT({
  sid: "rft_b297c8f1-9a38-4829-8418-655e46e97163",
  name: "Local Platform Owner",
  email: "phase2-commissioner-1785753015959@example.com",
  email_verified: true,
})
  .setProtectedHeader({ alg: "HS256", typ: "JWT" })
  .setIssuer("https://api.myfflapp.com")
  .setAudience("myffl-clients")
  .setSubject(userId)
  .setIssuedAt(now)
  .setExpirationTime(now + 600)
  .setJti(crypto.randomUUID())
  .sign(new TextEncoder().encode(vars.ACCESS_TOKEN_SIGNING_SECRET));

async function api(method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, origin: "http://localhost:5173", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (text.includes(apiKey)) throw new Error("The API response exposed the provider key.");
  const payload = JSON.parse(text);
  if (!response.ok || !payload.ok) throw new Error(payload.error?.message ?? `Request failed with ${response.status}.`);
  return payload.data;
}

const saved = await api("PUT", "/api/admin/providers/fantasypros/credential", {
  apiKey,
  enabled: true,
  reason: "Authenticated local credential smoke test",
});
if (!saved.credential.configured || !saved.credential.enabled || saved.credential.storage !== "admin-managed") {
  throw new Error("The provider credential did not become active.");
}
if (saved.credential.maskedKey !== `****${apiKey.slice(-4)}`) throw new Error("The masked key suffix is incorrect.");

const disabled = await api("PUT", "/api/admin/providers/fantasypros/credential", {
  enabled: false,
  reason: "Leave local scheduled synchronization disabled after smoke test",
});
if (disabled.credential.enabled) throw new Error("The provider credential was not disabled.");

console.log(JSON.stringify({
  configured: disabled.credential.configured,
  enabled: disabled.credential.enabled,
  storage: disabled.credential.storage,
  maskedKey: disabled.credential.maskedKey,
  requestsUsed: disabled.usage.requestsUsed,
  plaintextReturned: false,
}, null, 2));
