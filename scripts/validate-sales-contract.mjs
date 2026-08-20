import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("../astropages/sales.manifest.json", import.meta.url), "utf8"));
const adapter = [
  await readFile(new URL("../migrations/0007_sales_mcp_commerce_views.sql", import.meta.url), "utf8"),
  await readFile(new URL("../migrations/0009_vera_reporting_views.sql", import.meta.url), "utf8"),
].join("\n");
const implementation = await readFile(new URL("../src/server/aggregator/sales-mcp.ts", import.meta.url), "utf8");

assert.equal(manifest.version, 1);
assert.equal(manifest.contract, "sales-mcp.v1");
assert.equal(manifest.semanticModel, "commerce.v1");
assert.match(manifest.schemaRevision, /^[a-z0-9][a-z0-9._-]+$/);
assert.ok(Array.isArray(manifest.transactionKinds) && manifest.transactionKinds.length > 0);
assert.ok(Array.isArray(manifest.dimensions));
assert.ok(Array.isArray(manifest.entities));
assert.ok(Array.isArray(manifest.paymentStatuses) && manifest.paymentStatuses.length > 0);

const uniqueKeys = (items, label) => {
  const keys = items.map((item) => item.key);
  assert.equal(new Set(keys).size, keys.length, `${label} keys must be unique`);
  for (const item of items) {
    assert.match(item.key, /^[a-z0-9][a-z0-9_-]*$/, `${label} key ${item.key} is invalid`);
    assert.ok(typeof item.label === "string" && item.label.trim(), `${label} ${item.key} needs a label`);
  }
};

uniqueKeys(manifest.transactionKinds, "transaction kind");
uniqueKeys(manifest.dimensions, "dimension");
for (const kind of manifest.transactionKinds) {
  assert.match(adapter, new RegExp(`'${kind.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'\\s+AS\\s+kind_key`, "i"), `adapter view must emit ${kind.key}`);
  assert.ok(typeof kind.description === "string" && kind.description.trim(), `${kind.key} needs a semantic description`);
}
for (const dimension of manifest.dimensions) {
  assert.match(
    adapter,
    new RegExp(`'${dimension.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'\\s+AS\\s+dimension_key`, "i"),
    `adapter view must emit ${dimension.key}`,
  );
}
for (const entity of manifest.entities) {
  assert.equal(entity.type, "item", `unsupported Vera entity type ${entity.type}`);
  assert.ok(manifest.transactionKinds.some((kind) => kind.key === entity.transactionKind), `${entity.key} refers to an unknown transaction kind`);
}
for (const method of ["sales_schema", "sales_resolve_entity", "sales_metric", "sales_breakdown", "sales_trend", "sales_compare", "sales_transactions"]) {
  assert.match(implementation, new RegExp(`"${method}"`), `${method} must remain exposed`);
}

console.log(`Sales contract ${manifest.schemaRevision} is valid.`);
