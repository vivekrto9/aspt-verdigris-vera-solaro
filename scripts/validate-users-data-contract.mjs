import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("../astropages/users-data.manifest.json", import.meta.url), "utf8"));
const implementation = await readFile(new URL("../src/server/aggregator/users-data-mcp.ts", import.meta.url), "utf8");

assert.equal(manifest.version, 1);
assert.equal(manifest.contract, "users-data.v1");
assert.match(manifest.schemaRevision, /^[a-z0-9][a-z0-9._-]+$/);
assert.ok(manifest.entity?.idField);
assert.ok(Array.isArray(manifest.columns) && manifest.columns.length > 0);
assert.ok(Array.isArray(manifest.detailFields) && manifest.detailFields.length > 0);
assert.ok(Array.isArray(manifest.relatedSections));
assert.doesNotMatch(JSON.stringify(manifest), /\b(?:SELECT|WITH|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/i);

const sensitive = /(password|passcode|secret|token|hash|credential|challenge|session|csrf|otp)/i;
const keys = manifest.columns.map((column) => column.key);
assert.equal(new Set(keys).size, keys.length, "column keys must be unique");
assert.ok(keys.includes(manifest.entity.idField), "idField must be a list column");
for (const field of [...manifest.columns, ...manifest.detailFields]) {
  assert.match(field.key, /^[a-z][a-z0-9_]*$/);
  assert.doesNotMatch(field.key, sensitive);
}
for (const section of manifest.relatedSections) {
  assert.match(section.key, /^[a-z][a-z0-9_]*$/);
  assert.match(implementation, new RegExp(`sectionKey === "${section.key}"`), `${section.key} needs a fixed adapter`);
}
assert.doesNotMatch(JSON.stringify(manifest), /birth|encrypted|message_body|storage_key|provider_payment/i);
for (const method of ["users_schema", "users_list", "users_get", "users_related"]) {
  assert.match(implementation, new RegExp(`"${method}"`), `${method} must remain exposed`);
}

console.log(`Users Data contract ${manifest.schemaRevision} is valid.`);
