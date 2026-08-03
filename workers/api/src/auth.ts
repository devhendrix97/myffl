import type {
  AuthClientType,
  AuthSessionResponse,
  AuthUser,
  EmailAddressRequest,
  LoginRequest,
  LogoutRequest,
  MessageResponse,
  RefreshSessionRequest,
  RegisterRequest,
  RegistrationResponse,
  ResetPasswordRequest,
  TokenRequest,
  VerifyEmailResponse,
} from "@myffl/api-contracts";
import { sendPasswordResetEmail, sendVerificationEmail } from "./email";
import { ApiException } from "./http";
import {
  hashOpaqueToken,
  hashPassword,
  issueAccessToken,
  newId,
  newOpaqueToken,
  normalizeEmail,
  sha256Base64Url,
  verifyAccessToken,
  verifyPassword,
  type AccessTokenPrincipal,
} from "./security";

const accessTokenTtlSeconds = 15 * 60;
const refreshTokenTtlSeconds = 30 * 24 * 60 * 60;
const verificationTokenTtlSeconds = 24 * 60 * 60;
const passwordResetTtlSeconds = 60 * 60;
const refreshCookieName = "myffl_refresh";

export interface HandlerResult<T> {
  data: T;
  status?: number;
  headers?: HeadersInit;
}

interface UserRow {
  user_id: string;
  email: string;
  email_normalized: string;
  password_hash: string;
  email_verified_at_utc: string | null;
  display_name: string;
}

interface RefreshTokenRow extends UserRow {
  refresh_token_id: string;
  expires_at_utc: string;
  revoked_at_utc: string | null;
  replaced_by_token_id: string | null;
}

