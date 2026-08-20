import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

const createFakeD1 = ({ contentRows = {}, environmentState = null, revisionRows = [] } = {}) => {
  const statements = [];
  return {
    statements,
    prepare(sql) {
      const statement = {
        values: [],
        bind(...values) {
          this.values = values;
          return this;
        },
        async first() {
          statements.push({ sql, values: this.values, first: true });
          if (/MAX\(revision_number\).*revision/i.test(sql)) return { revision: 0 };
          if (/current_revision_number/i.test(sql)) return environmentState;
          if (/last_changed_at/i.test(sql)) return { last_changed_at: "2026-07-02T00:00:00.000Z" };
          const tableMatch = sql.match(/FROM\s+"?(ec_[a-z0-9_]+)"?/i);
          if (tableMatch) {
            const [slug, locale] = this.values;
            return contentRows[tableMatch[1]]?.find((row) => row.slug === slug && row.locale === locale) ?? null;
          }
          return null;
        },
        async all() {
          statements.push({ sql, values: this.values, all: true });
          if (/FROM ap_content_revision_log/i.test(sql)) return { results: revisionRows };
          if (/FROM sqlite_master/i.test(sql)) {
            return {
              results: Object.keys(contentRows)
                .filter((name) => this.values.includes(name))
                .map((name) => ({ name })),
            };
          }
          const tableMatch = sql.match(/FROM\s+"?(ec_[a-z0-9_]+)"?/i);
          if (tableMatch) {
            const tableRows = contentRows[tableMatch[1]] ?? [];
            const slugs = new Set(this.values.filter((value) => typeof value === "string"));
            return {
              results: tableRows.filter((row) => slugs.has(row.slug) && slugs.has(row.locale)),
            };
          }
          return { results: [] };
        },
        async run() {
          statements.push({ sql, values: this.values, run: true });
          return { success: true };
        },
      };
      return statement;
    },
  };
};

const createFakeBatchD1 = (options = {}) => {
  const db = createFakeD1(options);
  const batches = [];
  return {
    ...db,
    batches,
    async batch(statements) {
      batches.push(statements);
      return Promise.all(statements.map((statement) => statement.run()));
    },
  };
};

const createFakeEmdash = () => ({
  db: {},
  async handleContentGet(collection, entry, locale = "en") {
    if (collection !== "site_pages" || entry !== "home" || locale !== "en") {
      return { success: false, error: { message: "missing" } };
    }
    return {
      success: true,
      data: {
        item: {
          id: "content-site-pages-home-en",
          slug: entry,
          locale,
          data: {
            title: "Home",
            hero_kicker: "Trusted guidance",
            hero_title: "Premium guidance",
            private_note: "must not export",
          },
          liveData: {
            title: "Home",
            hero_kicker: "Trusted guidance",
            hero_title: "Premium guidance",
            private_note: "must not export",
          },
          publishedAt: "2026-07-02T00:00:00.000Z",
        },
      },
    };
  },
});

test("content release migration defines revision log and environment state", () => {
  const migration = read("migrations/0003_astropages_content_release_state.sql");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS ap_content_revision_log/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS ap_content_environment_state/);
  assert.match(migration, /source TEXT NOT NULL CHECK/);
  assert.match(migration, /openhands_mcp/);
  assert.match(migration, /system_import/);
});

