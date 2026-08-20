import { AP_TABLES as tables } from "./db/tables.ts";
import { createId, nowIso, safeString, type RuntimeEnv } from "./runtime.ts";
import { resolveRuntimeBinding } from "./runtime-bindings.ts";

type Row = Record<string, unknown>;

export type GeneratedSiteSsoRole = "owner" | "admin" | "editor" | "viewer";

export interface GeneratedSiteSsoPayload {
  iss: "astropages-control-plane";
  aud: "astropages-generated-site";
  sub: string;
  email?: string;
  name?: string | null;
  projectId: string;
  organizationId?: string;
  environment: "preview" | "production";
  role: GeneratedSiteSsoRole;
  targetPath: string;
  jti: string;
  iat: number;
  exp: number;
}

export interface GeneratedSiteRuntimeConfigSyncPayload {
  iss: "astropages-control-plane";
  aud: "astropages-generated-site-runtime-config-sync";
  sub?: string;
  projectId: string;
  environment: "preview" | "production";
  jti?: string;
  iat: number;
  exp: number;
}

const encoder = new TextEncoder();
const sessionCookieName = "ap_admin_session";
const csrfCookieName = "ap_admin_csrf";
const adminSessionTtlMs = 6 * 60 * 60 * 1000;
const roles = new Set(["owner", "admin", "editor", "viewer"]);
const ssoExchangeStepTimeoutMs = 3_000;

type ServerTimingMetric = {
  name: string;
  dur: number;
};

const withTimeout = async <T>(
  label: string,
  work: Promise<T>,
  timeoutMs = ssoExchangeStepTimeoutMs,
): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`${label} timed out`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

const timed = async <T>(
  timings: ServerTimingMetric[],
  name: string,
  work: () => Promise<T>,
): Promise<T> => {
  const startedAt = Date.now();
  try {
    return await withTimeout(name, work());
  } finally {
    timings.push({
      name,
      dur: Math.max(0, Date.now() - startedAt),
    });
  }
};

const appendServerTiming = (response: Response, timings: ServerTimingMetric[]) => {
  if (timings.length === 0) return response;
  const value = timings
    .map((metric) => `${metric.name};dur=${metric.dur}`)
    .join(", ");
  response.headers.set(
    "Server-Timing",
    value,
  );
  response.headers.set("x-astropages-sso-timing", value);
  return response;
};

const toHex = (buffer: ArrayBuffer) =>
  [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const sha256Hex = async (value: string) =>
  toHex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));

const randomHex = (bytes = 32) => {
  const array = new Uint8Array(bytes);
  crypto.getRandomValues(array);
  return [...array].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const base64UrlDecode = (value: string) => {
  const padded = value.padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
  const normalized = padded.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

const parseBase64UrlJson = <T>(value: string): T =>
  JSON.parse(new TextDecoder().decode(base64UrlDecode(value))) as T;

const firstRow = async <T extends Row = Row>(
  env: RuntimeEnv,
  sql: string,
  values: unknown[] = [],
) => {
  if (!env.DB) return null;
  const statement = env.DB.prepare(sql).bind(...values);
  return statement.first ? await statement.first() as T | null : null;
};

const run = async (env: RuntimeEnv, sql: string, values: unknown[] = []) => {
  if (!env.DB) return undefined;
  const statement = env.DB.prepare(sql).bind(...values);
  return statement.run ? await statement.run() : undefined;
};

const cookieValue = (request: Request, name: string) => {
  const cookie = request.headers.get("cookie") ?? "";
  return cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1) ?? "";
};

const cookieSuffix = (request: Request) => {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `Path=/; HttpOnly; SameSite=Lax${secure}`;
};

const csrfCookieSuffix = (request: Request) => {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `Path=/; SameSite=Lax${secure}`;
};

const formatCookieDate = (date: Date) => date.toUTCString();

const htmlError = (message: string, status = 401, timings: ServerTimingMetric[] = []) =>
  appendServerTiming(
    new Response(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>AstroPages editor sign-in</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f8f5ef;color:#26130d;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.panel{max-width:520px;margin:24px;padding:28px;border:1px solid #e4d5c2;border-radius:12px;background:#fffaf4;box-shadow:0 18px 48px rgba(38,19,13,.12)}h1{margin:0 0 10px;font-size:22px;line-height:1.2}p{margin:0;color:#6f6259;line-height:1.55}.action{margin-top:18px;font-weight:700;color:#b73224}</style></head><body><main class="panel"><h1>Could not open Content Studio</h1><p>${message}</p><p class="action">Close this tab and use Edit content again from AstroPages.</p></main></body></html>`,
      {
        status,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        },
      },
    ),
    timings,
  );

