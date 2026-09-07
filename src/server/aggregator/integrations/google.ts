import { resolveSecretBinding } from "../runtime-bindings.ts";
import type { RuntimeEnv } from "../runtime.ts";

export const providerFetch = (env: RuntimeEnv): typeof fetch =>
  typeof env.fetch === "function" ? env.fetch as typeof fetch : globalThis.fetch;

/** Tokens are request-local; never share credentials across Worker requests. */
export const googleAccessToken = async (env: RuntimeEnv, provider: "gmail" | "google_calendar") => {
  const prefix = provider === "gmail" ? "GMAIL_OAUTH" : "GOOGLE_CALENDAR";
  const [clientId, clientSecret, refreshToken] = await Promise.all(
    ["CLIENT_ID", "CLIENT_SECRET", "REFRESH_TOKEN"].map((key) => resolveSecretBinding(env, `${prefix}_${key}`)),
  );
  if (!clientId || !clientSecret || !refreshToken) throw new Error(`${provider}: OAuth setup is incomplete. Reconnect and sync credentials.`);
  const response = await providerFetch(env)("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json() as { access_token?: string; error?: string };
  if (!response.ok || !body.access_token) throw new Error(
    body.error === "invalid_grant" ? `${provider}: permission expired. Reconnect the integration.` : `${provider}: token refresh failed (HTTP ${response.status}).`,
  );
  return body.access_token;
};

export const googleCalendarRequest = async (env: RuntimeEnv, path: string, init: RequestInit = {}) => {
  const token = await googleAccessToken(env, "google_calendar");
  return providerFetch(env)(`https://www.googleapis.com/calendar/v3${path}`, {
    ...init, headers: { ...init.headers, authorization: `Bearer ${token}`, "content-type": "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
};
