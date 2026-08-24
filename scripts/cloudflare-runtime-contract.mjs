import { readFileSync } from "node:fs";
import { join } from "node:path";

export const runtimeContract = {
  environments: ["preview", "production"],
  bindingNames: {
    d1: "DB",
    r2: "MEDIA",
    kv: "SESSION",
    workerLoader: "LOADER",
    images: "IMAGES",
    emailQueue: "EMAIL_QUEUE",
  },
  resources: {
    local: {
      workerName: "aspt-verdigris-vera-solaro",
      d1DatabaseName: "aspt-verdigris-vera-solaro-site",
      r2BucketName: "aspt-verdigris-vera-solaro-media",
      kvNamespaceName: "LOCAL_ASPT_VERDIGRIS_VERA_SOLARO_SESSION_KV",
      emailQueueName: "aspt-verdigris-vera-solaro-email",
      emailDeadLetterQueueName: "aspt-verdigris-vera-solaro-email-dlq",
    },
    preview: {
      workerName: "aspt-verdigris-vera-solaro-preview",
      d1DatabaseName: "aspt-verdigris-vera-solaro-preview-site",
      r2BucketName: "aspt-verdigris-vera-solaro-preview-media",
      kvNamespaceName: "aspt-verdigris-vera-solaro-preview-session",
      emailQueueName: "aspt-verdigris-vera-solaro-preview-email",
      emailDeadLetterQueueName: "aspt-verdigris-vera-solaro-preview-email-dlq",
    },
    production: {
      workerName: "aspt-verdigris-vera-solaro-production",
      d1DatabaseName: "aspt-verdigris-vera-solaro-production-site",
      r2BucketName: "aspt-verdigris-vera-solaro-production-media",
      kvNamespaceName: "aspt-verdigris-vera-solaro-production-session",
      emailQueueName: "aspt-verdigris-vera-solaro-production-email",
      emailDeadLetterQueueName: "aspt-verdigris-vera-solaro-production-email-dlq",
    },
  },
  requiredSecretNames: ["EMDASH_ENCRYPTION_KEY", "ASTROPAGES_CONTROL_PLANE_CALLBACK_TOKEN"],
  generatedSiteRequiredSecretNames: ["EMDASH_ENCRYPTION_KEY", "ASTROPAGES_CONTROL_PLANE_CALLBACK_TOKEN"],
  sensitiveProviderSecretBindings: [
    { binding: "STRIPE_SECRET_KEY", provider: "STRIPE" },
    { binding: "STRIPE_WEBHOOK_SECRET", provider: "STRIPE" },
    { binding: "AWS_ACCESS_KEY_ID", provider: "AWS_SES" },
    { binding: "AWS_SECRET_ACCESS_KEY", provider: "AWS_SES" },
    { binding: "POSTHOG_PERSONAL_API_KEY", provider: "POSTHOG" },
    { binding: "CALENDLY_API_TOKEN", provider: "CALENDLY" },
    { binding: "CALENDLY_WEBHOOK_SIGNING_KEY", provider: "CALENDLY" },
    { binding: "GOOGLE_PLACES_API_KEY", provider: "GOOGLE_PLACES" },
  ],
  optionalProviderBindingNames: [
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "PUBLIC_STRIPE_PUBLISHABLE_KEY",
    "SES_SENDER_EMAIL",
    "SES_SENDER_NAME",
    "AWS_REGION",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "POSTHOG_PROJECT_API_KEY",
    "POSTHOG_PERSONAL_API_KEY",
    "POSTHOG_HOST",
    "POSTHOG_PROJECT_ID",
    "CALENDLY_API_TOKEN",
    "CALENDLY_WEBHOOK_SIGNING_KEY",
    "CALENDLY_30_MIN_EVENT_TYPE_URI",
    "GOOGLE_PLACES_API_KEY",
  ],
  publicRuntimeVarNames: [],
  workerFirstRoutes: ["/_emdash/*", "/api/*"],
  cronSchedules: ["*/2 * * * *"],
};

export const integrationSecretBundleBinding = "ASTROPAGES_INTEGRATION_SECRETS_JSON";
export const integrationSecretBundleSecretProvider = "INTEGRATIONS";
export const integrationSecretBundleSecretName = "INTEGRATION_SECRETS_JSON";
export const platformGooglePlacesSecretBinding = "ASTROPAGES_PLATFORM_GOOGLE_PLACES_API_KEY";
export const platformGooglePlacesSecretName = "ASTROPAGES_PLATFORM_GOOGLE_PLACES_GOOGLE_PLACES_API_KEY";

const projectIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const namePartPattern = /^[A-Z0-9_]+$/;

export const projectIdHexForSecretStore = (projectId) => {
  const normalizedProjectId = String(projectId ?? "").trim();
  if (!projectIdPattern.test(normalizedProjectId)) {
    throw new Error("ASTROPAGES_PROJECT_ID must be a valid UUID");
  }
  return normalizedProjectId.replaceAll("-", "").toUpperCase();
};

export const secretStoreSecretName = ({ envName, projectId, provider, bindingName }) => {
  const normalizedEnvName = String(envName ?? "").toUpperCase();
  if (!["PREVIEW", "PRODUCTION"].includes(normalizedEnvName)) {
    throw new Error("Secret Store environment must be preview or production");
  }
  if (!namePartPattern.test(provider)) {
    throw new Error("Secret Store provider must use uppercase alphanumeric or underscore characters");
  }
  if (!namePartPattern.test(bindingName)) {
    throw new Error("Secret Store binding name must use uppercase alphanumeric or underscore characters");
  }
  return `ASTROPAGES_${normalizedEnvName}_${projectIdHexForSecretStore(projectId)}_${provider}_${bindingName}`;
};

export const secretStoreSecretNameForBinding = ({ envName, projectId, binding }) => {
  const entry = runtimeContract.sensitiveProviderSecretBindings.find(
    (candidate) => candidate.binding === binding,
  );
  if (!entry) {
    throw new Error(`${binding} is not a sensitive provider Secret Store binding`);
  }
  return secretStoreSecretName({
    envName,
    projectId,
    provider: entry.provider,
    bindingName: entry.binding,
  });
};

export const secretStoreBundleSecretName = ({ envName, projectId }) =>
  secretStoreSecretName({
    envName,
    projectId,
    provider: integrationSecretBundleSecretProvider,
    bindingName: integrationSecretBundleSecretName,
  });

export const secretStoreBindingsForGeneratedSite = ({ envName, projectId, storeId, bindings = [] }) => {
  if (!storeId || typeof storeId !== "string") {
    throw new Error("CLOUDFLARE_SECRETS_STORE_ID is required for generated-site Secret Store bindings");
  }
  projectIdHexForSecretStore(projectId);
  return [
    {
      binding: platformGooglePlacesSecretBinding,
      store_id: storeId,
      secret_name: platformGooglePlacesSecretName,
    },
  ];
};

export const stripJsonc = (value) => {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const next = value[index + 1];

    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }

    if (char === "/" && next === "/") {
      while (index < value.length && value[index] !== "\n") {
        index += 1;
      }
      result += "\n";
      continue;
    }

    result += char;
  }

  return result.replace(/,\s*([}\]])/g, "$1");
};

export const readJsonc = (path) =>
  JSON.parse(stripJsonc(readFileSync(path, "utf8")));

const firstBinding = (items, binding) =>
  Array.isArray(items) ? items.find((item) => item.binding === binding) : undefined;

