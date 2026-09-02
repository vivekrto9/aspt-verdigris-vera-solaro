import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("shared layout installs consent-gated active-provider analytics", () => {
  const layoutName = readdirSync(new URL("../src/layouts/", import.meta.url))
    .find((name) => name.endsWith("Layout.astro") && read(`src/layouts/${name}`).includes("getPublicAnalyticsConfig"));
  assert.ok(layoutName);
  const layout = read(`src/layouts/${layoutName}`);
  const client = read("src/scripts/visitor-analytics.ts");
  assert.match(layout, /data-analytics-config/);
  assert.match(layout, /data-analytics-consent-banner/);
  assert.match(layout, /visitor-analytics\.ts/);
  assert.match(layout, /\.jc-analytics-consent[\s\S]*position:\s*fixed/);
  assert.match(client, /autocapture: false/);
  assert.match(client, /capture_pageview: false/);
  assert.match(client, /consent\(\)/);
  assert.match(client, /ga-disable-/);
  assert.match(client, /opt_out_capturing/);
  assert.doesNotMatch(client, /ASTROPAGES_TEST_ANALYTICS_ENABLED|phc_[a-z0-9]+/i);
});

test("public analytics config reads provider-specific public values only", () => {
  const source = read("src/server/aggregator/integrations/analytics.ts");
  assert.match(source, /ACTIVE_ANALYTICS_PROVIDER/);
  assert.match(source, /GA4_MEASUREMENT_ID/);
  assert.match(source, /getPublicPosthogConfig/);
  assert.doesNotMatch(read("src/scripts/visitor-analytics.ts"), /GA4_API_SECRET|POSTHOG_PERSONAL_API_KEY/);
});
