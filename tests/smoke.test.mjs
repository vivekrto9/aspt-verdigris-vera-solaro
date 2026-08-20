import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const readJson = (path) => JSON.parse(read(path));

test("Vera Solaro declares its stacked production capabilities", () => {
  const manifest = readJson("template.manifest.json");
  assert.equal(manifest.templateKey, "aspt-verdigris-vera-solaro");
  assert.equal(manifest.displayName, "Vera Solaro — Verdigris Almanac");
  assert.deepEqual(manifest.supportedCapabilities, [
    "capability-consultation-marketplace@0.3.0",
    "capability-checkout-and-payments@0.3.0",
    "capability-content-seo-localization@0.3.0",
    "capability-generated-site-operations@0.3.0",
    "capability-customer-auth@0.1.0",
    "capability-transactional-notifications@0.3.0",
    "capability-growth-and-automation@0.3.0",
  ]);
  for (const path of ["/", "/booking", "/account", "/letters", "/login", "/signup"]) {
    assert.equal(
      manifest.routes.visitorRoutes.some((route) => route.path === path),
      true,
      `${path} visitor route must be declared`,
    );
  }
});

test("domain-specific pages and folders are not present", () => {
  for (const path of [
    "src/pages/reports.astro",
    "src/pages/puja-services.astro",
    "src/pages/shop.astro",
    "src/pages/horoscope.astro",
    "src/pages/free-tools.astro",
    "src/lib/astrology",
  ]) {
    assert.equal(existsSync(new URL(path, root)), false, `${path} should not be in the base template`);
  }
});

test("legacy Northstar product-interest demo is absent", () => {
  for (const path of [
    "src/pages/lead-generation-demo.astro",
    "src/data/product-lead-demo.ts",
    "src/styles/product-lead-demo.css",
    "src/pages/api/astropages/generated-site/leads/product-interest.ts",
  ]) {
    assert.equal(existsSync(new URL(path, root)), false, `${path} must not be present`);
  }
  assert.doesNotMatch(read("src/pages/index.astro"), /lead-generation-demo|Lead demo/);
});

test("runtime schema is reduced to generic starter tables", () => {
  const migration = read("migrations/0001_base_runtime.sql");
  const authMigration = read("migrations/0002_customer_auth.sql");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS ap_runtime_config/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS ap_admin_sessions/);
  assert.doesNotMatch(migration, /ap_report_orders|ap_puja_orders|ap_product_orders|ap_consultation_bookings/);
  assert.match(authMigration, /CREATE TABLE IF NOT EXISTS ap_customer_accounts/);
  assert.match(authMigration, /CREATE TABLE IF NOT EXISTS ap_customer_sessions/);
  assert.match(authMigration, /CREATE TABLE IF NOT EXISTS ap_customer_password_resets/);
  const leadsMigration = read("migrations/0005_leads.sql");
  assert.match(leadsMigration, /CREATE TABLE IF NOT EXISTS ap_business_events/);
  assert.match(leadsMigration, /CREATE TABLE IF NOT EXISTS ap_leads/);
});

test("analytics MCP hook uses only fixed Vera reporting adapters", () => {
  assert.equal(existsSync(new URL("src/server/aggregator/analytics-mcp.ts", root)), true);
  assert.equal(existsSync(new URL("src/server/aggregator/analytics-query.ts", root)), true);

  const worker = read("src/worker.ts");
  const query = read("src/server/aggregator/analytics-query.ts");
  assert.match(worker, /maybeHandleAnalyticsMcpToolCall/);
  assert.match(query, /booking_funnel/);
  assert.match(query, /ap_vera_bookings/);
  assert.doesNotMatch(query, /ap_report_orders|ap_puja_orders|ap_product_orders|ap_consultation_bookings/);
  assert.doesNotMatch(query, /birth|encrypted_intake|customer_name|normalized_email|message\b/i);
});

test("customer auth pages and APIs are present", () => {
  for (const path of [
    "src/pages/login.astro",
    "src/pages/signup.astro",
    "src/pages/forgot-password.astro",
    "src/pages/reset-password.astro",
    "src/pages/api/astropages/generated-site/customer-auth/login.ts",
    "src/pages/api/astropages/generated-site/customer-auth/signup.ts",
    "src/pages/api/astropages/generated-site/customer-auth/request-password-reset.ts",
    "src/pages/api/astropages/generated-site/customer-auth/reset-password.ts",
    "src/pages/api/astropages/generated-site/customer-auth/logout.ts",
    "src/pages/api/astropages/generated-site/customer-auth/me.ts",
    "src/server/aggregator/customer-auth.ts",
  ]) {
    assert.equal(existsSync(new URL(path, root)), true, `${path} should be in the base template`);
  }
});
