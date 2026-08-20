import { errorResponse } from "./responses.ts";

export type JsonObject = Record<string, unknown>;
export type D1DatabaseLike = {
  prepare(query: string): {
    bind(...values: unknown[]): unknown;
    first<T = unknown>(): Promise<T | null>;
    run(): Promise<unknown>;
    all<T = unknown>(): Promise<{ results?: T[] }>;
  };
};

const recentJsonBodies = new Map<
  string,
  { expiresAt: number; body: JsonObject }
>();
const recentJsonBodyTtlMs = 2000;

const getBodyCacheKey = (request: Request) => {
  const url = new URL(request.url);

  return [
    request.method,
    url.pathname,
    request.headers.get("content-length") ?? "",
  ].join(" ");
};

export const readJsonBody = async (
  request: Request,
): Promise<{ ok: true; body: JsonObject } | { ok: false; response: Response }> => {
  const cacheKey = getBodyCacheKey(request);
  const replayRecentBody = () => {
    const cached = recentJsonBodies.get(cacheKey);
    if (!cached || cached.expiresAt < Date.now()) {
      recentJsonBodies.delete(cacheKey);
      return undefined;
    }

    return cached.body;
  };
  const rememberBody = (body: JsonObject) => {
    if (Object.keys(body).length === 0) {
      return;
    }

    recentJsonBodies.set(cacheKey, {
      body,
      expiresAt: Date.now() + recentJsonBodyTtlMs,
    });
  };

  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      const cachedBody = replayRecentBody();
      if (cachedBody) {
        return { ok: true, body: cachedBody };
      }

      return {
        ok: false,
        response: errorResponse("generated-site", "Request body must be a JSON object."),
      };
    }

    const parsedBody = body as JsonObject;
    rememberBody(parsedBody);

    return { ok: true, body: parsedBody };
  } catch {
    const cachedBody = replayRecentBody();
    if (cachedBody) {
      return { ok: true, body: cachedBody };
    }

    return {
      ok: false,
      response: errorResponse("generated-site", "Request body must be valid JSON."),
    };
  }
};

export const requirePost = (request: Request) => {
  if (request.method === "POST") {
    return undefined;
  }

  return errorResponse("generated-site", "Method not allowed.", 405);
};

export type GeneratedSiteRuntimeEnv = Record<string, unknown> & {
  DB?: D1DatabaseLike;
};

export const getRuntimeEnv = async (
  context: unknown,
): Promise<GeneratedSiteRuntimeEnv> => {
  const maybeContext = context as {
    locals?: {
      runtime?: {
        env?: GeneratedSiteRuntimeEnv;
      };
    };
  };

  try {
    if (maybeContext.locals?.runtime?.env) {
      return maybeContext.locals.runtime.env;
    }
  } catch {
    // Astro v6 Cloudflare runtime exposes env through cloudflare:workers.
  }

  try {
    const cloudflareWorkers = await import("cloudflare:workers");
    return cloudflareWorkers.env as GeneratedSiteRuntimeEnv;
  } catch {
    return {};
  }
};
