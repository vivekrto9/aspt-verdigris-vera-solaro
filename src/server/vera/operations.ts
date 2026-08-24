import { getManagedEmailTemplate } from "../aggregator/notifications/email-template-store.ts";
import {
  platformGooglePlacesSecretBinding,
  resolveRuntimeBinding,
  resolveSecretBinding,
} from "../aggregator/runtime-bindings.ts";
import {
  SHARED_CALENDLY_RUNTIME_KEY,
} from "./catalog.ts";
import {
  listCalendlyStaffReconciliations as listCalendlyStaffReconciliationsInternal,
  resolveCalendlyStaffReconciliation as resolveCalendlyStaffReconciliationInternal,
  validateCalendlyMapping,
} from "./calendly.ts";
import {
  all,
  fetchForEnv,
  first,
  isValidEmail,
  normalizeEmail,
  nowIso,
  parseObject,
  randomToken,
  run,
  runStatements,
  safeString,
  secureId,
  sha256Hex,
  timingSafeHexEqual,
} from "./db.ts";
import { enqueueVeraEmail, suppressVeraEmail } from "./email.ts";
import { encryptVeraPrivateJson, giftCodeHash } from "./security.ts";
import type { VeraEnv } from "./types.ts";
import { VERA_TABLES as tables } from "./types.ts";

const calendlyUriPattern = /^https:\/\/api\.calendly\.com\/event_types\/[A-Za-z0-9_-]+$/;
const webhookSetupProofKey = "VERA_PROVIDER_WEBHOOK_SETUP_PROOF";
const providerReadTimeoutMs = 5_000;
const providerResponseMaxBytes = 512_000;
const stripeWebhookEvents = [
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "payment_intent.processing",
  "payment_intent.canceled",
  "refund.created",
  "refund.updated",
  "refund.failed",
] as const;
const calendlyWebhookEvents = ["invitee.created", "invitee.canceled"] as const;

const expectedServices = new Map<string, { name: string; durationMinutes: number; priceCents: number }>([
  ["natal-hour", { name: "The Natal Hour", durationMinutes: 30, priceCents: 24_000 }],
  ["year-ahead", { name: "The Year Ahead", durationMinutes: 30, priceCents: 38_500 }],
  ["two-charts", { name: "Two Charts", durationMinutes: 30, priceCents: 42_000 }],
]);

const callable = (value: unknown, method: string) =>
  Boolean(value && typeof value === "object" && typeof (value as Record<string, unknown>)[method] === "function");

const siteOrigin = (env: VeraEnv, generated: boolean) => {
  const value = generated
    ? safeString(env.ASTROPAGES_SITE_URL)
    : safeString(env.ASTROPAGES_SITE_URL) || safeString(env.SITE_ORIGIN) || safeString(env.SITE_URL);
  try {
    const url = new URL(value);
    return Boolean(url.host) && (url.protocol === "https:" || (!generated && url.protocol === "http:"))
      ? url.origin
      : "";
  } catch {
    return "";
  }
};

const configuredOrigin = (env: VeraEnv, generated: boolean) => Boolean(siteOrigin(env, generated));

const readBoundedProviderObject = async (response: Response) => {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > providerResponseMaxBytes) return null;
  if (!response.body) return {};
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > providerResponseMaxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return parseObject(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return null;
  }
};

type WebhookRegistrationCheck = {
  ready: boolean;
  checked: boolean;
  source: "provider" | "cache" | "not-run";
  callbackConfigured: boolean;
  eventsConfigured: boolean;
  active: boolean;
  checkedPages: number;
  exhaustive: boolean;
  scope?: "organization" | "user" | "none";
};

const providerCache = (env: VeraEnv) => env.SESSION as {
  get?: (key: string) => Promise<string | null> | string | null;
  put?: (key: string, value: string, options?: { expirationTtl?: number }) => Promise<unknown> | unknown;
} | undefined;

const readProviderCheckCache = async (env: VeraEnv, key: string) => {
  try {
    const raw = await providerCache(env)?.get?.(key);
    if (!raw) return null;
    const cached = parseObject(raw);
    if (typeof cached.ready !== "boolean") return null;
    return { ...cached, source: "cache" } as WebhookRegistrationCheck;
  } catch {
    return null;
  }
};

const writeProviderCheckCache = async (env: VeraEnv, key: string, value: WebhookRegistrationCheck) => {
  try {
    await providerCache(env)?.put?.(key, JSON.stringify(value), {
      expirationTtl: value.ready ? 300 : 60,
    });
  } catch {
    // The live result remains authoritative for this response when KV is unavailable.
  }
};

const notRunWebhookCheck = (): WebhookRegistrationCheck => ({
  ready: false,
  checked: false,
  source: "not-run",
  callbackConfigured: false,
  eventsConfigured: false,
  active: false,
  checkedPages: 0,
  exhaustive: false,
});