const verifyControlPlaneJwt = async <T>(
  token: string,
  publicJwkBinding: unknown,
  expectedAudience: string,
): Promise<T> => {
  const publicJwkJson = await resolveRuntimeBinding(publicJwkBinding);
  if (!publicJwkJson) {
    throw new Error("generated-site control-plane public JWK is not configured");
  }

  const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    throw new Error("generated-site SSO token is malformed");
  }

  const header = parseBase64UrlJson<{ alg?: string; typ?: string }>(encodedHeader);
  if (header.alg !== "ES256") {
    throw new Error("generated-site SSO token algorithm is unsupported");
  }

  const publicJwk = JSON.parse(publicJwkJson) as JsonWebKey;
  const key = await crypto.subtle.importKey(
    "jwk",
    publicJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const verified = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    base64UrlDecode(encodedSignature),
    encoder.encode(`${encodedHeader}.${encodedPayload}`),
  );

  if (!verified) {
    throw new Error("generated-site SSO token signature is invalid");
  }

  const payload = parseBase64UrlJson<T>(encodedPayload);
  const payloadRecord = payload as Record<string, unknown>;
  const now = Math.floor(Date.now() / 1000);
  if (
    payloadRecord.iss !== "astropages-control-plane" ||
    payloadRecord.aud !== expectedAudience ||
    typeof payloadRecord.projectId !== "string" ||
    typeof payloadRecord.exp !== "number" ||
    payloadRecord.exp <= now
  ) {
    throw new Error("generated-site control-plane token payload is invalid");
  }

  return payload;
};

export const verifyGeneratedSiteSsoJwt = async (
  token: string,
  publicJwkBinding: unknown,
): Promise<GeneratedSiteSsoPayload> => {
  const payload = await verifyControlPlaneJwt<GeneratedSiteSsoPayload>(
    token,
    publicJwkBinding,
    "astropages-generated-site",
  );

  if (
    !payload.sub ||
    !payload.jti ||
    !roles.has(payload.role) ||
    !["preview", "production"].includes(payload.environment)
  ) {
    throw new Error("generated-site SSO token payload is invalid");
  }

  return payload;
};

export const verifyRuntimeConfigSyncJwt = async (
  token: string,
  publicJwkBinding: unknown,
): Promise<GeneratedSiteRuntimeConfigSyncPayload> => {
  const payload = await verifyControlPlaneJwt<GeneratedSiteRuntimeConfigSyncPayload>(
    token,
    publicJwkBinding,
    "astropages-generated-site-runtime-config-sync",
  );

  if (!["preview", "production"].includes(payload.environment)) {
    throw new Error("generated-site runtime config sync token payload is invalid");
  }

  return payload;
};

const sameSitePath = (value: string) => {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  const parsed = new URL(value, "https://generated-site.local");
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
};

