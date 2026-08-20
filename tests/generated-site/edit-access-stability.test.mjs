import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

const createReadinessDb = async ({
  missingTables = [],
  missingEntry = null,
  bootstrapState = true,
} = {}) => {
  const { getBuilderEntryConfig, getBuilderReleaseTargets } = await import("../../src/builder/registry.ts");
  const { activeLocales } = await import("../../src/data/localization-contract.ts");
  const { readAstroPagesEmDashBootstrapContract } = await import("../../src/server/generated-site/emdash-bootstrap.ts");
  const contract = await readAstroPagesEmDashBootstrapContract();
  const targets = getBuilderReleaseTargets();
  const activeLocaleCodes = activeLocales.map((item) => item.code);
  const collectionRows = new Map();
  const fieldsByCollectionId = new Map();
  const entries = new Set();
  const tableNames = new Set([
    "users",
    "ap_admin_sessions",
    "ap_admin_sso_exchanges",
    "ap_content_revision_log",
    "ap_content_environment_state",
    "_emdash_collections",
    "_emdash_fields",
    "revisions",
    "ap_emdash_bootstrap_state",
  ]);

  for (const target of targets) {
    const config = getBuilderEntryConfig(target.collection, target.entry);
    if (!config) continue;
    const collectionId = `col_${target.collection}`;
    collectionRows.set(target.collection, { id: collectionId, slug: target.collection });
    fieldsByCollectionId.set(
      collectionId,
      config.collectionConfig.fields.map((field) => field.slug),
    );
    tableNames.add(`ec_${target.collection}`);
    for (const locale of activeLocaleCodes) {
      entries.add(`${target.collection}:${target.entry}:${locale}`);
    }
  }

  for (const table of missingTables) tableNames.delete(table);
  if (missingEntry) {
    entries.delete(`${missingEntry.collection}:${missingEntry.entry}:${missingEntry.locale}`);
  }
  const bootstrapRows = bootstrapState
    ? [{
        template_key: "aspt-verdigris-vera-solaro",
        template_version: "test",
        builder_registry_hash: contract.registryHash,
        expected_collections: contract.expectedCollections,
        expected_fields: contract.expectedFields,
        expected_entries: contract.expectedEntries,
        completed_at: "2026-07-05T00:00:00.000Z",
        last_full_verified_at: "2026-07-05T00:00:00.000Z",
      }]
    : [];
  const queryLog = [];

  return {
    queryLog,
    prepare(sql) {
      return {
        values: [],
        bind(...values) {
          this.values = values;
          return this;
        },
        async first() {
          queryLog.push(sql);
          if (/FROM ap_emdash_bootstrap_state/i.test(sql)) {
            return bootstrapRows[0] ?? null;
          }
          return null;
        },
        async all() {
          queryLog.push(sql);
          if (/sqlite_master/i.test(sql)) {
            return {
              results: this.values
                .filter((name) => tableNames.has(name))
                .map((name) => ({ name })),
            };
          }
          if (/FROM _emdash_collections/i.test(sql)) {
            return {
              results: this.values
                .map((slug) => collectionRows.get(slug))
                .filter(Boolean),
            };
          }
          if (/FROM _emdash_fields/i.test(sql)) {
            const requestedCollectionIds = new Set(this.values);
            const results = [];
            for (const [collectionSlug, collection] of collectionRows.entries()) {
              if (!requestedCollectionIds.has(collection.id)) continue;
              for (const field of fieldsByCollectionId.get(collection.id) ?? []) {
                results.push({ collection: collectionSlug, field });
              }
            }
            return {
              results,
            };
          }
          if (/FROM\s+"?(ec_[a-z0-9_]+)"?\s+/i.test(sql)) {
            const table = sql.match(/FROM\s+"?(ec_[a-z0-9_]+)"?/i)[1];
            const collection = table.replace(/^ec_/, "");
            const splitIndex = this.values.length - activeLocaleCodes.length;
            const requestedEntries = new Set(this.values.slice(0, splitIndex));
            const requestedLocales = new Set(this.values.slice(splitIndex));
            return {
              results: [...entries]
                .map((key) => {
                  const [entryCollection, slug, locale] = key.split(":");
                  return { entryCollection, slug, locale };
                })
                .filter(({ entryCollection, slug, locale }) =>
                  entryCollection === collection &&
                  requestedEntries.has(slug) &&
                  requestedLocales.has(locale)
                )
                .map(({ slug, locale }) => ({ slug, locale })),
            };
          }
          return { results: [] };
        },
      };
    },
  };
};

const createTableDb = (tables) => ({
  prepare(sql) {
    return {
      bind(...values) {
        return {
          async all() {
            assert.match(sql, /sqlite_master/);
            return {
              results: values
                .filter((name) => tables.includes(name))
                .map((name) => ({ name })),
            };
          },
        };
      },
    };
  },
});

const context = (db) => ({
  locals: {
    runtime: {
      env: {
        DB: db,
      },
    },
  },
});

