import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = new URL("../", import.meta.url);
const exists = (path) => existsSync(new URL(path, root));
const registrationCommitSentinel = "RESOLVED_AT_TEMPLATE_REGISTRATION";
const expectedRepositoryUrl = `https://github.com/vivekrto9/${basename(fileURLToPath(root))}.git`;

test("catalog release identity is immutable and belongs to the source repository", () => {
  const manifest = JSON.parse(readFileSync(new URL("template.manifest.json", root), "utf8"));

  assert.deepEqual(manifest.repo, {
    url: expectedRepositoryUrl,
    commitSha: registrationCommitSentinel,
  });
  assert.equal(manifest.runtime.type, "official-emdash-astro-cloudflare");
  assert.equal(manifest.routes.admin, "/_emdash/admin");
});

test("template source delegates releases to the signed Woodpecker extension", () => {
  const manifest = JSON.parse(readFileSync(new URL("template.manifest.json", root), "utf8"));
  assert.deepEqual(manifest.workflows.template, {
  "provider": "woodpecker",
  "configurationSource": "signed-control-plane-extension",
  "entrypoint": "pnpm run astropages:pipeline",
  "purposes": {
    "ci": "template_ci",
    "preview": "template_preview",
    "production": "template_production"
  },
  "githubSafetyCi": ".github/workflows/ci.yml",
  "catalogScreenshots": "admin-managed"
});
  assert.deepEqual(manifest.workflows.generatedSite, {
    previewSeed: ".astropages/generated-site-workflows/deploy-preview.yml",
    previewInstalledPath: ".github/workflows/deploy-preview.yml",
    previewTrigger: "control-plane-workflow-dispatch",
    previewCallback: {
      statusRoute: "/callback/preview-deployments/:previewDeploymentId/status",
      auth: "service-bearer",
      urlSource: "ASTROPAGES_CONTROL_PLANE_CALLBACK_BASE_URL",
    },
    productionSeed: ".astropages/generated-site-workflows/deploy-production.yml",
    productionInstalledPath: ".github/workflows/deploy-production.yml",
    productionTrigger: "control-plane-workflow-dispatch",
    productionCallback: {
      statusRoute: "/callback/production-deployments/:productionDeploymentId/status",
      auth: "service-bearer",
      urlSource: "ASTROPAGES_CONTROL_PLANE_CALLBACK_BASE_URL",
    },
  });
  assert.equal(exists(".github/workflows/ci.yml"), true);
  assert.equal(exists(".github/workflows/deploy-template-preview.yml"), false);
  assert.equal(exists(".github/workflows/deploy-production.yml"), false);
  assert.equal(exists(".woodpecker.yml"), false);
  assert.equal(exists("scripts/astropages-pipeline.mjs"), true);
  assert.equal(exists(".astropages/generated-site-workflows/deploy-preview.yml"), true);
  assert.equal(exists(".astropages/generated-site-workflows/deploy-production.yml"), true);
});
