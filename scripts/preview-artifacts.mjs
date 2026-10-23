import { nativeBaseSeedDataTables, nativeSeedAssetAliases, nativePrivateEmailSampleKeys, nativeBaseSettingKeys, nativeDynamicCollections, nativeStaticAssetPaths, nativeStaticAssets } from "../src/server/generated-site/workspace-state/template-contract.ts";
import { createHash, sign, verify } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { createRequire } from "node:module";
import {
  readFileSync,
  readdirSync,
  lstatSync,
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applySeed } from "emdash/seed";
import {
  bootstrapAstroPagesEmDashContent,
  readAstroPagesEmDashBootstrapStatus,
} from "../src/server/generated-site/emdash-bootstrap.ts";
import { canonicalTemplateKey } from "../src/server/generated-site/template-runtime-identity.ts";
import { getBuilderReleaseTargets } from "../src/builder/registry.ts";
import { activeLocales } from "../src/data/localization-contract.ts";
import { exportWorkspaceAuthoredState, inspectWorkspaceAuthoredState } from "../src/server/generated-site/workspace-authored-state.ts";
import {
  collections,
  tables as authoredTables,
  settingKeys,
} from "../src/server/generated-site/workspace-state/domains.ts";
import {
  loadWranglerConfig,
  runtimeContract,
} from "./cloudflare-runtime-contract.mjs";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const requireEmDash = createRequire(import.meta.resolve("emdash/seed"));
const { Kysely, SqliteDialect } = requireEmDash("kysely");
const epoch = "2000-01-01T00:00:00.000Z";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const basePaymentPreference = JSON.stringify({
  value: "AUTO",
  schemaVersion: 1,
  revision: 1,
});
export const runtimeTuple = Object.freeze({
  wrangler: "4.94.0",
  miniflare: "4.20260521.0",
  workerd: "1.20260521.1",
});
export function assertRuntimeTuple(actual) {
  if (
    !actual ||
    Object.keys(actual).length !== 3 ||
    Object.entries(runtimeTuple).some(([key, value]) => actual[key] !== value)
  )
    throw new Error("preview_runtime_tuple_mismatch");
}
export const canonicalJson = (value) =>
  JSON.stringify(value, function (key, item) {
    return item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((name) => [name, item[name]]),
        )
      : item;
  });
const artifactKinds = [
  "worker_bundle",
  "workspace_base_sqlite",
  "seed_asset",
  "artifact_manifest",
];
const canonicalBytes = (value) => Buffer.from(canonicalJson(value));

export function signArtifactSet({
  templateCommitSha,
  sourceTreeDigest,
  keyId,
  privateKey,
  objects,
  workspaceEvidence,
  benchmark,
  launch,
}) {
  if (
    !/^[a-f0-9]{40}$/.test(templateCommitSha) ||
    !/^[a-f0-9]{64}$/.test(sourceTreeDigest) ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(keyId)
  )
    throw new Error("artifact_identity_invalid");
  const signed = objects
    .map(({ kind, bytes }) => {
      if (!artifactKinds.slice(0, 3).includes(kind) || !bytes.length)
        throw new Error("artifact_kind_invalid");
      const descriptor = {
        contractVersion: "preview-artifact.v1",
        canonicalTemplateKey,
        templateCommitSha,
        sourceTreeDigest,
        runtimeTuple,
        kind,
        digest: digest(bytes),
        byteSize: bytes.length,
      };
      descriptor.objectKey = `artifacts/sha256/${descriptor.digest}`;
      return {
        descriptor,
        signature: sign(null, canonicalBytes(descriptor), privateKey).toString(
          "base64",
        ),
        keyId,
        bytes,
      };
    })
    .sort((a, b) =>
      `${a.descriptor.kind}:${a.descriptor.digest}`.localeCompare(
        `${b.descriptor.kind}:${b.descriptor.digest}`,
        "en",
      ),
    );
  const manifest = {
    contractVersion: "preview-artifact.v1",
    canonicalTemplateKey,
    templateCommitSha,
    sourceTreeDigest,
    runtimeTuple,
    workspaceContract: "workspace-authored-state.v1",
    workspaceEvidence,
    ...(benchmark ? { benchmark } : {}),
    ...(launch ? { launch } : {}),
    artifacts: signed.map(({ descriptor }) => descriptor),
  };
  const bytes = canonicalBytes(manifest);
  const descriptor = {
    contractVersion: "preview-artifact.v1",
    canonicalTemplateKey,
    templateCommitSha,
    sourceTreeDigest,
    runtimeTuple,
    kind: "artifact_manifest",
    digest: digest(bytes),
    byteSize: bytes.length,
    objectKey: `artifacts/sha256/${digest(bytes)}`,
  };
  return {
    objects: [
      ...signed,
      {
        descriptor,
        signature: sign(null, canonicalBytes(descriptor), privateKey).toString(
          "base64",
        ),
        keyId,
        bytes,
      },
    ],
  };
}

