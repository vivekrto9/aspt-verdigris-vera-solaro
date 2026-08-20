import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { runtimeContract } from "./cloudflare-runtime-contract.mjs";

const runnerTemp = process.env.RUNNER_TEMP ?? ".wrangler/generated";
const outputPath = join(runnerTemp, "aspt-verdigris-vera-solaro-worker-secrets.json");
const secrets = {};
const generatedSiteMode =
  Boolean(process.env.ASTROPAGES_PROJECT_ID) ||
  process.env.ASTROPAGES_GENERATED_SITE_MODE === "1";
const requiredSecretNames = generatedSiteMode
  ? runtimeContract.generatedSiteRequiredSecretNames ?? runtimeContract.requiredSecretNames
  : runtimeContract.requiredSecretNames;
const optionalTemplateSecretNames = generatedSiteMode
  ? []
  : ["ASTROPAGES_CONTROL_PLANE_CALLBACK_TOKEN", "SERVICE_CALLBACK_BEARER_TOKEN"];

for (const name of requiredSecretNames) {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required to write the Worker secrets file`);
    process.exit(1);
  }
  secrets[name] = value;
}

for (const name of optionalTemplateSecretNames) {
  const value = process.env[name];
  if (value) secrets[name] = value;
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(secrets)}\n`, { mode: 0o600 });
console.log(`Worker secrets file written to ${outputPath}`);
