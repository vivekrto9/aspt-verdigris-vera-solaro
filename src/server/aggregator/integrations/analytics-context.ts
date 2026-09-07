import type { RuntimeEnv } from "../runtime.ts";
import { getPublicAnalyticsConfig } from "./analytics.ts";
export const storeAnalyticsContext = async (env: RuntimeEnv, request: Request, kind: "booking" | "product_order", id: string) => {
  const table = kind === "booking" ? "ap_consultation_bookings" : "ap_product_orders";
  let locale = "en";
  try { if (new URL(request.headers.get("referer") || request.url).pathname.startsWith("/hi/")) locale = "hi"; } catch { /* Default site locale. */ }
  await env.DB?.prepare("UPDATE " + table + " SET communication_locale = ? WHERE id = ? AND payment_state = 'pending'").bind(locale, id).run();
  const cookies = Object.fromEntries((request.headers.get("cookie") || "").split(";").map((part) => part.trim().split("=", 2)));
  if (cookies.ap_analytics_consent !== "granted") return;
  const clientId = cookies.ap_analytics_client_id || "";
  if (!/^[a-zA-Z0-9.-]{1,100}$/.test(clientId)) return;
  const config = await getPublicAnalyticsConfig(env);
  if (!config.enabled || cookies.ap_analytics_provider !== config.provider) return;
  const sessionId = /^\d{1,16}$/.test(cookies.ap_analytics_session_id || "") ? cookies.ap_analytics_session_id : null;
  await env.DB?.prepare("UPDATE " + table + " SET analytics_client_id = ?, analytics_provider = ?, analytics_session_id = ? WHERE id = ? AND payment_state = 'pending' AND analytics_client_id IS NULL").bind(clientId, config.provider, sessionId, id).run();
};