export async function register(
  body: RegisterRequest,
  env: Env,
  ctx: ExecutionContext,
  correlationId: string,
): Promise<HandlerResult<RegistrationResponse>> {
  const displayName = requireDisplayName(body.displayName);
  const email = requireEmail(body.email);
  const password = requireNewPassword(body.password, body.passwordConfirmation);
  await enforceAuthRateLimit(env, "register", email);

  const existing = await env.CORE_DB.prepare(
    "select user_id from users where email_normalized = ?1 limit 1",
  )
    .bind(email)
    .first<{ user_id: string }>();
  if (existing) {
    throw new ApiException(409, "account_exists", "An account already exists for this email address.");
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const userId = newId("usr");
  const verificationId = newId("emv");
  const verificationToken = newOpaqueToken();
  const verificationHash = await hashOpaqueToken(
    verificationToken,
    env.EMAIL_VERIFICATION_SECRET,
  );
  const verificationExpires = new Date(
    now.getTime() + verificationTokenTtlSeconds * 1000,
  ).toISOString();

  await env.CORE_DB.batch([
    env.CORE_DB.prepare(
      `insert into users (
        user_id, email, email_normalized, password_hash, email_verified_at_utc,
        created_at_utc, updated_at_utc, status, password_changed_at_utc
      ) values (?1, ?2, ?3, ?4, null, ?5, ?5, 'active', ?5)`,
    ).bind(userId, body.email.trim(), email, await hashPassword(password), nowIso),
    env.CORE_DB.prepare(
      `insert into user_profiles (
        user_id, display_name, created_at_utc, updated_at_utc
      ) values (?1, ?2, ?3, ?3)`,
    ).bind(userId, displayName, nowIso),
    env.CORE_DB.prepare(
      `insert into email_verifications (
        email_verification_id, user_id, token_hash, created_at_utc,
        expires_at_utc, completed_at_utc
      ) values (?1, ?2, ?3, ?4, ?5, null)`,
    ).bind(verificationId, userId, verificationHash, nowIso, verificationExpires),
    auditStatement(env.CORE_DB, userId, "auth.register", userId, correlationId, nowIso),
  ]);

  const emailDeliveryStatus = await sendVerificationSafely(env, {
    to: body.email.trim(),
    displayName,
    token: verificationToken,
  }, correlationId);
  queueAudit(ctx, env, userId, "auth.register", correlationId);

  return {
    status: 201,
    data: {
      userId,
      email: body.email.trim(),
      verificationRequired: true,
      emailDeliveryStatus,
    },
  };
}

export async function verifyEmail(
  body: TokenRequest,
  env: Env,
  ctx: ExecutionContext,
  correlationId: string,
): Promise<HandlerResult<VerifyEmailResponse>> {
  const token = requireToken(body.token);
  const tokenHash = await hashOpaqueToken(token, env.EMAIL_VERIFICATION_SECRET);
  const nowIso = new Date().toISOString();
  const user = await env.CORE_DB.prepare(
    `select users.user_id, users.email, users.email_normalized,
            users.password_hash, users.email_verified_at_utc, profiles.display_name
     from email_verifications verification
     join users on users.user_id = verification.user_id
     join user_profiles profiles on profiles.user_id = users.user_id
     where verification.token_hash = ?1
       and verification.completed_at_utc is null
       and verification.expires_at_utc > ?2
       and users.status = 'active'
     limit 1`,
  )
    .bind(tokenHash, nowIso)
    .first<UserRow>();
  if (!user) {
    throw new ApiException(400, "invalid_verification_token", "This verification link is invalid or has expired.");
  }

  await env.CORE_DB.batch([
    env.CORE_DB.prepare(
      `update email_verifications
       set completed_at_utc = ?1
       where token_hash = ?2 and completed_at_utc is null`,
    ).bind(nowIso, tokenHash),
    env.CORE_DB.prepare(
      `update users
       set email_verified_at_utc = coalesce(email_verified_at_utc, ?1), updated_at_utc = ?1
       where user_id = ?2`,
    ).bind(nowIso, user.user_id),
    auditStatement(env.CORE_DB, user.user_id, "auth.email_verified", user.user_id, correlationId, nowIso),
  ]);
  queueAudit(ctx, env, user.user_id, "auth.email_verified", correlationId);

  return {
    data: {
      userId: user.user_id,
      displayName: user.display_name,
      email: user.email,
      emailVerified: true,
      verified: true,
    },
  };
}

export async function resendVerification(
  body: EmailAddressRequest,
  env: Env,
  correlationId: string,
): Promise<HandlerResult<MessageResponse>> {
  const email = requireEmail(body.email);
  await enforceAuthRateLimit(env, "resend-verification", email);
  const user = await findUserByEmail(env.CORE_DB, email);

  if (user && !user.email_verified_at_utc) {
    const now = new Date();
    const nowIso = now.toISOString();
    const token = newOpaqueToken();
    await env.CORE_DB.batch([
      env.CORE_DB.prepare(
        `update email_verifications
         set completed_at_utc = ?1
         where user_id = ?2 and completed_at_utc is null`,
      ).bind(nowIso, user.user_id),
      env.CORE_DB.prepare(
        `insert into email_verifications (
          email_verification_id, user_id, token_hash, created_at_utc,
          expires_at_utc, completed_at_utc
        ) values (?1, ?2, ?3, ?4, ?5, null)`,
      ).bind(
        newId("emv"),
        user.user_id,
        await hashOpaqueToken(token, env.EMAIL_VERIFICATION_SECRET),
        nowIso,
        new Date(now.getTime() + verificationTokenTtlSeconds * 1000).toISOString(),
      ),
    ]);
    await sendVerificationSafely(env, {
      to: user.email,
      displayName: user.display_name,
      token,
    }, correlationId);
  }

  return { data: { message: "If this account needs verification, a new email is on its way." } };
}

export async function login(
  body: LoginRequest,
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  correlationId: string,
): Promise<HandlerResult<AuthSessionResponse>> {
  const email = requireEmail(body.email);
  const password = requireString(body.password, "Password");
  await enforceAuthRateLimit(env, "login", email);
  const user = await findUserByEmail(env.CORE_DB, email);
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    throw new ApiException(401, "invalid_credentials", "Invalid email or password.");
  }
  if (!user.email_verified_at_utc) {
    throw new ApiException(403, "email_not_verified", "Verify your email address before signing in.");
  }

  const nowIso = new Date().toISOString();
  await env.CORE_DB.batch([
    env.CORE_DB.prepare(
      "update users set last_login_at_utc = ?1, updated_at_utc = ?1 where user_id = ?2",
    ).bind(nowIso, user.user_id),
    auditStatement(env.CORE_DB, user.user_id, "auth.login", user.user_id, correlationId, nowIso),
  ]);
  queueAudit(ctx, env, user.user_id, "auth.login", correlationId);
  return createSession(env, user, body.clientType ?? "browser", request);
}

