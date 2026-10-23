import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../../scripts/ensure-cloudflare-resources.mjs", import.meta.url), "utf8");
const pagination = source.slice(source.indexOf("async function listAll("), source.indexOf("async function cloudflare("))
  .replace("export function", "function");
const getPath = source.slice(source.indexOf("function getPath("), source.indexOf("function setGithubEnv("));
const bucketsPath = "/accounts/test-account/r2/buckets";

function listWith(request) {
  return vm.runInNewContext(`${pagination}\n${getPath}\nlistAll`, { cloudflare: request, encodeURIComponent });
}

test("R2 follows its cursor and stops without a cursor despite total_count 227", async () => {
  const paths = [];
  const first = Array.from({ length: 100 }, (_, i) => ({ name: `bucket-${i}` }));
  const last = Array.from({ length: 100 }, (_, i) => ({ name: `last-${i}` }));
  const list = listWith(async (path) => {
    paths.push(path);
    assert.ok(paths.length <= 2, "pagination repeated the first page instead of terminating");
    return paths.length === 1
      ? { result: { buckets: first }, result_info: { total_count: 227, per_page: 100, cursor: "next+/=" } }
      : { result: { buckets: last }, result_info: { total_count: 227, per_page: 100 } };
  });
  assert.equal((await list(bucketsPath, "result.buckets")).length, 200);
  assert.deepEqual(paths, [bucketsPath + "?per_page=100", bucketsPath + "?per_page=100&cursor=next%2B%2F%3D"]);
});

test("R2 rejects a repeated cursor instead of looping successful responses", async () => {
  let calls = 0;
  const list = listWith(async () => {
    assert.ok(++calls <= 2, "pagination failed to reject the repeated cursor");
    return { result: { buckets: Array(100).fill({ name: "same" }) }, result_info: { total_count: 227, per_page: 100, cursor: "same" } };
  });
  await assert.rejects(list(bucketsPath, "result.buckets"), /non-advancing R2 cursor/);
  assert.equal(calls, 2);
});

test("numeric KV pagination retains page numbers and ignores unrelated cursor metadata", async () => {
  const paths = [];
  const list = listWith(async (path) => {
    paths.push(path);
    return { result: [{ id: paths.length }], result_info: { page: paths.length, total_pages: 2, cursor: "unused" } };
  });
  assert.equal((await list("/accounts/test-account/storage/kv/namespaces", "result")).length, 2);
  assert.deepEqual(paths.map(path => path.split("?")[1]), ["per_page=100&page=1", "per_page=100&page=2"]);
});
