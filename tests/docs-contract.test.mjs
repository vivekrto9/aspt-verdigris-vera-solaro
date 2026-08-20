import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const readJson = (path) => JSON.parse(read(path));

const docs = {
  readme: read("README.md"),
  agents: read("AGENTS.md"),
  cloudflare: read("docs/cloudflare-runtime.md"),
  openhands: read("docs/openhands-playbook.md"),
  leads: read("LEADS.md"),
};

test("repository docs describe Vera Solaro without stale single-page or legacy catalog guidance", () => {
  const publicDocs = Object.values(docs).join("\n");
  const d1Schema = read("database/d1/001_initial_site_schema.sql");

  assert.match(docs.readme, /# Vera Solaro/);
  assert.match(docs.readme, /`aspt-verdigris-vera-solaro` is the Verdigris Almanac edition of the Vera Solaro astrology template/);
  assert.match(docs.readme, /English-first[\s\S]*USD[\s\S]*Europe\/Rome/);
  assert.doesNotMatch(publicDocs, /single-page AstroPages template/i);
  assert.doesNotMatch(publicDocs, /only the home page/i);
  assert.doesNotMatch(publicDocs, /base template/i);
  assert.doesNotMatch(d1Schema, /single-page/i);
  assert.doesNotMatch(publicDocs, /templates\/astropages-base-template\/0\.1\.0\//);
  assert.doesNotMatch(publicDocs, /\b(?:PREVIEW_ASTRAGURU|PROD_ASTRAGURU|ASTROCONNECT)\b/);
  assert.match(docs.readme, /AstroPages Admin owns the semantic version, release notes, and changelog/i);
});

test("lead documentation is an agent-ready integration reference", () => {
  assert.match(docs.agents, /LEADS\.md/);
  assert.match(docs.leads, /leads\.v1/);
  assert.match(docs.leads, /linkBusinessLead/);
  assert.match(docs.leads, /linkNewsletterLead/);
  assert.match(docs.leads, /markLeadConvertedBySourceReference/);
  for (const source of ["consultation_booking", "waitlist", "newsletter", "contact"]) {
    assert.match(docs.leads, new RegExp("\\| `" + source + "` \\|"));
  }
  assert.match(docs.leads, /sourceReferenceType: "vera_booking"/);
  assert.match(docs.leads, /pagePath: "\/booking"/);
  assert.doesNotMatch(docs.leads, /`(?:product_order|puja_order|report_order|support)`/);
  assert.match(docs.leads, /wrangler d1 execute aspt-verdigris-vera-solaro-site --local/);
  assert.doesNotMatch(Object.values(docs).join("\n"), /product-interest|Northstar|lead-generation-demo/i);
});

test("docs keep template and generated-site deploys on callback-token secrets", () => {
  assert.match(
    docs.cloudflare,
    /Generated-site Worker runtime secrets are:\s*\n\s*-\s*`EMDASH_ENCRYPTION_KEY`\s*\n\s*-\s*`ASTROPAGES_CONTROL_PLANE_CALLBACK_TOKEN`/m,
  );
  assert.match(docs.agents, /Generated-site Worker deploys must not require `BUILDER_MCP_TOKEN` or `BUILDER_MCP_PROVISION_SECRET`/);
  assert.match(
    docs.readme,
    /Neither template-source nor generated-site deploys require `BUILDER_MCP_TOKEN` or `BUILDER_MCP_PROVISION_SECRET`/,
  );
  assert.match(docs.cloudflare, /No\s+preconfigured Builder MCP deployment secrets are required/);
  assert.doesNotMatch(
    `${docs.cloudflare}\n${docs.agents}\n${docs.openhands}`,
    /Generated-site deployments require:[\s\S]*BUILDER_MCP_(?:TOKEN|PROVISION_SECRET)/,
  );
  assert.doesNotMatch(docs.readme, /template-source[^\n]+may still use Builder MCP/i);
});

test("deployment docs enumerate only Vera's wired provider configuration", () => {
  for (const name of [
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_PUBLISHABLE_KEY",
    "CALENDLY_API_TOKEN",
    "CALENDLY_WEBHOOK_SIGNING_KEY",
    "SES_SENDER_EMAIL",
    "SES_SENDER_NAME",
    "AWS_REGION",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "ASTROPAGES_PLATFORM_GOOGLE_PLACES_API_KEY",
    "POSTHOG_PROJECT_API_KEY",
    "POSTHOG_HOST",
    "POSTHOG_PROJECT_ID",
  ]) {
    assert.match(docs.cloudflare, new RegExp(`\\b${name}\\b`));
  }
  assert.doesNotMatch(
    docs.cloudflare,
    /RAZORPAY|GA4_|ZAPIER|GOOGLE_CALENDAR|WATI|MAILCHIMP|X_ASTROLOGYAPI|PAYMENT_PROVIDER/,
  );
});

test("template release version metadata is owned by AstroPages Admin", () => {
  const manifest = readJson("template.manifest.json");
  const capabilityLock = readJson("capability-lock.json");
  const packageJson = readJson("package.json");
  const bootstrapSource = read("src/server/generated-site/emdash-bootstrap.ts");

  assert.equal(Object.hasOwn(manifest, "version"), false);
  assert.equal(Object.hasOwn(manifest, "registryVersionId"), false);
  assert.equal(Object.hasOwn(capabilityLock, "templateRegistryVersionId"), false);
  assert.equal(Object.hasOwn(packageJson, "version"), false);
  assert.doesNotMatch(bootstrapSource, /bootstrapTemplateVersion/);
});

test("AGENTS.md is a generated-customer-site runbook aligned with the Vera runtime", () => {
  const agents = docs.agents;
  const designLinkages = agents.match(
    /Before every user-facing layout, component, typography, color, styling, imagery, responsive, or interaction change[^\n]+DESIGN_PHILOSOPHY\.md[^\n]+DESIGN\.md/gi,
  ) ?? [];

  assert.equal(designLinkages.length, 1);
  assert.match(agents, /this site|current project/i);
  assert.doesNotMatch(agents, /\bthis (?:repo|repository|template)\b/i);
  assert.doesNotMatch(agents, /template-source mode|future (?:project|site)s?/i);

  assert.match(agents, /work package[^\n]+target branch[^\n]+protected paths[^\n]+mandatory/i);
  assert.match(agents, /exact test command[^\n]+work package/i);
  assert.match(agents, /explicitly selected skills are mandatory/i);
  assert.match(agents, /automatic mode[^\n]+genuinely relevant pinned skills/i);

  assert.match(
    agents,
    /`content_get` → minimal `content_update` with `_rev` → `content_publish` → `content_get`/,
  );
  assert.match(agents, /`content_publish`[^\n]+preview[^\n]+never[^\n]+production/i);
  assert.match(agents, /revision conflict[^\n]+re-?read[^\n]+concurrent changes/i);
  assert.match(agents, /single active query-parameter locale[^\n]+`en`/i);
  const editableTargets = [
    "site_chrome/main",
    "site_pages/home",
    "site_pages/not_found_page",
    "vera_home_sections/main",
    "vera_readings/main",
    "vera_booking/main",
    "vera_booking_payment/main",
    "vera_writing/main",
    "vera_article/main",
    "vera_about/main",
    "vera_questions/main",
    "vera_contact/main",
    "vera_legal/main",
    "vera_letters/main",
    "vera_letters_status/main",
    "vera_account/main",
    "vera_account_room/main",
    "vera_account_schedule/main",
    "vera_account_cancel/main",
    "vera_account_receipt/main",
    "vera_closed/main",
    "vera_auth/main",
  ];
  assert.equal(editableTargets.length, 22);
  for (const target of editableTargets) {
    assert.match(agents, new RegExp("`" + target.replace("/", "\\/") + "`"));
  }

  for (const tool of [
    "asset_list", "asset_get", "asset_create", "asset_import_url",
    "asset_update", "asset_replace", "asset_delete", "asset_restore",
  ]) {
    assert.match(agents, new RegExp(`\\b${tool}\\b`));
  }
  assert.match(agents, /expectedRevisionId/);
  assert.match(agents, /returned `sitePath`/);
  assert.match(agents, /stable asset identity/i);
  assert.match(agents, /never[^\n]+raw R2[^\n]+signed URLs/i);

  assert.match(agents, /Articles are dynamic EmDash content/i);
  assert.match(agents, /`posts` collection defined in `seed\/seed\.json`/i);
  assert.match(agents, /scripts\/markdown-to-portable-text\.mjs/);
  assert.match(agents, /never invent a second article store/i);
  assert.match(agents, /`ap_leads`/);
  assert.match(agents, /`ap_vera_\*` tables/);
  assert.match(agents, /`ap_customer_accounts`/);
  assert.match(agents, /public render[^\n]+read-only/i);
  assert.match(agents, /17 manifest-owned visitor routes/i);
  assert.match(agents, /GET \/api\/astropages\/generated-site\/vera\/operations/);
  assert.match(agents, /missing provider secrets[^\n]+must block the release callback/i);
  assert.match(agents, /email_template_render_sample/);
  assert.match(agents, /production promotion[^\n]+control plane/i);

  assert.match(agents, /content-only[^\n]+Git unchanged/i);
  assert.match(agents, /never deploy or publish production/i);
  assert.match(agents, /customer-facing summary/i);
  assert.doesNotMatch(agents, /^pnpm run build$/m);
});
