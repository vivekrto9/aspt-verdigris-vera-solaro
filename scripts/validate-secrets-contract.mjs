import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { runtimeContract } from "./cloudflare-runtime-contract.mjs";

const manifest = JSON.parse(
  await readFile(new URL("../astropages/secrets.manifest.json", import.meta.url), "utf8"),
);

assert.equal(manifest.version, 1, "Secrets manifest version must be 1");
assert.ok(Array.isArray(manifest.integrations), "integrations must be an array");

// Secrets the platform always provisions for this template. Everything else a
// source file reads has to be declared by the manifest so the deployment knows
// which credentials to collect.
const builtInSecretKeys = new Set([
  ...runtimeContract.requiredSecretNames,
  ...(runtimeContract.generatedSiteRequiredSecretNames ?? []),
  ...runtimeContract.sensitiveProviderSecretBindings.map((entry) => entry.binding),
  "ASTROPAGES_PLATFORM_GOOGLE_PLACES_API_KEY",
  "ASTROPAGES_PLATFORM_GOOGLE_PLACES_GOOGLE_PLACES_API_KEY",
]);

const declared = new Set();
for (const integration of manifest.integrations) {
  assert.match(integration.key, /^[a-z][a-z0-9_]{0,63}$/);
  assert.equal(typeof integration.name, "string");
  assert.ok(Array.isArray(integration.secrets));
  for (const secret of integration.secrets) {
    assert.match(secret.key, /^[A-Z][A-Z0-9_]{0,63}$/);
    assert.ok(!declared.has(secret.key), `duplicate secret key ${secret.key}`);
    declared.add(secret.key);
  }
}

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

const srcPath = new URL("../src", import.meta.url).pathname;
const lookupPattern = /resolveSecretBinding\([^,]+,\s*["']([A-Z][A-Z0-9_]*)["']/g;
for (const file of await sourceFiles(srcPath)) {
  const source = await readFile(file, "utf8");
  for (const match of source.matchAll(lookupPattern)) {
    assert.ok(
      builtInSecretKeys.has(match[1]) || declared.has(match[1]),
      `${path.relative(process.cwd(), file)} uses undeclared secret ${match[1]}`,
    );
  }
}

console.log("Secrets contract is valid.");
