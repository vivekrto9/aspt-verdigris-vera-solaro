import { runtimeContract } from "./cloudflare-runtime-contract.mjs";

console.log("# Operator-run Cloudflare resource plan");
console.log("# This prints equivalent manual Cloudflare resource commands.");
console.log("# It does not create resources.");
console.log("# Secret commands are for template-source deployments; generated sites use the generated-site secret contract.\n");

for (const envName of runtimeContract.environments) {
  const resource = runtimeContract.resources[envName];
  console.log(`## ${envName}`);
  console.log(`pnpm exec wrangler d1 create ${resource.d1DatabaseName}`);
  console.log(`pnpm exec wrangler r2 bucket create ${resource.r2BucketName}`);
  console.log(`pnpm exec wrangler kv namespace create ${resource.kvNamespaceName}`);
  console.log(`pnpm exec wrangler queues create ${resource.emailQueueName}`);
  console.log(`pnpm exec wrangler queues create ${resource.emailDeadLetterQueueName}`);
  for (const secretName of runtimeContract.requiredSecretNames) {
    console.log(`pnpm exec wrangler secret put ${secretName} --env ${envName}`);
  }
  console.log("");
}
