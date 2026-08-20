import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const workflowPaths = {
  ci: ".github/workflows/ci.yml",
  templatePreview: ".github/workflows/deploy-template-preview.yml",
  templateProduction: ".github/workflows/deploy-production.yml",
  generatedPreviewSeed: ".astropages/generated-site-workflows/deploy-preview.yml",
  generatedProductionSeed: ".astropages/generated-site-workflows/deploy-production.yml",
  installedPreview: ".github/workflows/deploy-preview.yml",
  installedProduction: ".github/workflows/deploy-production.yml",
};

const defaultRoot = new URL("../../", import.meta.url);

const asRootUrl = (root = defaultRoot) => {
  if (root instanceof URL) {
    return root;
  }
  const rootPath = String(root);
  return pathToFileURL(rootPath.endsWith("/") ? rootPath : `${rootPath}/`);
};

const fileUrl = (root, path) => new URL(path, asRootUrl(root));
const read = (root, path) => readFileSync(fileUrl(root, path), "utf8");
const exists = (root, path) => existsSync(fileUrl(root, path));

export const detectWorkflowMode = (root = defaultRoot) => {
  const hasGeneratedPreviewSeed = exists(root, workflowPaths.generatedPreviewSeed);
  const hasGeneratedSeedDir = exists(root, ".astropages/generated-site-workflows");
  const hasInstalledPreview = exists(root, workflowPaths.installedPreview);
  const hasTemplatePreview = exists(root, workflowPaths.templatePreview);

  if (hasGeneratedPreviewSeed && !hasInstalledPreview && !hasTemplatePreview) {
    return "template-source";
  }

  if (!hasGeneratedSeedDir && hasInstalledPreview && !hasTemplatePreview) {
    return "generated-site";
  }

  throw new Error(
    [
      "Repository has an invalid AstroPages workflow layout.",
      `templatePreview=${hasTemplatePreview}`,
      `generatedPreviewSeed=${hasGeneratedPreviewSeed}`,
      `generatedSeedDir=${hasGeneratedSeedDir}`,
      `installedPreview=${hasInstalledPreview}`,
      `root=${asRootUrl(root).pathname}`,
    ].join(" "),
  );
};

const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const readRuntimeContractSource = (root) => read(root, "scripts/cloudflare-runtime-contract.mjs");

const parseRuntimeResourceValue = (root, envName, key) => {
  const source = readRuntimeContractSource(root);
  const match = source.match(new RegExp(`${envName}:\\s*\\{[\\s\\S]*?${key}:\\s*"([^"]+)"`));
  assert.ok(match, `runtimeContract.resources.${envName}.${key} must exist`);
  return match[1];
};

const assertCiWorkflow = (root) => {
  const workflow = read(root, workflowPaths.ci);

  for (const command of [
    "pnpm install --frozen-lockfile",
    "pnpm run test",
    "pnpm run scan:safety",
    "pnpm run d1:schema:check",
    "pnpm run typecheck",
    "pnpm run build",
    "git diff --check",
  ]) {
    assert.match(workflow, new RegExp(escaped(command)));
  }
};

const assertPnpmSetup = (root, paths) => {
  for (const path of paths) {
    const workflow = read(root, path);
    assert.match(workflow, /pnpm\/action-setup@v4/);
    assert.doesNotMatch(workflow, /version:\s*11\.1\.3/);
  }
};

