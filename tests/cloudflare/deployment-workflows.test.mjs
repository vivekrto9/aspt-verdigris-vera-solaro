import test from "node:test";

import { assertDeploymentWorkflowContract } from "./generated-site-contract-assertions.mjs";

test("Cloudflare deployment workflows match the current repository mode", () => {
  assertDeploymentWorkflowContract();
});