test("content release middleware wraps EmDash after EmDash middleware", () => {
  const middleware = read("src/middleware.ts");
  assert.match(middleware, /sequence\(\s*emdashMiddleware,\s*astropagesContentReleaseMiddleware,\s*publicSeoMiddleware/s);
  const wrapper = read("src/server/generated-site/content-release-middleware.ts");
  assert.match(wrapper, /handleContentUpdate/);
  assert.match(wrapper, /handleContentPublish/);
  assert.match(wrapper, /recordContentRevision/);
  assert.match(wrapper, /getContentReleaseMutationAction\(locals\) === "publish"/);
  assert.match(wrapper, /shouldSkipLocalContentReleaseLog\(request, isDevelopmentRuntime\(\)\)/);
  assert.doesNotMatch(wrapper, /request\.clone\(\)|request\.json\(\)/);
});

test("content release mutation action is carried through request-local context", async () => {
  const {
    getContentReleaseMutationAction,
    setContentReleaseMutationAction,
  } = await import("../../src/server/generated-site/content-release-context.ts");
  const firstRequestLocals = {};
  const secondRequestLocals = {};

  assert.equal(getContentReleaseMutationAction(firstRequestLocals), undefined);
  setContentReleaseMutationAction(firstRequestLocals, "publish");
  setContentReleaseMutationAction(secondRequestLocals, "saveDraft");
  assert.equal(getContentReleaseMutationAction(firstRequestLocals), "publish");
  assert.equal(getContentReleaseMutationAction(secondRequestLocals), "saveDraft");
});

test("local development mutations skip deployed content release logging", async () => {
  const { shouldSkipLocalContentReleaseLog } = await import(
    "../../src/server/generated-site/content-release-context.ts"
  );

  assert.equal(
    shouldSkipLocalContentReleaseLog(new Request("http://localhost:4321/api/editor"), true),
    true,
  );
  assert.equal(
    shouldSkipLocalContentReleaseLog(new Request("http://127.0.0.1:4321/api/editor"), true),
    true,
  );
  assert.equal(
    shouldSkipLocalContentReleaseLog(new Request("http://[::1]:4321/api/editor"), true),
    true,
  );
  assert.equal(
    shouldSkipLocalContentReleaseLog(new Request("https://preview.example.com/api/editor"), true),
    false,
  );
  assert.equal(
    shouldSkipLocalContentReleaseLog(new Request("http://localhost:4321/api/editor"), false),
    false,
  );
});

test("content release snapshot is deterministic and restricted to builder fields", async () => {
  const { buildContentReleaseSnapshot } = await import("../../src/server/generated-site/content-release.ts");
  const env = {
    ASTROPAGES_SITE_ENVIRONMENT: "preview",
    DB: createFakeD1(),
  };
  const emdash = createFakeEmdash();

  const first = await buildContentReleaseSnapshot({ env, emdash });
  const second = await buildContentReleaseSnapshot({ env, emdash });

  assert.equal(first.templateKey, "aspt-verdigris-vera-solaro");
  assert.equal(first.environment, "preview");
  assert.equal(first.snapshotHash, second.snapshotHash);
  assert.equal(first.entries.some((entry) => "private_note" in entry.data), false);
  assert.equal(first.entries.some((entry) => entry.collection === "site_pages" && entry.entry === "home"), true);
});

test("content release snapshot reads direct D1 content without EmDash runtime", async () => {
  const { buildContentReleaseSnapshot } = await import("../../src/server/generated-site/content-release.ts");
  const env = {
    ASTROPAGES_SITE_ENVIRONMENT: "preview",
    DB: createFakeD1({
      contentRows: {
        ec_site_pages: [
          {
            id: "content-site-pages-home-en",
            slug: "home",
            locale: "en",
            published_at: "2026-07-02T00:00:00.000Z",
            draft_revision_id: null,
            title: "Home",
            hero_kicker: "Trusted guidance",
            hero_title: "Premium guidance",
            private_note: "must not export",
          },
        ],
      },
    }),
  };

  const snapshot = await buildContentReleaseSnapshot({ env });

  assert.equal(snapshot.templateKey, "aspt-verdigris-vera-solaro");
  assert.equal(snapshot.environment, "preview");
  assert.equal(snapshot.entries.some((entry) => "private_note" in entry.data), false);
  assert.equal(snapshot.entries.some((entry) => entry.collection === "site_pages" && entry.entry === "home"), true);
});

test("content release status is read-only and does not scan content tables", async () => {
  const { readContentReleaseStatus } = await import("../../src/server/generated-site/content-release.ts");
  const env = {
    ASTROPAGES_SITE_ENVIRONMENT: "preview",
    DB: createFakeD1({
      environmentState: {
        current_revision_number: 3,
        current_published_hash: "sha256:ledger-content",
        current_snapshot_hash: "sha256:ledger-snapshot",
        last_changed_at: "2026-07-02T00:00:00.000Z",
      },
      revisionRows: [
        {
          collection: "site_pages",
          entry: "home",
          locale: "en",
          changed_fields: JSON.stringify(["hero_title", "hero_body"]),
        },
      ],
    }),
  };

  const status = await readContentReleaseStatus({ env });
  const sql = env.DB.statements.map((statement) => statement.sql).join("\n");

  assert.equal(status.contentRevision, 3);
  assert.equal(status.publishedContentHash, "sha256:ledger-content");
  assert.equal(status.snapshotHash, "sha256:ledger-snapshot");
  assert.equal(status.changedEntries, 1);
  assert.equal(status.changedFields, 2);
  assert.doesNotMatch(sql, /CREATE TABLE/i);
  assert.doesNotMatch(sql, /FROM\s+"?ec_/i);
});

test("content release status keeps imported environment hash authoritative", async () => {
  const { readContentReleaseStatus } = await import("../../src/server/generated-site/content-release.ts");
  const env = {
    ASTROPAGES_SITE_ENVIRONMENT: "production",
    DB: createFakeD1({
      environmentState: {
        current_revision_number: 1,
        current_published_hash: "sha256:imported-snapshot-content",
        current_snapshot_hash: "sha256:imported-snapshot",
        last_changed_at: "2026-07-05T19:36:55.892Z",
      },
      revisionRows: [
        {
          collection: "site_pages",
          entry: "home",
          locale: "en",
          changed_fields: JSON.stringify(["hero_title"]),
          content_hash: "sha256:per-entry-import-hash",
        },
      ],
    }),
  };

  const status = await readContentReleaseStatus({ env });

  assert.equal(status.publishedContentHash, "sha256:imported-snapshot-content");
  assert.equal(status.snapshotHash, "sha256:imported-snapshot");
});

test("content release status avoids concurrent D1 reads", () => {
  const source = read("src/server/generated-site/content-release.ts");
  assert.doesNotMatch(
    source,
    /const\s+\[\s*state\s*,\s*revisionRows\s*\]\s*=\s*await\s+Promise\.all/s,
  );
  assert.match(source, /const state = await readEnvironmentState\(env, environment\);/);
  assert.match(source, /const revisionRows = await readContentReleaseRevisionRows\(env\);/);
});

test("content release import creates new content tables with builder fields", () => {
  const source = read("src/server/generated-site/content-release.ts");
  assert.match(source, /fieldColumns\.map\(\(field\) => `\$\{identifier\(field\)\} TEXT`\)/);
  assert.match(source, /PRAGMA table_info\(\$\{table\}\)/);
  assert.doesNotMatch(
    source,
    /for \(const field of config\.fields\)[\s\S]{0,160}ALTER TABLE/,
  );
});

test("content release import skips same snapshot retries", () => {
  const source = read("src/server/generated-site/content-release.ts");

  assert.match(source, /const currentState = await readEnvironmentState\(env, environment\);/);
  assert.match(source, /currentState\?\.current_published_hash === snapshot\.contentHash/);
  assert.match(source, /currentState\?\.current_snapshot_hash === snapshot\.snapshotHash/);
  assert.match(source, /importedEntries: 0/);
});

test("content release import batches entry and revision writes through D1", async () => {
  const { importContentReleaseSnapshot } = await import("../../src/server/generated-site/content-release.ts");
  const env = {
    ASTROPAGES_SITE_ENVIRONMENT: "production",
    DB: createFakeBatchD1(),
  };

  await importContentReleaseSnapshot({
    env,
    snapshot: {
      schemaVersion: 1,
      templateKey: "aspt-verdigris-vera-solaro",
      environment: "preview",
      contentRevision: 1,
      snapshotHash: "sha256:batch-snapshot",
      contentHash: "sha256:batch-content",
      exportedAt: "2026-07-17T00:00:00.000Z",
      summary: {
        entries: 2,
        fields: 4,
        pages: 1,
        seoFields: 0,
        contentFields: 4,
        locales: ["en", "hi"],
      },
      entries: [
        {
          collection: "site_pages",
          entry: "home",
          locale: "en",
          data: { title: "Home", hero_title: "English heading" },
          publishedAt: "2026-07-17T00:00:00.000Z",
        },
        {
          collection: "site_pages",
          entry: "home",
          locale: "hi",
          data: { title: "Home", hero_title: "Hindi heading" },
          publishedAt: "2026-07-17T00:00:00.000Z",
        },
      ],
    },
  });

  assert.equal(env.DB.batches.length > 0, true);
  assert.equal(env.DB.batches.some((batch) => batch.length > 1), true);
});

test("content release snapshot export can create release tables", () => {
  const statusRoute = read("src/server/generated-site/content-release.ts");
  assert.match(statusRoute, /ensureTables\s*=\s*true/);
});

test("content release service endpoints do not depend on EmDash locals", () => {
  const statusRoute = read("src/pages/api/astropages/generated-site/content-release/status.ts");
  const exportRoute = read("src/pages/api/astropages/generated-site/content-release/export.ts");

  assert.doesNotMatch(statusRoute, /context\.locals\.emdash/);
  assert.doesNotMatch(exportRoute, /context\.locals\.emdash/);
});

test("content release import endpoint returns a status-shaped payload", () => {
  const route = read("src/pages/api/astropages/generated-site/content-release/import.ts");

  assert.match(route, /readContentReleaseStatus/);
  assert.match(route, /const status = await readContentReleaseStatus/);
  assert.match(route, /data: status/);
  assert.doesNotMatch(route, /context\.locals\.emdash/);
});

test("content release status rejects browsers without service token", async () => {
  const { GET } = await import("../../src/pages/api/astropages/generated-site/content-release/status.ts");
  const response = await GET({
    request: new Request("https://base.example/api/astropages/generated-site/content-release/status"),
    locals: { runtime: { env: { ASTROPAGES_SITE_ENVIRONMENT: "preview", DB: createFakeD1() } } },
  });
  const body = await response.json();

  assert.equal(response.status, 401);
  assert.equal(body.status, "error");
  assert.match(body.message, /control-plane token/);
});