const assertTemplateWorkflowOrder = (root) => {
  const cases = [
    {
      path: workflowPaths.templatePreview,
      envName: "preview",
      configPath: ".wrangler/generated/wrangler.preview.jsonc",
    },
    {
      path: workflowPaths.templateProduction,
      envName: "production",
      configPath: ".wrangler/generated/wrangler.production.jsonc",
    },
  ];

  for (const { path, envName, configPath } of cases) {
    const databaseName = parseRuntimeResourceValue(root, envName, "d1DatabaseName");
    const workflow = read(root, path);
    assert.doesNotMatch(workflow, /ASTROPAGES_CONTROL_PLANE_CALLBACK_BASE_URL/);
    assert.doesNotMatch(workflow, /BUILDER_MCP_TOKEN|BUILDER_MCP_PROVISION_SECRET/);
    const schemaCheck = workflow.indexOf("pnpm run d1:schema:check");
    const ensureResources = workflow.indexOf(`node scripts/ensure-cloudflare-resources.mjs ${envName}`);
    const renderConfig = workflow.indexOf(`node scripts/render-wrangler-config.mjs ${envName}`);
    const generateCallbackToken = workflow.indexOf("Generate template deploy callback token");
    const writeSecrets = workflow.indexOf("node scripts/write-worker-secrets-file.mjs");
    const applyMigrations = workflow.indexOf(
      `pnpm exec wrangler d1 migrations apply ${databaseName} --env ${envName} --remote --config ${configPath}`,
    );
    const deploy = workflow.indexOf(
      `pnpm exec wrangler deploy --env ${envName} --config ${configPath} --secrets-file "$RUNNER_TEMP/aspt-verdigris-vera-solaro-worker-secrets.json"`,
    );
    const prepareEmdash = workflow.indexOf(`node scripts/prepare-deployed-emdash.mjs ${envName}`);

    for (const [label, index] of Object.entries({
      schemaCheck,
      ensureResources,
      renderConfig,
      generateCallbackToken,
      writeSecrets,
      applyMigrations,
      deploy,
      prepareEmdash,
    })) {
      assert.notEqual(index, -1, `${path} missing ${label}`);
    }

    assert.ok(schemaCheck < ensureResources, `${path} must validate schema before provisioning`);
    assert.ok(ensureResources < renderConfig, `${path} must provision before rendering wrangler config`);
    assert.ok(renderConfig < generateCallbackToken, `${path} must render config before generating template callback token`);
    assert.ok(generateCallbackToken < writeSecrets, `${path} must generate template callback token before writing secrets`);
    assert.ok(writeSecrets < applyMigrations, `${path} must write secrets before migrations`);
    assert.ok(applyMigrations < deploy, `${path} must apply D1 migrations before deploy`);
    assert.ok(deploy < prepareEmdash, `${path} must deploy before preparing EmDash`);
  }
};

