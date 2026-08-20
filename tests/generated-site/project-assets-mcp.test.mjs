import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

test("EmDash MCP advertises a complete project asset tool surface without exposing storage coordinates", async () => {
  const { projectAssetMcpTools } = await import("../../src/server/generated-site/project-assets-mcp.ts");
  assert.deepEqual(projectAssetMcpTools.map((tool) => tool.name), [
    "asset_list", "asset_get", "asset_create", "asset_import_url", "asset_update",
    "asset_replace", "asset_delete", "asset_restore",
  ]);
  assert.doesNotMatch(JSON.stringify(projectAssetMcpTools), /bucket|storageKey|signedUrl/i);
});

test("asset MCP calls require the existing EmDash bearer token and run before Astro", () => {
  const source = read("src/server/generated-site/project-assets-mcp.ts");
  const worker = read("src/worker.ts");
  assert.match(source, /_emdash_api_tokens/);
  assert.match(source, /AI asset writes are limited to 10 MB/);
  assert.match(source, /redirect: "error"/);
  assert.match(source, /url\.port && url\.port !== "443"/);
  assert.match(source, /hostname === "::1"/);
  assert.match(source, /hostname\.startsWith\("::ffff:"\)/);
  assert.match(source, /ASTROPAGES_CONTROL_PLANE_CALLBACK_BASE_URL/);
  assert.match(source, /callback\/project-assets/);
  assert.doesNotMatch(source, /scanStatus:\s*"not_required"/);
  assert.match(worker, /maybeHandleProjectAssetsMcp[\s\S]*maybeHandleAnalyticsMcpToolCall/);
});

test("tools/list augments EmDash streamable HTTP responses without reusing a consumed body", async () => {
  const { maybeHandleProjectAssetsMcp } = await import("../../src/server/generated-site/project-assets-mcp.ts");
  const request = new Request("https://example.test/_emdash/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} }),
  });
  const emdashPayload = JSON.stringify({
    jsonrpc: "2.0",
    id: 7,
    result: { tools: [{ name: "content_list", inputSchema: { type: "object" } }] },
  });

  const response = await maybeHandleProjectAssetsMcp(request, {}, async () => new Response(
    `event: message\ndata: ${emdashPayload}\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  ));

  assert.equal(response?.status, 200);
  assert.match(response?.headers.get("content-type") ?? "", /text\/event-stream/);
  const body = await response?.text();
  assert.match(body ?? "", /content_list/);
  assert.match(body ?? "", /asset_list/);
  assert.match(body ?? "", /asset_replace/);
});

test("asset list results keep arrays out of MCP structuredContent", async () => {
  const { projectAssetMcpResult } = await import("../../src/server/generated-site/project-assets-mcp.ts");
  const assets = [{ assetId: "asset_123", revisionId: "arev_123" }];
  const response = projectAssetMcpResult(9, assets);
  const payload = await response.json();

  assert.equal(payload.result.content[0].text, JSON.stringify(assets));
  assert.equal("structuredContent" in payload.result, false);

  const objectResponse = projectAssetMcpResult(10, assets[0]);
  const objectPayload = await objectResponse.json();
  assert.deepEqual(objectPayload.result.structuredContent, assets[0]);
});
