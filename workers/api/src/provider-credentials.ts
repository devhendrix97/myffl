import { ApiException } from "./http";

const PROVIDER = "fantasypros";
const KEY_VERSION = 1;

interface CredentialRow {
  encrypted_value_base64: string | null;
  iv_base64: string | null;
  enabled: number;
  last_four: string | null;
  validated_at_utc: string | null;
  created_at_utc: string;
  updated_at_utc: string;
}

export interface ProviderCredentialStatus {
  provider: typeof PROVIDER;
  configured: boolean;
  enabled: boolean;
  storage: "admin-managed" | "cloudflare-secret" | "not-configured";
  maskedKey?: string;
  validatedAtUtc?: string;
  updatedAtUtc?: string;
}

export async function fantasyProsCredentialStatus(env: Env): Promise<ProviderCredentialStatus> {
  const row = await credentialRow(env.CORE_DB);
  const fallback = env.FANTASYPROS_API_KEY?.trim();
  const configured = Boolean(row?.encrypted_value_base64 || fallback);
  const enabled = row ? row.enabled === 1 : configured && String(env.FANTASYPROS_SYNC_ENABLED) === "true";
  const lastFour = row?.last_four ?? (fallback ? fallback.slice(-4) : undefined);
  return {
    provider: PROVIDER,
    configured,
    enabled,
    storage: row?.encrypted_value_base64 ? "admin-managed" : fallback ? "cloudflare-secret" : "not-configured",
    maskedKey: lastFour ? `****${lastFour}` : undefined,
    validatedAtUtc: row?.validated_at_utc ?? undefined,
    updatedAtUtc: row?.updated_at_utc ?? undefined,
  };
}

export async function resolveFantasyProsApiKey(env: Env): Promise<string | undefined> {
  const row = await credentialRow(env.CORE_DB);
  if (!row) {
    return String(env.FANTASYPROS_SYNC_ENABLED) === "true" ? env.FANTASYPROS_API_KEY?.trim() : undefined;
  }
  if (row.enabled !== 1) return undefined;
  if (!row.encrypted_value_base64 || !row.iv_base64) return env.FANTASYPROS_API_KEY?.trim();
  return decryptCredential(row.encrypted_value_base64, row.iv_base64, env.PROVIDER_CREDENTIAL_ENCRYPTION_KEY);
}

export async function saveFantasyProsCredential(
  env: Env,
  userId: string,
  apiKey: string | undefined,
  enabled: boolean,
  validatedAtUtc?: string,
): Promise<ProviderCredentialStatus> {
  const current = await credentialRow(env.CORE_DB);
  const value = apiKey?.trim();
  if (!value && !current?.encrypted_value_base64 && !env.FANTASYPROS_API_KEY) {
    throw new ApiException(400, "provider_key_required", "Enter a FantasyPros API key.");
  }
  let encrypted = current?.encrypted_value_base64 ?? null;
  let iv = current?.iv_base64 ?? null;
  let lastFour = current?.last_four ?? env.FANTASYPROS_API_KEY?.slice(-4) ?? null;
  if (value) {
    const result = await encryptCredential(value, env.PROVIDER_CREDENTIAL_ENCRYPTION_KEY);
    encrypted = result.encryptedValueBase64;
    iv = result.ivBase64;
    lastFour = value.slice(-4);
  }
  const now = new Date().toISOString();
  await env.CORE_DB.prepare(
    `insert into provider_credentials
      (provider,encrypted_value_base64,iv_base64,key_version,enabled,last_four,validated_at_utc,
       created_by_user_id,updated_by_user_id,created_at_utc,updated_at_utc)
     values(?1,?2,?3,?4,?5,?6,?7,?8,?8,?9,?9)
     on conflict(provider) do update set
       encrypted_value_base64=excluded.encrypted_value_base64,iv_base64=excluded.iv_base64,
       key_version=excluded.key_version,enabled=excluded.enabled,last_four=excluded.last_four,
       validated_at_utc=coalesce(excluded.validated_at_utc,provider_credentials.validated_at_utc),
       updated_by_user_id=excluded.updated_by_user_id,updated_at_utc=excluded.updated_at_utc`,
  ).bind(PROVIDER, encrypted, iv, KEY_VERSION, enabled ? 1 : 0, lastFour, validatedAtUtc ?? null, userId, now).run();
  return fantasyProsCredentialStatus(env);
}

export async function encryptCredential(
  value: string,
  masterSecret: string | undefined,
  suppliedIv?: Uint8Array,
): Promise<{ encryptedValueBase64: string; ivBase64: string }> {
  const key = await encryptionKey(masterSecret);
  const iv = suppliedIv ?? crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: arrayBuffer(iv) },
    key,
    arrayBuffer(new TextEncoder().encode(value)),
  );
  return { encryptedValueBase64: toBase64(new Uint8Array(encrypted)), ivBase64: toBase64(iv) };
}

export async function decryptCredential(encryptedBase64: string, ivBase64: string, masterSecret: string | undefined): Promise<string> {
  try {
    const key = await encryptionKey(masterSecret);
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: arrayBuffer(fromBase64(ivBase64)) },
      key,
      arrayBuffer(fromBase64(encryptedBase64)),
    );
    return new TextDecoder().decode(decrypted);
  } catch {
    throw new Error("The provider credential could not be decrypted. Replace it in myFFL Admin.");
  }
}

async function credentialRow(db: D1Database): Promise<CredentialRow | null> {
  return db.prepare(
    `select encrypted_value_base64,iv_base64,enabled,last_four,validated_at_utc,created_at_utc,updated_at_utc
     from provider_credentials where provider=?1`,
  ).bind(PROVIDER).first<CredentialRow>();
}

async function encryptionKey(masterSecret: string | undefined): Promise<CryptoKey> {
  if (!masterSecret || new TextEncoder().encode(masterSecret).byteLength < 32) {
    throw new Error("The provider credential encryption secret is missing or too short.");
  }
  const material = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`myffl:provider-credentials:v${KEY_VERSION}:${masterSecret}`),
  );
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function toBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function arrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}