const validateStripeWebhookRegistration = async ({
  env,
  secret,
  publishableKey,
  origin,
  force = false,
}: {
  env: VeraEnv;
  secret: string;
  publishableKey: string;
  origin: string;
  force?: boolean;
}) => {
  const callback = `${origin}/api/astropages/generated-site/vera/webhooks/stripe`;
  const fingerprint = await sha256Hex(JSON.stringify([
    await sha256Hex(secret), publishableKey.slice(0, 8), callback, stripeWebhookEvents,
  ]));
  const cacheKey = `vera:readiness:stripe-webhook:${fingerprint}`;
  if (!force) {
    const cached = await readProviderCheckCache(env, cacheKey);
    if (cached) return cached;
  }
  let callbackConfigured = false;
  let eventsConfigured = false;
  let active = false;
  let exhaustive = true;
  let checkedPages = 0;
  let cursor = "";
  try {
    for (let page = 0; page < 3; page += 1) {
      const url = new URL("https://api.stripe.com/v1/webhook_endpoints");
      url.searchParams.set("limit", "100");
      if (cursor) url.searchParams.set("starting_after", cursor);
      const response = await fetchForEnv(env)(url, {
        headers: { accept: "application/json", authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(providerReadTimeoutMs),
      });
      checkedPages += 1;
      const payload = await readBoundedProviderObject(response);
      if (!response.ok || !payload) {
        exhaustive = false;
        break;
      }
      const endpoints = Array.isArray(payload.data) ? payload.data.map(parseObject) : [];
      for (const endpoint of endpoints) {
        if (safeString(endpoint.url) !== callback) continue;
        callbackConfigured = true;
        const enabled = new Set((Array.isArray(endpoint.enabled_events) ? endpoint.enabled_events : []).map(safeString));
        const hasEvents = enabled.has("*") || stripeWebhookEvents.every((event) => enabled.has(event));
        eventsConfigured ||= hasEvents;
        const endpointActive = safeString(endpoint.status) === "enabled";
        active ||= endpointActive;
        const secretLive = /^(?:sk|rk)_live_/.test(secret);
        const secretTest = /^(?:sk|rk)_test_/.test(secret);
        const publishableLive = publishableKey.startsWith("pk_live_");
        const publishableTest = publishableKey.startsWith("pk_test_");
        const modeKnown = (secretLive || secretTest) && (publishableLive || publishableTest);
        const modeMatches = modeKnown && secretLive === publishableLive && Boolean(endpoint.livemode) === secretLive;
        if (hasEvents && endpointActive && modeMatches) {
          const result: WebhookRegistrationCheck = {
            ready: true, checked: true, source: "provider", callbackConfigured: true,
            eventsConfigured: true, active: true, checkedPages, exhaustive: true,
          };
          await writeProviderCheckCache(env, cacheKey, result);
          return result;
        }
      }
      if (payload.has_more !== true) break;
      cursor = safeString(endpoints.at(-1)?.id);
      if (!cursor) {
        exhaustive = false;
        break;
      }
      if (page === 2) exhaustive = false;
    }
  } catch {
    exhaustive = false;
  }
  const result: WebhookRegistrationCheck = {
    ready: false, checked: true, source: "provider", callbackConfigured,
    eventsConfigured, active, checkedPages, exhaustive,
  };
  await writeProviderCheckCache(env, cacheKey, result);
  return result;
};

const validateCalendlyWebhookRegistration = async ({
  env,
  token,
  origin,
  force = false,
}: {
  env: VeraEnv;
  token: string;
  origin: string;
  force?: boolean;
}) => {
  const callback = `${origin}/api/astropages/generated-site/vera/webhooks/calendly`;
  const fingerprint = await sha256Hex(JSON.stringify([await sha256Hex(token), callback, calendlyWebhookEvents]));
  const cacheKey = `vera:readiness:calendly-webhook:${fingerprint}`;
  if (!force) {
    const cached = await readProviderCheckCache(env, cacheKey);
    if (cached) return cached;
  }
  let checkedPages = 0;
  let exhaustive = true;
  try {
    const currentResponse = await fetchForEnv(env)("https://api.calendly.com/users/me", {
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(providerReadTimeoutMs),
    });
    const currentPayload = await readBoundedProviderObject(currentResponse);
    const current = parseObject(currentPayload?.resource || currentPayload);
    const organization = safeString(current.current_organization) || safeString(current.organization);
    const user = safeString(current.uri);
    if (!currentResponse.ok || !organization || !user) throw new Error("calendly_identity_unavailable");
    const scopes: Array<{ scope: "organization" | "user"; user?: string }> = [
      { scope: "organization" },
      { scope: "user", user },
    ];
    for (const candidate of scopes) {
      let nextUrl = new URL("https://api.calendly.com/webhook_subscriptions");
      nextUrl.searchParams.set("organization", organization);
      nextUrl.searchParams.set("scope", candidate.scope);
      nextUrl.searchParams.set("count", "100");
      if (candidate.user) nextUrl.searchParams.set("user", candidate.user);
      for (let page = 0; page < 3; page += 1) {
        const response = await fetchForEnv(env)(nextUrl, {
          headers: { accept: "application/json", authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(providerReadTimeoutMs),
        });
        checkedPages += 1;
        const payload = await readBoundedProviderObject(response);
        if (!response.ok || !payload) {
          exhaustive = false;
          break;
        }
        const subscriptions = Array.isArray(payload.collection) ? payload.collection.map(parseObject) : [];
        for (const subscription of subscriptions) {
          const events = new Set((Array.isArray(subscription.events) ? subscription.events : []).map(safeString));
          if (
            safeString(subscription.callback_url) === callback &&
            safeString(subscription.state) === "active" &&
            calendlyWebhookEvents.every((event) => events.has(event))
          ) {
            const result: WebhookRegistrationCheck = {
              ready: true, checked: true, source: "provider", callbackConfigured: true,
              eventsConfigured: true, active: true, checkedPages, exhaustive: true,
              scope: candidate.scope,
            };
            await writeProviderCheckCache(env, cacheKey, result);
            return result;
          }
        }
        const next = safeString(parseObject(payload.pagination).next_page);
        if (!next) break;
        const parsedNext = new URL(next);
        if (parsedNext.origin !== "https://api.calendly.com" || parsedNext.pathname !== "/webhook_subscriptions") {
          exhaustive = false;
          break;
        }
        nextUrl = parsedNext;
        if (page === 2) exhaustive = false;
      }
    }
  } catch {
    exhaustive = false;
  }
  const result: WebhookRegistrationCheck = {
    ready: false, checked: true, source: "provider", callbackConfigured: false,
    eventsConfigured: false, active: false, checkedPages, exhaustive, scope: "none",
  };
  await writeProviderCheckCache(env, cacheKey, result);
  return result;
};

const webhookSetupFingerprint = async ({
  origin,
  stripeSecret,
  calendlyToken,
  stripeSigningSecret,
  calendlySigningKey,
}: {
  origin: string;
  stripeSecret: string;
  calendlyToken: string;
  stripeSigningSecret: string;
  calendlySigningKey: string;
}) => sha256Hex(JSON.stringify({
  version: 1,
  origin,
  stripeAccount: await sha256Hex(stripeSecret),
  calendlyAccount: await sha256Hex(calendlyToken),
  stripeSigning: await sha256Hex(stripeSigningSecret),
  calendlySigning: await sha256Hex(calendlySigningKey),
  stripeEvents: stripeWebhookEvents,
  calendlyEvents: calendlyWebhookEvents,
}));

const validateLiveCalendlyMapping = async ({
  env,
  eventTypeUri,
}: {
  env: VeraEnv;
  eventTypeUri: string;
}) => {
  const fingerprint = await sha256Hex(eventTypeUri);
  const cacheKey = `vera:readiness:calendly:${fingerprint}`;
  const cache = env.SESSION as {
    get?: (key: string) => Promise<string | null> | string | null;
    put?: (key: string, value: string, options?: { expirationTtl?: number }) => Promise<unknown> | unknown;
  } | undefined;
  try {
    const cached = await cache?.get?.(cacheKey);
    if (cached === "ready" || cached === "blocked") {
      return {
        ready: cached === "ready",
        checked: true,
        source: "cache",
        checkedMappings: 1,
      };
    }
  } catch {
    // A KV read failure must not make stale validation evidence authoritative.
  }
  const validation = await validateCalendlyMapping({ env, eventTypeUri, durationMinutes: 30 });
  const ready = validation.ok;
  try {
    await cache?.put?.(cacheKey, ready ? "ready" : "blocked", {
      expirationTtl: ready ? 300 : 60,
    });
  } catch {
    // Validation still remains authoritative for this response when cache storage fails.
  }
  return { ready, checked: true, source: "provider", checkedMappings: 1 };
};

export const listVeraOperationsReadiness = async (env: VeraEnv) => {
  const generated = Boolean(safeString(env.ASTROPAGES_PROJECT_ID));
  const environment = safeString(env.ASTROPAGES_SITE_ENVIRONMENT) || (generated ? "generated" : "local");
  let services: Record<string, unknown>[] = [];
  let runtime: Record<string, unknown>[] = [];
  let schemaReady = false;
  try {
    [services, runtime] = await Promise.all([
      all(env, `SELECT slug, name, duration_minutes, price_cents, currency, active, sort_order
        FROM ${tables.services} ORDER BY sort_order`),
      all(env, `SELECT key, value, status, updated_at FROM ap_runtime_config
        WHERE status = 'active' ORDER BY key`),
    ]);
    schemaReady = true;
  } catch {
    // A readiness check must report an unapplied schema instead of crashing.
  }
  const runtimeMap = new Map(runtime.map((row) => [safeString(row.key), safeString(row.value)]));
  const runtimeValue = (key: string) => runtimeMap.get(key) || (!generated ? safeString(env[key]) : "");
  const sharedCalendlyUri = runtimeValue(SHARED_CALENDLY_RUNTIME_KEY);
  const resolved = sharedCalendlyUri ? [{
    serviceSlug: "all",
    mode: "call",
    eventTypeUri: sharedCalendlyUri,
    active: true,
  }] : [];
  const calendlyReady = schemaReady && calendlyUriPattern.test(sharedCalendlyUri);
  const servicesReady = schemaReady && services.length === expectedServices.size && services.every((row) => {
    const expected = expectedServices.get(safeString(row.slug));
    return Boolean(
      expected && safeString(row.name) === expected.name &&
      Number(row.duration_minutes) === expected.durationMinutes &&
      Number(row.price_cents) === expected.priceCents &&
      safeString(row.currency) === "USD" && Number(row.active) === 1
    );
  });

  const resourceBindings = {
    DB: Boolean(env.DB?.prepare && env.DB?.batch),
    MEDIA: callable(env.MEDIA, "get") && callable(env.MEDIA, "put") && callable(env.MEDIA, "delete"),
    SESSION: callable(env.SESSION, "get") && callable(env.SESSION, "put"),
    EMAIL_QUEUE: callable(env.EMAIL_QUEUE, "send"),
    IMAGES: callable(env.IMAGES, "input") && callable(env.IMAGES, "info"),
  };
  const requiredResourceBindingNames = new Set(
    Object.keys(resourceBindings).filter((name) => !generated || name !== "EMAIL_QUEUE"),
  );
  const missingBindingNames = Object.entries(resourceBindings)
    .filter(([name, configured]) => requiredResourceBindingNames.has(name) && !configured)
    .map(([name]) => name);

  const [
    encryptionKey,
    platformGooglePlacesKey,
    stripeSecretKey,
    stripeWebhookSecret,
    calendlyApiToken,
    calendlyWebhookSigningKey,
    awsAccessKeyId,
    awsSecretAccessKey,
    fallbackGooglePlacesKey,
  ] = await Promise.all([
    resolveRuntimeBinding(env.EMDASH_ENCRYPTION_KEY),
    resolveRuntimeBinding(env[platformGooglePlacesSecretBinding]),
    resolveSecretBinding(env, "STRIPE_SECRET_KEY"),
    resolveSecretBinding(env, "STRIPE_WEBHOOK_SECRET"),
    resolveSecretBinding(env, "CALENDLY_API_TOKEN"),
    resolveSecretBinding(env, "CALENDLY_WEBHOOK_SIGNING_KEY"),
    resolveSecretBinding(env, "AWS_ACCESS_KEY_ID"),
    resolveSecretBinding(env, "AWS_SECRET_ACCESS_KEY"),
    resolveSecretBinding(env, "GOOGLE_PLACES_API_KEY"),
  ]);
  const googlePlacesKey = generated ? platformGooglePlacesKey : fallbackGooglePlacesKey;
  const secretStoreConfigured = !generated || Boolean(platformGooglePlacesKey);
  if (generated && !platformGooglePlacesKey) missingBindingNames.push(platformGooglePlacesSecretBinding);

  const requiredSecrets = new Map<string, string>([
    ["EMDASH_ENCRYPTION_KEY", encryptionKey],
    ["STRIPE_SECRET_KEY", stripeSecretKey],
    ["STRIPE_WEBHOOK_SECRET", stripeWebhookSecret],
    ["CALENDLY_API_TOKEN", calendlyApiToken],
    ["CALENDLY_WEBHOOK_SIGNING_KEY", calendlyWebhookSigningKey],
    ["AWS_ACCESS_KEY_ID", awsAccessKeyId],
    ["AWS_SECRET_ACCESS_KEY", awsSecretAccessKey],
    ["GOOGLE_PLACES_API_KEY", googlePlacesKey],
  ]);
  const missingSecretNames = [...requiredSecrets]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  const runtimeRequirements = [
    "STRIPE_PUBLISHABLE_KEY",
    SHARED_CALENDLY_RUNTIME_KEY,
    "SES_SENDER_EMAIL",
    "SES_SENDER_NAME",
    "AWS_REGION",
  ];
  const missingRuntimeConfigKeys = runtimeRequirements.filter((key) => !runtimeValue(key));
  if (!configuredOrigin(env, generated)) missingRuntimeConfigKeys.push("ASTROPAGES_SITE_URL");
  const posthogValues = {
    projectApiKey: runtimeValue("POSTHOG_PROJECT_API_KEY"),
    host: runtimeValue("POSTHOG_HOST"),
    projectId: runtimeValue("POSTHOG_PROJECT_ID"),
  };
  const posthogEnabled = Object.values(posthogValues).some(Boolean);
  const posthogReady = !posthogEnabled || Object.values(posthogValues).every(Boolean);
  if (posthogEnabled && !posthogReady) {
    if (!posthogValues.projectApiKey) missingRuntimeConfigKeys.push("POSTHOG_PROJECT_API_KEY");
    if (!posthogValues.host) missingRuntimeConfigKeys.push("POSTHOG_HOST");
    if (!posthogValues.projectId) missingRuntimeConfigKeys.push("POSTHOG_PROJECT_ID");
  }
  const cloudflareReady = schemaReady && missingBindingNames.length === 0;
  const securityReady = Boolean(encryptionKey) && secretStoreConfigured;
  const origin = siteOrigin(env, generated);
  const stripeConfigured = Boolean(runtimeValue("STRIPE_PUBLISHABLE_KEY") && stripeSecretKey && stripeWebhookSecret);
  const calendlyLiveValidation = calendlyReady && calendlyApiToken
    ? await validateLiveCalendlyMapping({ env, eventTypeUri: sharedCalendlyUri })
    : { ready: false, checked: false, source: "not-run", checkedMappings: 0 };
  const [stripeWebhookRegistration, calendlyWebhookRegistration] = await Promise.all([
    stripeConfigured && origin
      ? validateStripeWebhookRegistration({
        env,
        secret: stripeSecretKey,
        publishableKey: runtimeValue("STRIPE_PUBLISHABLE_KEY"),
        origin,
      })
      : notRunWebhookCheck(),
    calendlyApiToken && origin
      ? validateCalendlyWebhookRegistration({ env, token: calendlyApiToken, origin })
      : notRunWebhookCheck(),
  ]);
  const expectedProof = origin && stripeSecretKey && calendlyApiToken && stripeWebhookSecret && calendlyWebhookSigningKey
    ? await webhookSetupFingerprint({
      origin,
      stripeSecret: stripeSecretKey,
      calendlyToken: calendlyApiToken,
      stripeSigningSecret: stripeWebhookSecret,
      calendlySigningKey: calendlyWebhookSigningKey,
    })
    : "";
  const proof = parseObject(runtimeMap.get(webhookSetupProofKey));
  const proofFingerprint = safeString(proof.fingerprint);
  const webhookSetupProofReady = Boolean(
    expectedProof && proofFingerprint && timingSafeHexEqual(expectedProof, proofFingerprint)
  );
  const stripeReady = Boolean(stripeConfigured && stripeWebhookRegistration.ready && webhookSetupProofReady);
  const calendlyProviderReady = Boolean(
    calendlyApiToken && calendlyWebhookSigningKey && calendlyReady && calendlyLiveValidation.ready &&
    calendlyWebhookRegistration.ready && webhookSetupProofReady
  );
  const googlePlacesReady = Boolean(googlePlacesKey);
  const emailReady = Boolean(
    runtimeValue("SES_SENDER_EMAIL") && runtimeValue("SES_SENDER_NAME") && runtimeValue("AWS_REGION") &&
    awsAccessKeyId && awsSecretAccessKey
  );
  const originReady = Boolean(origin);
  const ready = Boolean(
    cloudflareReady && securityReady && servicesReady && stripeReady && calendlyProviderReady &&
    googlePlacesReady && emailReady && posthogReady && originReady &&
    missingRuntimeConfigKeys.length === 0 && missingSecretNames.length === 0
  );
  return {
    ready,
    environment,
    checks: {
      cloudflare: { ready: cloudflareReady, schemaReady, bindings: resourceBindings },
      security: { ready: securityReady, encryptionConfigured: Boolean(encryptionKey), secretStoreConfigured },
      catalog: { ready: servicesReady },
      stripe: {
        ready: stripeReady,
        publishableKeyConfigured: Boolean(runtimeValue("STRIPE_PUBLISHABLE_KEY")),
        secretKeyConfigured: Boolean(stripeSecretKey),
        webhookSigningConfigured: Boolean(stripeWebhookSecret),
        webhookRegistration: stripeWebhookRegistration,
        setupProofReady: webhookSetupProofReady,
      },
      calendly: {
        ready: calendlyProviderReady,
        apiTokenConfigured: Boolean(calendlyApiToken),
        webhookSigningConfigured: Boolean(calendlyWebhookSigningKey),
        mappingsReady: calendlyReady,
        liveValidation: calendlyLiveValidation,
        webhookRegistration: calendlyWebhookRegistration,
        setupProofReady: webhookSetupProofReady,
      },
      googlePlaces: { ready: googlePlacesReady, apiKeyConfigured: Boolean(googlePlacesKey) },
      email: {
        ready: emailReady,
        senderConfigured: Boolean(runtimeValue("SES_SENDER_EMAIL") && runtimeValue("SES_SENDER_NAME")),
        regionConfigured: Boolean(runtimeValue("AWS_REGION")),
        credentialsConfigured: Boolean(awsAccessKeyId && awsSecretAccessKey),
      },
      posthog: { ready: posthogReady, enabled: posthogEnabled, publicConfigComplete: posthogReady },
      siteOrigin: { ready: originReady },
    },
    missingSecretNames,
    missingRuntimeConfigKeys: [...new Set(missingRuntimeConfigKeys)],
    missingBindingNames: [...new Set(missingBindingNames)],
    services,
    calendlyMappings: resolved,
    calendlyReady,
};
};

export const validateVeraProviderWebhookSetup = async (
  env: VeraEnv,
  input: Record<string, unknown>,
) => {
  const generated = Boolean(safeString(env.ASTROPAGES_PROJECT_ID));
  const origin = siteOrigin(env, generated);
  const submittedStripeHash = safeString(input.stripeSigningSecretSha256).toLowerCase();
  const submittedCalendlyHash = safeString(input.calendlySigningKeySha256).toLowerCase();
  if (!origin || !/^[a-f0-9]{64}$/.test(submittedStripeHash) || !/^[a-f0-9]{64}$/.test(submittedCalendlyHash)) {
    return { ok: false as const, status: 400, message: "Provider webhook setup proof is invalid." };
  }
  const [stripeSecret, stripeSigningSecret, calendlyToken, calendlySigningKey] = await Promise.all([
    resolveSecretBinding(env, "STRIPE_SECRET_KEY"),
    resolveSecretBinding(env, "STRIPE_WEBHOOK_SECRET"),
    resolveSecretBinding(env, "CALENDLY_API_TOKEN"),
    resolveSecretBinding(env, "CALENDLY_WEBHOOK_SIGNING_KEY"),
  ]);
  const missingSecretNames = [
    stripeSecret ? "" : "STRIPE_SECRET_KEY",
    stripeSigningSecret ? "" : "STRIPE_WEBHOOK_SECRET",
    calendlyToken ? "" : "CALENDLY_API_TOKEN",
    calendlySigningKey ? "" : "CALENDLY_WEBHOOK_SIGNING_KEY",
  ].filter(Boolean);
  if (missingSecretNames.length) {
    return { ok: false as const, status: 503, message: "Provider webhook setup is incomplete.", missingSecretNames };
  }
  const [actualStripeHash, actualCalendlyHash] = await Promise.all([
    sha256Hex(stripeSigningSecret),
    sha256Hex(calendlySigningKey),
  ]);
  if (
    !timingSafeHexEqual(actualStripeHash, submittedStripeHash) ||
    !timingSafeHexEqual(actualCalendlyHash, submittedCalendlyHash)
  ) {
    return { ok: false as const, status: 409, message: "Provider webhook signing proof does not match configured secrets." };
  }
  const publishable = await first(env, `SELECT value FROM ap_runtime_config
    WHERE key = 'STRIPE_PUBLISHABLE_KEY' AND status = 'active'`);
  const [stripeRegistration, calendlyRegistration] = await Promise.all([
    validateStripeWebhookRegistration({
      env,
      secret: stripeSecret,
      publishableKey: safeString(publishable?.value) || safeString(env.PUBLIC_STRIPE_PUBLISHABLE_KEY),
      origin,
      force: true,
    }),
    validateCalendlyWebhookRegistration({ env, token: calendlyToken, origin, force: true }),
  ]);
  if (!stripeRegistration.ready || !calendlyRegistration.ready) {
    return {
      ok: false as const,
      status: 409,
      message: "Provider webhook registrations do not match this site.",
      data: { stripe: stripeRegistration, calendly: calendlyRegistration },
    };
  }
  const fingerprint = await webhookSetupFingerprint({
    origin,
    stripeSecret,
    calendlyToken,
    stripeSigningSecret,
    calendlySigningKey,
  });
  const validatedAt = nowIso();
  await run(env, `INSERT INTO ap_runtime_config
    (key, value, provider_key, scope, status, updated_at)
    VALUES (?, ?, 'vera', 'site', 'active', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value,
      provider_key = 'vera', scope = 'site', status = 'active', updated_at = excluded.updated_at`, [
    webhookSetupProofKey,
    JSON.stringify({ version: 1, fingerprint, validatedAt }),
    validatedAt,
  ]);
  return {
    ok: true as const,
    status: 200,
    message: "Provider webhook setup is verified.",
    verified: true,
    validatedAt,
    stripe: stripeRegistration,
    calendly: calendlyRegistration,
  };
};

export const listVeraCalendlyReconciliations = async (env: VeraEnv, input: Record<string, unknown>) => {
  const reconciliation = await listCalendlyStaffReconciliationsInternal(env, input);
  return {
    ok: true as const,
    status: 200,
    message: "Calendly reconciliation states loaded.",
    reconciliation,
  };
};

export const resolveVeraCalendlyReconciliation = (
  env: VeraEnv,
  input: Record<string, unknown>,
) => resolveCalendlyStaffReconciliationInternal(env, input);

export const replaceVeraCalendlyMappings = async (
  env: VeraEnv,
  input: Record<string, unknown>,
) => {
  const eventTypeUri = safeString(input.eventTypeUri);
  if (!calendlyUriPattern.test(eventTypeUri)) {
    return { ok: false as const, status: 400, message: "The shared 30-minute Calendly event type URI is invalid." };
  }
  const validation = await validateCalendlyMapping({ env, eventTypeUri, durationMinutes: 30 });
  if (!validation.ok) return validation;
  const now = nowIso();
  await runStatements(env, [
    env.DB!.prepare(`UPDATE ${tables.calendlyMappings}
      SET event_type_uri = NULL, active = 0, updated_at = ?`).bind(now),
    env.DB!.prepare(`DELETE FROM ap_runtime_config WHERE key LIKE 'VERA_CALENDLY_%'`),
    env.DB!.prepare(`INSERT INTO ap_runtime_config
      (key, value, provider_key, scope, status, updated_at)
      VALUES (?, ?, 'calendly', 'site', 'active', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value,
        provider_key = 'calendly', status = 'active', updated_at = excluded.updated_at`)
      .bind(SHARED_CALENDLY_RUNTIME_KEY, eventTypeUri, now),
  ]);
  return { ok: true as const, status: 200, message: "The shared 30-minute Calendly event is ready.", data: await listVeraOperationsReadiness(env) };
};

export const issueVeraGiftCertificate = async (
  env: VeraEnv,
  input: Record<string, unknown>,
) => {
  const amountCents = Number(input.amountCents);
  if (!Number.isInteger(amountCents) || amountCents < 500 || amountCents > 1_000_000) {
    return { ok: false as const, status: 400, message: "Gift amount must be between $5 and $10,000." };
  }
  const expiresAtValue = safeString(input.expiresAt);
  const expiresAt = expiresAtValue ? new Date(expiresAtValue) : null;
  if (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now())) {
    return { ok: false as const, status: 400, message: "Gift expiry must be a future date." };
  }
  const recipientEmail = normalizeEmail(input.recipientEmail);
  if (recipientEmail && !isValidEmail(recipientEmail)) {
    return { ok: false as const, status: 400, message: "Recipient email is invalid." };
  }
  const code = `VERA-${randomToken(8).toUpperCase()}`;
  const codeHash = await giftCodeHash(code);
  const id = secureId("vgift");
  const now = nowIso();
  await run(env, `INSERT INTO ${tables.giftCertificates}
    (id, code_hash, status, original_amount_cents, remaining_amount_cents,
     currency, expires_at, issued_at, updated_at)
    VALUES (?, ?, 'active', ?, ?, 'USD', ?, ?, ?)`, [
    id, codeHash, amountCents, amountCents, expiresAt?.toISOString() || null, now, now,
  ]);
  if (recipientEmail) {
    const siteUrl = safeString(env.ASTROPAGES_SITE_URL) || safeString(env.SITE_ORIGIN) || safeString(env.SITE_URL);
    if (!siteUrl) {
      return {
        ok: true as const,
        status: 201,
        message: "Gift issued, but email delivery is not configured.",
        giftId: id,
        code,
        emailQueued: false,
      };
    }
    await enqueueVeraEmail({
      env,
      eventType: "vera.gift.issued",
      templateKey: "vera_gift_issued_en",
      recipientEmail,
      recipientName: safeString(input.recipientName),
      payload: {
        customerName: safeString(input.recipientName) || "Recipient",
        giftAmount: new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amountCents / 100),
        giftCode: code,
        siteUrl,
      },
      idempotencyKey: `gift-issued:${id}`,
    });
  }
  return { ok: true as const, status: 201, message: "Gift certificate issued. The code is returned once.", giftId: id, code, emailQueued: Boolean(recipientEmail) };
};

