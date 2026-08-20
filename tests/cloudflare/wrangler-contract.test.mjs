import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  platformGooglePlacesSecretBinding,
  secretStoreBindingsForGeneratedSite,
  loadWranglerConfig,
  runtimeContract,
  validateCloudflareRuntimeConfig,
} from "../../scripts/cloudflare-runtime-contract.mjs";
import { assertWranglerRuntimeContract } from "./generated-site-contract-assertions.mjs";

const workerSource = readFileSync(new URL("../../src/worker.ts", import.meta.url), "utf8");
const veraEmailSource = readFileSync(new URL("../../src/server/vera/email.ts", import.meta.url), "utf8");
const renderWranglerSource = readFileSync(
  new URL("../../scripts/render-wrangler-config.mjs", import.meta.url),
  "utf8",
);

test("wrangler config defines local, preview, and production runtime bindings", () => {
  const config = loadWranglerConfig();

  assert.deepEqual(validateCloudflareRuntimeConfig(config), []);
  assert.deepEqual(Object.keys(config.env).sort(), ["preview", "production"]);

  for (const envName of ["local", ...runtimeContract.environments]) {
    const section = envName === "local" ? config : config.env[envName];
    assert.equal(section.images.binding, "IMAGES");
    assert.equal(section.d1_databases[0].binding, "DB");
    assert.equal(section.r2_buckets[0].binding, "MEDIA");
    assert.equal(section.kv_namespaces[0].binding, "SESSION");
    assert.equal(section.worker_loaders[0].binding, "LOADER");
    assert.equal(section.assets.binding, "ASSETS");
    assert.equal(section.queues.producers[0].binding, "EMAIL_QUEUE");
    assert.equal(
      section.queues.producers[0].queue,
      runtimeContract.resources[envName].emailQueueName,
    );
    assert.equal(
      section.queues.consumers[0].dead_letter_queue,
      runtimeContract.resources[envName].emailDeadLetterQueueName,
    );
    assert.deepEqual(section.triggers.crons, runtimeContract.cronSchedules);
    assert.equal(section.observability.logs.enabled, true);
    assert.deepEqual(section.assets.run_worker_first, runtimeContract.workerFirstRoutes);
    if (envName === "local") {
      assert.equal(section.secrets, undefined);
    } else {
      assert.deepEqual(section.secrets.required, runtimeContract.requiredSecretNames);
    }
    for (const bindingName of runtimeContract.optionalProviderBindingNames) {
      assert.equal(section.secrets?.required?.includes(bindingName) ?? false, false);
    }
  }
});

test("preview and production resource names match the approved contract", () => {
  const config = loadWranglerConfig();
  const serializedConfig = JSON.stringify(config);

  assert.doesNotMatch(serializedConfig, /third-project/);

  assert.equal(config.env.preview.name, runtimeContract.resources.preview.workerName);
  assert.equal(
    config.env.preview.d1_databases[0].database_name,
    runtimeContract.resources.preview.d1DatabaseName,
  );
  assert.equal(
    config.env.preview.r2_buckets[0].bucket_name,
    runtimeContract.resources.preview.r2BucketName,
  );
  assert.equal(
    config.env.preview.kv_namespaces[0].id,
    "PREVIEW_SESSION_KV_NAMESPACE_ID_FROM_WRANGLER_CREATE",
  );

  assert.equal(
    config.env.production.name,
    runtimeContract.resources.production.workerName,
  );
  assert.equal(
    config.env.production.d1_databases[0].database_name,
    runtimeContract.resources.production.d1DatabaseName,
  );
  assert.equal(
    config.env.production.r2_buckets[0].bucket_name,
    runtimeContract.resources.production.r2BucketName,
  );
  assert.equal(
    config.env.production.kv_namespaces[0].id,
    "PRODUCTION_SESSION_KV_NAMESPACE_ID_FROM_WRANGLER_CREATE",
  );
});

test("worker secret contract and generated-site Secret Store bindings match platform contract", () => {
  assertWranglerRuntimeContract();
  assert.deepEqual(runtimeContract.generatedSiteRequiredSecretNames, [
    "EMDASH_ENCRYPTION_KEY",
    "ASTROPAGES_CONTROL_PLANE_CALLBACK_TOKEN",
  ]);
  const bindings = secretStoreBindingsForGeneratedSite({
    envName: "preview",
    projectId: "11111111-1111-4111-8111-111111111111",
    storeId: "store-123",
  });
  assert.deepEqual(
    bindings.map((binding) => binding.binding),
    [platformGooglePlacesSecretBinding],
  );
});

test("runtime provider binding contract is scoped to Vera integrations", () => {
  assert.deepEqual(
    runtimeContract.sensitiveProviderSecretBindings.map(({ binding }) => binding),
    [
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "POSTHOG_PERSONAL_API_KEY",
      "CALENDLY_API_TOKEN",
      "CALENDLY_WEBHOOK_SIGNING_KEY",
      "GOOGLE_PLACES_API_KEY",
    ],
  );
  assert.equal(
    runtimeContract.optionalProviderBindingNames.some((name) =>
      /RAZORPAY|GA4_|ZAPIER|GOOGLE_CALENDAR|WATI|MAILCHIMP|X_ASTROLOGYAPI|PAYMENT_PROVIDER/.test(name)
    ),
    false,
  );
  assert.deepEqual(runtimeContract.publicRuntimeVarNames, []);
  assert.doesNotMatch(
    JSON.stringify(runtimeContract.optionalProviderBindingNames),
    /GTM|META_PIXEL|GOOGLE_ADS/,
  );
});

test("worker consumes queued email wake-ups and recovers scheduled Vera work", () => {
  assert.match(workerSource, /queue\(batch: VeraQueueBatch/);
  assert.match(workerSource, /scheduled\(_event: unknown/);
  assert.match(workerSource, /processEmailOutbox/);
  assert.match(workerSource, /dispatchDueCampaigns/);
  assert.match(workerSource, /dispatchDueFollowUps/);
  assert.match(workerSource, /expireStaleVeraBookings/);
  assert.match(workerSource, /completeElapsedVeraBookings/);
  assert.match(workerSource, /ap_vera_rate_limits WHERE datetime\(updated_at\) < datetime\(\?\)/);
  assert.match(workerSource, /maybeHandleUsersDataMcpToolCall/);
  assert.match(veraEmailSource, /EMAIL_QUEUE\.send\(\{ version: 1, kind: "vera-email-outbox", outboxId \}\)/);
  assert.match(veraEmailSource, /scheduled delivery will retry/);
});

test("rendered deployments expose the canonical environment URL to Vera runtime links", () => {
  assert.match(renderWranglerSource, /const siteUrlVariable = `\$\{variablePrefix\}_SITE_URL`/);
  assert.match(renderWranglerSource, /ASTROPAGES_SITE_URL: siteUrl/);
  assert.match(renderWranglerSource, /must be an absolute HTTPS origin/);
});
