import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const packageJson = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const source = readFileSync(new URL("scripts/astropages-pipeline.mjs", root), "utf8");

test("repository exposes the provider-neutral AstroPages pipeline entrypoint", () => {
  assert.equal(packageJson.scripts["astropages:pipeline"], "node scripts/astropages-pipeline.mjs");
  for (const purpose of [
    "template_ci",
    "template_preview",
    "template_production",
    "generated_preview",
    "generated_production",
  ]) {
    assert.match(source, new RegExp(`\\b${purpose}\\b`));
  }
});

test("generated callbacks identify the exact Woodpecker run and deployment", () => {
  assert.match(source, /pipelineProvider:\s*"woodpecker"/);
  assert.match(source, /requiredEnv\("CI_PIPELINE_NUMBER"\)/);
  assert.doesNotMatch(source, /requiredEnv\("CI_PIPELINE_ID"\)/);
  assert.match(source, /ASTROPAGES_COMMIT_SHA/);
  assert.match(source, /ASTROPAGES_PREVIEW_DEPLOYMENT_ID/);
  assert.match(source, /ASTROPAGES_PRODUCTION_DEPLOYMENT_ID/);
  assert.doesNotMatch(source, /failureMessage/);
  assert.match(source, /AbortSignal\.timeout\(300_000\)/);
});

test("template deployments create a process-local callback token without logging it", () => {
  assert.match(source, /randomBytes\(32\)\.toString\("hex"\)/);
  assert.match(source, /process\.env\.ASTROPAGES_CONTROL_PLANE_CALLBACK_TOKEN/);
  assert.doesNotMatch(source, /console\.log\([^\n]*ASTROPAGES_CONTROL_PLANE_CALLBACK_TOKEN/);
});

test("template deployment preserves verification, migration, deploy, and portable smoke-check stages", () => {
  for (const command of [
    "scan:safety",
    "d1:schema:check",
    "render-wrangler-config.mjs",
    "write-worker-secrets-file.mjs",
    "wrangler",
    "prepare-deployed-emdash.mjs",
  ]) {
    assert.match(source, new RegExp(command.replaceAll(".", "\\.")));
  }
  assert.match(source, /smokeRoutes/);
  assert.doesNotMatch(source, /verifyVeraReadiness|vera_runtime_readiness/);
  assert.match(source, /await smokeRoutes\(siteUrl, routes\);/);
  assert.match(source, /await deployWorker\(\{ environment, templateSource: false \}\);\s+await postDeploymentStatus\(successStatus\);/);
  assert.match(source, /\["\/", \[200, 301, 302\]\]/);
  assert.doesNotMatch(source, /consultations|puja-services|astrologers\/maya-trivedi/);
});
