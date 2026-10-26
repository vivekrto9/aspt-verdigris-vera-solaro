import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { buildBaseWorkspace } from "../scripts/preview-artifacts.mjs";
import { nativeStaticAssets } from "../src/server/generated-site/workspace-state/template-contract.ts";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

test("native Vera Solaro base is deterministic and keeps public catalog, content, and assets", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vera-native-contract-"));
  try {
    const commit = "0".repeat(40);
    const first = join(directory, "first.sqlite");
    const second = join(directory, "second.sqlite");
    const a = await buildBaseWorkspace(first, { templateCommitSha: commit });
    const b = await buildBaseWorkspace(second, { templateCommitSha: commit });
    assert.equal(sha256(readFileSync(first)), sha256(readFileSync(second)));
    assert.equal(a.authoredFingerprint, b.authoredFingerprint);
    const assets = JSON.parse(readFileSync(new URL("../astropages/assets.manifest.json", import.meta.url), "utf8")).assets;
    assert.equal(a.seedAssets.length, assets.length);
    assert.equal(a.localizedEntries, 22);
    assert.equal(nativeStaticAssets.length, 0);
    const db = new DatabaseSync(first, { readOnly: true });
    try {
      for (const [table, minimum] of Object.entries({
        ap_vera_services: 3,
        ap_vera_calendly_mappings: 6,
        ap_email_templates: 15,
        ap_email_events: 15,
        ap_email_variable_mappings: 21,
        ap_asset_records: new Set(assets.map((asset) => asset.contentHash)).size,
        ap_asset_aliases: assets.length,
      })) assert.ok(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count >= minimum, table);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ap_email_deliveries").get().count, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ap_customer_accounts").get().count, 0);
      assert.deepEqual(db.prepare("SELECT slug, duration_minutes, price_inr_cents, price_usd_cents, active FROM ap_vera_services ORDER BY slug").all().map((row) => ({ ...row })), [
        { slug: "natal-hour", duration_minutes: 30, price_inr_cents: 1990000, price_usd_cents: 24000, active: 1 },
        { slug: "two-charts", duration_minutes: 30, price_inr_cents: 3490000, price_usd_cents: 42000, active: 1 },
        { slug: "year-ahead", duration_minutes: 30, price_inr_cents: 3150000, price_usd_cents: 38500, active: 1 },
      ]);
      assert.equal(db.prepare("SELECT value_json FROM ap_business_settings WHERE key='payment_preference'").get().value_json, '{"value":"AUTO","schemaVersion":1,"revision":1}');
      assert.ok(db.prepare("SELECT id FROM _emdash_collections WHERE slug='vera_home_sections'").get());
      assert.ok(db.prepare("SELECT id FROM _emdash_collections WHERE slug='site_chrome'").get());
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
      assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    } finally { db.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
