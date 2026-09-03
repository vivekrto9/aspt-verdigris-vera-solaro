import { getPublicAnalyticsConfig, recordAnalyticsPurchase } from "../aggregator/integrations/analytics.ts";
import type { VeraEnv, VeraRow } from "./types.ts";
import { safeString } from "./db.ts";

export const veraAnalyticsContext = async (env: VeraEnv, request: Request) => {
  const empty = { clientId: null, provider: null, sessionId: null };
  try {
    const cookies = Object.fromEntries((request.headers.get("cookie") || "").split(";").map((part) => part.trim().split("=", 2)));
    if (cookies.ap_analytics_consent !== "granted" || !/^[a-zA-Z0-9.-]{1,100}$/.test(cookies.ap_analytics_client_id || "")) return empty;
    const config = await getPublicAnalyticsConfig(env);
    if (!config.enabled || config.provider !== cookies.ap_analytics_provider) return empty;
    return { clientId: cookies.ap_analytics_client_id, provider: config.provider, sessionId: /^\d{1,16}$/.test(cookies.ap_analytics_session_id || "") ? cookies.ap_analytics_session_id : null };
  } catch { return empty; }
};

// Each verified payment attempt is a separate transaction (deposit / balance),
// not a repeat of the full booking price. No intake or contact data is sent.
export const recordVeraPaymentAnalytics = async (env: VeraEnv, booking: VeraRow, attempt: VeraRow) => {
  try {
    await recordAnalyticsPurchase(env, {
      id: safeString(attempt.id), amountCents: Number(attempt.amount_cents), currency: safeString(attempt.currency).toUpperCase(),
      clientId: safeString(booking.analytics_client_id), provider: safeString(booking.analytics_provider), sessionId: safeString(booking.analytics_session_id), consent: Boolean(booking.analytics_client_id),
    });
  } catch { /* Analytics must never prevent payment confirmation or scheduling. */ }
};
