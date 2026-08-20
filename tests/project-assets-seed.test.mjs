import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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
