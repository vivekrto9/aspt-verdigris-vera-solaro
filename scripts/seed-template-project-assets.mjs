import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const environment = process.argv[2];
if (!['local', 'preview', 'production'].includes(environment)) throw new Error('Usage: node scripts/seed-template-project-assets.mjs <local|preview|production>');
const isLocal = environment === 'local';
const configPath = isLocal ? 'wrangler.jsonc' : `.wrangler/generated/wrangler.${environment}.jsonc`;
const manifest = JSON.parse(await fs.readFile('astropages/assets.manifest.json', 'utf8'));
const templateManifest = JSON.parse(await fs.readFile('template.manifest.json', 'utf8'));
const parseJsonc = (source) => JSON.parse(source
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/,\s*([}\]])/g, '$1'));
const config = parseJsonc(await fs.readFile(configPath, 'utf8'));
const section = isLocal ? config : config.env?.[environment] ?? config;
const bucket = section.r2_buckets?.find((item) => item.binding === 'MEDIA')?.bucket_name;
const database = section.d1_databases?.find((item) => item.binding === 'DB')?.database_name;
if (!bucket || !database) throw new Error(`${isLocal ? 'Local' : `Rendered ${environment}`} R2/D1 bindings are missing.`);

const opaque = (prefix, value) => `${prefix}_${crypto.createHash('sha256').update(value).digest('hex').slice(0, 26)}`;
const sql = (value) => `'${String(value ?? '').replaceAll("'", "''")}'`;
const nullable = (value) => value == null ? 'NULL' : sql(value);
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const runOnce = (args) => new Promise((resolve, reject) => {
  const child = spawn('pnpm', ['exec', 'wrangler', ...args], { stdio: 'inherit' });
  child.on('error', reject);
  child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`wrangler exited with ${code}`)));
});
const run = async (args, { maxAttempts = 4 } = {}) => {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await runOnce(args);
    } catch (error) {
      if (attempt >= maxAttempts) throw error;
      const delay = Math.min(4_000, 1_000 * (2 ** (attempt - 1))) + Math.floor(Math.random() * 250);
      console.warn(`Wrangler operation failed; retrying attempt ${attempt + 1} of ${maxAttempts} after ${delay}ms.`);
      await sleep(delay);
    }
  }
};

const records = await Promise.all(manifest.assets.map(async (asset) => {
  const assetId = opaque('asset', `${templateManifest.templateKey}:${asset.seedKey}`);
  const revisionId = opaque('arev', `${templateManifest.templateKey}:${asset.seedKey}:${asset.contentHash}`);
  const fileName = path.basename(asset.source);
  const sizeBytes = (await fs.stat(path.join(manifest.seedRoot, asset.source))).size;
  return { ...asset, assetId, revisionId, fileName, sizeBytes, storageKey: `assets/${assetId}/revisions/${revisionId}/${fileName}` };
}));

const uploadConcurrency = isLocal ? 1 : 4;
for (let offset = 0; offset < records.length; offset += uploadConcurrency) {
  await Promise.all(records.slice(offset, offset + uploadConcurrency).map((asset) => run([
    'r2', 'object', 'put', `${bucket}/${asset.storageKey}`,
    '--file', path.join(manifest.seedRoot, asset.source), '--content-type', asset.mimeType,
    isLocal ? '--local' : '--remote', '--force',
    ...(!isLocal ? ['--env', environment] : []),
    '--config', configPath,
  ])));
}

const now = new Date().toISOString();
const statements = [];
for (const asset of records) {
  statements.push(
    `INSERT INTO media (id, filename, mime_type, size, alt, caption, storage_key, content_hash, status) VALUES (${sql(asset.assetId)}, ${sql(asset.fileName)}, ${sql(asset.mimeType)}, ${asset.sizeBytes}, NULL, NULL, ${sql(asset.storageKey)}, ${sql(asset.contentHash)}, 'ready') ON CONFLICT(id) DO UPDATE SET filename=excluded.filename, mime_type=excluded.mime_type, size=excluded.size, storage_key=excluded.storage_key, content_hash=excluded.content_hash, status='ready';`,
    `INSERT INTO ap_asset_records (asset_id, current_revision_id, display_name, origin, visibility, protected, replaceable, created_at, updated_at) VALUES (${sql(asset.assetId)}, ${sql(asset.revisionId)}, ${sql(asset.displayName)}, 'template', ${sql(asset.visibility ?? 'customer')}, ${asset.protected === false ? 0 : 1}, ${asset.replaceable === false ? 0 : 1}, ${sql(now)}, ${sql(now)}) ON CONFLICT(asset_id) DO UPDATE SET current_revision_id=excluded.current_revision_id, display_name=excluded.display_name, visibility=excluded.visibility, protected=excluded.protected, replaceable=excluded.replaceable, deleted_at=NULL, updated_at=excluded.updated_at;`,
    `INSERT INTO ap_asset_revisions (revision_id, asset_id, revision_number, storage_key, content_hash, etag, file_name, mime_type, size_bytes, status, scan_status, created_at) VALUES (${sql(asset.revisionId)}, ${sql(asset.assetId)}, 1, ${sql(asset.storageKey)}, ${sql(asset.contentHash)}, ${sql(asset.contentHash)}, ${sql(asset.fileName)}, ${sql(asset.mimeType)}, ${asset.sizeBytes}, 'ready', 'clean', ${sql(now)}) ON CONFLICT(revision_id) DO UPDATE SET status='ready', scan_status='clean';`,
  );
  if (asset.alias) statements.push(`INSERT INTO ap_asset_aliases (alias, asset_id, origin, protected, created_at, updated_at) VALUES (${sql(asset.alias)}, ${sql(asset.assetId)}, 'template', 1, ${sql(now)}, ${sql(now)}) ON CONFLICT(alias) DO UPDATE SET asset_id=excluded.asset_id, protected=1, updated_at=excluded.updated_at;`);
}
if (!isLocal) statements.push(`INSERT INTO ap_asset_release_state (environment, current_revision_number, active_asset_count, deleted_asset_count, last_changed_at, updated_at) VALUES (${sql(environment)}, 1, ${records.length}, 0, ${sql(now)}, ${sql(now)}) ON CONFLICT(environment) DO UPDATE SET active_asset_count=excluded.active_asset_count, deleted_asset_count=0, current_asset_hash=NULL, current_snapshot_hash=NULL, updated_at=excluded.updated_at;`);
const temp = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'astropages-assets-')), 'seed.sql');
await fs.writeFile(temp, `${statements.join('\n')}\n`, { mode: 0o600 });
try {
  await run([
    'd1', 'execute', database, '--file', temp,
    isLocal ? '--local' : '--remote', '--yes',
    ...(!isLocal ? ['--env', environment] : []),
    '--config', configPath,
  ]);
} finally {
  await fs.rm(path.dirname(temp), { recursive: true, force: true });
}
console.log(`Seeded ${records.length} template project assets into ${environment} R2/D1.`);
