import { getRuntimeConfigValue } from "../runtime-config.ts";
import { resolveSecretBinding } from "../runtime-bindings.ts";
import type { RuntimeEnv } from "../runtime.ts";
import { getPublicPosthogConfig } from "./posthog.ts";
import { providerFetch } from "./google.ts";

export const getPublicAnalyticsConfig = async (env: RuntimeEnv) => {
  const provider = await getRuntimeConfigValue(env, "ACTIVE_ANALYTICS_PROVIDER") || "posthog";
  if ((provider === "ga4" || provider === "ga4_measurement_protocol")) {
    const measurementId = await getRuntimeConfigValue(env, "GA4_MEASUREMENT_ID");
    return { provider, enabled: /^G-[A-Z0-9]+$/.test(measurementId), measurementId, projectApiKey: "", host: "" };
  }
  if (provider !== "posthog") return { provider, enabled: false, measurementId: "", projectApiKey: "", host: "" };
  const posthog = await getPublicPosthogConfig(env);
  return { ...posthog, enabled: posthog.enabled, provider, measurementId: "" };
};

export const recordAnalyticsPurchase = async (env: RuntimeEnv, input: {
  id: string; clientId: string; sessionId?: string; consent: boolean; provider: string; amountCents: number; currency: string;
}) => {
  if (!env.DB || !input.consent || !/^[a-zA-Z0-9.-]{1,100}$/.test(input.clientId)) return;
  const config = await getPublicAnalyticsConfig(env);
  if (!config.enabled || config.provider !== input.provider) return;
  const id = `purchase:${input.id}`;
  const claim = await env.DB.prepare("INSERT OR IGNORE INTO ap_analytics_deliveries (id, provider, status, created_at) VALUES (?, ?, 'sending', ?)").bind(id, config.provider, new Date().toISOString()).run();
  if (claim.meta?.changes !== 1) return;
  try {
    let response: Response;
    if (config.provider === "ga4" || config.provider === "ga4_measurement_protocol") {
      const secret = await resolveSecretBinding(env, "GA4_API_SECRET");
      if (!secret) throw new Error("GA4 secret missing");
      const url = new URL("https://www.google-analytics.com/mp/collect");
      url.searchParams.set("measurement_id", config.measurementId);
      url.searchParams.set("api_secret", secret);
      response = await providerFetch(env)(url, {
        method: "POST", signal: AbortSignal.timeout(10_000), headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_id: input.clientId, events: [{ name: "purchase", params: {
          ...(input.sessionId && /^\d{1,16}$/.test(input.sessionId) ? { session_id: Number(input.sessionId) } : {}),
          ...(env.ASTROPAGES_PUBLIC_SITE_URL ? { page_location: String(env.ASTROPAGES_PUBLIC_SITE_URL) + "/" } : {}),
          transaction_id: input.id, value: input.amountCents / 100, currency: input.currency, engagement_time_msec: 1,
        } }] }),
      });
    } else {
      response = await providerFetch(env)(`${config.host}/capture/`, {
        method: "POST", signal: AbortSignal.timeout(10_000), headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: config.projectApiKey, event: "purchase", properties: {
          distinct_id: input.clientId, $insert_id: id, value: input.amountCents / 100, currency: input.currency,
        } }),
      });
    }
    await env.DB.prepare("UPDATE ap_analytics_deliveries SET status = ? WHERE id = ?").bind(response.ok ? "sent" : "failed", id).run();
  } catch {
    await env.DB.prepare("UPDATE ap_analytics_deliveries SET status = 'unknown' WHERE id = ?").bind(id).run();
  }
};
