import {
  loadWranglerConfig,
  validateCloudflareRuntimeConfig,
} from "./cloudflare-runtime-contract.mjs";

const failures = validateCloudflareRuntimeConfig(loadWranglerConfig());

if (failures.length > 0) {
  console.error("Cloudflare runtime contract check failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Cloudflare runtime contract check passed");
