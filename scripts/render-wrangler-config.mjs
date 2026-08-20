import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  loadWranglerConfig,
  runtimeContract,
  secretStoreBindingsForGeneratedSite,
} from "./cloudflare-runtime-contract.mjs";

const envName = process.argv[2];
if (!["preview", "production"].includes(envName)) {
  fail("Usage: node scripts/render-wrangler-config.mjs <preview|production>");
}

const variablePrefix = deploymentVariablePrefix(envName);
const sourceConfig = loadWranglerConfig();
const config = loadDeployConfig();
const section = structuredClone(sourceConfig.env?.[envName]);
if (!section) fail(`wrangler.jsonc is missing env.${envName}`);
const generatedSiteMode = isGeneratedSiteMode();
const requiredSecretNames = requiredWorkerSecretNames(generatedSiteMode);

const d1Id = requiredEnv(`${variablePrefix}_SITE_D1_DATABASE_ID`);
const kvId = requiredEnv(`${variablePrefix}_SITE_SESSION_KV_NAMESPACE_ID`);

rewriteDeployPaths(config);
rewriteDeployPaths(section);
applyDynamicRouteAssetRules(config);
applyDynamicRouteAssetRules(section);
stripEmptyWarningSections(config);
section.d1_databases = section.d1_databases.map((database) =>
  database.binding === runtimeContract.bindingNames.d1
    ? { ...database, database_id: d1Id, migrations_dir: "../../migrations" }
    : database,
);
section.kv_namespaces = section.kv_namespaces.map((namespace) =>
  namespace.binding === runtimeContract.bindingNames.kv
    ? { ...namespace, id: kvId }
    : namespace,
);

const secretStoreBindings = generatedSiteSecretStoreBindings(envName);
if (secretStoreBindings.length > 0) {
  section.secrets_store_secrets = secretStoreBindings;
}
applyGeneratedSiteSsoVars(section, envName);

config.secrets = {
  required: requiredSecretNames,
};
section.secrets = {
  required: requiredSecretNames,
};
config.env = {
  ...(config.env ?? {}),
  [envName]: section,
};
if (generatedSiteMode) {
  stripGeneratedSiteQueueBindings(config);
}

const outputPath = join(".wrangler", "generated", `wrangler.${envName}.jsonc`);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`);
console.log(`Rendered ${outputPath}`);

function loadDeployConfig() {
  const builtConfigPath = join("dist", "server", "wrangler.json");
  if (existsSync(builtConfigPath)) {
    return JSON.parse(readFileSync(builtConfigPath, "utf8"));
  }
  return loadWranglerConfig();
}

function rewriteDeployPaths(config) {
  if (existsSync(join("dist", "server", "entry.mjs"))) {
    config.main = "../../dist/server/entry.mjs";
  } else if (config.main) {
    config.main = "../../src/worker.ts";
  }
  if (config.assets?.directory) {
    config.assets.directory = "../../dist/client";
  }
}

function applyDynamicRouteAssetRules(config) {
  if (config.assets) {
    config.assets.run_worker_first = runtimeContract.workerFirstRoutes;
  }
}

function stripEmptyWarningSections(config) {
  for (const key of [
    "vars",
    "durable_objects",
    "workflows",
    "migrations",
    "cloudchamber",
    "send_email",
    "queues",
    "vectorize",
    "ai_search_namespaces",
    "ai_search",
    "hyperdrive",
    "services",
    "analytics_engine_datasets",
    "dispatch_namespaces",
    "mtls_certificates",
    "pipelines",
    "secrets_store_secrets",
    "artifacts",
    "unsafe_hello_world",
    "flagship",
    "ratelimits",
    "vpc_services",
    "vpc_networks",
  ]) {
    const value = config[key];
    if (isEffectivelyEmpty(value)) {
      delete config[key];
    }
  }
}

function isEffectivelyEmpty(value) {
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  const entries = Object.values(value);
  return entries.length === 0 || entries.every(isEffectivelyEmpty);
}

function deploymentVariablePrefix(envName) {
  return envName === "production" ? "PRODUCTION" : "PREVIEW";
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) fail(`${name} is required`);
  return value;
}

function generatedSiteSecretStoreBindings(envName) {
  const projectId = process.env.ASTROPAGES_PROJECT_ID;
  const storeId = process.env.CLOUDFLARE_SECRETS_STORE_ID;
  if (!projectId && !storeId) {
    return [];
  }
  if (!projectId) {
    fail("ASTROPAGES_PROJECT_ID is required when CLOUDFLARE_SECRETS_STORE_ID is set");
  }
  if (!storeId) {
    fail("CLOUDFLARE_SECRETS_STORE_ID is required when ASTROPAGES_PROJECT_ID is set");
  }
  try {
    return secretStoreBindingsForGeneratedSite({
      envName,
      projectId,
      storeId,
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : "Invalid generated-site Secret Store configuration");
  }
}

function applyGeneratedSiteSsoVars(section, envName) {
  const variablePrefix = deploymentVariablePrefix(envName);
  const siteUrlVariable = `${variablePrefix}_SITE_URL`;
  const siteUrl = normalizeSiteUrl(requiredEnv(siteUrlVariable), siteUrlVariable);
  section.vars = {
    ...(section.vars ?? {}),
    ASTROPAGES_SITE_URL: siteUrl,
  };

  const projectId = process.env.ASTROPAGES_PROJECT_ID;
  if (!projectId) {
    return;
  }
  const publicJwk = process.env.ASTROPAGES_SSO_PUBLIC_JWK;
  if (!publicJwk) {
    fail("ASTROPAGES_SSO_PUBLIC_JWK is required when ASTROPAGES_PROJECT_ID is set");
  }
  const callbackBaseUrl = process.env.ASTROPAGES_CONTROL_PLANE_CALLBACK_BASE_URL;
  if (!callbackBaseUrl || !/^https?:\/\//i.test(callbackBaseUrl)) {
    fail("ASTROPAGES_CONTROL_PLANE_CALLBACK_BASE_URL is required when ASTROPAGES_PROJECT_ID is set");
  }
  section.vars = {
    ...(section.vars ?? {}),
    ASTROPAGES_PROJECT_ID: projectId,
    ASTROPAGES_SITE_ENVIRONMENT: envName,
    ASTROPAGES_SSO_PUBLIC_JWK: publicJwk,
    ASTROPAGES_CONTROL_PLANE_CALLBACK_BASE_URL: callbackBaseUrl.replace(/\/+$/, ""),
  };
}

function normalizeSiteUrl(value, variableName) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${variableName} must be an absolute HTTPS origin`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname && parsed.pathname !== "/")
  ) {
    fail(`${variableName} must be an absolute HTTPS origin`);
  }
  return parsed.origin;
}

function isGeneratedSiteMode() {
  return Boolean(process.env.ASTROPAGES_PROJECT_ID) ||
    process.env.ASTROPAGES_GENERATED_SITE_MODE === "1";
}

function requiredWorkerSecretNames(generatedSiteMode) {
  if (generatedSiteMode) {
    return runtimeContract.generatedSiteRequiredSecretNames ?? runtimeContract.requiredSecretNames;
  }
  return runtimeContract.requiredSecretNames;
}

function stripGeneratedSiteQueueBindings(config) {
  delete config.queues;
  for (const environment of Object.values(config.env ?? {})) {
    if (environment && typeof environment === "object") {
      delete environment.queues;
    }
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
