import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertDeploymentWorkflowContract,
  assertWranglerRuntimeContract,
} from "./generated-site-contract-assertions.mjs";

test("generated-site workflow and runtime contracts pass without template-only files", () => {
  const root = mkdtempSync(join(tmpdir(), "base-generated-site-contract-"));

  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });

  writeFileSync(
    join(root, ".github", "workflows", "ci.yml"),
    [
      "name: CI",
      "steps:",
      "  - uses: pnpm/action-setup@v4",
      "  - run: pnpm install --frozen-lockfile",
      "  - run: pnpm run test",
      "  - run: pnpm run scan:safety",
      "  - run: pnpm run d1:schema:check",
      "  - run: pnpm run typecheck",
      "  - run: pnpm run build",
      "  - run: git diff --check",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, ".github", "workflows", "deploy-preview.yml"),
    [
      "name: Deploy Preview",
      "on:",
      "  workflow_dispatch:",
      "    inputs:",
      "      verification_profile:",
      "env:",
      "  ASTROPAGES_CONTROL_PLANE_CALLBACK_TOKEN: ${{ secrets.ASTROPAGES_CONTROL_PLANE_CALLBACK_TOKEN }}",
      "  ASTROPAGES_CONTROL_PLANE_CALLBACK_BASE_URL: ${{ secrets.ASTROPAGES_CONTROL_PLANE_CALLBACK_BASE_URL }}",
      "  CLOUDFLARE_SECRETS_STORE_ID: ${{ secrets.CLOUDFLARE_SECRETS_STORE_ID }}",
      "  ASTROPAGES_SSO_PUBLIC_JWK: ${{ vars.ASTROPAGES_SSO_PUBLIC_JWK }}",
      "  PREVIEW_SITE_D1_DATABASE_ID: ${{ vars.PREVIEW_SITE_D1_DATABASE_ID }}",
      "  PREVIEW_SITE_SESSION_KV_NAMESPACE_ID: ${{ vars.PREVIEW_SITE_SESSION_KV_NAMESPACE_ID }}",
      "  PREVIEW_SITE_URL: ${{ vars.PREVIEW_SITE_URL }}",
      "jobs:",
      "  deploy:",
      "    steps:",
      "      - uses: pnpm/action-setup@v4",
      "      - run: node scripts/render-wrangler-config.mjs preview",
      "      - run: node scripts/write-worker-secrets-file.mjs",
      "      - run: pnpm exec wrangler d1 migrations apply base-site-preview-site --env preview --remote --config .wrangler/generated/wrangler.preview.jsonc",
      "      - run: pnpm exec wrangler deploy --env preview --config .wrangler/generated/wrangler.preview.jsonc --secrets-file \"$RUNNER_TEMP/aspt-verdigris-vera-solaro-worker-secrets.json\"",
      "      - run: node scripts/prepare-deployed-emdash.mjs preview",
      "      - run: curl -sS \"$PREVIEW_SITE_URL/api/astropages/generated-site/health\"",
      "      - run: curl -sS \"$PREVIEW_SITE_URL/api/astropages/generated-site/edit-readiness\"",
      "      - run: |",
      "          curl -sS \"$PREVIEW_SITE_URL/api/astropages/generated-site/vera/operations\" -H \"Authorization: Bearer ${ASTROPAGES_CONTROL_PLANE_CALLBACK_TOKEN}\"",
      "          node -e 'const body = { status: \"ready\", state: \"ready\", data: { ready: true } }; if (body.status !== \"ready\" || body.state !== \"ready\" || body.data?.ready !== true) process.exit(1)'",
      "      - run: echo initial_seed_fast code_change_strict",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, ".github", "workflows", "deploy-production.yml"),
    [
      "name: Deploy Production",
      "on:",
      "  workflow_dispatch:",
      "env:",
      "  ASTROPAGES_CONTROL_PLANE_CALLBACK_TOKEN: ${{ secrets.ASTROPAGES_CONTROL_PLANE_CALLBACK_TOKEN }}",
      "  ASTROPAGES_CONTROL_PLANE_CALLBACK_BASE_URL: ${{ secrets.ASTROPAGES_CONTROL_PLANE_CALLBACK_BASE_URL }}",
      "  CLOUDFLARE_SECRETS_STORE_ID: ${{ secrets.CLOUDFLARE_SECRETS_STORE_ID }}",
      "  ASTROPAGES_SSO_PUBLIC_JWK: ${{ vars.ASTROPAGES_SSO_PUBLIC_JWK }}",
      "  PRODUCTION_SITE_D1_DATABASE_ID: ${{ vars.PRODUCTION_SITE_D1_DATABASE_ID }}",
      "  PRODUCTION_SITE_SESSION_KV_NAMESPACE_ID: ${{ vars.PRODUCTION_SITE_SESSION_KV_NAMESPACE_ID }}",
      "  PRODUCTION_SITE_URL: ${{ vars.PRODUCTION_SITE_URL }}",
      "jobs:",
      "  deploy:",
      "    steps:",
      "      - uses: pnpm/action-setup@v4",
      "      - run: node scripts/render-wrangler-config.mjs production",
      "      - run: node scripts/write-worker-secrets-file.mjs",
      "      - run: pnpm exec wrangler d1 migrations apply base-site-production-site --env production --remote --config .wrangler/generated/wrangler.production.jsonc",
      "      - run: pnpm exec wrangler deploy --env production --config .wrangler/generated/wrangler.production.jsonc --secrets-file \"$RUNNER_TEMP/aspt-verdigris-vera-solaro-worker-secrets.json\"",
      "      - run: node scripts/prepare-deployed-emdash.mjs production",
      "      - run: curl -sS \"$PRODUCTION_SITE_URL/api/astropages/generated-site/edit-readiness\"",
      "      - run: |",
      "          curl -sS \"$PRODUCTION_SITE_URL/api/astropages/generated-site/vera/operations\" -H \"Authorization: Bearer ${ASTROPAGES_CONTROL_PLANE_CALLBACK_TOKEN}\"",
      "          node -e 'const body = { status: \"ready\", state: \"ready\", data: { ready: true } }; if (body.status !== \"ready\" || body.state !== \"ready\" || body.data?.ready !== true) process.exit(1)'",
      "      - run: |",
      "          curl -sS --fail --max-time 60 \\",
      "            -X POST \"${ASTROPAGES_CONTROL_PLANE_CALLBACK_URL}\" \\",
      "            -H \"Authorization: Bearer ${ASTROPAGES_CONTROL_PLANE_CALLBACK_TOKEN}\" \\",
      "            -H \"Content-Type: application/json\" \\",
      "            --data @\"$RUNNER_TEMP/production-status-live.json\" \\",
      "            -o \"$RUNNER_TEMP/production-status-live-response.json\"",
      "          node <<'NODE'",
      "          const deployment = { status: 'live' };",
      "          if (deployment.status !== \"live\") {",
      "            console.error(`AstroPages production callback returned status ${deployment.status || \"unknown\"}.`);",
      "            process.exit(1);",
      "          }",
      "          NODE",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "wrangler.jsonc"),
    JSON.stringify({
      env: {
        preview: { secrets: { required: ["EMDASH_ENCRYPTION_KEY", "ASTROPAGES_CONTROL_PLANE_CALLBACK_TOKEN"] } },
        production: { secrets: { required: ["EMDASH_ENCRYPTION_KEY", "ASTROPAGES_CONTROL_PLANE_CALLBACK_TOKEN"] } },
      },
    }),
  );
  writeFileSync(
    join(root, "scripts", "cloudflare-runtime-contract.mjs"),
    [
      "export const runtimeContract = {",
      "  resources: {",
      '    preview: { d1DatabaseName: "base-site-preview-site" },',
      '    production: { d1DatabaseName: "base-site-production-site" },',
      "  },",
      '  requiredSecretNames: ["EMDASH_ENCRYPTION_KEY", "ASTROPAGES_CONTROL_PLANE_CALLBACK_TOKEN"],',
      "};",
      "",
    ].join("\n"),
  );

  assert.doesNotThrow(() => assertDeploymentWorkflowContract(root));
  assert.doesNotThrow(() => assertWranglerRuntimeContract(root));
});
