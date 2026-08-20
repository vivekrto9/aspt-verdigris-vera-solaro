import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

import { databaseNameForEnvironment } from "./wrangler-deploy-target.mjs";

const purposes = new Set([
  "template_ci",
  "template_preview",
  "template_production",
  "generated_preview",
  "generated_production",
]);
const purpose = process.env.ASTROPAGES_PIPELINE_PURPOSE ?? "";
const runnerTemp = mkdtempSync(join(tmpdir(), "astropages-pipeline-"));
let deploymentStage = "starting";

process.env.RUNNER_TEMP = runnerTemp;
process.env.GITHUB_REPOSITORY ||= process.env.CI_REPO ?? "";

try {
  if (!purposes.has(purpose)) {
    throw new Error(`Unsupported ASTROPAGES_PIPELINE_PURPOSE: ${purpose || "missing"}`);
  }
  verifyExactCommit();
  if (purpose === "template_production" && process.env.CI_COMMIT_BRANCH !== "main") {
    throw new Error("Template production deploys must run from main.");
  }

  if (purpose.startsWith("generated_")) {
    await runGeneratedPipeline();
  } else {
    await runTemplatePipeline();
  }
} finally {
  rmSync(runnerTemp, { force: true, recursive: true });
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function verifyExactCommit() {
  const expected = requiredEnv("ASTROPAGES_COMMIT_SHA");
  const result = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error("Unable to read the checked-out commit SHA.");
  const actual = result.stdout.trim();
  if (actual !== expected) {
    throw new Error(`Checked-out commit ${actual} does not match requested commit ${expected}.`);
  }
}

function run(command, args, stage) {
  deploymentStage = stage;
  console.log(`AstroPages pipeline stage: ${stage}`);
  const result = spawnSync(command, args, {
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed during ${stage}.`);
  }
}

function runPnpmScript(name, stage = name) {
  run("pnpm", ["run", name], stage);
}

function installDependencies() {
  run("pnpm", ["install", "--frozen-lockfile"], "dependency_install");
}

function strictVerification() {
  runPnpmScript("test", "test");
  runPnpmScript("scan:safety", "safety_scan");
  runPnpmScript("d1:schema:check", "d1_schema_check");
  runPnpmScript("typecheck", "typecheck");
}

async function runTemplatePipeline() {
  installDependencies();
  strictVerification();
  runPnpmScript("build", "build");
  if (purpose === "template_ci") return;
  const environment = purpose === "template_preview" ? "preview" : "production";
  await deployWorker({ environment, templateSource: true });
}

async function runGeneratedPipeline() {
  const isPreview = purpose === "generated_preview";
  const environment = isPreview ? "preview" : "production";
  const initialStatus = isPreview ? "building" : "deploying";
  const successStatus = isPreview ? "ready" : "live";

  try {
    await postDeploymentStatus(initialStatus);
    installDependencies();
    if (!isPreview || process.env.ASTROPAGES_VERIFICATION_PROFILE !== "initial_seed_fast") {
      strictVerification();
    }
    runPnpmScript("build", "build");
    await deployWorker({ environment, templateSource: false });
    await postDeploymentStatus(successStatus);
  } catch (error) {
    try {
      await postDeploymentStatus("failed", error);
    } catch (callbackError) {
      console.error(`Failure callback also failed: ${callbackError instanceof Error ? callbackError.message : String(callbackError)}`);
    }
    throw error;
  }
}

async function ensureResources(environment) {
  deploymentStage = "resource_repair";
  const { main } = await import("./ensure-cloudflare-resources.mjs");
  await main(environment);
}

function generatedConfigPath(environment) {
  return `.wrangler/generated/wrangler.${environment}.jsonc`;
}

function databaseNameFromConfig(configPath, environment) {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  return databaseNameForEnvironment(config, environment);
}

function workerSecretsPath() {
  const file = readdirSync(runnerTemp).find((name) => name.endsWith("-worker-secrets.json"));
  if (!file) throw new Error("Worker secrets file was not generated.");
  return join(runnerTemp, file);
}

async function deployWorker({ environment, templateSource }) {
  await ensureResources(environment);
  run("node", ["scripts/render-wrangler-config.mjs", environment], "render_wrangler_config");
  if (templateSource && !process.env.ASTROPAGES_CONTROL_PLANE_CALLBACK_TOKEN) {
    process.env.ASTROPAGES_CONTROL_PLANE_CALLBACK_TOKEN = randomBytes(32).toString("hex");
  }
  run("node", ["scripts/write-worker-secrets-file.mjs"], "write_worker_secrets");

  const configPath = generatedConfigPath(environment);
  const databaseName = databaseNameFromConfig(configPath, environment);
  run("pnpm", [
    "exec", "wrangler", "d1", "migrations", "apply", databaseName,
    "--env", environment, "--remote", "--config", configPath,
  ], "d1_migrations");

  if (!templateSource && environment === "preview") {
    for (const command of [
      "SELECT disabled FROM users LIMIT 0;",
      "SELECT name FROM _emdash_migrations WHERE name = '009_user_disabled';",
    ]) {
      run("pnpm", [
        "exec", "wrangler", "d1", "execute", databaseName,
        "--env", environment, "--remote", "--config", configPath, "--command", command,
      ], "emdash_d1_schema_check");
    }
  }

  if (templateSource) {
    run("node", ["scripts/seed-template-project-assets.mjs", environment], "seed_template_assets");
  }
  run("pnpm", [
    "exec", "wrangler", "deploy", "--env", environment, "--config", configPath,
    "--secrets-file", workerSecretsPath(),
  ], "worker_deploy");
  run("node", ["scripts/prepare-deployed-emdash.mjs", environment], "prepare_deployed_emdash");

  const siteUrl = requiredEnv(environment === "preview" ? "PREVIEW_SITE_URL" : "PRODUCTION_SITE_URL");
  const routes = templateSource
    ? [
        ["/", [200, 301, 302]],
        ["/api/astropages/generated-site/health", [200]],
        ["/api/astropages/generated-site/edit-readiness", [200]],
        ["/_assets/aliases/vera-portrait/vera-portrait.webp", [200, 301, 302]],
        ["/_emdash/admin", [200, 302]],
        ["/_emdash/api/setup/status", [200]],
      ]
    : environment === "preview"
      ? [
          ["/api/astropages/generated-site/health", [200]],
          ["/api/astropages/generated-site/edit-readiness", [200]],
        ]
      : [
          ["/api/astropages/generated-site/health", [200]],
          ["/api/astropages/generated-site/edit-readiness", [200]],
          ["/", [200]],
          ["/_emdash/admin", [200, 302]],
          ["/_emdash/api/setup/status", [200]],
        ];
  await smokeRoutes(siteUrl, routes);
}

async function smokeRoutes(siteUrl, routes) {
  deploymentStage = "smoke_checks";
  for (const [path, expectedStatuses] of routes) {
    const deadline = Date.now() + 180_000;
    let lastStatus = 0;
    while (Date.now() <= deadline) {
      try {
        const response = await fetch(new URL(path, siteUrl), { redirect: "manual", signal: AbortSignal.timeout(30_000) });
        lastStatus = response.status;
        if (expectedStatuses.includes(lastStatus)) {
          console.log(`${path} -> ${lastStatus}`);
          break;
        }
      } catch (error) {
        lastStatus = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    if (!expectedStatuses.includes(lastStatus)) {
      throw new Error(`${path} returned ${lastStatus}, expected ${expectedStatuses.join(",")}.`);
    }
  }
}

function callbackContext() {
  const isPreview = purpose === "generated_preview";
  const deploymentId = requiredEnv(
    isPreview ? "ASTROPAGES_PREVIEW_DEPLOYMENT_ID" : "ASTROPAGES_PRODUCTION_DEPLOYMENT_ID",
  );
  const baseUrl = requiredEnv("ASTROPAGES_CONTROL_PLANE_CALLBACK_BASE_URL").replace(/\/+$/, "");
  return {
    isPreview,
    deploymentId,
    url: `${baseUrl}/callback/${isPreview ? "preview" : "production"}-deployments/${encodeURIComponent(deploymentId)}/status`,
  };
}

async function postDeploymentStatus(status, failure) {
  const context = callbackContext();
  const pipelineRunId = requiredEnv("CI_PIPELINE_NUMBER");
  const commitSha = requiredEnv("ASTROPAGES_COMMIT_SHA");
  const body = {
    status,
    pipelineProvider: "woodpecker",
    pipelineRunId,
    commitSha,
    evidence: {
      pipelineRunUrl: process.env.CI_PIPELINE_URL ?? null,
      repository: process.env.CI_REPO ?? null,
      branch: process.env.CI_COMMIT_BRANCH ?? null,
      dispatchKey: process.env.ASTROPAGES_DISPATCH_KEY ?? null,
      projectId: process.env.ASTROPAGES_PROJECT_ID ?? null,
      projectVersionId: process.env.ASTROPAGES_PROJECT_VERSION_ID ?? null,
      projectBranchId: process.env.ASTROPAGES_PROJECT_BRANCH_ID ?? null,
      previewDeploymentId: process.env.ASTROPAGES_PREVIEW_DEPLOYMENT_ID ?? null,
      productionDeploymentId: process.env.ASTROPAGES_PRODUCTION_DEPLOYMENT_ID ?? null,
      verificationProfile: process.env.ASTROPAGES_VERIFICATION_PROFILE ?? null,
      failureStage: failure ? deploymentStage : undefined,
    },
  };
  if (status === "ready") body.previewUrl = requiredEnv("PREVIEW_SITE_URL");
  if (status === "live") {
    body.productionUrl = requiredEnv("PRODUCTION_SITE_URL");
    body.deployedAt = new Date().toISOString();
  }
  const response = await fetch(context.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requiredEnv("ASTROPAGES_CONTROL_PLANE_CALLBACK_TOKEN")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    // Production callbacks may promote a complete R2 asset projection and a
    // localized content snapshot before acknowledging the deployment.
    signal: AbortSignal.timeout(300_000),
  });
  const responseBody = await response.text();
  if (!response.ok) throw new Error(`AstroPages callback returned ${response.status}.`);
  if (status === "live") {
    const deployment = JSON.parse(responseBody);
    if (deployment.status !== "live") {
      throw new Error(`AstroPages production callback returned ${deployment.status || "unknown"}.`);
    }
  }
}
