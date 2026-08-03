import { jwtVerify, SignJWT } from "jose";

const encoder = new TextEncoder();
const accessTokenIssuer = "https://api.myfflapp.com";
const accessTokenAudience = "myffl-clients";
const passwordHashIterations = 100000;

export interface AccessTokenPrincipal {
  userId: string;
  sessionId: string;
  displayName: string;
  email: string;
  emailVerified: boolean;
  expiresAtUtc: string;
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: passwordHashIterations, hash: "SHA-256" },
    key,
    256,
  );
  return `pbkdf2_sha256$${passwordHashIterations}$${toBase64(salt)}$${toBase64(new Uint8Array(bits))}`;
}

export async function verifyPassword(
  password: string,
  storedHash: string,
): Promise<boolean> {
  const [scheme, iterationText, saltText, hashText] = storedHash.split("$");
  const iterations = Number(iterationText);
  if (
    scheme !== "pbkdf2_sha256" ||
    !Number.isInteger(iterations) ||
    iterations < 100000 ||
    iterations > 1000000 ||
    !saltText ||
    !hashText
  ) {
    return false;
  }

  try {
    const salt = toArrayBuffer(fromBase64(saltText));
    const expected = fromBase64(hashText);
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(password),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
      key,
      256,
    );
    return timingSafeEqual(expected, new Uint8Array(bits));
  } catch {
    return false;
  }
}

export function newOpaqueToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

export async function hashOpaqueToken(
  token: string,
  secret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(requireStrongSecret(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(token));
  return toBase64Url(new Uint8Array(signature));
}

export async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return toBase64Url(new Uint8Array(digest));
}

export async function issueAccessToken(
  principal: Omit<AccessTokenPrincipal, "expiresAtUtc">,
  secret: string,
  ttlSeconds: number,
): Promise<{ token: string; expiresAtUtc: string }> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiresSeconds = nowSeconds + ttlSeconds;
  const token = await new SignJWT({
    sid: principal.sessionId,
    name: principal.displayName,
    email: principal.email,
    email_verified: principal.emailVerified,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(accessTokenIssuer)
    .setAudience(accessTokenAudience)
    .setSubject(principal.userId)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(expiresSeconds)
    .setJti(crypto.randomUUID())
    .sign(encoder.encode(requireStrongSecret(secret)));

  return {
    token,
    expiresAtUtc: new Date(expiresSeconds * 1000).toISOString(),
  };
}

export async function verifyAccessToken(
  token: string,
  secret: string,
): Promise<AccessTokenPrincipal> {
  const { payload } = await jwtVerify(
    token,
    encoder.encode(requireStrongSecret(secret)),
    {
      algorithms: ["HS256"],
      issuer: accessTokenIssuer,
      audience: accessTokenAudience,
      clockTolerance: 5,
    },
  );

  if (
    typeof payload.sub !== "string" ||
    typeof payload.sid !== "string" ||
    typeof payload.name !== "string" ||
    typeof payload.email !== "string" ||
    typeof payload.email_verified !== "boolean" ||
    typeof payload.exp !== "number"
  ) {
    throw new Error("Access token claims are invalid.");
  }

  return {
    userId: payload.sub,
    sessionId: payload.sid,
    displayName: payload.name,
    email: payload.email,
    emailVerified: payload.email_verified,
    expiresAtUtc: new Date(payload.exp * 1000).toISOString(),
  };
}

export function requireStrongSecret(secret: string | undefined): string {
  if (!secret || encoder.encode(secret).byteLength < 32) {
    throw new Error("A required authentication secret is missing or too short.");
  }
  return secret;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
