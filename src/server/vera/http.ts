import type { APIContext } from "astro";

import { getRuntimeEnv } from "../generated-site/request.ts";
import { errorResponse } from "../generated-site/responses.ts";
import { first, sha256Hex } from "./db.ts";
import type { VeraEnv } from "./types.ts";

export const getVeraEnv = async (context: APIContext) =>
  await getRuntimeEnv(context) as VeraEnv;

export const requireMethod = (request: Request, method: "GET" | "POST" | "PUT") =>
  request.method === method
    ? null
    : errorResponse("vera.request", `${method} is required.`, 405);

export const readBoundedText = async (request: Request, maxBytes: number) => {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return { ok: false as const, message: "Request body is too large.", status: 413 };
  }
  if (!request.body) return { ok: true as const, text: "" };
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return { ok: false as const, message: "Request body is too large.", status: 413 };
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return { ok: true as const, text };
  } finally {
    reader.releaseLock();
  }
};

export const readJsonObject = async (request: Request, maxBytes = 32_768) => {
  const type = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (type !== "application/json") {
    return { ok: false as const, message: "An application/json body is required.", status: 415 };
  }
  const body = await readBoundedText(request, maxBytes);
  if (!body.ok) return body;
  try {
    const value = JSON.parse(body.text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return { ok: true as const, body: value as Record<string, unknown> };
  } catch {
    return { ok: false as const, message: "Request body must be a JSON object.", status: 400 };
  }
};

export const requestToken = (request: Request, body?: Record<string, unknown>) => {
  const authorization = request.headers.get("authorization") ?? "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const bodyToken = typeof body?.manageToken === "string" ? body.manageToken.trim() : "";
  return bearer || bodyToken;
};

export const enforceVeraRateLimit = async ({
  env,
  request,
  feature,
  scope,
  limit,
  windowSeconds,
  identity = "request-ip",
}: {
  env: VeraEnv;
  request: Request;
  feature: string;
  scope: string;
  limit: number;
  windowSeconds: number;
  identity?: "request-ip" | "global";
}) => {
  const address = identity === "global"
    ? "all-clients"
    : (
      request.headers.get("cf-connecting-ip")
      || request.headers.get("x-real-ip")
      || "unavailable"
    ).trim().toLowerCase();
  const identityHash = await sha256Hex(`${scope}\u0000${address}`);
  const windowMs = windowSeconds * 1_000;
  const windowStartedAt = new Date(Math.floor(Date.now() / windowMs) * windowMs).toISOString();
  try {
    const row = await first<{ request_count: number }>(env, `
      INSERT INTO ap_vera_rate_limits (
        scope, identity_hash, window_started_at, request_count, updated_at
      ) VALUES (?, ?, ?, 1, datetime('now'))
      ON CONFLICT(scope, identity_hash, window_started_at) DO UPDATE SET
        request_count = request_count + 1,
        updated_at = datetime('now')
      RETURNING request_count
    `, [scope, identityHash, windowStartedAt]);
    if (Number(row?.request_count ?? limit + 1) <= limit) return null;
    const response = errorResponse(feature, "Too many requests. Please try again shortly.", 429);
    response.headers.set("retry-after", String(windowSeconds));
    response.headers.set("cache-control", "private, no-store");
    return response;
  } catch {
    const response = errorResponse(feature, "This request cannot be accepted right now.", 503);
    response.headers.set("cache-control", "private, no-store");
    return response;
  }
};