export const createVeraNewsletterCampaign = async ({
  env,
  input,
  actor,
}: {
  env: VeraEnv;
  input: Record<string, unknown>;
  actor: string;
}) => {
  const name = safeString(input.name).slice(0, 160);
  const templateKey = safeString(input.templateKey) || "vera_newsletter_dispatch_en";
  const campaignSubject = safeString(input.subject).slice(0, 180);
  const campaignBody = safeString(input.body).slice(0, 20_000);
  const scheduledFor = new Date(safeString(input.scheduledFor));
  if (!name || !campaignSubject || !campaignBody || !Number.isFinite(scheduledFor.getTime())) {
    return { ok: false as const, status: 400, message: "Campaign name, subject, body, and schedule are required." };
  }
  const template = await getManagedEmailTemplate(env, templateKey);
  if (
    !template || template.eventType !== "vera.newsletter.dispatch" ||
    !template.requiredVariables.includes("unsubscribeUrl")
  ) {
    return { ok: false as const, status: 409, message: "Choose a published Vera marketing template with unsubscribeUrl." };
  }
  const id = secureId("vcampaign");
  const now = nowIso();
  await run(env, `INSERT INTO ${tables.newsletterCampaigns}
    (id, name, template_key, payload_json, status, scheduled_for, dispatch_cursor,
     created_by, created_at, updated_at, started_at, completed_at)
    VALUES (?, ?, ?, ?, 'scheduled', ?, NULL, ?, ?, ?, NULL, NULL)`, [
    id, name, templateKey, JSON.stringify({ campaignSubject, campaignBody }),
    scheduledFor.toISOString(), actor.slice(0, 160) || "control-plane", now, now,
  ]);
  return { ok: true as const, status: 201, message: "Newsletter campaign scheduled.", campaignId: id };
};

