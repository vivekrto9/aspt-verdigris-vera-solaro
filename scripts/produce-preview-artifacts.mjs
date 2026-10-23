import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPrivateKey } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  collectWorkerFiles,
  producePreviewArtifacts,
  writeArtifactCandidate,
} from "./preview-artifacts.mjs";

// Called by the control-plane exact-source build orchestrator. The request and
// signing key live outside both clean build trees, never in worker inputs.
const requestPath = process.argv[2];
if (!requestPath)
  throw new Error(
    "Usage: node scripts/produce-preview-artifacts.mjs <request.json>",
  );
const request = JSON.parse(readFileSync(requestPath, "utf8"));
const root = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
const candidate = await producePreviewArtifacts({
  templateCommitSha: request.templateCommitSha,
  sourceTreeDigest: request.sourceTreeDigest,
  keyId: request.keyId,
  privateKey: createPrivateKey(readFileSync(request.signingKeyPath)),
  ...(request.benchmarkPath
    ? { benchmark: JSON.parse(readFileSync(request.benchmarkPath, "utf8")) }
    : {}),
  workerBuilds: [
    collectWorkerFiles(resolve(root, "dist"), { sourceRoot: root }),
    collectWorkerFiles(resolve(request.secondSourceRoot, "dist"), {
      sourceRoot: request.secondSourceRoot,
    }),
  ],
});
writeArtifactCandidate(candidate, request.outputDirectory);
console.log(
  JSON.stringify({
    kind: "local-preview-artifact-candidate",
    objects: candidate.objects.length,
    benchmarkIncluded: Boolean(request.benchmarkPath),
    catalogApprovalPerformed: false,
  }),
);
