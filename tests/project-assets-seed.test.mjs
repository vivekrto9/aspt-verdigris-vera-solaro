import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { buildTemplateAssetRevisionSeedSql } from "../scripts/project-assets-seed-sql.mjs";

const root = new URL("../", import.meta.url);

test("remote D1 asset seeding relies on Wrangler's execute batch transaction", () => {
  const seedScript = readFileSync(
    new URL("scripts/seed-template-project-assets.mjs", root),
    "utf8",
  );

  assert.doesNotMatch(seedScript, /BEGIN(?:\s+TRANSACTION)?;|COMMIT;/i);
  assert.match(seedScript, /\[\s*'d1', 'execute'/s);
});

test("remote asset seeding retries transient Wrangler failures with bounded concurrency", () => {
  const source = readFileSync(
    new URL("../scripts/seed-template-project-assets.mjs", import.meta.url),
    "utf8",
  );

  assert.match(source, /maxAttempts\s*=\s*4/);
  assert.match(source, /attempt\s*<=\s*maxAttempts/);
  assert.match(source, /Math\.min\(4_000/);
  assert.match(source, /uploadConcurrency = isLocal \? 1 : 4/);
  assert.doesNotMatch(source, /console\.(?:warn|error)\([^\n]*args/);
});

test("asset seeding supports the local Wrangler target as well as remote environments", () => {
  const seedScript = readFileSync(new URL("scripts/seed-template-project-assets.mjs", root), "utf8");

  assert.match(seedScript, /\['local', 'preview', 'production'\]/);
  assert.match(seedScript, /isLocal \? '--local' : '--remote'/);
});

test("changed template assets append a revision and remain idempotent on retry", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE ap_asset_revisions (
    revision_id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL,
    revision_number INTEGER NOT NULL,
    storage_key TEXT NOT NULL UNIQUE,
    content_hash TEXT NOT NULL,
    etag TEXT NOT NULL,
    file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    status TEXT NOT NULL,
    scan_status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (asset_id, revision_number)
  );`);
  database.exec(`INSERT INTO ap_asset_revisions (
    revision_id, asset_id, revision_number, storage_key, content_hash, etag,
    file_name, mime_type, size_bytes, status, scan_status, created_at
  ) VALUES (
    'arev_old', 'asset_logo', 1, 'assets/asset_logo/revisions/arev_old/logo.svg',
    'sha256:old', 'sha256:old', 'logo.svg', 'image/svg+xml', 100,
    'ready', 'clean', '2026-08-19T00:00:00.000Z'
  );`);

  const changedAsset = {
    assetId: "asset_logo",
    revisionId: "arev_new",
    storageKey: "assets/asset_logo/revisions/arev_new/logo.svg",
    contentHash: "sha256:new",
    fileName: "logo.svg",
    mimeType: "image/svg+xml",
    sizeBytes: 120,
  };
  const seedSql = buildTemplateAssetRevisionSeedSql(changedAsset, "2026-08-20T00:00:00.000Z");

  database.exec(seedSql);
  database.exec(seedSql);

  assert.deepEqual(
    database.prepare(`SELECT revision_id, revision_number FROM ap_asset_revisions
      WHERE asset_id = ? ORDER BY revision_number`).all("asset_logo").map((row) => ({ ...row })),
    [
      { revision_id: "arev_old", revision_number: 1 },
      { revision_id: "arev_new", revision_number: 2 },
    ],
  );
  database.close();
});
