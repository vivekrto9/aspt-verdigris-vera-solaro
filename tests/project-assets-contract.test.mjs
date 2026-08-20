import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = new URL("../", import.meta.url);
const readJson = (path) => JSON.parse(readFileSync(new URL(path, root), "utf8"));
const walk = (directory) => readdirSync(directory).flatMap((name) => {
  const absolute = new URL(`${name}${statSync(new URL(name, directory)).isDirectory() ? "/" : ""}`, directory);
  return statSync(absolute).isDirectory() ? walk(absolute) : [absolute];
});

test("template assets use a portable seed manifest without deterministic layout slots", () => {
  const template = readJson("template.manifest.json");
  const assets = readJson("astropages/assets.manifest.json");
  assert.deepEqual(template.assets, {
    contractVersion: 1,
    manifestPath: "astropages/assets.manifest.json",
    seedRoot: "astropages/assets",
  });
  assert.equal(assets.contractVersion, 1);
  assert.equal(assets.assets.length > 0, true);
  assert.equal(new Set(assets.assets.map((asset) => asset.alias)).size, assets.assets.length);
  assert.equal(assets.assets.every((asset) => asset.protected && asset.replaceable), true);
  assert.doesNotMatch(JSON.stringify(assets), /assetSlots|slotKey|requiredPlacement|usages/i);
  for (const asset of assets.assets) assert.equal(existsSync(new URL(`astropages/assets/${asset.source}`, root)), true);
});

test("seed manifest content hashes are current", () => {
  const result = spawnSync(process.execPath, ["scripts/validate-project-assets-contract.mjs"], { cwd: new URL(".", root), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("site source uses Project Assets delivery instead of public SVG paths", () => {
  const source = walk(new URL("src/", root))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  assert.doesNotMatch(source, /["'`](?:\/assets\/[^"'`\s)]+\.svg|\/favicon\.svg)/);
});
