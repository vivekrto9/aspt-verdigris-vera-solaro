import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const manifest = JSON.parse(readFileSync(new URL("../template.manifest.json", import.meta.url), "utf8"));
const leadsManifest = JSON.parse(readFileSync(new URL("../astropages/leads.manifest.json", import.meta.url), "utf8"));
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const generatedSettings = JSON.parse(readFileSync(new URL("../src/generated/site-settings.json", import.meta.url), "utf8"));
const runtimeConfigSource = readFileSync(new URL("../src/server/aggregator/runtime-config.ts", import.meta.url), "utf8");

const routePaths = (items) => new Set(items.map((item) => item.path));

test("template manifest keeps the Vera Solaro source identity and market defaults", () => {
  assert.equal(packageJson.name, "@astropages/aspt-verdigris-vera-solaro");
  assert.equal(packageJson.emdash.label, "Vera Solaro");
  assert.equal(manifest.templateKey, "aspt-verdigris-vera-solaro");
  assert.equal(manifest.displayName, "Vera Solaro — Verdigris Almanac");
  assert.equal(manifest.stage, "production-template");
  assert.deepEqual(manifest.repo, {
    url: "https://github.com/vivekrto9/aspt-verdigris-vera-solaro.git",
    commitSha: "RESOLVED_AT_TEMPLATE_REGISTRATION",
  });
  assert.equal(
    manifest.secrets.deploymentMapping.workerSecretsFile,
    "aspt-verdigris-vera-solaro-worker-secrets.json",
  );
  assert.equal(manifest.localization.requiredDefaultLocale, "en");
  assert.deepEqual(manifest.localization.activeLocales, ["en"]);
  assert.equal(generatedSettings.siteSettings.brandName, "Vera Solaro");
  assert.equal(generatedSettings.siteSettings.defaultLocale, "en");
  assert.equal(generatedSettings.siteSettings.currency, "USD");
  assert.equal(generatedSettings.siteSettings.timezone, "Europe/Rome");
  assert.equal(Object.hasOwn(manifest, "version"), false);
  assert.equal(Object.hasOwn(manifest, "registryVersionId"), false);
  assert.equal(Object.hasOwn(manifest, "analytics"), false);
  assert.equal(manifest.leads.required, true);
  assert.equal(manifest.leads.path, "astropages/leads.manifest.json");
});

test("manifest declares reusable generated-site APIs and current visitor routes", () => {
  const visitorRoutes = routePaths(manifest.routes.visitorRoutes);
  const expectedVisitorRoutes = [
    "/",
    "/about",
    "/readings",
    "/readings/[service]",
    "/booking",
    "/booking/details",
    "/booking/[id]/payment",
    "/booking/[id]/confirmation",
    "/writing",
    "/writing/[slug]",
    "/questions",
    "/contact",
    "/letters",
    "/legal",
    "/account",
    "/account/profile",
    "/account/billing",
    "/closed",
    "/login",
    "/signup",
    "/forgot-password",
    "/reset-password",
  ];
  assert.deepEqual([...visitorRoutes], expectedVisitorRoutes);
  for (const path of expectedVisitorRoutes) {
    assert.equal(visitorRoutes.has(path), true, `${path} visitor route must be declared`);
  }

  const apiRoutes = routePaths(manifest.routes.generatedSiteApis);
  for (const path of [
    "/api/astropages/generated-site/health",
    "/api/astropages/generated-site/edit-readiness",
    "/api/astropages/generated-site/emdash/bootstrap",
    "/api/astropages/generated-site/content-release/status",
    "/api/astropages/generated-site/content-release/export",
    "/api/astropages/generated-site/content-release/import",
    "/api/astropages/generated-site/runtime-config/sync",
    "/api/astropages/generated-site/sso/exchange",
    "/api/astropages/generated-site/editor/content-field",
    "/api/astropages/generated-site/editor/provision-mcp-token",
    "/api/astropages/generated-site/email-templates",
    "/api/astropages/generated-site/email-templates/render",
    "/api/astropages/generated-site/email-templates/test-send",
    "/api/astropages/generated-site/email-templates/publish",
  ]) {
    assert.equal(apiRoutes.has(path), true, `${path} generated-site API must be declared`);
  }

  const apiMethod = (path) => manifest.routes.generatedSiteApis.find((route) => route.path === path)?.method;
  assert.equal(
    apiMethod("/api/astropages/generated-site/customer-auth/signup"),
    "GET/POST",
    "signup must declare both account creation and email verification methods",
  );
  assert.equal(
    apiMethod("/api/astropages/generated-site/vera/bookings/[id]/status"),
    "GET/POST",
    "booking status must declare both status reads and authenticated scheduling retries",
  );
});

