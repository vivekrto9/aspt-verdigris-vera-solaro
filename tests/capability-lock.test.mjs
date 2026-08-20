import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const lock = JSON.parse(readFileSync(new URL("../capability-lock.json", import.meta.url), "utf8"));

test("capability lock pins the neutral runtime and email-template capabilities", () => {
  assert.equal(lock.lockVersion, "0.3.0");
  assert.equal(Object.hasOwn(lock, "templateRegistryVersionId"), false);
  assert.deepEqual(
    lock.capabilities.map((capability) => capability.capabilityKey),
    [
      "content-seo-localization",
      "generated-site-operations",
      "customer-auth",
      "transactional-notifications",
    ],
  );
  assert.equal(JSON.stringify(lock).includes("astrology-api"), false);
  assert.equal(JSON.stringify(lock).includes("ai-chat"), false);
  assert.equal(JSON.stringify(lock).includes("lead-capture"), false);
});