/** Trust roots are supplied by the operator, never taken from artifact contents. */
export function verifyArtifactSet(set, trustedKeys) {
  if (!set || !Array.isArray(set.objects) || set.objects.length > 1000)
    throw new Error("artifact_inventory_invalid");
  const identities = new Set();
  for (const object of set.objects) {
    const d = object.descriptor;
    if (
      !d ||
      d.contractVersion !== "preview-artifact.v1" ||
      d.canonicalTemplateKey !== canonicalTemplateKey ||
      !artifactKinds.includes(d.kind) ||
      !/^[a-f0-9]{40}$/.test(d.templateCommitSha) ||
      !/^[a-f0-9]{64}$/.test(d.sourceTreeDigest)
    )
      throw new Error("artifact_identity_invalid");
    assertRuntimeTuple(d.runtimeTuple);
    if (
      digest(object.bytes) !== d.digest ||
      d.byteSize !== object.bytes.length ||
      d.objectKey !== `artifacts/sha256/${d.digest}`
    )
      throw new Error("artifact_digest_mismatch");
    if (
      !Object.hasOwn(trustedKeys, object.keyId) ||
      !verify(
        null,
        canonicalBytes(d),
        trustedKeys[object.keyId],
        Buffer.from(object.signature, "base64"),
      )
    )
      throw new Error("artifact_signature_invalid");
    const identity = `${d.kind}:${d.digest}`;
    if (identities.has(identity))
      throw new Error("artifact_inventory_duplicate");
    identities.add(identity);
  }
  const ofKind = (kind) =>
    set.objects.filter((object) => object.descriptor.kind === kind);
  for (const kind of [
    "worker_bundle",
    "workspace_base_sqlite",
    "artifact_manifest",
  ])
    if (ofKind(kind).length !== 1)
      throw new Error("artifact_inventory_missing");
  if (!ofKind("seed_asset").length)
    throw new Error("artifact_inventory_missing");
  const manifest = JSON.parse(
    Buffer.from(ofKind("artifact_manifest")[0].bytes).toString("utf8"),
  );
  const payloads = set.objects.filter(
    (object) => object.descriptor.kind !== "artifact_manifest",
  );
  if (
    manifest.contractVersion !== "preview-artifact.v1" ||
    manifest.canonicalTemplateKey !== canonicalTemplateKey ||
    manifest.workspaceContract !== "workspace-authored-state.v1" ||
    !Array.isArray(manifest.artifacts) ||
    manifest.artifacts.length !== payloads.length ||
    payloads.some(
      (object) =>
        manifest.artifacts.filter(
          (d) => canonicalJson(d) === canonicalJson(object.descriptor),
        ).length !== 1,
    )
  )
    throw new Error("artifact_inventory_mismatch");
  for (const { descriptor: d } of set.objects)
    if (
      d.templateCommitSha !== manifest.templateCommitSha ||
      d.sourceTreeDigest !== manifest.sourceTreeDigest ||
      canonicalJson(d.runtimeTuple) !== canonicalJson(manifest.runtimeTuple)
    )
      throw new Error("artifact_identity_mismatch");
  return manifest;
}

/** A regular-file-only container: no tar/PAX/link extraction semantics. */
export function decodeWorkerBundle(
  bytes,
  { maxExpandedBytes = 64 * 1024 * 1024 } = {},
) {
  if (
    bytes.length > 32 * 1024 * 1024 ||
    !Number.isSafeInteger(maxExpandedBytes) ||
    maxExpandedBytes < 1 ||
    maxExpandedBytes > 64 * 1024 * 1024
  )
    throw new Error("worker_bundle_size_limit");
  const archive = JSON.parse(
    gunzipSync(bytes, { maxOutputLength: maxExpandedBytes }).toString("utf8"),
  );
  if (
    archive.format !== "preview-worker-files.v1" ||
    !Array.isArray(archive.files) ||
    archive.files.length > 10000
  )
    throw new Error("unsafe_worker_bundle");
  const paths = new Set();
  return archive.files.map((file) => {
    if (
      file.type !== "file" ||
      typeof file.path !== "string" ||
      !file.path ||
      file.path.length > 512 ||
      file.path.includes("\\") ||
      /[\x00-\x1f\x7f:]/.test(file.path) ||
      file.path
        .split("/")
        .some((part) => !part || part === "." || part === "..") ||
      typeof file.data !== "string"
    )
      throw new Error("unsafe_worker_bundle_path");
    if (paths.has(file.path)) throw new Error("duplicate_worker_bundle_path");
    if (
      [...paths].some(
        (path) =>
          path.startsWith(file.path + "/") || file.path.startsWith(path + "/"),
      )
    )
      throw new Error("worker_bundle_path_conflict");
    paths.add(file.path);
    const data = Buffer.from(file.data, "base64");
    if (data.toString("base64") !== file.data)
      throw new Error("unsafe_worker_bundle_encoding");
    return { path: file.path, bytes: data };
  });
}

