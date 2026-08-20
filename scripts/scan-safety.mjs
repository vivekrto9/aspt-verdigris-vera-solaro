import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const ignoredDirs = new Set([
  ".astro",
  ".git",
  ".local-smoke",
  ".turbo",
  ".wrangler",
  "dist",
  "node_modules",
]);
const ignoredFiles = new Set([".dev.vars", ".dev.vars.local", ".env", ".env.local"]);
const scannedExtensions = new Set([
  ".astro",
  ".css",
  ".env",
  ".example",
  ".js",
  ".json",
  ".jsonc",
  ".md",
  ".mjs",
  ".sql",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

const getExtension = (path) => {
  if (path.endsWith(".dev.vars.example")) return ".example";
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot);
};

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return ignoredDirs.has(entry.name) ? [] : walk(path);
    }
    return [path];
  });

const failures = [];
const serverCapabilityPrefix = "src/server/capabilities/";
const providerLeakAllowedPrefixes = [
  "src/server/capabilities/vendor/astropages-capabilities/",
  "src/server/capabilities/provider-boundary.ts",
  "tests/",
];
const browserFacingPrefixes = ["src/pages/", "src/layouts/", "src/utils/"];
const serverRoutePrefixes = ["src/pages/api/"];

for (const localSecretFile of ignoredFiles) {
  if (existsSync(join(root, localSecretFile))) {
    const status = await run("git", ["check-ignore", "-q", localSecretFile]);
    if (status !== 0) {
      failures.push(`${localSecretFile} exists but is not ignored by Git`);
    }
  }
}

for (const file of walk(root)) {
  const rel = relative(root, file);
  if (ignoredFiles.has(rel)) continue;
  if (!scannedExtensions.has(getExtension(rel))) continue;

  const text = readFileSync(file, "utf8");
  const checks = [
    [/Basic\s+[A-Za-z0-9+/=]{16,}/, "Basic auth material must not be committed"],
    [/BUILDER_MCP_TOKEN\s*=\s*(?!ec_pat_replace-with|<|$)[^\s]+/, "real Builder MCP token value"],
    [/BUILDER_MCP_PROVISION_SECRET\s*=\s*(?!replace-with|<|$)[^\s]+/, "real Builder MCP provision secret value"],
    [/EMDASH_ENCRYPTION_KEY\s*=\s*(?!replace-with|<|$)[^\s]+/, "real EmDash encryption key value"],
    [/CLOUDFLARE_API_TOKEN\s*=\s*(?!replace-with|<|$)[^\s]+/, "real Cloudflare API token value"],
    [/CLOUDFLARE_ACCOUNT_ID\s*=\s*(?!replace-with|<|$)[^\s]+/, "real Cloudflare account id value"],
    [/"database_id"\s*:\s*"[0-9a-f-]{32,}"/i, "real Cloudflare D1 database id value"],
    [/"id"\s*:\s*"[0-9a-f-]{32,}"/i, "real Cloudflare resource id value"],
  ];

  for (const [pattern, message] of checks) {
    if (pattern.test(text)) {
      failures.push(`${rel}: ${message}`);
    }
  }

  const hasProviderInternals =
    /https:\/\/json\.astrologyapi\.com|https:\/\/json-chat\.astrologyapi\.com|Basic \$\{/.test(
      text,
    );
  const providerInternalsAllowed = providerLeakAllowedPrefixes.some((prefix) =>
    rel.startsWith(prefix),
  );
  if (hasProviderInternals && !providerInternalsAllowed) {
    failures.push(`${rel}: provider internals must stay server-side`);
  }

  const isBrowserFacing = browserFacingPrefixes.some((prefix) =>
    rel.startsWith(prefix),
  );
  const isServerRoute = serverRoutePrefixes.some((prefix) =>
    rel.startsWith(prefix),
  );
  if (
    isBrowserFacing &&
    !isServerRoute &&
    new RegExp(`${serverCapabilityPrefix}|astropages-capabilities`).test(text)
  ) {
    failures.push(`${rel}: browser-facing code must not import capabilities`);
  }
}

if (failures.length > 0) {
  console.error("Safety scan failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Safety scan passed");

async function run(command, args) {
  const { spawn } = await import("node:child_process");
  return await new Promise((resolve) => {
    const child = spawn(command, args, { cwd: root, stdio: "ignore" });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}