export const storeVeraPrivateFile = async ({
  env,
  bookingId,
  reportId,
  kind,
  file,
}: {
  env: VeraEnv;
  bookingId: string;
  reportId?: string;
  kind: string;
  file: File;
}) => {
  const allowedKinds = new Set(["chart", "recording", "report_pdf", "worksheet", "document"]);
  const allowedTypes = new Set([
    "application/pdf", "audio/mpeg", "audio/mp4", "video/mp4", "text/plain", "image/png", "image/jpeg",
  ]);
  const isRecording = kind === "recording" && ["audio/mpeg", "audio/mp4"].includes(file.type);
  const sizeLimit = isRecording ? 90 * 1024 * 1024 : 25 * 1024 * 1024;
  if (
    !allowedKinds.has(kind) || !allowedTypes.has(file.type) ||
    (kind === "recording" && !isRecording) || file.size < 1 || file.size > sizeLimit
  ) {
    return { ok: false as const, status: 400, message: "Use a supported private file within its size limit." };
  }
  const booking = await first(env, `SELECT id, account_id, customer_name, email FROM ${tables.bookings} WHERE id = ?`, [bookingId]);
  if (!safeString(booking?.account_id)) {
    return { ok: false as const, status: 409, message: "Booking must be linked to a customer account." };
  }
  if (reportId) {
    const report = await first(env, `SELECT id FROM ${tables.reports}
      WHERE id = ? AND booking_id = ? AND account_id = ?`, [reportId, bookingId, safeString(booking?.account_id)]);
    if (!report) return { ok: false as const, status: 409, message: "Report does not belong to this booking." };
  }
  if (!env.MEDIA?.put) return { ok: false as const, status: 503, message: "Private file storage is not configured." };
  const id = secureId("vfile");
  const safeName = file.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-120) || "private-file";
  const storageKey = `private/vera/${safeString(booking?.account_id)}/${id}/${safeName}`;
  await env.MEDIA.put(storageKey, file, {
    httpMetadata: { contentType: file.type },
    customMetadata: { accountId: safeString(booking?.account_id), bookingId },
  });
  try {
    await run(env, `INSERT INTO ${tables.privateFiles}
      (id, account_id, booking_id, report_id, kind, file_name, content_type,
       size_bytes, storage_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      id, safeString(booking?.account_id), bookingId, reportId || null, kind,
      file.name.slice(0, 180), file.type, file.size, storageKey, nowIso(),
    ]);
  } catch (error) {
    await env.MEDIA.delete?.(storageKey).catch(() => undefined);
    throw error;
  }
  return { ok: true as const, status: 201, message: "Private file stored.", fileId: id };
};

export const publishVeraReport = async (env: VeraEnv, input: Record<string, unknown>) => {
  const bookingId = safeString(input.bookingId);
  const title = safeString(input.title).slice(0, 180);
  const content = input.content && typeof input.content === "object" ? input.content : null;
  if (!bookingId || !title || !content || JSON.stringify(content).length > 100_000) {
    return { ok: false as const, status: 400, message: "Booking, title, and bounded report content are required." };
  }
  const booking = await first(env, `SELECT id, account_id, customer_name, email
    FROM ${tables.bookings} WHERE id = ?`, [bookingId]);
  if (!safeString(booking?.account_id)) {
    return { ok: false as const, status: 409, message: "Booking must be linked to a customer account." };
  }
  const encrypted = await encryptVeraPrivateJson(env, content as Record<string, unknown>);
  if (!encrypted) return { ok: false as const, status: 503, message: "Private report encryption is not configured." };
  const existing = await first(env, `SELECT id FROM ${tables.reports} WHERE booking_id = ?`, [bookingId]);
  const id = safeString(existing?.id) || secureId("vreport");
  const now = nowIso();
  await run(env, `INSERT INTO ${tables.reports}
    (id, account_id, booking_id, title, status, encrypted_payload,
     published_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'published', ?, ?, ?, ?)
    ON CONFLICT(booking_id) DO UPDATE SET title = excluded.title,
      status = 'published', encrypted_payload = excluded.encrypted_payload,
      published_at = excluded.published_at, updated_at = excluded.updated_at`, [
    id, safeString(booking?.account_id), bookingId, title, encrypted, now, now, now,
  ]);
  const configuredOrigin = safeString(env.ASTROPAGES_SITE_URL) || safeString(env.SITE_ORIGIN) || safeString(env.SITE_URL);
  if (configuredOrigin) {
    try {
      const accountUrl = new URL("/account", configuredOrigin);
      await enqueueVeraEmail({
        env,
        eventType: "vera.report.ready",
        templateKey: "vera_report_ready_en",
        recipientEmail: safeString(booking?.email),
        recipientName: safeString(booking?.customer_name),
        payload: {
          customerName: safeString(booking?.customer_name),
          reportTitle: title,
          accountUrl: accountUrl.toString(),
        },
        idempotencyKey: `report-ready:${id}:${now}`,
      });
    } catch {
      // Publishing remains authoritative if optional email setup is incomplete.
    }
  }
  return { ok: true as const, status: 200, message: "Private report published.", reportId: id };
};

export const sendVeraStaffMessage = async (env: VeraEnv, input: Record<string, unknown>) => {
  const bookingId = safeString(input.bookingId);
  const accountIdInput = safeString(input.accountId);
  const threadIdInput = safeString(input.threadId);
  const subject = safeString(input.subject).slice(0, 180);
  const body = safeString(input.body);
  if (!body || body.length > 5_000) {
    return { ok: false as const, status: 400, message: "Message must be 5,000 characters or fewer." };
  }
  let accountId = accountIdInput;
  if (bookingId) {
    const booking = await first(env, `SELECT account_id FROM ${tables.bookings} WHERE id = ?`, [bookingId]);
    accountId ||= safeString(booking?.account_id);
  }
  if (!accountId) return { ok: false as const, status: 400, message: "A linked customer account is required." };
  let threadId = threadIdInput;
  if (threadId) {
    const thread = await first(env, `SELECT id FROM ${tables.messageThreads}
      WHERE id = ? AND account_id = ? AND status = 'open'`, [threadId, accountId]);
    if (!thread) return { ok: false as const, status: 404, message: "Open message thread was not found." };
  } else {
    if (!subject) return { ok: false as const, status: 400, message: "Subject is required for a new thread." };
    const existing = bookingId
      ? await first(env, `SELECT id FROM ${tables.messageThreads}
          WHERE booking_id = ? AND account_id = ?`, [bookingId, accountId])
      : null;
    threadId = safeString(existing?.id);
    if (!threadId) {
      threadId = secureId("vthread");
      const now = nowIso();
      await run(env, `INSERT INTO ${tables.messageThreads}
        (id, account_id, booking_id, subject, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'open', ?, ?)`, [threadId, accountId, bookingId || null, subject, now, now]);
    }
  }
  const now = nowIso();
  await run(env, `INSERT INTO ${tables.messages}
    (id, thread_id, sender_role, body, read_at, created_at)
    VALUES (?, ?, 'vera', ?, NULL, ?)`, [secureId("vmessage"), threadId, body, now]);
  await run(env, `UPDATE ${tables.messageThreads} SET updated_at = ? WHERE id = ?`, [now, threadId]);
  return { ok: true as const, status: 201, message: "Private message sent.", threadId };
};

export const suppressVeraRecipient = suppressVeraEmail;
