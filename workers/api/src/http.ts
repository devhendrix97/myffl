import type { ApiEnvelope, ApiError } from "@myffl/api-contracts";

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

export class ApiException extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiException";
  }
}

export function json<T>(
  data: T,
  request: Request,
  env: Env,
  correlationId: string,
  init?: ResponseInit,
): Response {
  const body: ApiEnvelope<T> = { ok: true, correlationId, data };
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      ...jsonHeaders,
      ...corsHeaders(request, env),
      ...init?.headers,
    },
  });
}

export function errorJson(
  error: ApiError,
  request: Request,
  env: Env,
  correlationId: string,
  status = 400,
): Response {
  const body: ApiEnvelope<never> = { ok: false, correlationId, error };
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...jsonHeaders, ...corsHeaders(request, env) },
  });
}

export function corsHeaders(request: Request, env: Env): HeadersInit {
  const origin = request.headers.get("origin");
  if (!origin) return {};
  if (!isAllowedOrigin(origin, env)) return { vary: "Origin" };
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization,x-correlation-id",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

export function isAllowedOrigin(origin: string, env: Env): boolean {
  const allowed = new Set([
    env.APPLICATION_BASE_URL,
    "http://localhost:5173",
    "http://127.0.0.1:5173",
  ]);
  return allowed.has(origin);
}

export async function readJson<T>(request: Request): Promise<T> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new ApiException(415, "unsupported_media_type", "Expected an application/json request body.");
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 32768) {
    throw new ApiException(413, "request_too_large", "The request body is too large.");
  }

  try {
    return (await request.json()) as T;
  } catch {
    throw new ApiException(400, "invalid_json", "The request body is not valid JSON.");
  }
}
