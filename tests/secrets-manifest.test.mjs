import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { runtimeContract } from "../scripts/cloudflare-runtime-contract.mjs";

// Secrets the platform always provisions for this template; every other secret a
// source file reads must be declared by the manifest so the deployment knows
// which credentials to collect.
const builtInSecretKeys = new Set([
  ...runtimeContract.requiredSecretNames,
  ...(runtimeContract.generatedSiteRequiredSecretNames ?? []),
  ...runtimeContract.sensitiveProviderSecretBindings.map((entry) => entry.binding),
  "ASTROPAGES_PLATFORM_GOOGLE_PLACES_API_KEY",
  "ASTROPAGES_PLATFORM_GOOGLE_PLACES_GOOGLE_PLACES_API_KEY",
]);

const sourceFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(target);
      return /\.(?:ts|tsx|js|mjs)$/.test(entry.name) ? [target] : [];
    }),
  );
  return nested.flat();
};

test("secret manifest contains requirements only and declares non-catalog lookups", async () => {
  const manifest = JSON.parse(await readFile("astropages/secrets.manifest.json", "utf8"));
  assert.equal(manifest.version, 1);
  assert.ok(Array.isArray(manifest.integrations));

  const declared = new Set();
  for (const integration of manifest.integrations) {
    assert.match(integration.key, /^[a-z][a-z0-9_]{0,63}$/);
    assert.equal(typeof integration.name, "string");
    assert.ok(Array.isArray(integration.secrets));
    for (const secret of integration.secrets) {
      // The manifest states requirements only; it never carries secret values.
      assert.deepEqual(
        Object.keys(secret).sort(),
        Object.keys(secret)
          .filter((key) => ["key", "label", "helpText", "required", "environments"].includes(key))
          .sort(),
      );
      assert.match(secret.key, /^[A-Z][A-Z0-9_]{0,63}$/);
      assert.ok(!declared.has(secret.key), `duplicate secret key ${secret.key}`);
      declared.add(secret.key);
    }
  }

  const lookupPattern = /resolveSecretBinding\([^,]+,\s*["']([A-Z][A-Z0-9_]*)["']/g;
  for (const file of await sourceFiles("src")) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(lookupPattern)) {
      assert.ok(
        builtInSecretKeys.has(match[1]) || declared.has(match[1]),
        `${path.relative(process.cwd(), file)} uses undeclared secret ${match[1]}`,
      );
    }
  }
});