test("manifest method declarations include implemented multi-method Vera routes", () => {
  const cases = [
    {
      path: "/api/astropages/generated-site/customer-auth/signup",
      source: readFileSync(
        new URL("../src/pages/api/astropages/generated-site/customer-auth/signup.ts", import.meta.url),
        "utf8",
      ),
    },
    {
      path: "/api/astropages/generated-site/vera/bookings/[id]/status",
      source: readFileSync(
        new URL("../src/pages/api/astropages/generated-site/vera/bookings/[id]/status.ts", import.meta.url),
        "utf8",
      ),
    },
  ];

  for (const item of cases) {
    const declaration = manifest.routes.generatedSiteApis.find((route) => route.path === item.path);
    assert.equal(declaration?.method, "GET/POST", `${item.path} must declare GET/POST`);
    assert.match(item.source, /export const GET\b/);
    assert.match(item.source, /export const POST\b/);
  }
});

test("manifest distinguishes template deploy secrets from generated-site deploy secrets", () => {
  assert.equal(manifest.secrets.requiredNow.includes("BUILDER_MCP_TOKEN"), false);
  assert.equal(manifest.secrets.requiredNow.includes("BUILDER_MCP_PROVISION_SECRET"), false);
  assert.equal(manifest.secrets.requiredForTemplateDeployment.includes("BUILDER_MCP_TOKEN"), false);
  assert.equal(manifest.secrets.requiredForTemplateDeployment.includes("BUILDER_MCP_PROVISION_SECRET"), false);
  assert.equal(
    manifest.secrets.requiredForTemplateDeployment.includes("ASTROPAGES_CONTROL_PLANE_CALLBACK_TOKEN"),
    false,
    "template deployment generates its callback token inside the pipeline",
  );

  assert.equal(manifest.secrets.requiredForGeneratedSiteDeployment.includes("EMDASH_ENCRYPTION_KEY"), true);
  assert.equal(
    manifest.secrets.requiredForGeneratedSiteDeployment.includes("ASTROPAGES_CONTROL_PLANE_CALLBACK_TOKEN"),
    true,
  );
  assert.equal(manifest.secrets.requiredForGeneratedSiteDeployment.includes("BUILDER_MCP_TOKEN"), false);
  assert.equal(manifest.secrets.requiredForGeneratedSiteDeployment.includes("BUILDER_MCP_PROVISION_SECRET"), false);
  assert.equal(manifest.secrets.requiredForGeneratedSiteDeployment.includes("CLOUDFLARE_SECRETS_STORE_ID"), false);
  assert.equal(manifest.secrets.deploymentVariables.includes("CLOUDFLARE_SECRETS_STORE_ID"), true);
  assert.deepEqual(manifest.secrets.deploymentMapping.workerSecrets, [
    "EMDASH_ENCRYPTION_KEY",
    "ASTROPAGES_CONTROL_PLANE_CALLBACK_TOKEN",
  ]);
  assert.deepEqual(manifest.secrets.deploymentMapping.generatedSiteWorkerSecrets, [
    "EMDASH_ENCRYPTION_KEY",
    "ASTROPAGES_CONTROL_PLANE_CALLBACK_TOKEN",
  ]);
  assert.equal(
    manifest.secrets.deploymentMapping.generatedSiteRuntimeVars.includes("ASTROPAGES_SITE_URL"),
    false,
  );
  for (const key of manifest.secrets.generatedSiteRuntimeConfig) {
    assert.match(runtimeConfigSource, new RegExp(`"${key}"`), `${key} must be accepted by runtime config sync`);
  }
});

test("manifest declares reusable runtime persistence tables", () => {
  for (const table of [
    "ap_runtime_config",
    "ap_admin_sessions",
    "ap_admin_sso_exchanges",
    "ap_content_revision_log",
    "ap_content_environment_state",
    "ap_emdash_bootstrap_state",
    "ap_customer_accounts",
    "ap_business_events",
    "ap_leads",
    "ap_email_templates",
    "ap_email_events",
    "ap_email_variable_mappings",
  ]) {
    assert.equal(manifest.runtimePersistence.tables.includes(table), true, `${table} must be declared`);
  }
  for (const table of ["ap_report_orders", "ap_puja_orders", "ap_shop_products", "ap_consultation_bookings"]) {
    assert.equal(manifest.runtimePersistence.tables.includes(table), false, `${table} is not part of base`);
  }
});

test("leads manifest exposes only Vera's supported privacy-safe sources", () => {
  assert.equal(leadsManifest.semanticModel, "leads.v1");
  assert.equal(leadsManifest.table, "ap_leads");
  assert.deepEqual(Object.keys(leadsManifest.sources), [
    "consultation_booking",
    "waitlist",
    "newsletter",
    "contact",
  ]);
  assert.doesNotMatch(JSON.stringify(leadsManifest.sources), /birth|message|notes|intake/i);
});
