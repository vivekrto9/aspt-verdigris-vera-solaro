import assert from "node:assert/strict";
import test from "node:test";

test("runtime binding resolution times out stalled Secret Store reads", async () => {
  const { resolveRuntimeBinding } = await import("../../src/server/aggregator/runtime-bindings.ts");
  const startedAt = Date.now();
  const value = await resolveRuntimeBinding({
    get: () => new Promise(() => {}),
  });

  assert.equal(value, "");
  assert.ok(Date.now() - startedAt < 2500);
});

test("Worker secrets win and the legacy bundle remains a fallback", async () => {
  const { integrationSecretBundleBinding, resolveSecretBinding } = await import("../../src/server/aggregator/runtime-bindings.ts");
  const env = {
    DIRECT_SECRET: "direct-value",
    [integrationSecretBundleBinding]: JSON.stringify({ secrets: {
      DIRECT_SECRET: "bundled-value",
      BUNDLE_ONLY_SECRET: "legacy-value",
    } }),
  };

  assert.equal(await resolveSecretBinding(env, "DIRECT_SECRET"), "direct-value");
  assert.equal(await resolveSecretBinding(env, "BUNDLE_ONLY_SECRET"), "legacy-value");
});
