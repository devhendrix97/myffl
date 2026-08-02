import type { ApiEnvelope, ApiError } from "@myffl/api-contracts";

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

export function json<T>(
  data: T,
  correlationId: string,
  init?: ResponseInit,
): Response {
  const body: ApiEnvelope<T> = { ok: true, correlationId, data };
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { ...jsonHeaders, ...corsHeaders(), ...init?.headers },
  });
}

export function errorJson(
  error: ApiError,
  correlationId: string,
  status = 400,
): Response {
  const body: ApiEnvelope<never> = { ok: false, correlationId, error };
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...jsonHeaders, ...corsHeaders() },
  });
}

export function corsHeaders(): HeadersInit {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization,x-correlation-id",
  };
}

export async function readJson<T>(request: Request): Promise<T> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Error("Expected application/json request body.");
  }
  return (await request.json()) as T;
}

