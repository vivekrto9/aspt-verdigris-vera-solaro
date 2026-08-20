import crypto from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "astropages/assets.manifest.json");
const seedRoot = path.join(root, "astropages/assets");
const write = process.argv.includes("--write");
const walk = (directory) => readdirSync(directory).flatMap((name) => {
  const absolute = path.join(directory, name);
  return statSync(absolute).isDirectory() ? walk(absolute) : [absolute];
});
const mime = (file) => ({ ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".avif": "image/avif", ".gif": "image/gif", ".pdf": "application/pdf", ".woff": "font/woff", ".woff2": "font/woff2" })[path.extname(file).toLowerCase()];
const aliasFor = (source) => source.replace(/\.[^.]+$/, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
const titleFor = (source) => path.basename(source, path.extname(source)).replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
const hash = (bytes) => `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;

if (!existsSync(seedRoot)) throw new Error("astropages/assets seed root is missing");
const files = walk(seedRoot).map((file) => path.relative(seedRoot, file).split(path.sep).join("/")).sort();
const generated = {
  contractVersion: 1,
  seedRoot: "astropages/assets",
  assets: files.map((source) => {
    const mimeType = mime(source);
    if (!mimeType) throw new Error(`Unsupported seed asset type: ${source}`);
    return {
      seedKey: source,
      source,
      alias: aliasFor(source),
      displayName: titleFor(source),
      mimeType,
      contentHash: hash(readFileSync(path.join(seedRoot, source))),
      visibility: "customer",
      protected: true,
      replaceable: true,
    };
  }),
};
const serialized = `${JSON.stringify(generated, null, 2)}\n`;
if (write) writeFileSync(manifestPath, serialized);
if (!existsSync(manifestPath) || readFileSync(manifestPath, "utf8") !== serialized) {
  throw new Error("astropages/assets.manifest.json is stale; run pnpm project-assets:contract:write");
}
const aliases = generated.assets.map((asset) => asset.alias);
if (new Set(aliases).size !== aliases.length) throw new Error("Seed asset aliases must be unique");
if (/\b(slot|slotKey|usage|requiredPlacement)\b/i.test(serialized)) throw new Error("Project asset seed contracts must not prescribe layout slots or usages");
console.log(`Project asset contract verified (${generated.assets.length} seed assets).`);