export async function refreshSession(
  body: RefreshSessionRequest,
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  correlationId: string,
): Promise<HandlerResult<AuthSessionResponse>> {
  const token = body.refreshToken?.trim() || readCookie(request, refreshCookieName);
  if (!token) throw new ApiException(401, "refresh_required", "Your session has expired. Sign in again.");
  const clientType: AuthClientType = body.clientType ?? (body.refreshToken ? "native" : "browser");
  const tokenHash = await hashOpaqueToken(token, env.REFRESH_TOKEN_HASHING_SECRET);
  const session = await findRefreshSession(env.CORE_DB, tokenHash);
  const now = new Date();
  const nowIso = now.toISOString();

  if (!session) throw new ApiException(401, "invalid_refresh_token", "Your session has expired. Sign in again.");
  if (session.revoked_at_utc) {
    if (session.replaced_by_token_id) {
      await env.CORE_DB.prepare(
        "update refresh_tokens set revoked_at_utc = coalesce(revoked_at_utc, ?1) where user_id = ?2",
      ).bind(nowIso, session.user_id).run();
    }
    throw new ApiException(401, "refresh_token_reused", "This session is no longer valid. Sign in again.");
  }
  if (session.expires_at_utc <= nowIso) {
    await env.CORE_DB.prepare(
      "update refresh_tokens set revoked_at_utc = ?1 where refresh_token_id = ?2",
    ).bind(nowIso, session.refresh_token_id).run();
    throw new ApiException(401, "refresh_token_expired", "Your session has expired. Sign in again.");
  }
  if (!session.email_verified_at_utc) {
    throw new ApiException(403, "email_not_verified", "Verify your email address before signing in.");
  }

  const replacementId = newId("rft");
  const replacementToken = newOpaqueToken();
  await env.CORE_DB.batch([
    env.CORE_DB.prepare(
      `update refresh_tokens
       set revoked_at_utc = ?1, replaced_by_token_id = ?2
       where refresh_token_id = ?3 and revoked_at_utc is null`,
    ).bind(nowIso, replacementId, session.refresh_token_id),
    env.CORE_DB.prepare(
      `insert into refresh_tokens (
        refresh_token_id, user_id, token_hash, created_at_utc, expires_at_utc,
        revoked_at_utc, replaced_by_token_id
      ) values (?1, ?2, ?3, ?4, ?5, null, null)`,
    ).bind(
      replacementId,
      session.user_id,
      await hashOpaqueToken(replacementToken, env.REFRESH_TOKEN_HASHING_SECRET),
      nowIso,
      new Date(now.getTime() + refreshTokenTtlSeconds * 1000).toISOString(),
    ),
    auditStatement(env.CORE_DB, session.user_id, "auth.refresh", replacementId, correlationId, nowIso),
  ]);
  queueAudit(ctx, env, session.user_id, "auth.refresh", correlationId);

  return sessionResponse(
    env,
    session,
    replacementId,
    replacementToken,
    clientType,
    request,
  );
}

export async function logout(
  body: LogoutRequest,
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  correlationId: string,
): Promise<HandlerResult<MessageResponse>> {
  const nowIso = new Date().toISOString();
  const principal = await tryAccessPrincipal(request, env);
  let userId = principal?.userId;
  let sessionId = principal?.sessionId;
  const refreshToken = body.refreshToken?.trim() || readCookie(request, refreshCookieName);

  if (refreshToken) {
    const session = await findRefreshSession(
      env.CORE_DB,
      await hashOpaqueToken(refreshToken, env.REFRESH_TOKEN_HASHING_SECRET),
    );
    userId ??= session?.user_id;
    sessionId ??= session?.refresh_token_id;
  }
  if (sessionId) {
    await env.CORE_DB.prepare(
      "update refresh_tokens set revoked_at_utc = coalesce(revoked_at_utc, ?1) where refresh_token_id = ?2",
    ).bind(nowIso, sessionId).run();
  }
  if (userId) queueAudit(ctx, env, userId, "auth.logout", correlationId);

  return {
    data: { message: "You have been signed out." },
    headers: { "set-cookie": clearRefreshCookie(env) },
  };
}

export async function currentUser(
  request: Request,
  env: Env,
): Promise<HandlerResult<AuthUser>> {
  const principal = await authenticate(request, env);
  return {
    data: {
      userId: principal.userId,
      displayName: principal.displayName,
      email: principal.email,
      emailVerified: principal.emailVerified,
    },
  };
}