const validateEnvironmentBindings = (config, envName, failures) => {
  const section = envName === "local" ? config : config.env?.[envName];
  const expected = runtimeContract.resources[envName];

  if (!section) {
    failures.push(`missing ${envName} environment`);
    return;
  }

  if (section.name !== expected.workerName) {
    failures.push(`${envName} worker name must be ${expected.workerName}`);
  }

  const d1 = firstBinding(section.d1_databases, runtimeContract.bindingNames.d1);
  if (!d1 || d1.database_name !== expected.d1DatabaseName) {
    failures.push(`${envName} D1 binding must use ${expected.d1DatabaseName}`);
  }

  const r2 = firstBinding(section.r2_buckets, runtimeContract.bindingNames.r2);
  if (!r2 || r2.bucket_name !== expected.r2BucketName) {
    failures.push(`${envName} R2 binding must use ${expected.r2BucketName}`);
  }

  const kv = firstBinding(section.kv_namespaces, runtimeContract.bindingNames.kv);
  if (!kv) {
    failures.push(`${envName} KV binding SESSION is required`);
  }

  if (envName === "local" && kv?.id !== expected.kvNamespaceName) {
    failures.push(`${envName} KV id must stay local-only`);
  }

  if (
    envName !== "local" &&
    kv?.id !== `${envName.toUpperCase()}_SESSION_KV_NAMESPACE_ID_FROM_WRANGLER_CREATE`
  ) {
    failures.push(`${envName} KV id must be an operator-filled placeholder`);
  }

  const loader = firstBinding(
    section.worker_loaders,
    runtimeContract.bindingNames.workerLoader,
  );
  if (!loader) {
    failures.push(`${envName} Worker Loader binding LOADER is required`);
  }

  if (section.images?.binding !== runtimeContract.bindingNames.images) {
    failures.push(`${envName} Images binding must be IMAGES`);
  }

  const emailProducer = firstBinding(
    section.queues?.producers,
    runtimeContract.bindingNames.emailQueue,
  );
  if (emailProducer?.queue !== expected.emailQueueName) {
    failures.push(`${envName} EMAIL_QUEUE producer must use ${expected.emailQueueName}`);
  }
  const emailConsumer = Array.isArray(section.queues?.consumers)
    ? section.queues.consumers.find((consumer) => consumer.queue === expected.emailQueueName)
    : undefined;
  if (!emailConsumer) {
    failures.push(`${envName} email Queue consumer is required`);
  } else {
    if (emailConsumer.dead_letter_queue !== expected.emailDeadLetterQueueName) {
      failures.push(`${envName} email Queue consumer must use ${expected.emailDeadLetterQueueName} as its DLQ`);
    }
    if (emailConsumer.max_retries !== 5) {
      failures.push(`${envName} email Queue consumer must retry five times`);
    }
  }

  if (JSON.stringify(section.triggers?.crons) !== JSON.stringify(runtimeContract.cronSchedules)) {
    failures.push(`${envName} must schedule the email outbox cron`);
  }
  if (section.observability?.enabled !== true || section.observability?.logs?.enabled !== true) {
    failures.push(`${envName} must enable Worker observability logs`);
  }

  if (section.assets?.binding !== "ASSETS") {
    failures.push(`${envName} assets binding must be ASSETS`);
  }

  if (
    JSON.stringify(section.assets?.run_worker_first) !==
    JSON.stringify(runtimeContract.workerFirstRoutes)
  ) {
    failures.push(
      `${envName} assets.run_worker_first must route EmDash and generated-site APIs through the Worker before static assets`,
    );
  }

  const requiredSecrets = section.secrets?.required ?? config.secrets?.required ?? [];
  if (envName !== "local") {
    for (const secretName of runtimeContract.requiredSecretNames) {
      if (!requiredSecrets.includes(secretName)) {
        failures.push(`${envName} must declare required secret ${secretName}`);
      }
    }
  }

  for (const bindingName of runtimeContract.optionalProviderBindingNames) {
    if (requiredSecrets.includes(bindingName)) {
      failures.push(`${envName} must not require optional provider binding ${bindingName}`);
    }
  }

  const secretStoreBindings = section.secrets_store_secrets ?? [];
  for (const publicVarName of runtimeContract.publicRuntimeVarNames) {
    if (firstBinding(secretStoreBindings, publicVarName)) {
      failures.push(`${envName} must not bind public runtime var ${publicVarName} through Secret Store`);
    }
  }

  if (envName !== "local") {
    const vars = section.vars ?? {};
    for (const publicVarName of runtimeContract.publicRuntimeVarNames) {
      if (!(publicVarName in vars)) {
        failures.push(`${envName} must declare public runtime var ${publicVarName}`);
      }
    }
  }
};

export const validateCloudflareRuntimeConfig = (config) => {
  const failures = [];

  validateEnvironmentBindings(config, "local", failures);
  for (const envName of runtimeContract.environments) {
    validateEnvironmentBindings(config, envName, failures);
  }

  const serialized = JSON.stringify(config);
  for (const secretName of runtimeContract.requiredSecretNames) {
    if (new RegExp(`${secretName}\\s*[:=]`).test(serialized)) {
      failures.push(`${secretName} must not be stored in wrangler.jsonc`);
    }
  }

  return failures;
};

export const loadWranglerConfig = (root = process.cwd()) =>
  readJsonc(join(root, "wrangler.jsonc"));
