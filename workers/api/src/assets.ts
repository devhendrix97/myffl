import { ApiException } from "./http";

const PROVIDER_ASSET_PREFIX = "provider-assets/";

export function providerAssetUrl(env: Env, key: string | null | undefined): string | undefined {
  if (!key) return undefined;
  const base = env.API_BASE_URL.replace(/\/+$/, "");
  return `${base}/api/assets/${key.split("/").map(encodeURIComponent).join("/")}`;
}

export function espnAthleteHeadshotUrl(env: Env, playerId: string | null | undefined, storedKey?: string | null): string | undefined {
  if (storedKey) return providerAssetUrl(env, storedKey);
  const match = playerId?.match(/^espn-player-(\d+)$/);
  return match ? providerAssetUrl(env, `provider-assets/athletes/${match[1]}/headshot`) : undefined;
}

export async function handleAssetRequest(request: Request, url: URL, env: Env): Promise<Response | undefined> {
  const match = url.pathname.match(/^\/api\/assets\/(.+)$/);
  if (!match) return undefined;
  if (request.method !== "GET" && request.method !== "HEAD") throw new ApiException(405, "method_not_allowed", "This asset endpoint supports GET and HEAD.");
  const key = decodeURIComponent(match[1]);
  if (!key.startsWith(PROVIDER_ASSET_PREFIX)) throw new ApiException(404, "asset_not_found", "Asset not found.");
  const object = await env.ASSETS_BUCKET.get(key);
  if (!object) {
    const fallback = await cacheEspnAthleteHeadshot(env, key);
    if (!fallback) throw new ApiException(404, "asset_not_found", "Asset not found.");
    return imageResponse(request, fallback);
  }
  return imageResponse(request, object);
}

function imageResponse(request: Request, object: R2ObjectBody): Response {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  if (!headers.has("cache-control")) headers.set("cache-control", "public, max-age=86400");
  return new Response(request.method === "HEAD" ? null : object.body, { headers });
}

async function cacheEspnAthleteHeadshot(env: Env, key: string): Promise<R2ObjectBody | null> {
  const match = key.match(/^provider-assets\/athletes\/(\d+)\/headshot$/);
  if (!match) return null;
  const sourceUrl = `https://a.espncdn.com/i/headshots/nfl/players/full/${match[1]}.png`;
  try {
    const response = await fetch(sourceUrl, {
      headers: { accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8,*/*;q=0.5" },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok || !response.body) return null;
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (!contentType?.startsWith("image/")) return null;
    await env.ASSETS_BUCKET.put(key, response.body, {
      httpMetadata: { contentType, cacheControl: "public, max-age=31536000, immutable" },
      customMetadata: { provider: "espn", sourceUrl, fetchedAtUtc: new Date().toISOString() },
    });
    return env.ASSETS_BUCKET.get(key);
  } catch {
    return null;
  }
}
