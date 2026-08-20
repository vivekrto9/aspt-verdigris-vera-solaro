import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

test("sales manifest owns the shared commerce and MCP contracts", () => {
  const raw = readFileSync(join(process.cwd(), "astropages/sales.manifest.json"), "utf8");
  const manifest = JSON.parse(raw);
  assert.equal(manifest.contract, "sales-mcp.v1");
  assert.equal(manifest.semanticModel, "commerce.v1");
});
