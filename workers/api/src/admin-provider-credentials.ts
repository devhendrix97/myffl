import type { HandlerResult } from "./auth";
import type { AdminPrincipal } from "./admin-platform";
import { requiredReason } from "./admin-rules";
import { fantasyProsRequestUsage, importFantasyProsCsv, syncFantasyProsNow, validateFantasyProsApiKey, type RankingScoring } from "./fantasypros";
import { ApiException, readJson } from "./http";
import { fantasyProsCredentialStatus, saveFantasyProsCredential } from "./provider-credentials";

const PATH = "/api/admin/providers/fantasypros/credential";

export async function handleAdminProviderCredentialRequest(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
  admin: AdminPrincipal,
  correlationId: string,
): Promise<HandlerResult<unknown> | undefined> {
  if (request.method === "GET" && url.pathname === PATH) return { data: await dashboard(env) };
  if (request.method === "PUT" && url.pathname === PATH) {
    requireRole(admin, ["owner"]);
    const body = await readJson<{ apiKey?: string; enabled?: boolean; reason?: string }>(request);
    const reason = requiredReason(body.reason);
    const apiKey = body.apiKey?.trim();
    const validation = apiKey ? await validateFantasyProsApiKey(env, apiKey) : undefined;
    const status = await saveFantasyProsCredential(env, admin.userId, apiKey, body.enabled === true, validation?.validatedAtUtc);
    await audit(env, admin.userId, "admin.provider_credential.updated", correlationId, {
      provider: "fantasypros",
      enabled: status.enabled,
      storage: status.storage,
      keyReplaced: Boolean(apiKey),
      reason,
    });
    return { data: await dashboard(env) };
  }
  if (request.method === "POST" && url.pathname === "/api/admin/providers/fantasypros/sync") {
    requireRole(admin, ["owner", "operator"]);
    const status = await fantasyProsCredentialStatus(env);
    if (!status.configured || !status.enabled) {
      throw new ApiException(409, "provider_not_enabled", "Configure and enable the FantasyPros credential first.");
    }
    await syncFantasyProsNow(env);
    await audit(env, admin.userId, "admin.provider_sync.requested", correlationId, { provider: "fantasypros" });
    return { data: { accepted: true, provider: "fantasypros" } };
  }
  if (request.method === "POST" && url.pathname === "/api/admin/providers/fantasypros/csv") {
    requireRole(admin, ["owner", "operator"]);
    const body = await readJson<{ csv?: string; seasonYear?: number; scoring?: RankingScoring; scope?: string; sourceUpdatedAt?: string; reason?: string }>(request);
    const reason = requiredReason(body.reason);
    const seasonYear = Number.isInteger(body.seasonYear) ? body.seasonYear! : new Date().getUTCFullYear();
    const scoring = ["STD", "HALF", "PPR"].includes(String(body.scoring)) ? body.scoring! : "PPR";
    const csv = body.csv?.trim();
    if (!csv) throw new ApiException(400, "csv_required", "Paste FantasyPros CSV content before importing.");
    const result = await importFantasyProsCsv(env, csv, { seasonYear, scoring, scope: body.scope, sourceUpdatedAt: body.sourceUpdatedAt });
    await audit(env, admin.userId, "admin.provider_csv.imported", correlationId, { provider: "fantasypros", ...result, reason });
    return { data: result };
  }
  return undefined;
}

async function dashboard(env: Env): Promise<unknown> {
  const [credential, usage, runs] = await Promise.all([
    fantasyProsCredentialStatus(env),
    fantasyProsRequestUsage(env),
    env.NFL_DB.prepare(
      `select fantasypros_sync_run_id as runId,scoring,position_scope as positionScope,status,
        records_seen as recordsSeen,records_mapped as recordsMapped,error_message as errorMessage,
        started_at_utc as startedAtUtc,completed_at_utc as completedAtUtc
       from fantasypros_sync_runs order by started_at_utc desc limit 20`,
    ).all(),
  ]);
  return { credential, usage, recentRuns: runs.results ?? [] };
}

function requireRole(admin: AdminPrincipal, allowed: string[]): void {
  if (!allowed.includes(admin.role)) {
    throw new ApiException(403, "admin_role_required", "Only a platform owner can change provider credentials.");
  }
}

async function audit(env: Env, userId: string, action: string, correlationId: string, metadata: unknown): Promise<void> {
  await env.CORE_DB.prepare(
    `insert into audit_events
      (audit_event_id,actor_user_id,action,entity_type,entity_id,correlation_id,created_at_utc,metadata_json)
     values(?1,?2,?3,'provider_credential','fantasypros',?4,?5,?6)`,
  ).bind(crypto.randomUUID(), userId, action, correlationId, new Date().toISOString(), JSON.stringify(metadata)).run();
}
