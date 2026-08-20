import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const outputName = "aspt-verdigris-vera-solaro-worker-secrets.json";

const runWriter = (env) => {
  const runnerTemp = mkdtempSync(join(tmpdir(), "vera-worker-secrets-"));
  const result = spawnSync(process.execPath, ["scripts/write-worker-secrets-file.mjs"], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      RUNNER_TEMP: runnerTemp,
      ...env,
    },
    encoding: "utf8",
  });
  return { result, runnerTemp };
};

test("generated-site secret file contains only generated-site Worker secrets", () => {
  const { result, runnerTemp } = runWriter({
    ASTROPAGES_PROJECT_ID: "11111111-1111-4111-8111-111111111111",
    EMDASH_ENCRYPTION_KEY: "test-emdash-key",
    ASTROPAGES_CONTROL_PLANE_CALLBACK_TOKEN: "test-callback-token",
  });

  try {
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(runnerTemp, outputName), "utf8")), {
      EMDASH_ENCRYPTION_KEY: "test-emdash-key",
      ASTROPAGES_CONTROL_PLANE_CALLBACK_TOKEN: "test-callback-token",
    });
  } finally {
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});

test("template-source secret file uses the generated callback token and excludes stale Builder secrets", () => {
  const { result, runnerTemp } = runWriter({
    EMDASH_ENCRYPTION_KEY: "test-emdash-key",
    ASTROPAGES_CONTROL_PLANE_CALLBACK_TOKEN: "test-callback-token",
    BUILDER_MCP_TOKEN: "test-builder-token",
    BUILDER_MCP_PROVISION_SECRET: "test-provision-secret",
  });

  try {
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(runnerTemp, outputName), "utf8")), {
      EMDASH_ENCRYPTION_KEY: "test-emdash-key",
      ASTROPAGES_CONTROL_PLANE_CALLBACK_TOKEN: "test-callback-token",
    });
  } finally {
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});

test("template-source secret file rejects Builder-only deployment credentials", () => {
  const { result, runnerTemp } = runWriter({
    EMDASH_ENCRYPTION_KEY: "test-emdash-key",
    BUILDER_MCP_TOKEN: "test-builder-token",
    BUILDER_MCP_PROVISION_SECRET: "test-provision-secret",
  });

  try {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ASTROPAGES_CONTROL_PLANE_CALLBACK_TOKEN is required/);
  } finally {
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});
