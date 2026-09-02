import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
test("runtime supports explicit provider selections and disabled rows", () => {
  const source = read("src/server/aggregator/runtime-config.ts");
  for (const key of ["TRANSACTIONAL_EMAIL_PROVIDER", "ACTIVE_ANALYTICS_PROVIDER", "ACTIVE_SCHEDULING_PROVIDER"]) assert.match(source, new RegExp(key));
  assert.match(source, /status IN \('active', 'disabled'\)/);
  assert.match(source, /Object\.hasOwn\(config, key\)/);
});
test("transactional mail routes Gmail and SES without fallback", () => {
  const source = read("src/server/aggregator/notifications/transactional.ts");
  assert.match(source, /provider === "ses"/);
  assert.match(source, /gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages\/send/);
  assert.match(source, /Never retry a send automatically/);
  assert.doesNotMatch(source, /catch[\s\S]{0,160}sendSesTransactionalEmail/);
});
test("analytics is consent gated and only initializes the active provider", () => {
  const source = read("src/scripts/visitor-analytics.ts");
  assert.match(source, /consent\(\)/);
  assert.match(source, /config\.provider === "posthog"/);
  assert.match(source, /ga4_measurement_protocol|ga4/);
  assert.match(source, /setInterval/);
  assert.doesNotMatch(source, /ASTROPAGES_TEST_ANALYTICS_ENABLED/);
});
test("provider-neutral idempotency schema is forward-only", () => {
  const migrations = readdirSync(new URL("migrations/", root)).map((name) => read("migrations/" + name)).join("\n");
  assert.match(migrations, /ap_analytics_deliveries/);
  assert.match(migrations, /ap_email_deliveries/);
  assert.match(migrations, /ap_booking_preview_policy/);
});