export function encodeWorkerBundle(files) {
  const bytes = gzipSync(
    canonicalBytes({
      format: "preview-worker-files.v1",
      files: files
        .map((file) => ({
          path: file.path,
          type: "file",
          data: file.bytes.toString("base64"),
        }))
        .sort((a, b) =>
          Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)),
        ),
    }),
    { level: 9 },
  );
  decodeWorkerBundle(bytes);
  return bytes;
}

export function installedRuntimeTuple() {
  const require = createRequire(import.meta.url);
  const wrangler = require.resolve("wrangler/package.json");
  const miniflare = createRequire(wrangler).resolve("miniflare/package.json");
  const workerd = createRequire(miniflare).resolve("workerd/package.json");
  const actual = Object.fromEntries(
    Object.entries({ wrangler, miniflare, workerd }).map(([name, file]) => [
      name,
      JSON.parse(readFileSync(file, "utf8")).version,
    ]),
  );
  assertRuntimeTuple(actual);
  return actual;
}

export function verifyNativeStaticAssetFiles(files) {
  for (const asset of nativeStaticAssets) {
    if (!/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+$/.test(asset.path) || asset.path.includes("..") || !/^[a-f0-9]{64}$/.test(asset.digest)) throw new Error("native_public_asset_path_invalid");
    const matches = files.filter(file => file.path === `client${asset.path}`);
    if (matches.length !== 1 || digest(matches[0].bytes) !== asset.digest) throw new Error("native_public_asset_bundle_mismatch");
  }
}

export function collectWorkerFiles(directory, { sourceRoot = root } = {}) {
  const files = [];
  let size = 0;
  const visit = (relative) => {
    const absolute = resolve(directory, relative);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error("unsafe_worker_bundle_path");
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolute).sort())
        visit(`${relative}/${name}`);
      return;
    }
    if (!stat.isFile()) throw new Error("unsafe_worker_bundle_path");
    if (relative.startsWith("server/") && !relative.endsWith(".mjs")) return;
    if (relative.endsWith(".map") || relative === "client/.assetsignore")
      return;
    if (
      relative.split("/").some((part) => part.startsWith(".")) ||
      /(?:^|\/)(?:wrangler\.[^/]+|astropages\.site\.json)$/.test(relative)
    )
      throw new Error("artifact_secret_configuration");
    size += stat.size;
    if (size > 48 * 1024 * 1024) throw new Error("worker_bundle_size_limit");
    const bytes = readFileSync(absolute);
    if (bytes.includes(Buffer.from(sourceRoot + "/")))
      throw new Error("artifact_host_metadata");
    if (/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/.test(bytes.toString("utf8")))
      throw new Error("artifact_secret_material");
    files.push({ path: relative, bytes });
  };
  visit("client");
  visit("server");
  if (!files.some((file) => file.path === "server/entry.mjs"))
    throw new Error("artifact_worker_entry_missing");
  verifyNativeStaticAssetFiles(files);
  encodeWorkerBundle(files);
  return files;
}

/** Writes a fresh local candidate only; this is never durable release authority. */
export function writeArtifactCandidate(candidate, directory) {
  for (const object of candidate.objects)
    if (
      object.descriptor.objectKey !==
        `artifacts/sha256/${digest(object.bytes)}` ||
      object.descriptor.byteSize !== object.bytes.length
    )
      throw new Error("artifact_digest_mismatch");
  mkdirSync(directory, { mode: 0o700 });
  mkdirSync(resolve(directory, "artifacts/sha256"), {
    recursive: true,
    mode: 0o700,
  });
  for (const object of candidate.objects)
    writeFileSync(
      resolve(directory, object.descriptor.objectKey),
      object.bytes,
      { flag: "wx", mode: 0o600 },
    );
  writeFileSync(
    resolve(directory, "candidate.json"),
    canonicalJson({
      objects: candidate.objects.map(({ bytes, ...object }) => object),
    }),
    { flag: "wx", mode: 0o600 },
  );
}