test("generated-site SSO exchange has bounded browser-safe failure handling", () => {
  const source = read("src/server/aggregator/admin-sso.ts");

  assert.match(source, /const ssoExchangeStepTimeoutMs = 3_000/);
  assert.match(source, /htmlError/);
  assert.match(source, /content-type": "text\/html; charset=utf-8"/);
  assert.match(source, /Could not open Content Studio/);
  assert.match(source, /appendServerTiming/);
  assert.match(source, /x-astropages-sso-timing/);
  for (const timing of [
    "sso_verify_jwt",
    "sso_exchange_lookup",
    "sso_exchange_insert",
    "sso_session_insert",
  ]) {
    assert.match(source, new RegExp(timing));
  }
  assert.doesNotMatch(source, /console\.(log|warn|error)\([^)]*token/i);
});

test("starter homepage mounts the Content Studio launcher when Builder auth is present", () => {
  const layout = read("src/layouts/BaseLayout.astro");
  const page = read("src/pages/index.astro");
  const frame = read("src/components/vera/VeraFrame.astro");

  assert.match(layout, /import BuilderToolbar from "\.\.\/builder\/BuilderToolbar\.astro"/);
  assert.match(layout, /builderToolbar/);
  assert.match(layout, /<BuilderToolbar \{\.\.\.builderToolbar\} \/>/);
  assert.match(page, /<VeraFrame \{\.\.\.page\}/);
  assert.match(frame, /reviewTargets/);
  assert.match(frame, /launcherEnabled: Boolean\(builder\.launcherEnabled\)/);
  assert.match(frame, /studioModeEnabled: Boolean\(builder\.studioModeEnabled\)/);
  assert.match(frame, /hasSavedDraft: builderPage\.hasSavedDraft \|\| chromePage\.hasSavedDraft/);
});

test("localhost does not bypass Content Studio authentication", () => {
  const auth = read("src/builder/auth.ts");

  assert.doesNotMatch(
    auth,
    /localBuilderAccess|localBuilderCookieName|base-template-local-builder|local-content-studio/,
  );
  assert.match(auth, /const session = await getAdminSession/);
  assert.match(auth, /AstroPages SSO is required for Builder access\./);
});

test("Content Studio editor endpoints request EmDash preview runtime", () => {
  const toolbar = read("src/builder/BuilderToolbar.astro");

  assert.match(toolbar, /content-field\?_preview=1/);
  assert.match(toolbar, /content-diff\?_preview=1/);
});

test("authenticated edit preview falls back to read-only published content instead of source defaults", () => {
  const content = read("src/builder/content.ts");

  assert.match(content, /const readPublishedBuilderContent = async/);
  assert.match(content, /if \(emdash\?\.handleContentGet\)/);
  assert.match(content, /readPublishedBuilderContent\(collection, entry, locale, defaults\)/);
  assert.match(content, /full EmDash[\s\S]+cannot load draft content/);
});

test("edit readiness endpoint reports ready when generated-site edit tables exist", async () => {
  const { GET } = await import("../../src/pages/api/astropages/generated-site/edit-readiness.ts");
  const db = await createReadinessDb();
  const response = await GET(context(db));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.status, "ready");
  assert.equal(body.ready, true);
  assert.equal(body.bootstrap.mode, "fast");
  assert.match(body.bootstrap.registryHash, /^sha256:/);
  assert.deepEqual(body.missingTables, []);
  assert.equal(body.bootstrap.ready, true);
  assert.equal(
    db.queryLog.some((sql) => /FROM\s+"?(ec_[a-z0-9_]+)"?\s+/i.test(sql)),
    false,
  );
});

test("edit readiness endpoint fails clearly when generated-site edit tables are missing", async () => {
  const { GET } = await import("../../src/pages/api/astropages/generated-site/edit-readiness.ts");
  const response = await GET(context(createTableDb(["users"])));
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.status, "not_ready");
  assert.equal(body.ready, false);
  assert.deepEqual(body.missingTables, [
    "ap_admin_sessions",
    "ap_admin_sso_exchanges",
    "ap_content_revision_log",
    "ap_content_environment_state",
    "_emdash_collections",
    "_emdash_fields",
    "revisions",
  ]);
});

test("edit readiness endpoint fails clearly when builder content is not bootstrapped", async () => {
  const { GET } = await import("../../src/pages/api/astropages/generated-site/edit-readiness.ts");
  const response = await GET(context(await createReadinessDb({
    missingEntry: { collection: "home_intro", entry: "main", locale: "en" },
    bootstrapState: false,
  })));
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.status, "not_ready");
  assert.equal(body.state, "missing_builder_content");
  assert.equal(body.ready, false);
  assert.equal(body.bootstrap.ready, false);
  assert.equal(body.bootstrap.mode, "fast");
  assert.deepEqual(body.bootstrap.missingEntries, []);
});

test("edit readiness deep mode still reports missing builder entries", async () => {
  const { GET } = await import("../../src/pages/api/astropages/generated-site/edit-readiness.ts");
  const db = await createReadinessDb({
    missingEntry: { collection: "site_pages", entry: "home", locale: "en" },
    bootstrapState: true,
  });
  const response = await GET({
    ...context(db),
    request: new Request("https://example.test/api/astropages/generated-site/edit-readiness?deep=1"),
  });
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.status, "not_ready");
  assert.equal(body.bootstrap.mode, "deep");
  assert.equal(body.bootstrap.ready, false);
  assert.deepEqual(body.bootstrap.missingEntries, [
    { collection: "site_pages", entry: "home", locale: "en" },
  ]);
  assert.equal(
    db.queryLog.some((sql) => /FROM\s+"?(ec_[a-z0-9_]+)"?\s+/i.test(sql)),
    true,
  );
});
