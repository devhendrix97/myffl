import type {
  EmailAddressRequest,
  HealthResponse,
  LoginRequest,
  LogoutRequest,
  PhaseStatusResponse,
  RefreshSessionRequest,
  RegisterRequest,
  ResetPasswordRequest,
  TokenRequest,
} from "@myffl/api-contracts";
import {
  currentUser,
  forgotPassword,
  login,
  logout,
  refreshSession,
  register,
  resendVerification,
  resetPassword,
  verifyEmail,
  type HandlerResult,
} from "./auth";
import { ApiException, corsHeaders, errorJson, isAllowedOrigin, json, readJson } from "./http";
import { handleLeagueRequest } from "./league";
import { handleScoringRequest } from "./scoring";
import { handleAdminRequest } from "./admin";
import { enqueueScheduledProviderWork, processProviderQueue, type ProviderJob } from "./provider";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const correlationId = request.headers.get("x-correlation-id") ?? crypto.randomUUID();

    if (request.method === "OPTIONS") {
      const origin = request.headers.get("origin");
      if (origin && !isAllowedOrigin(origin, env)) {
        return errorJson(
          { code: "origin_not_allowed", message: "This origin is not allowed." },
          request,
          env,
          correlationId,
          403,
        );
      }
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    try {
      const url = new URL(request.url);
      const result = await routeRequest(request, url, env, ctx, correlationId);
      if (!result) {
        return errorJson(
          { code: "not_found", message: "The requested endpoint does not exist." },
          request,
          env,
          correlationId,
          404,
        );
      }
      return json(result.data, request, env, correlationId, {
        status: result.status,
        headers: result.headers,
      });
    } catch (error) {
      if (error instanceof ApiException) {
        return errorJson(
          { code: error.code, message: error.message, details: error.details },
          request,
          env,
          correlationId,
          error.status,
        );
      }

      console.error(JSON.stringify({
        level: "error",
        event: "api_request_failed",
        correlationId,
        method: request.method,
        path: new URL(request.url).pathname,
        error: error instanceof Error ? error.message : String(error),
      }));
      return errorJson(
        { code: "request_failed", message: "The request could not be completed." },
        request,
        env,
        correlationId,
        500,
      );
    }
  },
  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(enqueueScheduledProviderWork(env));
  },
  async queue(batch, env): Promise<void> {
    if (batch.queue !== "myffl-espn-updates") return;
    await processProviderQueue(batch as MessageBatch<ProviderJob>, env);
  },
} satisfies ExportedHandler<Env>;

async function routeRequest(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
  correlationId: string,
): Promise<HandlerResult<unknown> | undefined> {
  if (request.method === "GET" && url.pathname === "/health") {
    return {
      data: {
        service: "myffl-api",
        environment: env.ENVIRONMENT,
        status: "healthy",
        version: "0.5.1",
        utc: new Date().toISOString(),
      } satisfies HealthResponse,
    };
  }
  if (request.method === "GET" && url.pathname === "/phase-status") {
    return { data: phaseStatus() };
  }
  if (request.method === "GET" && url.pathname === "/auth/me") {
    return currentUser(request, env);
  }
  if (request.method === "POST" && url.pathname === "/auth/register") {
    return register(await readJson<RegisterRequest>(request), env, ctx, correlationId);
  }
  if (request.method === "POST" && url.pathname === "/auth/verify-email") {
    return verifyEmail(await readJson<TokenRequest>(request), env, ctx, correlationId);
  }
  if (request.method === "POST" && url.pathname === "/auth/resend-verification") {
    return resendVerification(await readJson<EmailAddressRequest>(request), env, correlationId);
  }
  if (request.method === "POST" && url.pathname === "/auth/login") {
    return login(await readJson<LoginRequest>(request), request, env, ctx, correlationId);
  }
  if (request.method === "POST" && url.pathname === "/auth/refresh") {
    return refreshSession(
      await readJson<RefreshSessionRequest>(request),
      request,
      env,
      ctx,
      correlationId,
    );
  }
  if (request.method === "POST" && url.pathname === "/auth/logout") {
    return logout(await readJson<LogoutRequest>(request), request, env, ctx, correlationId);
  }
  if (request.method === "POST" && url.pathname === "/auth/forgot-password") {
    return forgotPassword(await readJson<EmailAddressRequest>(request), env, correlationId);
  }
  if (request.method === "POST" && url.pathname === "/auth/reset-password") {
    return resetPassword(
      await readJson<ResetPasswordRequest>(request),
      env,
      ctx,
      correlationId,
    );
  }
  const adminResult = await handleAdminRequest(request, url, env, ctx, correlationId);
  if (adminResult) return adminResult;
  const scoringResult = await handleScoringRequest(request, url, env, ctx, correlationId);
  if (scoringResult) return scoringResult;
  const leagueResult = await handleLeagueRequest(request, url, env, ctx, correlationId);
  if (leagueResult) return leagueResult;
  return undefined;
}

function phaseStatus(): PhaseStatusResponse {
  return {
    phase: "phase-4",
    title: "ESPN Data Integration",
    items: [
      {
        key: "cloudflare-resources",
        label: "Cloudflare resources",
        status: "available",
        summary: "D1, R2, Queues, Pages, rate limiting, and Email Sending are online.",
      },
      {
        key: "auth-api",
        label: "Authentication API",
        status: "available",
        summary: "Verification, login, refresh, revocation, and password recovery are available.",
      },
      {
        key: "league-management",
        label: "League management",
        status: "available",
        summary: "Creation, invitations, memberships, roles, teams, and settings are available.",
      },
      {
        key: "shard-routing",
        label: "Shard routing",
        status: "available",
        summary: "The core directory resolves each league without exposing shard locations to clients.",
      },
      {
        key: "scoring-catalog",
        label: "Scoring catalog and presets",
        status: "available",
        summary: "Plain-language statistics and six editable starting presets are available.",
      },
      {
        key: "scoring-versioning",
        label: "Scoring drafts and versions",
        status: "available",
        summary: "Commissioners can edit, preview, audit, and apply versioned scoring rules.",
      },
      {
        key: "espn-provider",
        label: "ESPN NFL provider",
        status: "available",
        summary: "Teams, schedules, game states, box scores, injuries, mappings, and raw archives are synchronized.",
      },
      {
        key: "provider-replay",
        label: "Provider test mode",
        status: "available",
        summary: "Administrators can replay deterministic ESPN-shaped game updates in an isolated data scope.",
      },
    ],
  };
}
