type AnalyticsPosthog = {
  capture: (name: string, properties?: Record<string, unknown>) => void;
  opt_out_capturing: () => void;
};
export {};
type Config = { enabled?: boolean; provider?: string; measurementId?: string; projectApiKey?: string; host?: string };
declare global {
  interface Window {
    astroPagesTrack?: (name: string, payload?: Record<string, unknown>) => void;
    astroPagesAnalytics?: { withdraw: () => void };
    posthog?: AnalyticsPosthog;
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}
let config: Config = {};
try { config = JSON.parse(document.querySelector("script[data-analytics-config]")?.textContent || "{}") as Config; } catch { /* Fail closed. */ }
const banner = document.querySelector<HTMLElement>("[data-analytics-consent-banner]");
const consentKey = "astropages:analytics-consent";
const consent = () => { try { return localStorage.getItem(consentKey) === "granted"; } catch { return false; } };
const cookie = (key: string, value: string) => {
  document.cookie = `${key}=${encodeURIComponent(value)}; Path=/; SameSite=Lax; Max-Age=31536000${location.protocol === "https:" ? "; Secure" : ""}`;
};
let stopped = false;
let started: Promise<void> | undefined;
const privatePage = () => /\/(?:login|signup|password|confirmation|account|settings|booking\/manage)(?:\/|$)/.test(location.pathname);
const safePath = () => privatePage() ? "/" : location.pathname;
const initialize = () => {
  if (!config.enabled || !consent() || stopped) return Promise.resolve();
  if (started) return started;
  started = (async () => {
    const clientId = localStorage.getItem("astropages:analytics-client-id") || crypto.randomUUID();
    localStorage.setItem("astropages:analytics-client-id", clientId);
    cookie("ap_analytics_client_id", clientId);
    cookie("ap_analytics_provider", config.provider || "");
    if ((config.provider === "ga4" || config.provider === "ga4_measurement_protocol") && config.measurementId) {
      window.dataLayer = [];
      window.gtag = function (..._args: unknown[]) { window.dataLayer?.push(arguments); };
      window.gtag("consent", "default", { analytics_storage: "granted", ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" });
      window.gtag("set", { page_location: `${location.origin}${safePath()}`, page_title: "", page_referrer: "" });
      window.gtag("js", new Date());
      window.gtag("config", config.measurementId, { send_page_view: false, client_id: clientId, allow_google_signals: false });
      const script = document.createElement("script");
      script.async = true;
      script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(config.measurementId)}`;
      document.head.append(script);
      window.gtag("get", config.measurementId, "session_id", (sessionId: unknown) => {
        if (!stopped && consent() && typeof sessionId === "number") cookie("ap_analytics_session_id", String(sessionId));
      });
    } else if (config.provider === "posthog" && config.projectApiKey) {
      const { default: posthog } = await import("posthog-js");
      if (stopped || !consent()) return;
      posthog.init(config.projectApiKey, {
        api_host: config.host, autocapture: false, capture_pageview: false, capture_pageleave: false,
        disable_session_recording: true, person_profiles: "never", persistence: "memory",
        bootstrap: { distinctID: clientId },
        sanitize_properties: (properties) => ({ ...properties, $current_url: `${location.origin}${safePath()}`, $referrer: "", $pathname: safePath() }),
      });
      window.posthog = posthog;
    }
  })().catch(() => { stopped = true; });
  return started;
};
window.astroPagesTrack = (name, payload = {}) => {
  if (privatePage() || !consent() || !config.enabled || stopped || !/^[a-zA-Z_$][a-zA-Z0-9_$]{0,39}$/.test(name)) return;
  const safePayload = Object.fromEntries(Object.entries(payload).filter(([key, value]) =>
    ["currency", "value", "session_minutes", "locale"].includes(key) && ["string", "number", "boolean"].includes(typeof value)));
  void initialize().then(() => {
    if (stopped || !consent()) return;
    if (config.provider === "posthog") window.posthog?.capture(name === "page_view" ? "$pageview" : name, { ...safePayload, $current_url: `${location.origin}${safePath()}` });
    else window.gtag?.("event", name, { ...safePayload, page_location: `${location.origin}${safePath()}`, page_title: "", page_referrer: "" });
  });
};
const pageview = () => window.astroPagesTrack?.("page_view");
const decide = (allowed: boolean) => {
  localStorage.setItem(consentKey, allowed ? "granted" : "denied");
  cookie("ap_analytics_consent", allowed ? "granted" : "denied");
  if (banner) banner.hidden = true;
  if (allowed) pageview();
};
window.astroPagesAnalytics = {
  withdraw: () => {
    stopped = true;
    window.posthog?.opt_out_capturing();
    window.dataLayer = [];
    if (config.measurementId) Reflect.set(window, `ga-disable-${config.measurementId}`, true);
    decide(false);
  },
};
banner?.querySelector("[data-analytics-consent-accept]")?.addEventListener("click", () => decide(true));
banner?.querySelector("[data-analytics-consent-decline]")?.addEventListener("click", () => decide(false));
try {
  if (config.enabled && banner && !localStorage.getItem(consentKey)) banner.hidden = false;
  if (consent()) { cookie("ap_analytics_consent", "granted"); pageview(); }
} catch { /* Storage unavailable: no tracking. */ }
const refresh = async () => {
  try {
    const response = await fetch("/api/astropages/generated-site/analytics-config", { cache: "no-store" });
    if (!response.ok) return;
    const next = await response.json() as Config;
    if (JSON.stringify(next) !== JSON.stringify(config)) {
      stopped = true;
      window.posthog?.opt_out_capturing();
      window.dataLayer = [];
      if (config.measurementId) Reflect.set(window, `ga-disable-${config.measurementId}`, true);
      location.reload();
    }
  } catch { /* Retain applied config on a transient read failure. */ }
};
setInterval(() => { if (!document.hidden) void refresh(); }, 30_000);
document.addEventListener("astro:page-load", () => { void refresh(); pageview(); });
window.addEventListener("storage", (event) => { if (event.key === consentKey) location.reload(); });
