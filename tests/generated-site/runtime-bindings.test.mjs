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
