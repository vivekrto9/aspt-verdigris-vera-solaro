import assert from "node:assert/strict";
import test from "node:test";

import { github } from "../scripts/ensure-cloudflare-resources.mjs";

test("GitHub repository variable requests retry transient fetch failures", async (context) => {
  const originalFetch = globalThis.fetch;
  const delays = [];
  let requestCount = 0;

  context.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => {
    requestCount += 1;
    if (requestCount === 1) {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
      });
    }
    return new Response(JSON.stringify({ name: "PRODUCTION_SITE_URL", value: "https://example.test" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const result = await github(
    "/repos/example/site/actions/variables/PRODUCTION_SITE_URL",
    { method: "GET" },
    "test-token",
    {},
    {
      attempts: 2,
      sleepFn: async (delayMs) => delays.push(delayMs),
    },
  );

  assert.equal(result.status, 200);
  assert.equal(requestCount, 2);
  assert.deepEqual(delays, [2_000]);
});

test("GitHub repository variable requests do not retry authorization failures", async (context) => {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;

  context.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => {
    requestCount += 1;
    return new Response(JSON.stringify({ message: "Bad credentials" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  };

  await assert.rejects(
    github(
      "/repos/example/site/actions/variables/PRODUCTION_SITE_URL",
      { method: "GET" },
      "bad-token",
      {},
      { attempts: 2, sleepFn: async () => assert.fail("must not sleep") },
    ),
    /Bad credentials/,
  );
  assert.equal(requestCount, 1);
});