export async function forgotPassword(
  body: EmailAddressRequest,
  env: Env,
  correlationId: string,
): Promise<HandlerResult<MessageResponse>> {
  const email = requireEmail(body.email);
  await enforceAuthRateLimit(env, "forgot-password", email);
  const user = await findUserByEmail(env.CORE_DB, email);

  if (user?.email_verified_at_utc) {
    const now = new Date();
    const nowIso = now.toISOString();
    const token = newOpaqueToken();
    await env.CORE_DB.batch([
      env.CORE_DB.prepare(
        `update password_reset_requests
         set completed_at_utc = ?1
         where user_id = ?2 and completed_at_utc is null`,
      ).bind(nowIso, user.user_id),
      env.CORE_DB.prepare(
        `insert into password_reset_requests (
          password_reset_request_id, user_id, token_hash, created_at_utc,
          expires_at_utc, completed_at_utc
        ) values (?1, ?2, ?3, ?4, ?5, null)`,
      ).bind(
        newId("pwr"),
        user.user_id,
        await hashOpaqueToken(token, env.PASSWORD_RESET_SECRET),
        nowIso,
        new Date(now.getTime() + passwordResetTtlSeconds * 1000).toISOString(),
      ),
    ]);
    try {
      await sendPasswordResetEmail(env, {
        to: user.email,
        displayName: user.display_name,
        token,
      });
    } catch (error) {
      logEmailFailure("password_reset", correlationId, error);
    }
  }

  return { data: { message: "If an account matches that email, a reset link is on its way." } };
}

export async function resetPassword(
  body: ResetPasswordRequest,
  env: Env,
  ctx: ExecutionContext,
  correlationId: string,
): Promise<HandlerResult<MessageResponse>> {
  const token = requireToken(body.token);
  const password = requireNewPassword(body.password, body.passwordConfirmation);
  const tokenHash = await hashOpaqueToken(token, env.PASSWORD_RESET_SECRET);
  const nowIso = new Date().toISOString();
  const reset = await env.CORE_DB.prepare(
    `select reset.password_reset_request_id, reset.user_id
     from password_reset_requests reset
     join users on users.user_id = reset.user_id
     where reset.token_hash = ?1
       and reset.completed_at_utc is null
       and reset.expires_at_utc > ?2
       and users.status = 'active'
     limit 1`,
  )
    .bind(tokenHash, nowIso)
    .first<{ password_reset_request_id: string; user_id: string }>();
  if (!reset) {
    throw new ApiException(400, "invalid_reset_token", "This password reset link is invalid or has expired.");
  }

  await env.CORE_DB.batch([
    env.CORE_DB.prepare(
      `update users
       set password_hash = ?1, password_changed_at_utc = ?2, updated_at_utc = ?2
       where user_id = ?3`,
    ).bind(await hashPassword(password), nowIso, reset.user_id),
    env.CORE_DB.prepare(
      "update password_reset_requests set completed_at_utc = ?1 where password_reset_request_id = ?2",
    ).bind(nowIso, reset.password_reset_request_id),
    env.CORE_DB.prepare(
      "update refresh_tokens set revoked_at_utc = coalesce(revoked_at_utc, ?1) where user_id = ?2",
    ).bind(nowIso, reset.user_id),
    auditStatement(env.CORE_DB, reset.user_id, "auth.password_reset", reset.user_id, correlationId, nowIso),
  ]);
  queueAudit(ctx, env, reset.user_id, "auth.password_reset", correlationId);

  return {
    data: { message: "Your password has been changed. Sign in with your new password." },
    headers: { "set-cookie": clearRefreshCookie(env) },
  };
}

async function createSession(
  env: Env,
  user: UserRow,
  clientType: AuthClientType,
  request: Request,
): Promise<HandlerResult<AuthSessionResponse>> {
  const now = new Date();
  const sessionId = newId("rft");
  const refreshToken = newOpaqueToken();
  await env.CORE_DB.prepare(
    `insert into refresh_tokens (
      refresh_token_id, user_id, token_hash, created_at_utc, expires_at_utc,
      revoked_at_utc, replaced_by_token_id
    ) values (?1, ?2, ?3, ?4, ?5, null, null)`,
  )
    .bind(
      sessionId,
      user.user_id,
      await hashOpaqueToken(refreshToken, env.REFRESH_TOKEN_HASHING_SECRET),
      now.toISOString(),
      new Date(now.getTime() + refreshTokenTtlSeconds * 1000).toISOString(),
    )
    .run();
  return sessionResponse(env, user, sessionId, refreshToken, clientType, request);
}