/** Shared immutable bytes may have multiple stable native asset identities. */
export function deduplicateSeedAssets(assets) {
  const objects = new Map();
  for (const asset of assets) {
    if (!/^[a-f0-9]{64}$/.test(asset.digest) || !Buffer.isBuffer(asset.bytes) ||
        asset.size !== asset.bytes.length || digest(asset.bytes) !== asset.digest ||
        typeof asset.mimeType !== "string" || !asset.mimeType)
      throw new Error("seed_asset_digest_mismatch");
    const previous = objects.get(asset.digest);
    if (previous && (previous.size !== asset.size || previous.mimeType !== asset.mimeType || !previous.bytes.equals(asset.bytes)))
      throw new Error("seed_asset_metadata_conflict");
    objects.set(asset.digest, asset);
  }
  return [...objects.values()].sort((left, right) => left.digest.localeCompare(right.digest));
}

/** Local producer. Missing benchmark remains explicit: catalog approval rejects it. */
export async function producePreviewArtifacts(input) {
  installedRuntimeTuple();
  if (!Array.isArray(input.workerBuilds) || input.workerBuilds.length !== 2)
    throw new Error("artifact_rebuild_required");
  for (const files of input.workerBuilds) verifyNativeStaticAssetFiles(files);
  const [first, second] = input.workerBuilds.map(encodeWorkerBundle);
  if (!first.equals(second))
    throw new Error("artifact_worker_rebuild_mismatch");
  const directory = mkdtempSync(resolve(tmpdir(), "vera-solaro-preview-artifact-"));
  try {
    const firstFile = resolve(directory, "first.sqlite");
    const secondFile = resolve(directory, "second.sqlite");
    const identity = { templateCommitSha: input.templateCommitSha };
    const evidence = await buildBaseWorkspace(firstFile, identity);
    const rebuilt = await buildBaseWorkspace(secondFile, identity);
    const sqlite = readFileSync(firstFile);
    if (
      !sqlite.equals(readFileSync(secondFile)) ||
      canonicalJson(evidence) !== canonicalJson(rebuilt)
    )
      throw new Error("artifact_workspace_rebuild_mismatch");
    const config = loadWranglerConfig(root);
    const launch = {
      workerEntrypoint: "server/entry.mjs",
      assetsDirectory: "client",
      compatibilityDate: config.compatibility_date,
      compatibilityFlags: config.compatibility_flags,
      resourceBindings: { ...runtimeContract.bindingNames, assets: "ASSETS" },
      workerFirstRoutes: runtimeContract.workerFirstRoutes,
      requiredSecretBindings: [
        ...runtimeContract.requiredSecretNames,
        "ASTROPAGES_PREVIEW_ASTRO_KEY",
      ],
      environment: "preview",
      pluginBridgeExport: "PluginBridge",
    };
    return signArtifactSet({
      ...input,
      launch,
      workspaceEvidence: { ...evidence, deterministicRebuildVerified: true },
      objects: [
        { kind: "worker_bundle", bytes: first },
        { kind: "workspace_base_sqlite", bytes: sqlite },
        ...deduplicateSeedAssets(readSeedAssets()).map((asset) => ({
          kind: "seed_asset",
          bytes: asset.bytes,
        })),
      ],
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Native EmDash and the template bootstrap run unchanged against real SQLite. */
function databaseAdapters(sqlite) {
  const DB = {
    prepare(sql) {
      let values = [];
      return {
        bind(...next) {
          values = next;
          return this;
        },
        async first() {
          return sqlite.prepare(sql).get(...values) ?? null;
        },
        async all() {
          try { return { results: sqlite.prepare(sql).all(...values) }; } catch (error) { throw new Error(`${error.message}: ${sql}`); }
        },
        async run() {
          return sqlite.prepare(sql).run(...values);
        },
        execute() {
          try { return { results: sqlite.prepare(sql).all(...values) }; } catch (error) { throw new Error(`${error.message}: ${sql}`); }
        },
      };
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((statement) => statement.execute());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const database = {
    close() {},
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      return {
        reader: statement.columns().length > 0,
        all(values) {
          return statement.all(...values);
        },
        run(values) {
          return statement.run(...values);
        },
      };
    },
  };
  return {
    DB,
    kysely: new Kysely({ dialect: new SqliteDialect({ database }) }),
  };
}

/** Artifact-only canonical identities use semantic keys, never authored values.
 * Only the initial seed database is accepted here; this is not a checkpoint tool.
 */
export function canonicalizeWorkspaceDatabase(sqlite) {
  const tables = sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )
    .all()
    .map((row) => row.name);
  const ids = new Map();
  const add = (old, key) => {
    if (old) ids.set(old, `seed_${digest(key).slice(0, 26)}`);
  };
  const collections = sqlite
    .prepare("SELECT id,slug FROM _emdash_collections ORDER BY slug")
    .all();
  for (const collection of collections) {
    add(collection.id, `collection:${collection.slug}`);
    for (const field of sqlite
      .prepare(
        "SELECT id,slug FROM _emdash_fields WHERE collection_id=? ORDER BY slug",
      )
      .all(collection.id))
      add(field.id, `field:${collection.slug}:${field.slug}`);
    const table = `ec_${collection.slug}`;
    if (!tables.includes(table)) continue;
    for (const entry of sqlite
      .prepare(`SELECT * FROM ${quote(table)} ORDER BY slug,locale`)
      .all()) {
      const key = `${collection.slug}:${entry.slug}:${entry.locale}`;
      add(entry.id, `entry:${key}`);
      add(entry.live_revision_id, `revision:live:${key}`);
      add(entry.draft_revision_id, `revision:draft:${key}`);
    }
  }
  sqlite.exec("PRAGMA foreign_keys=OFF; BEGIN");
  try {
    for (const table of tables) {
      const columns = sqlite
        .prepare(`PRAGMA table_info(${quote(table)})`)
        .all()
        .map((column) => column.name);
      const identityColumns =
        table === "_emdash_collections"
          ? ["id"]
          : table === "_emdash_fields"
            ? ["id", "collection_id"]
            : table === "revisions"
              ? ["id", "entry_id"]
              : table.startsWith("ec_")
                ? [
                    "id",
                    "translation_group",
                    "live_revision_id",
                    "draft_revision_id",
                  ]
                : [];
      for (const column of identityColumns.filter((name) =>
        columns.includes(name),
      )) {
        const update = sqlite.prepare(
          `UPDATE ${quote(table)} SET ${quote(column)}=? WHERE ${quote(column)}=?`,
        );
        for (const [old, value] of ids) update.run(value, old);
      }
      // Creation/update metadata is generated while building this empty baseline.
      // Scheduled times and authored strings/JSON are intentionally untouched.
      const generatedMetadata =
        table.startsWith("ec_") || baseSeedDataTables.includes(table) || ["ap_email_templates", "ap_email_events", "ap_email_variable_mappings"].includes(table) ||
        [
          "_emdash_collections",
          "_emdash_fields",
          "revisions",
          "options",
          "media",
          "ap_asset_records",
          "ap_asset_revisions",
          "ap_asset_aliases",
          "ap_emdash_bootstrap_state",
          "ap_workspace_authored_state",
          "ap_email_templates",
        ].includes(table);
      if (generatedMetadata)
        for (const column of ["created_at", "updated_at", "timestamp"].filter(
          (name) => columns.includes(name),
        ))
          sqlite
            .prepare(
              `UPDATE ${quote(table)} SET ${quote(column)}=? WHERE ${quote(column)} IS NOT NULL`,
            )
            .run(epoch);
      // Migration 0017 creates this non-authored default with a wall-clock
      // timestamp. Normalize only that fresh baseline row; customer values are
      // never passed through the artifact builder.
      if (table === "ap_business_settings")
        sqlite
          .prepare("UPDATE ap_business_settings SET updated_at=? WHERE key IN ('payment_preference','site','vera_payment_pricing')")
          .run(epoch);
      if (table === "ap_emdash_bootstrap_state")
        for (const column of ["completed_at", "last_full_verified_at"])
          sqlite
            .prepare(`UPDATE ${quote(table)} SET ${quote(column)}=?`)
            .run(epoch);
      if ((table === "revisions" || table.startsWith("ec_")) && columns.includes("author_id"))
        sqlite.exec(`UPDATE ${quote(table)} SET author_id=NULL WHERE author_id IN ('astropages-bootstrap','astropages-seed')`);
      if ((table.startsWith("ec_") || table === "retired_ec_media_mentions") && columns.includes("published_at"))
        sqlite
          .prepare(
            `UPDATE ${quote(table)} SET published_at=? WHERE ${table === 'retired_ec_media_mentions' ? 'published_at IS NOT NULL' : "id LIKE 'seed_%' AND published_at IS NOT NULL"}`,
          )
          .run(epoch);
    }
    sqlite.exec("COMMIT");
  } catch (error) {
    sqlite.exec("ROLLBACK");
    throw error;
  } finally {
    sqlite.exec("PRAGMA foreign_keys=ON");
  }
}

function readSeedAssets() {
  const manifest = JSON.parse(
    readFileSync(resolve(root, "astropages/assets.manifest.json")),
  );
  const assetRoot = resolve(root, manifest.seedRoot);
  if (!assetRoot.startsWith(root + sep))
    throw new Error("unsafe_seed_asset_path");
  const aliases = new Set(manifest.assets.map((asset) => asset.alias).filter(Boolean));
  for (const mapping of nativeSeedAssetAliases) {
    if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(mapping.alias) || aliases.has(mapping.alias) ||
        !manifest.assets.some((asset) => asset.seedKey === mapping.seedKey))
      throw new Error("native_seed_alias_contract_invalid");
    aliases.add(mapping.alias);
  }
  return manifest.assets.map((asset) => {
    if (
      typeof asset.source !== "string" ||
      asset.source
        .split("/")
        .some((part) => !part || part === "." || part === "..") ||
      asset.source.includes("\\")
    )
      throw new Error("unsafe_seed_asset_path");
    let current = assetRoot;
    for (const part of asset.source.split("/")) {
      current = resolve(current, part);
      if (lstatSync(current).isSymbolicLink())
        throw new Error("unsafe_seed_asset_path");
    }
    if (!lstatSync(current).isFile()) throw new Error("unsafe_seed_asset_path");
    const bytes = readFileSync(current);
    const hash = digest(bytes);
    if (asset.contentHash !== `sha256:${hash}`)
      throw new Error("seed_asset_digest_mismatch");
    return {
      ...asset,
      digest: hash,
      size: bytes.length,
      objectKey: `assets/sha256/${hash}`,
      bytes,
    };
  });
}

const baseSeedDataTables = nativeBaseSeedDataTables;
const maxBaseSeedRowsPerTable = 1000;
const maxBaseSeedTextBytes = 32 * 1024;
const sensitiveSeedKey = (value) => /(?:^|[^a-z0-9])(?:(?:api|access|auth|bearer|client|private|signing|encryption)?[-_ ]?(?:key|token|secret|credential|password)|project[-_ ]?id)(?:$|[^a-z0-9])/i.test(value);
const sensitiveSeedValue = (value) =>
  /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9_-]+\b|\b(?:ghp|gho|github_pat|xox[baprs])_[A-Za-z0-9_-]+\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\b|\b(?:api|access|auth|bearer|session|signing|encryption|private)?[-_ ]?(?:key|token|secret|credential|password|project[-_ ]?id)\s*[:=]\s*["']?[A-Za-z0-9._-]{4,}/i.test(value);

const assertSafeBaseSeedValue = (value, depth = 0, nodes = { count: 0 }) => {
  if (++nodes.count > 1000 || depth > 12) throw new Error("workspace_unsafe_seed_data");
  if (typeof value === "string") {
    if (Buffer.byteLength(value) > maxBaseSeedTextBytes || sensitiveSeedValue(value))
      throw new Error("workspace_unsafe_seed_data");
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (sensitiveSeedKey(key)) throw new Error("workspace_unsafe_seed_data");
    assertSafeBaseSeedValue(child, depth + 1, nodes);
  }
};

const assertSafeBaseSeedData = (sqlite) => {
  for (const table of baseSeedDataTables) {
    const columns = sqlite
      .prepare(`PRAGMA table_info(${quote(table)})`)
      .all()
      .filter((column) => /TEXT/i.test(column.type))
      .map((column) => column.name);
    const rows = sqlite
      .prepare(`SELECT ${columns.map(quote).join(",")} FROM ${quote(table)} LIMIT ?`)
      .all(maxBaseSeedRowsPerTable + 1);
    if (rows.length > maxBaseSeedRowsPerTable) throw new Error("workspace_unsafe_seed_data");
    for (const row of rows)
      for (const value of Object.values(row)) {
        assertSafeBaseSeedValue(value);
        if (typeof value !== "string") continue;
        let parsed;
        try {
          parsed = JSON.parse(value);
        } catch {
          // Free-text catalog descriptions are valid; only valid JSON has keys to inspect.
          continue;
        }
        if (parsed && typeof parsed === "object") assertSafeBaseSeedValue(parsed);
      }
  }
};

export async function verifyBaseWorkspace(sqlite, identity) {
  const { DB, kysely } = databaseAdapters(sqlite);
  try {
    const allowed = new Set([
      ...authoredTables.map((table) => table.name),
      "_emdash_collections",
      "_emdash_fields",
      "_emdash_migrations",
      ...nativeBaseSeedDataTables,
      "ap_emdash_bootstrap_state",
      "ap_workspace_authored_state",
      "ap_asset_release_state",
      "_emdash_fts_posts_data",
      "_emdash_fts_posts_config",
    ]);
    for (const { name } of sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()) {
      if (
        !allowed.has(name) &&
        sqlite.prepare(`SELECT COUNT(*) n FROM ${quote(name)}`).get().n !== 0
      )
        throw new Error("workspace_excluded_rows");
    }
    const settings = sqlite
      .prepare("SELECT key,value_json FROM ap_business_settings ORDER BY key")
      .all();
    if (
      canonicalJson(settings.map((row) => row.key)) !==
        canonicalJson([...nativeBaseSettingKeys].sort()) ||
      settings.find((row) => row.key === "payment_preference")?.value_json !==
        basePaymentPreference
    )
      throw new Error("workspace_unsafe_settings");
    assertSafeBaseSeedData(sqlite);
    const env = { DB, ASTROPAGES_SITE_ENVIRONMENT: "preview" };
    const readiness = await readAstroPagesEmDashBootstrapStatus({
      env,
      mode: "deep",
    });
    if (!readiness.ready || readiness.expectedEntries !== getBuilderReleaseTargets().length * activeLocales.length)
      throw new Error("workspace_bootstrap_contract_failed");
    for (const collection of Object.keys(nativeDynamicCollections)) {
      const declared = sqlite.prepare("SELECT * FROM _emdash_collections WHERE slug=?").get(collection);
      if (!declared || !JSON.parse(declared.supports).includes("revisions"))
        throw new Error("workspace_dynamic_collection_contract_failed");
    }
    for (const name of collections)
      if (
        !sqlite
          .prepare("SELECT name FROM sqlite_master WHERE name=?")
          .get(`ec_${name}`)
      )
        throw new Error("workspace_collection_missing");
    if (
      sqlite.prepare("PRAGMA foreign_key_check").all().length ||
      sqlite.prepare("PRAGMA integrity_check").get().integrity_check !== "ok"
    )
      throw new Error("workspace_integrity_failed");
    for (const {path, digest: expectedDigest} of nativeStaticAssets) {
      if (!/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+$/.test(path) || path.includes("..")) throw new Error("native_public_asset_path_invalid");
      let current = resolve(root,"public");
      if (lstatSync(current).isSymbolicLink()) throw new Error("native_public_asset_missing");
      for (const part of path.slice(1).split("/")) {
        current = resolve(current,part);
        if (lstatSync(current).isSymbolicLink()) throw new Error("native_public_asset_missing");
      }
      const file = current;
      if (!file.startsWith(resolve(root,"public") + sep) || !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink() || digest(readFileSync(file)) !== expectedDigest) throw new Error("native_public_asset_missing");
    }
    const assets = readSeedAssets();
    const workspace = {
      DB,
      env,
      identity,
      blobs: {
        async verify(blob) {
          return assets.some(
            (asset) => asset.digest === blob.sha256 && asset.size === blob.size,
          );
        },
      },
    };
    await exportWorkspaceAuthoredState(workspace);
    const observed = await inspectWorkspaceAuthoredState(workspace);
    for (const table of [
      "media",
      "revisions",
      ...collections.map((name) => `ec_${name}`),
    ]) {
      if (
        sqlite
          .prepare(
            `SELECT COUNT(*) n FROM ${quote(table)} WHERE author_id IS NOT NULL`,
          )
          .get().n
      )
        throw new Error("workspace_excluded_actor");
    }
    return {
      contractVersion: "workspace-authored-state.v1",
      localizedEntries: getBuilderReleaseTargets().length * activeLocales.length,
      collections: collections.length,
      foreignKeysVerified: true,
      integrityVerified: true,
      excludedRowsVerified: true,
      authoredFingerprint: observed.fingerprint,
    };
  } finally {
    await kysely.destroy();
  }
}

/** Builds only from the checked-out template's complete native seed and migrations.
 * The release orchestrator owns exact Git SHA/tree verification and worker build.
 */
export async function buildBaseWorkspace(outputPath, { templateCommitSha }) {
  if (!/^[a-f0-9]{40}$/.test(templateCommitSha))
    throw new Error("artifact_identity_invalid");
  const sqlite = new DatabaseSync(":memory:");
  const { DB, kysely } = databaseAdapters(sqlite);
  try {
    // Vera's service-table migrations rebuild referenced tables; validate final FK state after replay.
    sqlite.exec("PRAGMA foreign_keys=OFF");
    const migrations = readdirSync(resolve(root, "migrations"))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    const migrationDigest = digest(
      JSON.stringify(
        migrations.map((name) => [
          name,
          digest(readFileSync(resolve(root, "migrations", name))),
        ]),
      ),
    );
    for (const name of migrations)
      sqlite.exec(readFileSync(resolve(root, "migrations", name), "utf8"));
    sqlite.exec("PRAGMA foreign_keys=ON");
    if (sqlite.prepare("PRAGMA foreign_key_check").all().length) throw new Error("workspace_migration_foreign_key_invalid");
    // This is a fresh source-built fixture only, never a project/customer DB.
    // Preserve native email definitions while excluding private example payloads
    // from the signed SQLite artifact as well as the authored projection.
    const privatePaths = nativePrivateEmailSampleKeys.map((key) => `'$.${key}'`).join(",");
    sqlite.exec(`UPDATE ap_email_templates SET sample_payload_json=json_remove(sample_payload_json,${privatePaths});
      UPDATE ap_email_variable_mappings SET sample_value_json=NULL WHERE variable_key IN (${nativePrivateEmailSampleKeys.map((key) => `'${key}'`).join(",")})`);
    const seed = JSON.parse(
      readFileSync(resolve(root, "seed/seed.json"), "utf8"),
    );
    // Seed only native dynamic collections; Builder entries have their own bootstrap.
    const nativeSeed = await applySeed(kysely, { ...seed, collections: seed.collections.filter((collection) => Object.hasOwn(nativeDynamicCollections, collection.slug)), content: Object.fromEntries(Object.entries(seed.content ?? {}).filter(([collection]) => Object.hasOwn(nativeDynamicCollections, collection))) }, {
      includeContent: true,
      onConflict: "skip",
    });
    // Runtime values are supplied by signed control-plane synchronization, not the native authored seed.
    sqlite.exec("DELETE FROM ap_runtime_config");
    const env = { DB, ASTROPAGES_SITE_ENVIRONMENT: "preview" };
    await bootstrapAstroPagesEmDashContent({ env, mode: "full" });
    const assets = readSeedAssets();
    const assetIdsByDigest = new Map();
    for (const asset of assets) {
      const existingId = assetIdsByDigest.get(asset.digest);
      const id = existingId ?? `asset_${digest(`${canonicalTemplateKey}:${asset.seedKey}`).slice(0, 26)}`;
      const revision = `arev_${digest(`${canonicalTemplateKey}:${asset.seedKey}:${asset.contentHash}`).slice(0, 26)}`;
      const filename = asset.source.split("/").at(-1);
      if (!existingId) {
        assetIdsByDigest.set(asset.digest, id);
        sqlite
          .prepare(
            "INSERT INTO media(id,filename,mime_type,size,storage_key,content_hash) VALUES (?,?,?,?,?,?)",
          )
          .run(
            id,
            filename,
            asset.mimeType,
            asset.size,
            asset.objectKey,
            asset.digest,
          );
        sqlite
          .prepare(
            "INSERT INTO ap_asset_records(asset_id,current_revision_id,display_name,origin,visibility,protected,replaceable) VALUES (?,?,?,'template',?,?,?)",
          )
          .run(
            id,
            revision,
            asset.displayName,
            asset.visibility ?? "customer",
            asset.protected === false ? 0 : 1,
            asset.replaceable === false ? 0 : 1,
          );
        sqlite
          .prepare(
            "INSERT INTO ap_asset_revisions(revision_id,asset_id,revision_number,storage_key,content_hash,etag,file_name,mime_type,size_bytes) VALUES (?,?,1,?,?,?,?,?,?)",
          )
          .run(
            revision,
            id,
            asset.objectKey,
            asset.digest,
            asset.digest,
            filename,
            asset.mimeType,
            asset.size,
          );
      }
      for (const alias of [asset.alias, ...nativeSeedAssetAliases.filter((mapping) => mapping.seedKey === asset.seedKey).map((mapping) => mapping.alias)].filter(Boolean))
        sqlite
          .prepare(
            "INSERT INTO ap_asset_aliases(alias,asset_id,origin,protected) VALUES (?,?,'template',1)",
          )
          .run(alias, id);
    }
    sqlite
      .prepare(
        "INSERT INTO ap_asset_release_state(environment,current_revision_number,active_asset_count,deleted_asset_count,last_changed_at,updated_at) VALUES ('preview',1,?,0,?,?)",
      )
      .run(assetIdsByDigest.size, epoch, epoch);
    canonicalizeWorkspaceDatabase(sqlite);
    const verified = await verifyBaseWorkspace(sqlite, { templateCommitSha, migrationDigest });
    canonicalizeWorkspaceDatabase(sqlite);
    sqlite.prepare("VACUUM INTO ?").run(outputPath);
    return {
      ...verified,
      migrations,
      migrationDigest,
      nativeSeed,
      localizedEntries: getBuilderReleaseTargets().length * activeLocales.length,
      seedAssets: assets.map(({ bytes, ...asset }) => asset),
      nativeStaticAssets,
    };
  } finally {
    await kysely.destroy();
    sqlite.close();
  }
}