export const createAdminSsoExchangeSession = async ({
  env,
  request,
}: {
  env: RuntimeEnv;
  request: Request;
}): Promise<{ ok: true; response: Response } | { ok: false; response: Response }> => {
  const timings: ServerTimingMetric[] = [];
  const url = new URL(request.url);
  const token = url.searchParams.get("token") ?? "";
  const next = sameSitePath(url.searchParams.get("next") ?? "/_emdash/admin");

  let payload: GeneratedSiteSsoPayload;
  try {
    payload = await timed(timings, "sso_verify_jwt", () =>
      verifyGeneratedSiteSsoJwt(token, env.ASTROPAGES_SSO_PUBLIC_JWK)
    );
  } catch {
    return {
      ok: false,
      response: htmlError("The editor sign-in link is invalid or expired.", 401, timings),
    };
  }

  const expectedProjectId = safeString(env.ASTROPAGES_PROJECT_ID);
  const expectedEnvironment = safeString(env.ASTROPAGES_SITE_ENVIRONMENT);
  if (
    (expectedProjectId && payload.projectId !== expectedProjectId) ||
    (expectedEnvironment && payload.environment !== expectedEnvironment) ||
    payload.targetPath !== next
  ) {
    return {
      ok: false,
      response: htmlError("This editor sign-in link is for a different project or destination.", 403, timings),
    };
  }

  const existing = await timed(timings, "sso_exchange_lookup", () =>
    firstRow(
      env,
      `SELECT jti FROM ${tables.adminSsoExchanges} WHERE jti = ?`,
      [payload.jti],
    )
  );
  if (existing) {
    return {
      ok: false,
      response: htmlError("This editor sign-in link was already used.", 409, timings),
    };
  }

  const now = nowIso();
  try {
    await timed(timings, "sso_exchange_insert", () =>
      run(
        env,
        `INSERT INTO ${tables.adminSsoExchanges} (
          id, jti, subject, project_id, environment, role, target_path,
          expires_at, consumed_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          createId("asx"),
          payload.jti,
          payload.sub,
          payload.projectId,
          payload.environment,
          payload.role,
          payload.targetPath,
          new Date(payload.exp * 1000).toISOString(),
          now,
          now,
        ],
      )
    );
  } catch {
    return {
      ok: false,
      response: htmlError("The editor sign-in service is temporarily unavailable.", 503, timings),
    };
  }

  const sessionToken = randomHex(32);
  const csrfToken = randomHex(32);
  const expiresAt = new Date(Date.now() + adminSessionTtlMs).toISOString();
  try {
    await timed(timings, "sso_session_insert", async () =>
      run(
        env,
        `INSERT INTO ${tables.adminSessions} (
          id, subject, role, email, session_token_hash, csrf_token_hash,
          expires_at, last_seen_at, revoked_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        [
          createId("asess"),
          payload.sub,
          payload.role,
          payload.email ?? "",
          await sha256Hex(sessionToken),
          await sha256Hex(csrfToken),
          expiresAt,
          now,
          now,
        ],
      )
    );
  } catch {
    return {
      ok: false,
      response: htmlError("The editor session could not be created. Retry from AstroPages.", 503, timings),
    };
  }

  const response = appendServerTiming(
    new Response(null, {
      status: 302,
      headers: {
        location: new URL(next, request.url).toString(),
      },
    }),
    timings,
  );
  response.headers.append(
    "set-cookie",
    `${sessionCookieName}=${sessionToken}; Expires=${formatCookieDate(new Date(expiresAt))}; ${cookieSuffix(request)}`,
  );
  response.headers.append(
    "set-cookie",
    `${csrfCookieName}=${csrfToken}; Expires=${formatCookieDate(new Date(expiresAt))}; ${csrfCookieSuffix(request)}`,
  );
  return { ok: true, response };
};

export const getAdminSession = async (env: RuntimeEnv, request: Request) => {
  const token = cookieValue(request, sessionCookieName);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await firstRow(
    env,
    `SELECT subject, role, csrf_token_hash, expires_at
       FROM ${tables.adminSessions}
      WHERE session_token_hash = ? AND revoked_at IS NULL`,
    [tokenHash],
  );
  if (!row || new Date(String(row.expires_at)).getTime() <= Date.now()) return null;

  await run(env, `UPDATE ${tables.adminSessions} SET last_seen_at = ? WHERE session_token_hash = ?`, [
    nowIso(),
    tokenHash,
  ]);

  return {
    subject: String(row.subject),
    role: String(row.role) as GeneratedSiteSsoRole,
    csrfTokenHash: String(row.csrf_token_hash ?? ""),
    csrfToken: cookieValue(request, csrfCookieName),
  };
};

export const adminCsrfMatches = async (env: RuntimeEnv, request: Request) => {
  const session = await getAdminSession(env, request);
  if (!session) return false;
  const csrf = request.headers.get("x-astropages-admin-csrf") ?? cookieValue(request, csrfCookieName);
  return Boolean(csrf) && (await sha256Hex(csrf)) === session.csrfTokenHash;
};

export const clearAdminSessionCookies = (request: Request) => [
  `${sessionCookieName}=; Max-Age=0; ${cookieSuffix(request)}`,
  `${csrfCookieName}=; Max-Age=0; ${csrfCookieSuffix(request)}`,
];

export const revokeAdminSession = async (env: RuntimeEnv, request: Request) => {
  const token = cookieValue(request, sessionCookieName);
  if (token) {
    await run(env, `UPDATE ${tables.adminSessions} SET revoked_at = ? WHERE session_token_hash = ?`, [
      nowIso(),
      await sha256Hex(token),
    ]);
  }
  return clearAdminSessionCookies(request);
};
