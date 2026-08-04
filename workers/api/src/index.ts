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
import { handleGameFeedRequest } from "./game-feed";
import { processScoringQueue, type ScoringJob } from "./score-processing";
import { handleDraftRequest, processExpiredDrafts } from "./draft";
import { handleTeamRequest } from "./team";
import { enqueueDueWaivers, handleTransactionRequest, processDueTrades, processWaiverQueue, type WaiverJob } from "./transactions";
import { handleRealtimeRequest } from "./realtime";
import { handleMatchupRequest } from "./matchups";
import { handleCommunicationRequest } from "./communication";
import { handleNotificationRequest, processNotificationQueue, type NotificationJob } from "./notifications";
export { LeagueRealtime, LiveNflEvent, MatchupRealtime } from "./realtime";

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
      if (result instanceof Response) return result;
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
    ctx.waitUntil(Promise.all([enqueueScheduledProviderWork(env), processExpiredDrafts(env), enqueueDueWaivers(env), processDueTrades(env)]).then(() => undefined));
  },
  async queue(batch, env): Promise<void> {
    if (batch.queue === "myffl-espn-updates") {
      await processProviderQueue(batch as MessageBatch<ProviderJob>, env);
      return;
    }
    if (batch.queue === "myffl-scoring") {
      await processScoringQueue(batch as MessageBatch<ScoringJob>, env);
      return;
    }
    if (batch.queue === "myffl-waivers") {
      await processWaiverQueue(batch as MessageBatch<WaiverJob>, env);
      return;
    }
    if (batch.queue === "myffl-notifications") {
      await processNotificationQueue(batch as MessageBatch<NotificationJob>, env);
    }
  },
} satisfies ExportedHandler<Env>;

async function routeRequest(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
  correlationId: string,
): Promise<HandlerResult<unknown> | Response | undefined> {
  if (request.method === "GET" && url.pathname === "/health") {
    return {
      data: {
        service: "myffl-api",
        environment: env.ENVIRONMENT,
        status: "healthy",
        version: "1.0.0",
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
  const realtimeResult = await handleRealtimeRequest(request, url, env);
  if (realtimeResult) return realtimeResult;
  const gameFeedResult = await handleGameFeedRequest(request, url, env);
  if (gameFeedResult) return gameFeedResult;
  const scoringResult = await handleScoringRequest(request, url, env, ctx, correlationId);
  if (scoringResult) return scoringResult;
  const draftResult = await handleDraftRequest(request, url, env, ctx, correlationId);
  if (draftResult) return draftResult;
  const teamResult = await handleTeamRequest(request, url, env, correlationId);
  if (teamResult) return teamResult;
  const transactionResult = await handleTransactionRequest(request, url, env, correlationId);
  if (transactionResult) return transactionResult;
  const matchupResult = await handleMatchupRequest(request, url, env, correlationId);
  if (matchupResult) return matchupResult;
  const communicationResult = await handleCommunicationRequest(request, url, env, correlationId);
  if (communicationResult) return communicationResult;
  const notificationResult = await handleNotificationRequest(request, url, env);
  if (notificationResult) return notificationResult;
  const leagueResult = await handleLeagueRequest(request, url, env, ctx, correlationId);
  if (leagueResult) return leagueResult;
  return undefined;
}

function phaseStatus(): PhaseStatusResponse {
  return {
    phase: "release-1",
    title: "Production release",
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
      {
        key: "live-scoring",
        label: "League-specific live scoring",
        status: "available",
        summary: "Provider statistics are scored independently for each league with component breakdowns and preserved revisions.",
      },
      {
        key: "draft-system",
        label: "Live draft system",
        status: "available",
        summary: "Draft setup, board, server clock, queues, autopick, roster acquisition, and commissioner recovery controls are available.",
      },
      {
        key: "team-management",
        label: "Team and lineup management",
        status: "available",
        summary: "Managers can set legal weekly lineups, respect kickoff locks, preview optimization, and inspect live fantasy totals.",
      },
      {
        key: "player-directory",
        label: "Player directory and profiles",
        status: "available",
        summary: "League-aware search, ownership, injuries, watchlists, profiles, recent statistics, and comparison are available.",
      },
      {
        key: "waiver-system",
        label: "Waivers and free agents",
        status: "available",
        summary: "Immediate moves, ordered claims, FAAB, configurable tiebreakers, conditional drops, and queue-backed processing are available.",
      },
      {
        key: "trade-system",
        label: "Multi-asset trades",
        status: "available",
        summary: "Players, FAAB, and future picks support proposals, counteroffers, review, voting, expiration, validation, and atomic settlement.",
      },
      {
        key: "realtime-gameday",
        label: "Real-time gameday",
        status: "available",
        summary: "Durable Object WebSocket rooms deliver resumable league, matchup, and NFL event updates.",
      },
      {
        key: "matchups-standings",
        label: "Matchups and standings",
        status: "available",
        summary: "Live scores, projections, win probability, player breakdowns, schedules, standings, and snapshots are available.",
      },
      {
        key: "playoff-brackets",
        label: "Playoff brackets",
        status: "available",
        summary: "Seeded brackets support byes, multi-week totals, advancement, consolation play, and third-place matchups.",
      },
      {
        key: "league-communication",
        label: "League communication",
        status: "available",
        summary: "League and draft chat support replies, mentions, reactions, images, GIFs, polls, announcements, pins, and read indicators.",
      },
      {
        key: "activity-reports",
        label: "Activity and weekly reports",
        status: "available",
        summary: "Immutable league activity and persisted weekly highlights make important events and results easy to audit.",
      },
      {
        key: "notification-delivery",
        label: "Notification delivery",
        status: "available",
        summary: "Per-league preferences control in-app, desktop, browser push, and email notification delivery.",
      },
      {
        key: "platform-administration",
        label: "Platform administration",
        status: "available",
        summary: "Role-gated user, league, player, event, scoring investigation, correction, audit, replay, and monitoring tools are available.",
      },
      {
        key: "native-desktop",
        label: "Native desktop workspace",
        status: "available",
        summary: "The WPF client hosts the production workspace with navigation, shortcuts, report export, offline state, and a dockable matchup view.",
      },
    ],
  };
}