async function sessionResponse(
  env: Env,
  user: UserRow,
  sessionId: string,
  refreshToken: string,
  clientType: AuthClientType,
  request: Request,
): Promise<HandlerResult<AuthSessionResponse>> {
  const access = await issueAccessToken(
    {
      userId: user.user_id,
      sessionId,
      displayName: user.display_name,
      email: user.email,
      emailVerified: Boolean(user.email_verified_at_utc),
    },
    env.ACCESS_TOKEN_SIGNING_SECRET,
    accessTokenTtlSeconds,
  );
  const isNative = clientType === "native";
  return {
    data: {
      userId: user.user_id,
      displayName: user.display_name,
      email: user.email,
      emailVerified: Boolean(user.email_verified_at_utc),
      accessToken: access.token,
      refreshToken: isNative ? refreshToken : undefined,
      accessTokenExpiresAtUtc: access.expiresAtUtc,
    },
    headers: isNative ? undefined : { "set-cookie": refreshCookie(refreshToken, env, request) },
  };
}

async function authenticate(request: Request, env: Env): Promise<AccessTokenPrincipal> {
  const principal = await requireAccessPrincipal(request, env);
  const active = await env.CORE_DB.prepare(
    `select refresh.refresh_token_id
     from refresh_tokens refresh
     join users on users.user_id = refresh.user_id
     where refresh.refresh_token_id = ?1
       and refresh.user_id = ?2
       and refresh.revoked_at_utc is null
       and refresh.expires_at_utc > ?3
       and users.status = 'active'
     limit 1`,
  )
    .bind(principal.sessionId, principal.userId, new Date().toISOString())
    .first<{ refresh_token_id: string }>();
  if (!active) throw new ApiException(401, "session_revoked", "Your session is no longer active.");
  return principal;
}

async function requireAccessPrincipal(request: Request, env: Env): Promise<AccessTokenPrincipal> {
  const authorization = request.headers.get("authorization") ?? "";
  const [scheme, token] = authorization.split(" ", 2);
  if (scheme.toLowerCase() !== "bearer" || !token) {
    throw new ApiException(401, "authentication_required", "Sign in to continue.");
  }
  try {
    return await verifyAccessToken(token, env.ACCESS_TOKEN_SIGNING_SECRET);
  } catch {
    throw new ApiException(401, "invalid_access_token", "Your sign-in has expired. Please try again.");
  }
}

async function tryAccessPrincipal(
  request: Request,
  env: Env,
): Promise<AccessTokenPrincipal | undefined> {
  try {
    return await requireAccessPrincipal(request, env);
  } catch {
    return undefined;
  }
}

async function findUserByEmail(db: D1Database, email: string): Promise<UserRow | null> {
  return db.prepare(
    `select users.user_id, users.email, users.email_normalized, users.password_hash,
            users.email_verified_at_utc, profiles.display_name
     from users
     join user_profiles profiles on profiles.user_id = users.user_id
     where users.email_normalized = ?1 and users.status = 'active'
     limit 1`,
  ).bind(email).first<UserRow>();
}

async function findRefreshSession(
  db: D1Database,
  tokenHash: string,
): Promise<RefreshTokenRow | null> {
  return db.prepare(
    `select refresh.refresh_token_id, refresh.expires_at_utc,
            refresh.revoked_at_utc, refresh.replaced_by_token_id,
            users.user_id, users.email, users.email_normalized, users.password_hash,
            users.email_verified_at_utc, profiles.display_name
     from refresh_tokens refresh
     join users on users.user_id = refresh.user_id
     join user_profiles profiles on profiles.user_id = users.user_id
     where refresh.token_hash = ?1 and users.status = 'active'
     limit 1`,
  ).bind(tokenHash).first<RefreshTokenRow>();
}

async function enforceAuthRateLimit(env: Env, action: string, identity: string): Promise<void> {
  const identityHash = await sha256Base64Url(identity);
  const outcome = await env.AUTH_RATE_LIMITER.limit({ key: `${action}:${identityHash}` });
  if (!outcome.success) {
    throw new ApiException(429, "rate_limited", "Too many attempts. Wait a minute and try again.");
  }
}

