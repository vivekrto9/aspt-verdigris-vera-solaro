import { AP_TABLES as tables } from "./db/tables.ts";
import { resolveRuntimeBinding } from "./runtime-bindings.ts";

type RuntimeEnv = Record<string, unknown> & {
  DB?: {
    prepare: (sql: string) => {
      bind: (...values: unknown[]) => any;
      run?: () => Promise<unknown>;
      all?: <T = Record<string, unknown>>() => Promise<{ results?: T[] }>;
    };
  };
};

const safeString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const isMissingRuntimeConfigTableError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return (
    message.includes("ap_runtime_config") &&
    (message.includes("no such table") || message.includes("SQLITE_ERROR"))
  );
};

export const runtimeConfigCacheTtlMs = 60_000;

export const runtimeConfigKeys = [
  "TRANSACTIONAL_EMAIL_PROVIDER",
  "ACTIVE_ANALYTICS_PROVIDER",
  "ACTIVE_SCHEDULING_PROVIDER",
  "GMAIL_SENDER_EMAIL",
  "GMAIL_SENDER_NAME",
  "GA4_MEASUREMENT_ID",
  "GOOGLE_CALENDAR_CALENDAR_ID",
  "GOOGLE_CALENDAR_DEFAULT_TIMEZONE",
  "SES_SENDER_EMAIL",
  "SES_SENDER_NAME",
  "AWS_REGION",
  "STRIPE_PUBLISHABLE_KEY",
  "CALENDLY_EVENT_TYPE_URI",
  "POSTHOG_PROJECT_API_KEY",
  "POSTHOG_HOST",
  "POSTHOG_PROJECT_ID",
] as const;

export const sensitiveRuntimeBindingNames = [
  "GA4_API_SECRET",
  "GMAIL_OAUTH_CLIENT_ID",
  "GMAIL_OAUTH_CLIENT_SECRET",
  "GMAIL_OAUTH_REFRESH_TOKEN",
  "GMAIL_STATUS_CALLBACK_TOKEN",
  "GOOGLE_CALENDAR_CLIENT_ID",
  "GOOGLE_CALENDAR_CLIENT_SECRET",
  "GOOGLE_CALENDAR_REFRESH_TOKEN",
  "GOOGLE_CALENDAR_STATUS_CALLBACK_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "POSTHOG_PERSONAL_API_KEY",
] as const;

const runtimeConfigKeySet = new Set<string>(runtimeConfigKeys);
const sensitiveRuntimeBindingSet = new Set<string>(sensitiveRuntimeBindingNames);

type RuntimeConfigMap = Record<string, string>;

let cachedConfig: {
  cacheKey: string;
  loadedAt: number;
  values: RuntimeConfigMap;
} | null = null;

export const isRuntimeConfigKey = (key: unknown): key is typeof runtimeConfigKeys[number] =>
  runtimeConfigKeySet.has(safeString(key));

export const isSensitiveRuntimeBindingName = (key: unknown) =>
  sensitiveRuntimeBindingSet.has(safeString(key));

const cacheKeyForEnv = (env: RuntimeEnv) =>
  [
    safeString(env.ASTROPAGES_PROJECT_ID) || "local-project",
    safeString(env.ASTROPAGES_SITE_ENVIRONMENT) || "local",
  ].join(":");

export const invalidateRuntimeConfigCache = () => {
  cachedConfig = null;
};

export const getRuntimeConfig = async (env: RuntimeEnv): Promise<RuntimeConfigMap> => {
  const cacheKey = cacheKeyForEnv(env);
  const now = Date.now();
  if (
    cachedConfig &&
    cachedConfig.cacheKey === cacheKey &&
    now - cachedConfig.loadedAt < runtimeConfigCacheTtlMs
  ) {
    return cachedConfig.values;
  }

  const values: RuntimeConfigMap = {};
  if (env.DB) {
    try {
      const statement = env.DB.prepare(
        `SELECT key, value, status
         FROM ${tables.runtimeConfig}
         WHERE status IN ('active', 'disabled')`,
      );
      const rows = await statement.all?.<{ key?: string; value?: string; status?: string }>() ?? { results: [] };
      for (const row of rows.results ?? []) {
        const key = safeString(row.key);
        if (isRuntimeConfigKey(key)) {
          values[key] = row.status === "disabled"
            ? (["TRANSACTIONAL_EMAIL_PROVIDER", "ACTIVE_ANALYTICS_PROVIDER", "ACTIVE_SCHEDULING_PROVIDER"].includes(key) ? "none" : "")
            : safeString(row.value);
        }
      }
    } catch (error) {
      if (!isMissingRuntimeConfigTableError(error)) throw error;
    }
  }

  cachedConfig = { cacheKey, loadedAt: now, values };
  return values;
};

export const getRuntimeConfigValue = async (
  env: RuntimeEnv,
  key: typeof runtimeConfigKeys[number],
) => {
  const config = await getRuntimeConfig(env);
  const configuredValue = safeString(config[key]);
  if (Object.hasOwn(config, key)) return configuredValue;

  // Local/template maintenance fallback; production generated sites should use D1 runtime config.
  return safeString(env[key]) || await resolveRuntimeBinding(env[key]);
};

export const upsertRuntimeConfigRows = async ({
  env,
  config,
  disabledKeys,
}: {
  env: RuntimeEnv;
  config: Array<{
    key: string;
    value: string;
    providerKey?: string;
    status?: "active" | "disabled";
  }>;
  disabledKeys: string[];
}) => {
  if (!env.DB) throw new Error("Runtime configuration database is unavailable.");
  const selections: Record<string, string[]> = {
    TRANSACTIONAL_EMAIL_PROVIDER: ["ses", "gmail"],
    ACTIVE_ANALYTICS_PROVIDER: ["posthog", "ga4", "ga4_measurement_protocol"],
    ACTIVE_SCHEDULING_PROVIDER: ["calendly", "google_calendar"],
  };
  for (const item of config) {
    if (selections[item.key] && item.status !== "disabled" && !selections[item.key].includes(item.value)) throw new Error("Unsupported active integration provider.");
  }
  const now = new Date().toISOString();

  for (const item of config) {
    const key = safeString(item.key);
    if (!isRuntimeConfigKey(key) || isSensitiveRuntimeBindingName(key)) continue;
    const status = item.status === "disabled" ? "disabled" : "active";
    await env.DB.prepare(
      `INSERT INTO ${tables.runtimeConfig} (
        key, value, provider_key, scope, status, updated_at
      ) VALUES (?, ?, ?, 'provider', ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        provider_key = excluded.provider_key,
        scope = excluded.scope,
        status = excluded.status,
        updated_at = excluded.updated_at`,
    ).bind(
      key,
      safeString(item.value),
      safeString(item.providerKey) || null,
      status,
      now,
    ).run?.();
  }

  for (const key of disabledKeys) {
    const safeKey = safeString(key);
    if (!isRuntimeConfigKey(safeKey) || isSensitiveRuntimeBindingName(safeKey)) continue;
    await env.DB.prepare(
      `INSERT INTO ${tables.runtimeConfig} (key, value, provider_key, scope, status, updated_at)\n       VALUES (?, '', NULL, 'provider', 'disabled', ?)\n       ON CONFLICT(key) DO UPDATE SET status = 'disabled', updated_at = excluded.updated_at`,
    ).bind(safeKey, now).run?.();
  }

  invalidateRuntimeConfigCache();
};
