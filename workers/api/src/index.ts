import type {
  AuthSessionResponse,
  HealthResponse,
  LoginRequest,
  PhaseStatusResponse,
  RegisterRequest,
} from "@myffl/api-contracts";
import { corsHeaders, errorJson, json, readJson } from "./http";
import {
  hashPassword,
  newId,
  newOpaqueToken,
  normalizeEmail,
  sha256Base64Url,
  verifyPassword,
} from "./security";

const accessTokenTtlSeconds = 15 * 60;
const refreshTokenTtlSeconds = 30 * 24 * 60 * 60;

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const correlationId =
      request.headers.get("x-correlation-id") ?? crypto.randomUUID();

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        return json<HealthResponse>(
          {
            service: "myffl-api",
            environment: env.ENVIRONMENT,
            status: "healthy",
            version: "0.1.0",
            utc: new Date().toISOString(),
          },
          correlationId,
        );
      }

      if (request.method === "GET" && url.pathname === "/phase-status") {
        return json<PhaseStatusResponse>(phaseStatus(), correlationId);
      }

      if (request.method === "POST" && url.pathname === "/auth/register") {
        const body = await readJson<RegisterRequest>(request);
        const session = await register(body, env, ctx, correlationId);
        return json(session, correlationId, { status: 201 });
      }

      if (request.method === "POST" && url.pathname === "/auth/login") {
        const body = await readJson<LoginRequest>(request);
        const session = await login(body, env, correlationId);
        return json(session, correlationId);
      }

      return errorJson(
        { code: "not_found", message: "The requested endpoint does not exist." },
        correlationId,
        404,
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          message: "Unhandled API request failure.",
          correlationId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return errorJson(
        {
          code: "request_failed",
          message: error instanceof Error ? error.message : "Request failed.",
        },
        correlationId,
        500,
      );
    }
  },
} satisfies ExportedHandler<Env>;

function phaseStatus(): PhaseStatusResponse {
  return {
    phase: "phase-1",
    title: "Cloudflare Foundation and Authentication",
    items: [
      {
        key: "cloudflare-resources",
        label: "Cloudflare resources",
        status: "available",
        summary: "D1, R2, Queues, Pages, and Email Sending are provisioned.",
      },
      {
        key: "auth-api",
        label: "Authentication API",
        status: "in_progress",
        summary: "Registration and login endpoints exist; verification and revocation are next.",
      },
      {
        key: "desktop-shell",
        label: "Desktop shell",
        status: "available",
        summary: "Visual Studio WPF shell is runnable.",
      },
      {
        key: "mobile-shell",
        label: "Mobile shell",
        status: "available",
        summary: "React PWA shell is runnable against the API status endpoints.",
      },
    ],
  };
}

async function register(
  request: RegisterRequest,
  env: Env,
  ctx: ExecutionContext,
  correlationId: string,
): Promise<AuthSessionResponse> {
  const coreDb = requireBinding(env.CORE_DB, "CORE_DB");
  const auditQueue = requireBinding(env.AUDIT_QUEUE, "AUDIT_QUEUE");
  const displayName = request.displayName.trim();
  const email = normalizeEmail(request.email);

  if (displayName.length < 2) throw new Error("Display name is required.");
  if (!email.includes("@")) throw new Error("A valid email address is required.");
  if (request.password.length < 12) {
    throw new Error("Password must be at least 12 characters.");
  }
  if (request.password !== request.passwordConfirmation) {
    throw new Error("Password confirmation does not match.");
  }

  const now = new Date().toISOString();
  const existing = await coreDb.prepare(
    "select user_id from users where email_normalized = ?1 limit 1",
  )
    .bind(email)
    .first<{ user_id: string }>();

  if (existing) throw new Error("An account already exists for this email.");

  const userId = newId("usr");
  const passwordHash = await hashPassword(request.password);
  await coreDb.batch([
    coreDb.prepare(
      `insert into users (
        user_id, email, email_normalized, password_hash, email_verified_at_utc,
        created_at_utc, updated_at_utc, status
      ) values (?1, ?2, ?3, ?4, null, ?5, ?5, 'active')`,
    ).bind(userId, request.email.trim(), email, passwordHash, now),
    coreDb.prepare(
      `insert into user_profiles (
        user_id, display_name, created_at_utc, updated_at_utc
      ) values (?1, ?2, ?3, ?3)`,
    ).bind(userId, displayName, now),
    coreDb.prepare(
      `insert into audit_events (
        audit_event_id, actor_user_id, action, entity_type, entity_id,
        correlation_id, created_at_utc, metadata_json
      ) values (?1, ?2, 'auth.register', 'user', ?2, ?3, ?4, '{}')`,
    ).bind(newId("aud"), userId, correlationId, now),
  ]);

  ctx.waitUntil(queueAudit(auditQueue, userId, "auth.register", correlationId));
  return createSession(coreDb, userId, displayName, email);
}

async function login(
  request: LoginRequest,
  env: Env,
  correlationId: string,
): Promise<AuthSessionResponse> {
  const coreDb = requireBinding(env.CORE_DB, "CORE_DB");
  const email = normalizeEmail(request.email);
  const user = await coreDb.prepare(
    `select users.user_id, users.email_normalized, users.password_hash, profiles.display_name
     from users
     join user_profiles profiles on profiles.user_id = users.user_id
     where users.email_normalized = ?1 and users.status = 'active'
     limit 1`,
  )
    .bind(email)
    .first<{
      user_id: string;
      email_normalized: string;
      password_hash: string;
      display_name: string;
    }>();

  if (!user || !(await verifyPassword(request.password, user.password_hash))) {
    throw new Error("Invalid email or password.");
  }

  await coreDb.prepare(
    `insert into audit_events (
      audit_event_id, actor_user_id, action, entity_type, entity_id,
      correlation_id, created_at_utc, metadata_json
    ) values (?1, ?2, 'auth.login', 'user', ?2, ?3, ?4, '{}')`,
  )
    .bind(newId("aud"), user.user_id, correlationId, new Date().toISOString())
    .run();

  return createSession(coreDb, user.user_id, user.display_name, user.email_normalized);
}

async function createSession(
  coreDb: D1Database,
  userId: string,
  displayName: string,
  email: string,
): Promise<AuthSessionResponse> {
  const now = new Date();
  const sessionId = newId("ses");
  const refreshToken = newOpaqueToken();
  const accessToken = newOpaqueToken();
  const refreshExpires = new Date(now.getTime() + refreshTokenTtlSeconds * 1000);
  const accessExpires = new Date(now.getTime() + accessTokenTtlSeconds * 1000);

  await coreDb.prepare(
    `insert into refresh_tokens (
      refresh_token_id, user_id, token_hash, created_at_utc, expires_at_utc,
      revoked_at_utc, replaced_by_token_id
    ) values (?1, ?2, ?3, ?4, ?5, null, null)`,
  )
    .bind(
      sessionId,
      userId,
      await sha256Base64Url(refreshToken),
      now.toISOString(),
      refreshExpires.toISOString(),
    )
    .run();

  return {
    userId,
    displayName,
    email,
    accessToken,
    refreshToken,
    accessTokenExpiresAtUtc: accessExpires.toISOString(),
  };
}

async function queueAudit(
  auditQueue: Queue,
  userId: string,
  action: string,
  correlationId: string,
): Promise<void> {
  await auditQueue.send({
    userId,
    action,
    correlationId,
    utc: new Date().toISOString(),
  });
}

function requireBinding<T>(binding: T | undefined, name: string): T {
  if (!binding) {
    throw new Error(`Required Cloudflare binding is missing: ${name}.`);
  }
  return binding;
}
