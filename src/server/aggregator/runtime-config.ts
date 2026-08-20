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
  "SES_SENDER_EMAIL",
  "SES_SENDER_NAME",
  "AWS_REGION",
  "STRIPE_PUBLISHABLE_KEY",
  "VERA_CALENDLY_NATAL_HOUR_CALL_URI",
  "VERA_CALENDLY_NATAL_HOUR_IN_PERSON_URI",
  "VERA_CALENDLY_YEAR_AHEAD_CALL_URI",
  "VERA_CALENDLY_YEAR_AHEAD_IN_PERSON_URI",
  "VERA_CALENDLY_TWO_CHARTS_CALL_URI",
  "VERA_CALENDLY_TWO_CHARTS_IN_PERSON_URI",
  "POSTHOG_PROJECT_API_KEY",
  "POSTHOG_HOST",
  "POSTHOG_PROJECT_ID",
] as const;

export const sensitiveRuntimeBindingNames = [
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
        `SELECT key, value
         FROM ${tables.runtimeConfig}
         WHERE status = 'active'`,
      );
      const rows = await statement.all?.<{ key?: string; value?: string }>() ?? { results: [] };
      for (const row of rows.results ?? []) {
        const key = safeString(row.key);
        if (isRuntimeConfigKey(key)) {
          values[key] = safeString(row.value);
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
  if (configuredValue) return configuredValue;

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
  if (!env.DB) return;
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
      `UPDATE ${tables.runtimeConfig}
       SET status = 'disabled', updated_at = ?
       WHERE key = ?`,
    ).bind(now, safeKey).run?.();
  }

  invalidateRuntimeConfigCache();
};