function auditStatement(
  db: D1Database,
  userId: string,
  action: string,
  entityId: string,
  correlationId: string,
  nowIso: string,
): D1PreparedStatement {
  return db.prepare(
    `insert into audit_events (
      audit_event_id, actor_user_id, action, entity_type, entity_id,
      correlation_id, created_at_utc, metadata_json
    ) values (?1, ?2, ?3, 'user', ?4, ?5, ?6, '{}')`,
  ).bind(newId("aud"), userId, action, entityId, correlationId, nowIso);
}

function queueAudit(
  ctx: ExecutionContext,
  env: Env,
  userId: string,
  action: string,
  correlationId: string,
): void {
  ctx.waitUntil(
    env.AUDIT_QUEUE.send({
      userId,
      action,
      correlationId,
      utc: new Date().toISOString(),
    }).catch((error: unknown) => {
      console.error(JSON.stringify({
        level: "error",
        event: "audit_queue_failed",
        action,
        correlationId,
        error: error instanceof Error ? error.message : String(error),
      }));
    }),
  );
}

async function sendVerificationSafely(
  env: Env,
  input: { to: string; displayName: string; token: string },
  correlationId: string,
): Promise<"sent" | "deferred"> {
  try {
    await sendVerificationEmail(env, input);
    return "sent";
  } catch (error) {
    logEmailFailure("verification", correlationId, error);
    return "deferred";
  }
}

function logEmailFailure(kind: string, correlationId: string, error: unknown): void {
  const emailError = error as { code?: unknown; message?: unknown };
  console.error(JSON.stringify({
    level: "error",
    event: "auth_email_failed",
    kind,
    correlationId,
    code: typeof emailError.code === "string" ? emailError.code : undefined,
    error: typeof emailError.message === "string" ? emailError.message : String(error),
  }));
}

function requireDisplayName(value: unknown): string {
  const displayName = requireString(value, "Display name").trim();
  if (displayName.length < 2 || displayName.length > 50) {
    throw new ApiException(400, "invalid_display_name", "Display name must be between 2 and 50 characters.");
  }
  return displayName;
}

function requireEmail(value: unknown): string {
  const email = normalizeEmail(requireString(value, "Email"));
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiException(400, "invalid_email", "Enter a valid email address.");
  }
  return email;
}

function requireNewPassword(passwordValue: unknown, confirmationValue: unknown): string {
  const password = requireString(passwordValue, "Password");
  const confirmation = requireString(confirmationValue, "Password confirmation");
  if (password.length < 12 || password.length > 128) {
    throw new ApiException(400, "invalid_password", "Password must be between 12 and 128 characters.");
  }
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) {
    throw new ApiException(400, "invalid_password", "Password must include uppercase, lowercase, and a number.");
  }
  if (password !== confirmation) {
    throw new ApiException(400, "password_mismatch", "Password confirmation does not match.");
  }
  return password;
}

function requireToken(value: unknown): string {
  const token = requireString(value, "Token").trim();
  if (token.length < 32 || token.length > 256) {
    throw new ApiException(400, "invalid_token", "The supplied account link is invalid.");
  }
  return token;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiException(400, "validation_failed", `${label} is required.`);
  }
  return value;
}

function readCookie(request: Request, name: string): string | undefined {
  const cookie = request.headers.get("cookie");
  if (!cookie) return undefined;
  for (const part of cookie.split(";")) {
    const [key, ...valueParts] = part.trim().split("=");
    if (key === name) return decodeURIComponent(valueParts.join("="));
  }
  return undefined;
}

function refreshCookie(token: string, env: Env, request: Request): string {
  const secure = env.ENVIRONMENT !== "local" || new URL(request.url).protocol === "https:";
  return [
    `${refreshCookieName}=${encodeURIComponent(token)}`,
    "Path=/auth",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${refreshTokenTtlSeconds}`,
    secure ? "Secure" : "",
  ].filter(Boolean).join("; ");
}

function clearRefreshCookie(env: Env): string {
  return [
    `${refreshCookieName}=`,
    "Path=/auth",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    env.ENVIRONMENT === "local" ? "" : "Secure",
  ].filter(Boolean).join("; ");
}
