import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

const createFakeD1 = () => {
  const statements = [];
  const tables = new Map();
  const rows = new Map();
  const tableRows = (table) => {
    if (!rows.has(table)) rows.set(table, []);
    return rows.get(table);
  };
  const rowByKey = (table, key, value) =>
    tableRows(table).find((row) => row[key] === value) ?? null;
  const valuesForInsert = (sql, values) => {
    const columns = sql
      .match(/\(([^)]+)\)\s*VALUES/i)?.[1]
      .split(",")
      .map((column) => column.replace(/"/g, "").trim()) ?? [];
    return Object.fromEntries(columns.map((column, index) => [column, values[index]]));
  };

  return {
    statements,
    rows,
    prepare(sql) {
      const statement = {
        values: [],
        bind(...values) {
          this.values = values;
          return this;
        },
        async first() {
          statements.push({ sql, values: this.values, first: true });
          if (/sqlite_master/i.test(sql)) {
            const name = this.values[0];
            return tables.has(name) ? { name } : null;
          }
          if (/FROM _emdash_collections/i.test(sql) && /WHERE slug = \?/i.test(sql)) {
            return tableRows("_emdash_collections").find((row) => row.slug === this.values[0]) ?? null;
          }
          if (/FROM\s+"?(ec_[a-z0-9_]+)"?\s+WHERE slug = \? AND locale = \?/i.test(sql)) {
            const table = sql.match(/FROM\s+"?(ec_[a-z0-9_]+)"?/i)[1];
            return tableRows(table).find((row) => row.slug === this.values[0] && row.locale === this.values[1]) ?? null;
          }
          if (/FROM ap_emdash_bootstrap_state/i.test(sql)) {
            return rowByKey("ap_emdash_bootstrap_state", "template_key", this.values[0]);
          }
          return null;
        },
        async all() {
          statements.push({ sql, values: this.values, all: true });
          if (/sqlite_master/i.test(sql)) {
            return {
              results: this.values
                .filter((name) => tables.has(name))
                .map((name) => ({ name })),
            };
          }
          if (/PRAGMA table_info/i.test(sql)) {
            const table = sql.match(/PRAGMA table_info\("?(ec_[a-z0-9_]+)"?\)/i)?.[1];
            return { results: [...(tables.get(table) ?? [])].map((name) => ({ name })) };
          }
          return { results: [] };
        },
        async run() {
          statements.push({ sql, values: this.values, run: true });
          const createMatch = sql.match(/CREATE TABLE(?: IF NOT EXISTS)?\s+"?(ec_[a-z0-9_]+|_emdash_collections|_emdash_fields|revisions|ap_emdash_bootstrap_state)"?/i);
          if (createMatch) {
            const table = createMatch[1];
            tables.set(table, new Set([...(tables.get(table) ?? []), "id"]));
          }
          const alterMatch = sql.match(/ALTER TABLE\s+"?(ec_[a-z0-9_]+)"?\s+ADD COLUMN\s+"?([a-z0-9_]+)"?/i);
          if (alterMatch) {
            tables.set(alterMatch[1], new Set([...(tables.get(alterMatch[1]) ?? []), alterMatch[2]]));
          }
          if (/INSERT OR IGNORE INTO _emdash_collections/i.test(sql)) {
            tables.set("_emdash_collections", new Set([...(tables.get("_emdash_collections") ?? []), "id"]));
            const data = valuesForInsert(sql, this.values);
            if (!tableRows("_emdash_collections").some((row) => row.slug === data.slug)) {
              tableRows("_emdash_collections").push(data);
            }
          }
          if (/INSERT OR IGNORE INTO _emdash_fields/i.test(sql)) {
            tables.set("_emdash_fields", new Set([...(tables.get("_emdash_fields") ?? []), "id"]));
            const data = valuesForInsert(sql, this.values);
            if (!tableRows("_emdash_fields").some((row) => row.collection_id === data.collection_id && row.slug === data.slug)) {
              tableRows("_emdash_fields").push(data);
            }
          }
          if (/INSERT INTO\s+"?(ec_[a-z0-9_]+)"?/i.test(sql)) {
            const table = sql.match(/INSERT INTO\s+"?(ec_[a-z0-9_]+)"?/i)[1];
            const data = valuesForInsert(sql, this.values);
            tableRows(table).push(data);
          }
          if (/INSERT INTO ap_emdash_bootstrap_state/i.test(sql)) {
            const data = valuesForInsert(sql, this.values);
            const existing = rowByKey("ap_emdash_bootstrap_state", "template_key", data.template_key);
            if (existing) {
              Object.assign(existing, data);
            } else {
              tableRows("ap_emdash_bootstrap_state").push(data);
            }
          }
          if (/UPDATE\s+"?(ec_[a-z0-9_]+)"?/i.test(sql)) {
            const table = sql.match(/UPDATE\s+"?(ec_[a-z0-9_]+)"?/i)[1];
            const id = this.values[this.values.length - 1];
            const row = tableRows(table).find((item) => item.id === id);
            if (row) row.updated = true;
          }
          return { success: true };
        },
      };
      return statement;
    },
  };
};

const createFakeBatchD1 = () => {
  const db = createFakeD1();
  const batches = [];
  return {
    ...db,
    batches,
    async batch(statements) {
      batches.push(statements);
      const results = [];
      for (const statement of statements) {
        results.push(await statement.run());
      }
      return results;
    },
  };
};

test("explicit EmDash bootstrap materializes full builder content for MCP before browser edit mode", async () => {
  const { bootstrapAstroPagesEmDashContent } = await import("../../src/server/generated-site/emdash-bootstrap.ts");
  const { getBuilderEntryConfig } = await import("../../src/builder/registry.ts");
  const env = {
    ASTROPAGES_SITE_ENVIRONMENT: "preview",
    DB: createFakeD1(),
  };

  const result = await bootstrapAstroPagesEmDashContent({ env });
  const statementCountAfterFirstBootstrap = env.DB.statements.length;
  await bootstrapAstroPagesEmDashContent({ env });
  const secondBootstrapStatements = env.DB.statements.slice(statementCountAfterFirstBootstrap);

  const homeConfig = getBuilderEntryConfig("site_pages", "home");
  const chromeConfig = getBuilderEntryConfig("site_chrome", "main");
  const collections = env.DB.rows.get("_emdash_collections") ?? [];
  const fields = env.DB.rows.get("_emdash_fields") ?? [];
  const homeRows = env.DB.rows.get("ec_site_pages") ?? [];
  const chromeRows = env.DB.rows.get("ec_site_chrome") ?? [];
  const homeEn = homeRows.find((row) => row.slug === "home" && row.locale === "en");
  const chromeEn = chromeRows.find((row) => row.slug === "main" && row.locale === "en");

  assert.equal(result.status, "ready");
  assert.equal(collections.some((row) => row.slug === "site_pages"), true);
  assert.equal(collections.some((row) => row.slug === "site_chrome"), true);
  assert.equal(
    fields.filter((row) => row.collection_id === collections.find((row) => row.slug === "site_pages").id).length,
    homeConfig.collectionConfig.fields.length,
  );
  assert.equal(
    fields.filter((row) => row.collection_id === collections.find((row) => row.slug === "site_chrome").id).length,
    chromeConfig.collectionConfig.fields.length,
  );
  assert.equal(homeEn.status, "published");
  assert.equal(chromeEn.status, "published");
  assert.equal(typeof homeEn.hero_title, "string");
  assert.equal(typeof homeEn.hero_body, "string");
  assert.equal(typeof chromeEn.brand_name, "string");
  assert.equal(homeRows.filter((row) => row.slug === "home" && row.locale === "en").length, 1);
  assert.equal(chromeRows.filter((row) => row.slug === "main" && row.locale === "en").length, 1);
  assert.equal(
    env.DB.statements.some((statement) => /ALTER TABLE\s+"?ec_/i.test(statement.sql)),
    false,
  );
  assert.equal(
    secondBootstrapStatements.some((statement) => /UPDATE\s+"?ec_/i.test(statement.sql)),
    false,
  );
  assert.equal(
    secondBootstrapStatements.some((statement) => /INSERT INTO revisions/i.test(statement.sql)),
    false,
  );
  assert.equal(
    env.DB.statements.some((statement) =>
      /INSERT OR IGNORE INTO _emdash_fields/i.test(statement.sql) &&
      /"required", "unique"/.test(statement.sql)
    ),
    true,
  );
});

test("explicit EmDash bootstrap can run in bounded batches for deployed Workers", async () => {
  const { bootstrapAstroPagesEmDashContent } = await import("../../src/server/generated-site/emdash-bootstrap.ts");
  const { getBuilderReleaseTargets } = await import("../../src/builder/registry.ts");
  const env = {
    ASTROPAGES_SITE_ENVIRONMENT: "preview",
    DB: createFakeD1(),
  };

  const first = await bootstrapAstroPagesEmDashContent({ env, cursor: 0, limit: 2 });
  const second = await bootstrapAstroPagesEmDashContent({
    env,
    cursor: first.nextCursor,
    limit: 2,
  });

  assert.equal(first.processedTargets, 2);
  assert.equal(first.nextCursor, 2);
  assert.equal(second.cursor, 2);
  assert.equal(second.processedTargets, Math.min(2, getBuilderReleaseTargets().length - 2));
});

test("explicit EmDash bootstrap uses D1 batch when the Worker binding supports it", async () => {
  const { bootstrapAstroPagesEmDashContent } = await import("../../src/server/generated-site/emdash-bootstrap.ts");
  const env = {
    ASTROPAGES_SITE_ENVIRONMENT: "preview",
    DB: createFakeBatchD1(),
  };

  await bootstrapAstroPagesEmDashContent({ env, cursor: 0, limit: 1 });

  assert.equal(env.DB.batches.length > 0, true);
  assert.equal(env.DB.batches.some((batch) => batch.length > 1), true);
});

test("explicit EmDash bootstrap records deterministic bootstrap state and can skip when current", async () => {
  const {
    bootstrapAstroPagesEmDashContent,
    readAstroPagesEmDashBootstrapStatus,
  } = await import("../../src/server/generated-site/emdash-bootstrap.ts");
  const env = {
    ASTROPAGES_SITE_ENVIRONMENT: "preview",
    DB: createFakeD1(),
  };

  const first = await bootstrapAstroPagesEmDashContent({ env, mode: "full" });
  const statementCountAfterFirstBootstrap = env.DB.statements.length;
  const second = await bootstrapAstroPagesEmDashContent({ env, mode: "auto" });
  const secondBootstrapStatements = env.DB.statements.slice(statementCountAfterFirstBootstrap);
  const status = await readAstroPagesEmDashBootstrapStatus({ env, mode: "fast" });
  const stateRows = env.DB.rows.get("ap_emdash_bootstrap_state") ?? [];

  assert.equal(first.skipped, false);
  assert.equal(second.skipped, true);
  assert.equal(second.registryHash, first.registryHash);
  assert.match(first.registryHash, /^sha256:/);
  assert.equal(stateRows.length, 1);
  assert.equal(stateRows[0].builder_registry_hash, first.registryHash);
  assert.equal(status.ready, true);
  assert.equal(status.mode, "fast");
  assert.equal(status.registryHash, first.registryHash);
  assert.equal(
    secondBootstrapStatements.some((statement) => /FROM\s+"?(ec_[a-z0-9_]+)"?/i.test(statement.sql)),
    false,
  );
  assert.equal(
    secondBootstrapStatements.some((statement) => /INSERT INTO revisions/i.test(statement.sql)),
    false,
  );
});

test("builder registry keeps every physical EmDash collection under the D1 column cap", async () => {
  const { getBuilderEntryConfig, getBuilderReleaseTargets } = await import("../../src/builder/registry.ts");
  const baseEmDashContentColumns = 16;
  const d1ColumnCap = 100;

  const oversizedTargets = getBuilderReleaseTargets()
    .map((target) => ({
      collection: target.collection,
      columns:
        baseEmDashContentColumns +
        (getBuilderEntryConfig(target.collection, target.entry)?.collectionConfig.fields.length ?? 0),
    }))
    .filter((target) => target.columns > d1ColumnCap);

  assert.deepEqual(oversizedTargets, []);
});

test("deployed EmDash preparation bootstraps content through the bounded generated-site endpoint", () => {
  const source = read("scripts/prepare-deployed-emdash.mjs");

  assert.match(source, /\/api\/astropages\/generated-site\/emdash\/bootstrap/);
  assert.match(source, /\/api\/astropages\/generated-site\/edit-readiness/);
  assert.match(source, /Bootstrap already current; skipping full builder content bootstrap/);
  assert.doesNotMatch(source, /requiredEnv\("BUILDER_MCP_PROVISION_SECRET"\)/);
  assert.match(source, /ASTROPAGES_CONTROL_PLANE_CALLBACK_TOKEN/);
  assert.match(source, /SERVICE_CALLBACK_BEARER_TOKEN/);
  assert.match(source, /BUILDER_MCP_PROVISION_SECRET/);
  assert.match(source, /body\.status !== "ready"/);
  assert.match(source, /mode: "full"/);
  assert.match(source, /cursor/);
  assert.match(source, /limit: 10/);
  assert.match(source, /nextCursor/);
  assert.doesNotMatch(source, /createCloudflareD1Binding/);
  assert.doesNotMatch(source, /import\("\.\.\/src\/server\/generated-site\/emdash-bootstrap\.ts"\)/);
});