const assertTemplateSmokes = (root) => {
  for (const path of [workflowPaths.templatePreview, workflowPaths.templateProduction]) {
    const workflow = read(root, path);
    for (const smokePath of [
      "/",
      "/api/astropages/generated-site/health",
      "/api/astropages/generated-site/edit-readiness",
      "/_emdash/admin",
      "/_emdash/api/setup/status",
    ]) {
      assert.match(workflow, new RegExp(`smoke "${smokePath.replace(/\//g, "\\/")}"`), `${path} must smoke ${smokePath}`);
    }
    assert.doesNotMatch(workflow, /\/astrologers\/|\/booking-policy\//);
  }
};

const assertGeneratedWorkflowBasics = (root, paths) => {
  for (const path of paths) {
    const workflow = read(root, path);
    assert.match(workflow, /workflow_dispatch:/);
    assert.match(workflow, /ASTROPAGES_CONTROL_PLANE_CALLBACK_TOKEN/);
    assert.match(workflow, /ASTROPAGES_CONTROL_PLANE_CALLBACK_BASE_URL/);
    assert.match(workflow, /CLOUDFLARE_SECRETS_STORE_ID/);
    assert.match(workflow, /ASTROPAGES_SSO_PUBLIC_JWK/);
    assert.match(workflow, /scripts\/prepare-deployed-emdash\.mjs/);
    assert.match(workflow, /\/api\/astropages\/generated-site\/edit-readiness/);
    assert.match(workflow, /\/api\/astropages\/generated-site\/vera\/operations/);
    assert.match(workflow, /Authorization: Bearer \$\{ASTROPAGES_CONTROL_PLANE_CALLBACK_TOKEN\}/);
    assert.match(workflow, /body\.status !== "ready"/);
    assert.match(workflow, /body\.state !== "ready"/);
    assert.match(workflow, /body\.data\?\.ready !== true/);
    assert.doesNotMatch(workflow, /Create Your Free Birth Chart|Start your astrology chat|\/birth-chart|\/chat|\/puja-services|\/consultations|\/reports|\/shop/);
  }
};

const assertGeneratedWorkflowOrder = (root, pathsByEnv) => {
  for (const { path, envName, configPath } of pathsByEnv) {
    const databaseName = parseRuntimeResourceValue(root, envName, "d1DatabaseName");
    const workflow = read(root, path);
    const renderConfig = workflow.indexOf(`node scripts/render-wrangler-config.mjs ${envName}`);
    const writeSecrets = workflow.indexOf("node scripts/write-worker-secrets-file.mjs");
    const applyMigrations = workflow.indexOf(
      `pnpm exec wrangler d1 migrations apply ${databaseName} --env ${envName} --remote --config ${configPath}`,
    );
    const deploy = workflow.indexOf(
      `pnpm exec wrangler deploy --env ${envName} --config ${configPath} --secrets-file "$RUNNER_TEMP/aspt-verdigris-vera-solaro-worker-secrets.json"`,
    );

    for (const [label, index] of Object.entries({ renderConfig, writeSecrets, applyMigrations, deploy })) {
      assert.notEqual(index, -1, `${path} missing ${label}`);
    }
    assert.ok(renderConfig < writeSecrets, `${path} must render config before writing secrets`);
    assert.ok(writeSecrets < applyMigrations, `${path} must write secrets before migrations`);
    assert.ok(applyMigrations < deploy, `${path} must apply D1 migrations before deploy`);
    assert.doesNotMatch(workflow, /third-project-(preview|production)-site/);
    assert.doesNotMatch(workflow, /astropages-base-template/);
    assert.doesNotMatch(workflow, /PREVIEW_ASTRAGURU|PROD_ASTRAGURU|ASTRAGURU_|ASTROCONNECT/);
  }
};

const assertGenericGeneratedVariables = (root, previewPath, productionPath) => {
  const previewWorkflow = read(root, previewPath);
  const productionWorkflow = read(root, productionPath);

  assert.match(previewWorkflow, /PREVIEW_SITE_D1_DATABASE_ID: \$\{\{ vars\.PREVIEW_SITE_D1_DATABASE_ID \}\}/);
  assert.match(previewWorkflow, /PREVIEW_SITE_SESSION_KV_NAMESPACE_ID: \$\{\{ vars\.PREVIEW_SITE_SESSION_KV_NAMESPACE_ID \}\}/);
  assert.match(previewWorkflow, /PREVIEW_SITE_URL: \$\{\{ vars\.PREVIEW_SITE_URL \}\}/);
  assert.match(previewWorkflow, /verification_profile/);
  assert.match(previewWorkflow, /initial_seed_fast/);
  assert.match(previewWorkflow, /code_change_strict/);
  assert.match(previewWorkflow, /\/api\/astropages\/generated-site\/health/);

  assert.match(productionWorkflow, /PRODUCTION_SITE_D1_DATABASE_ID: \$\{\{ vars\.PRODUCTION_SITE_D1_DATABASE_ID \}\}/);
  assert.match(productionWorkflow, /PRODUCTION_SITE_SESSION_KV_NAMESPACE_ID: \$\{\{ vars\.PRODUCTION_SITE_SESSION_KV_NAMESPACE_ID \}\}/);
  assert.match(productionWorkflow, /PRODUCTION_SITE_URL: \$\{\{ vars\.PRODUCTION_SITE_URL \}\}/);
  assert.doesNotMatch(`${previewWorkflow}\n${productionWorkflow}`, /PREVIEW_ASTRAGURU|PROD_ASTRAGURU|ASTRAGURU_|ASTROCONNECT/);
};

const assertProductionCallbackStatusIsVerified = (root, productionPath) => {
  const workflow = read(root, productionPath);

  assert.match(workflow, /production-status-live-response\.json/);
  assert.match(workflow, /AstroPages production callback returned status/);
  assert.match(workflow, /deployment\.status !== "live"/);
};

export const assertDeploymentWorkflowContract = (root = defaultRoot) => {
  const mode = detectWorkflowMode(root);
  assertCiWorkflow(root);

  if (mode === "template-source") {
    for (const path of [
      workflowPaths.ci,
      workflowPaths.generatedPreviewSeed,
      workflowPaths.generatedProductionSeed,
    ]) {
      assert.equal(exists(root, path), true, `${path} must exist`);
    }
    assertPnpmSetup(root, [
      workflowPaths.ci,
      workflowPaths.generatedPreviewSeed,
      workflowPaths.generatedProductionSeed,
    ]);
    assertGeneratedWorkflowBasics(root, [
      workflowPaths.generatedPreviewSeed,
      workflowPaths.generatedProductionSeed,
    ]);
    assertGeneratedWorkflowOrder(root, [
      {
        path: workflowPaths.generatedPreviewSeed,
        envName: "preview",
        configPath: ".wrangler/generated/wrangler.preview.jsonc",
      },
      {
        path: workflowPaths.generatedProductionSeed,
        envName: "production",
        configPath: ".wrangler/generated/wrangler.production.jsonc",
      },
    ]);
    assertGenericGeneratedVariables(
      root,
      workflowPaths.generatedPreviewSeed,
      workflowPaths.generatedProductionSeed,
    );
    assertProductionCallbackStatusIsVerified(root, workflowPaths.generatedProductionSeed);
    return;
  }

  assert.equal(exists(root, workflowPaths.templatePreview), false, `${workflowPaths.templatePreview} must not be required in generated-site mode`);
  assert.equal(exists(root, ".astropages/generated-site-workflows"), false, ".astropages/generated-site-workflows must not be required in generated-site mode");
  assert.equal(exists(root, workflowPaths.installedPreview), true, `${workflowPaths.installedPreview} must exist`);
  assert.equal(exists(root, workflowPaths.installedProduction), true, `${workflowPaths.installedProduction} must exist`);
  assertPnpmSetup(root, [
    workflowPaths.ci,
    workflowPaths.installedPreview,
    workflowPaths.installedProduction,
  ]);
  assertGeneratedWorkflowBasics(root, [
    workflowPaths.installedPreview,
    workflowPaths.installedProduction,
  ]);
  assertGeneratedWorkflowOrder(root, [
    {
      path: workflowPaths.installedPreview,
      envName: "preview",
      configPath: ".wrangler/generated/wrangler.preview.jsonc",
    },
    {
      path: workflowPaths.installedProduction,
      envName: "production",
      configPath: ".wrangler/generated/wrangler.production.jsonc",
    },
  ]);
  assertGenericGeneratedVariables(root, workflowPaths.installedPreview, workflowPaths.installedProduction);
  assertProductionCallbackStatusIsVerified(root, workflowPaths.installedProduction);
};

const parseRequiredSecretNames = (source) => {
  const marker = "requiredSecretNames:";
  const markerIndex = source.indexOf(marker);
  assert.notEqual(markerIndex, -1, "runtimeContract.requiredSecretNames must exist");
  const openBracketIndex = source.indexOf("[", markerIndex);
  const closeBracketIndex = source.indexOf("]", openBracketIndex);
  assert.notEqual(openBracketIndex, -1, "runtimeContract.requiredSecretNames must be an array");
  assert.notEqual(closeBracketIndex, -1, "runtimeContract.requiredSecretNames array must close");
  return Array.from(source.slice(openBracketIndex, closeBracketIndex + 1).matchAll(/"([^"]+)"/g), (match) => match[1]);
};

export const assertWranglerRuntimeContract = (root = defaultRoot) => {
  const mode = detectWorkflowMode(root);
  const contractSource = readRuntimeContractSource(root);
  const requiredSecretNames = parseRequiredSecretNames(contractSource);

  if (mode === "generated-site") {
    assert.deepEqual(requiredSecretNames, [
      "EMDASH_ENCRYPTION_KEY",
      "ASTROPAGES_CONTROL_PLANE_CALLBACK_TOKEN",
    ]);
    assert.doesNotMatch(contractSource, /"BUILDER_MCP_TOKEN"|"BUILDER_MCP_PROVISION_SECRET"/);
    const wranglerSource = exists(root, "wrangler.jsonc") ? read(root, "wrangler.jsonc") : "";
    assert.doesNotMatch(wranglerSource, /"BUILDER_MCP_TOKEN"|"BUILDER_MCP_PROVISION_SECRET"/);
    return;
  }

  assert.deepEqual(requiredSecretNames, [
    "EMDASH_ENCRYPTION_KEY",
    "ASTROPAGES_CONTROL_PLANE_CALLBACK_TOKEN",
  ]);
  assert.doesNotMatch(contractSource, /"BUILDER_MCP_TOKEN"|"BUILDER_MCP_PROVISION_SECRET"/);
  const wranglerSource = exists(root, "wrangler.jsonc") ? read(root, "wrangler.jsonc") : "";
  assert.doesNotMatch(wranglerSource, /"BUILDER_MCP_TOKEN"|"BUILDER_MCP_PROVISION_SECRET"/);
  const generatedSiteMarker = "generatedSiteRequiredSecretNames:";
  const generatedSiteMarkerIndex = contractSource.indexOf(generatedSiteMarker);
  assert.notEqual(
    generatedSiteMarkerIndex,
    -1,
    "template runtime contract must declare generated-site Worker secrets",
  );
  const generatedSiteOpenBracketIndex = contractSource.indexOf("[", generatedSiteMarkerIndex);
  const generatedSiteCloseBracketIndex = contractSource.indexOf("]", generatedSiteOpenBracketIndex);
  const generatedSiteRequiredSecretNames = Array.from(
    contractSource
      .slice(generatedSiteOpenBracketIndex, generatedSiteCloseBracketIndex + 1)
      .matchAll(/"([^"]+)"/g),
    (match) => match[1],
  );
  assert.deepEqual(generatedSiteRequiredSecretNames, [
    "EMDASH_ENCRYPTION_KEY",
    "ASTROPAGES_CONTROL_PLANE_CALLBACK_TOKEN",
  ]);
};
