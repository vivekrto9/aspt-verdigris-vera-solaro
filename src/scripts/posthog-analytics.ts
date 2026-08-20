import type { PostHog, PostHogInterface } from "posthog-js";

type PublicPosthogConfig = {
  enabled?: boolean;
  projectApiKey?: string;
  host?: string;
};

type AnalyticsConsent = "granted" | "denied" | null;

type AnalyticsController = {
  getConsent: () => AnalyticsConsent;
  setConsent: (value: Exclude<AnalyticsConsent, null>) => void;
  withdraw: () => void;
};

const consentStorageKey = "vera-solaro:analytics-consent";
const allowedEvents = new Set([
  "page_viewed",
  "reading_viewed",
  "booking_started",
  "mode_selected",
  "slot_selected",
  "intake_completed",
  "payment_started",
  "payment_failed",
  "scheduling_retry_requested",
  "booking_confirmed",
  "waitlist_joined",
  "letter_opt_in_started",
  "letter_opt_in_confirmed",
  "contact_submitted",
]);
const allowedPayloadKeys = new Set(["service", "mode", "step", "status", "source"]);

declare global {
  interface Window {
    astroPagesAnalytics?: AnalyticsController;
    astroPagesTrack?: (eventName: string, payload?: Record<string, unknown>) => void;
    posthog?: PostHog | PostHogInterface;
  }
}

const configNode = document.querySelector<HTMLScriptElement>("script[data-posthog-config]");
const consentBanner = document.querySelector<HTMLElement>("[data-analytics-consent-banner]");

const readConfig = (): PublicPosthogConfig => {
  try {
    return JSON.parse(configNode?.textContent || "{}") as PublicPosthogConfig;
  } catch {
    return {};
  }
};

const config = readConfig();
const projectApiKey = String(config.projectApiKey || "").trim();
const posthogHost = String(config.host || "https://us.i.posthog.com").replace(/\/$/, "");
let posthogPromise: Promise<PostHog | null> | null = null;
let memoryConsent: AnalyticsConsent = null;

const sanitizedUrl = (value: string) => {
  try {
    const url = new URL(value, window.location.origin);
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:booking|manage|token|verify|code)$/i.test(key) || /token|secret|authorization|session/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    url.hash = "";
    return url.toString();
  } catch {
    return window.location.origin + window.location.pathname;
  }
};

const sanitizeAnalyticsEvent = <T extends { properties?: Record<string, unknown> } | null>(event: T): T => {
  if (!event?.properties) return event;
  const properties = { ...event.properties };
  for (const key of ["$current_url", "$referrer", "$initial_current_url", "$initial_referrer"]) {
    if (typeof properties[key] === "string") properties[key] = sanitizedUrl(properties[key]);
  }
  return { ...event, properties } as T;
};

const readConsent = (): AnalyticsConsent => {
  try {
    const stored = window.localStorage.getItem(consentStorageKey);
    if (stored === "granted" || stored === "denied") return stored;
  } catch {
    // Storage can be unavailable in hardened browsing contexts.
  }
  return memoryConsent;
};

const writeConsent = (value: Exclude<AnalyticsConsent, null>) => {
  memoryConsent = value;
  try {
    window.localStorage.setItem(consentStorageKey, value);
  } catch {
    // Keep the choice for this document when persistent storage is unavailable.
  }
};

const setBannerVisibility = (visible: boolean) => {
  if (consentBanner) consentBanner.hidden = !visible;
};

const safePayload = (payload: Record<string, unknown>) => {
  const entries: Array<[string, string | number | boolean]> = [];
  for (const [key, value] of Object.entries(payload)) {
    if (!allowedPayloadKeys.has(key)) continue;
    if (typeof value === "boolean" || typeof value === "number") entries.push([key, value]);
    else if (typeof value === "string" && value.length <= 64) entries.push([key, value]);
  }
  return Object.fromEntries(entries);
};

const capturePageView = (posthog: PostHog | PostHogInterface) => {
  posthog.capture("page_viewed", {
    route: window.location.pathname,
    locale: document.body.dataset.locale || "en",
  });
};

const initializePosthog = (): Promise<PostHog | null> => {
  if (!config.enabled || !projectApiKey || readConsent() !== "granted") return Promise.resolve(null);
  if (posthogPromise) return posthogPromise;

  posthogPromise = import("posthog-js")
    .then(({ default: posthog }) => {
      posthog.init(projectApiKey, {
        api_host: posthogHost,
        autocapture: false,
        capture_pageview: false,
        capture_pageleave: false,
        disable_session_recording: true,
        mask_all_text: true,
        mask_all_element_attributes: true,
        mask_personal_data_properties: true,
        get_current_url: () => sanitizedUrl(window.location.href),
        before_send: sanitizeAnalyticsEvent,
        persistence: "localStorage+cookie",
        person_profiles: "identified_only",
        advanced_disable_feature_flags: true,
        advanced_disable_feature_flags_on_first_load: true,
        loaded: (client) => {
          window.posthog = client;
          client.opt_in_capturing();
          document.documentElement.dataset.posthogReady = "true";
          capturePageView(client);
        },
      });
      window.posthog = posthog;
      return posthog;
    })
    .catch(() => {
      document.documentElement.dataset.posthogReady = "false";
      return null;
    });

  return posthogPromise;
};

const setConsent = (value: Exclude<AnalyticsConsent, null>) => {
  writeConsent(value);
  setBannerVisibility(false);

  if (value === "granted") {
    if (window.posthog) {
      window.posthog.opt_in_capturing();
      capturePageView(window.posthog);
      return;
    }
    void initializePosthog();
    return;
  }

  window.posthog?.opt_out_capturing();
  window.posthog?.reset(true);
  document.documentElement.dataset.posthogReady = "false";
};

window.astroPagesAnalytics = {
  getConsent: readConsent,
  setConsent,
  withdraw: () => setConsent("denied"),
};

window.astroPagesTrack = (eventName, payload = {}) => {
  if (readConsent() !== "granted" || !allowedEvents.has(eventName)) return;
  void initializePosthog().then((posthog) => {
    posthog?.capture(eventName, {
      ...safePayload(payload),
      route: window.location.pathname,
      locale: document.body.dataset.locale || "en",
    });
  });
};

consentBanner
  ?.querySelector("[data-analytics-consent-accept]")
  ?.addEventListener("click", () => setConsent("granted"));
consentBanner
  ?.querySelector("[data-analytics-consent-decline]")
  ?.addEventListener("click", () => setConsent("denied"));

const initialConsent = readConsent();
if (initialConsent === "granted") void initializePosthog();
else if (initialConsent === null && config.enabled && projectApiKey) setBannerVisibility(true);
