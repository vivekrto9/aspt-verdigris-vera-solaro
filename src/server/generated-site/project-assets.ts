export type AssetReference =
  | { assetId: string; alias?: never }
  | { alias: string; assetId?: never };

export type AssetSnapshotRow = {
  asset_id: string;
  revision_id: string;
  revision_number: number;
  storage_key: string;
  content_hash: string;
  etag: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  display_name: string;
  visibility: "customer" | "system";
  aliases: string;
  origin?: "template" | "user" | "ai";
  protected?: number;
  replaceable?: number;
  folder?: string | null;
  category?: string | null;
  alt_text?: string | null;
  caption?: string | null;
  width?: number | null;
  height?: number | null;
  duration_seconds?: number | null;
};

export type AssetSnapshotItem = {
  assetId: string;
  revisionId: string;
  revisionNumber: number;
  storageKey: string;
  contentHash: string;
  etag: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  displayName: string;
  visibility: "customer" | "system";
  aliases: string[];
  origin: "template" | "user" | "ai";
  protected: boolean;
  replaceable: boolean;
  folder: string | null;
  category: string | null;
  altText: string | null;
  caption: string | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
};

export type AssetReleaseSnapshot = {
  schemaVersion: 1;
  templateKey: string;
  environment: "preview" | "production";
  assetRevision: number;
  assetHash: string;
  snapshotHash: string;
  exportedAt: string;
  assets: AssetSnapshotItem[];
};

type D1Statement = {
  bind(...values: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
  run(): Promise<unknown>;
};

type AssetR2Object = {
  body: BodyInit;
  httpEtag?: string;
  writeHttpMetadata?: (headers: Headers) => void;
};

export type AssetRuntimeEnv = Record<string, unknown>;

export type RegisterAssetRevisionInput = {
  env: AssetRuntimeEnv;
  assetId: string;
  revisionId: string;
  expectedRevisionId?: string;
  storageKey: string;
  contentHash: string;
  etag: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  width?: number | null;
  height?: number | null;
  durationSeconds?: number | null;
  displayName: string;
  altText?: string | null;
  caption?: string | null;
  folder?: string | null;
  category?: string | null;
  origin: "template" | "user" | "ai";
  visibility?: "customer" | "system";
  aliases?: string[];
  protected?: boolean;
  replaceable?: boolean;
  actorType: "user" | "agent" | "system" | "unknown";
  actorId?: string | null;
  scanStatus?: "pending" | "clean" | "infected" | "not_required";
};

const encoder = new TextEncoder();
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const aliasPattern = /^[a-z0-9][a-z0-9-]{0,127}$/;

const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
};

const sha256Hex = async (value: unknown) => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(typeof value === "string" ? value : stableStringify(value)),
  );
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
};

const statement = (env: AssetRuntimeEnv, sql: string) => {
  const db = env.DB as { prepare?(sql: string): unknown } | undefined;
  if (!db?.prepare) throw new Error("D1 database binding is not configured.");
  return db.prepare(sql) as D1Statement;
};

const first = <T extends Record<string, unknown>>(
  env: AssetRuntimeEnv,
  sql: string,
  values: unknown[] = [],
) => statement(env, sql).bind(...values).first<T>();

const run = (env: AssetRuntimeEnv, sql: string, values: unknown[] = []) =>
  statement(env, sql).bind(...values).run();

const all = async <T extends Record<string, unknown>>(
  env: AssetRuntimeEnv,
  sql: string,
  values: unknown[] = [],
) => {
  const result = await statement(env, sql).bind(...values).all<T>();
  return result.results ?? [];
};

const resolveEnvironment = (env: AssetRuntimeEnv): "preview" | "production" => {
  const value = env.ASTROPAGES_SITE_ENVIRONMENT;
  if (value === "preview" || value === "production") {
    return value;
  }
  throw new Error("ASTROPAGES_SITE_ENVIRONMENT must be preview or production for project assets.");
};

const safeIdentifier = (value: string, label: string, pattern = identifierPattern) => {
  if (!pattern.test(value)) throw new Error(`${label} is invalid.`);
  return encodeURIComponent(value);
};

const safeFileName = (value: string) => {
  const normalized = value.trim();
  if (!normalized || normalized.includes("/") || normalized.includes("\\") || normalized.includes("\0")) {
    throw new Error("Asset filename is invalid.");
  }
  return encodeURIComponent(normalized);
};

export const assetUrl = (reference: AssetReference, fileName = "asset") => {
  if ("assetId" in reference && reference.assetId) {
    return `/_assets/assets/${safeIdentifier(reference.assetId, "Asset ID")}/${safeFileName(fileName)}`;
  }
  if ("alias" in reference && reference.alias) {
    return `/_assets/aliases/${safeIdentifier(reference.alias, "Asset alias", aliasPattern)}/${safeFileName(fileName)}`;
  }
  throw new Error("An asset ID or alias is required.");
};

export const immutableAssetUrl = (input: {
  revisionId: string;
  contentHash: string;
  fileName: string;
}) =>
  `/_assets/revisions/${safeIdentifier(input.revisionId, "Revision ID")}/${encodeURIComponent(
    input.contentHash,
  )}/${safeFileName(input.fileName)}`;

const aliasesFromRow = (value: string) => {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string").sort()
      : [];
  } catch {
    return [];
  }
};

const snapshotItem = (row: AssetSnapshotRow): AssetSnapshotItem => ({
  assetId: row.asset_id,
  revisionId: row.revision_id,
  revisionNumber: Number(row.revision_number),
  storageKey: row.storage_key,
  contentHash: row.content_hash,
  etag: row.etag,
  fileName: row.file_name,
  mimeType: row.mime_type,
  sizeBytes: Number(row.size_bytes),
  displayName: row.display_name,
  visibility: row.visibility,
  aliases: aliasesFromRow(row.aliases),
  origin: row.origin ?? "user",
  protected: Number(row.protected ?? 0) === 1,
  replaceable: Number(row.replaceable ?? 1) === 1,
  folder: row.folder ?? null,
  category: row.category ?? null,
  altText: row.alt_text ?? null,
  caption: row.caption ?? null,
  width: row.width == null ? null : Number(row.width),
  height: row.height == null ? null : Number(row.height),
  durationSeconds: row.duration_seconds == null ? null : Number(row.duration_seconds),
});

export const buildAssetSnapshotFromRows = async (input: {
  templateKey: string;
  environment: "preview" | "production";
  assetRevision: number;
  rows: AssetSnapshotRow[];
}): Promise<AssetReleaseSnapshot> => {
  const assets = input.rows
    .map(snapshotItem)
    .sort((left, right) => left.assetId.localeCompare(right.assetId));
  const publicAssets = assets.map(({ storageKey: _storageKey, etag: _etag, ...asset }) => asset);
  const assetHash = await sha256Hex(publicAssets);
  const snapshotHash = await sha256Hex({
    schemaVersion: 1,
    templateKey: input.templateKey,
    environment: input.environment,
    assetRevision: input.assetRevision,
    assets,
  });
  return {
    schemaVersion: 1,
    templateKey: input.templateKey,
    environment: input.environment,
    assetRevision: input.assetRevision,
    assetHash,
    snapshotHash,
    exportedAt: new Date().toISOString(),
    assets,
  };
};

const assertStorageKey = (input: RegisterAssetRevisionInput) => {
  const prefix = `assets/${input.assetId}/revisions/${input.revisionId}/`;
  if (!input.storageKey.startsWith(prefix) || input.storageKey.includes("..")) {
    throw new Error("Asset storage key does not match its project asset revision.");
  }
};

const aliasValues = (aliases: string[] | undefined) =>
  [...new Set(aliases ?? [])].map((alias) => {
    if (!aliasPattern.test(alias)) throw new Error(`Asset alias is invalid: ${alias}`);
    return alias;
  });

const assertAliasesAvailable = async (env: AssetRuntimeEnv, assetId: string, aliases: string[]) => {
  for (const alias of aliases) {
    const existing = await first<{ asset_id?: unknown }>(
      env,
      `SELECT asset_id FROM ap_asset_aliases WHERE alias = ?`,
      [alias],
    );
    if (typeof existing?.asset_id === "string" && existing.asset_id !== assetId) {
      throw new Error(`Asset alias "${alias}" already belongs to another project asset.`);
    }
  }
};

export const readAssetStatus = async (env: AssetRuntimeEnv) => {
  const environment = resolveEnvironment(env);
  const state = await first<{
    current_revision_number?: unknown;
    current_asset_hash?: unknown;
    current_snapshot_hash?: unknown;
    last_changed_at?: unknown;
  }>(
    env,
    `SELECT current_revision_number, current_asset_hash, current_snapshot_hash, last_changed_at
       FROM ap_asset_release_state WHERE environment = ?`,
    [environment],
  );
  const counts = await first<{ active_count?: unknown; deleted_count?: unknown }>(
    env,
    `SELECT
       SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) AS active_count,
       SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS deleted_count
       FROM ap_asset_records`,
  );
  return {
    contractVersion: 1 as const,
    environment,
    ready: true,
    assetRevision: Number(state?.current_revision_number ?? 0),
    assetHash: typeof state?.current_asset_hash === "string" ? state.current_asset_hash : null,
    snapshotHash: typeof state?.current_snapshot_hash === "string" ? state.current_snapshot_hash : null,
    activeAssetCount: Number(counts?.active_count ?? 0),
    deletedAssetCount: Number(counts?.deleted_count ?? 0),
    lastChangedAt: typeof state?.last_changed_at === "string" ? state.last_changed_at : null,
  };
};

const snapshotRows = (env: AssetRuntimeEnv) => all<AssetSnapshotRow>(
  env,
  `SELECT
     a.asset_id,
     a.current_revision_id AS revision_id,
     r.revision_number,
     r.storage_key,
     r.content_hash,
     r.etag,
     r.file_name,
     r.mime_type,
     r.size_bytes,
     a.display_name,
     a.visibility,
     a.origin,
     a.protected,
     a.replaceable,
     a.folder,
     a.category,
     m.alt AS alt_text,
     m.caption,
     r.width,
     r.height,
     r.duration_seconds,
     COALESCE((
       SELECT json_group_array(alias)
       FROM (SELECT alias FROM ap_asset_aliases WHERE asset_id = a.asset_id ORDER BY alias)
     ), '[]') AS aliases
   FROM ap_asset_records a
   JOIN ap_asset_revisions r ON r.revision_id = a.current_revision_id
   JOIN media m ON m.id = a.asset_id
   WHERE a.deleted_at IS NULL AND r.status = 'ready'
   ORDER BY a.asset_id`,
);

export const buildAssetSnapshot = async (input: {
  env: AssetRuntimeEnv;
  templateKey: string;
}) => {
  const status = await readAssetStatus(input.env);
  const snapshot = await buildAssetSnapshotFromRows({
    templateKey: input.templateKey,
    environment: status.environment,
    assetRevision: status.assetRevision,
    rows: await snapshotRows(input.env),
  });
  const timestamp = new Date().toISOString();
  await run(
    input.env,
    `UPDATE ap_asset_release_state
     SET current_asset_hash = ?, current_snapshot_hash = ?, active_asset_count = ?,
         last_exported_at = ?, updated_at = ?
     WHERE environment = ?`,
    [
      snapshot.assetHash,
      snapshot.snapshotHash,
      snapshot.assets.length,
      timestamp,
      timestamp,
      status.environment,
    ],
  );
  return snapshot;
};

const assertSnapshot = async (snapshot: AssetReleaseSnapshot) => {
  if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.assets)) {
    throw new Error("Project asset snapshot is invalid.");
  }
  const rebuilt = await buildAssetSnapshotFromRows({
    templateKey: snapshot.templateKey,
    environment: snapshot.environment,
    assetRevision: snapshot.assetRevision,
    rows: snapshot.assets.map((asset) => ({
      asset_id: asset.assetId,
      revision_id: asset.revisionId,
      revision_number: asset.revisionNumber,
      storage_key: asset.storageKey,
      content_hash: asset.contentHash,
      etag: asset.etag,
      file_name: asset.fileName,
      mime_type: asset.mimeType,
      size_bytes: asset.sizeBytes,
      display_name: asset.displayName,
      visibility: asset.visibility,
      aliases: JSON.stringify(asset.aliases),
      origin: asset.origin,
      protected: asset.protected ? 1 : 0,
      replaceable: asset.replaceable ? 1 : 0,
      folder: asset.folder,
      category: asset.category,
      alt_text: asset.altText,
      caption: asset.caption,
      width: asset.width,
      height: asset.height,
      duration_seconds: asset.durationSeconds,
    })),
  });
  if (rebuilt.assetHash !== snapshot.assetHash || rebuilt.snapshotHash !== snapshot.snapshotHash) {
    throw new Error("Project asset snapshot hash is invalid.");
  }
};

export const importAssetSnapshot = async (input: {
  env: AssetRuntimeEnv;
  snapshot: AssetReleaseSnapshot;
}) => {
  await assertSnapshot(input.snapshot);
  const environment = resolveEnvironment(input.env);
  const existing = await first<{ current_snapshot_hash?: unknown }>(
    input.env,
    `SELECT current_snapshot_hash FROM ap_asset_release_state WHERE environment = ?`,
    [environment],
  );
  if (existing?.current_snapshot_hash === input.snapshot.snapshotHash) {
    return { imported: false, status: await readAssetStatus(input.env) };
  }
  const timestamp = new Date().toISOString();
  await run(input.env, `UPDATE ap_asset_records SET deleted_at = ?, updated_at = ?`, [timestamp, timestamp]);
  await run(input.env, `DELETE FROM ap_asset_aliases`);
  for (const asset of input.snapshot.assets) {
    await run(
      input.env,
      `INSERT INTO media (
         id, filename, mime_type, size, width, height, alt, caption, storage_key,
         content_hash, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready')
       ON CONFLICT(id) DO UPDATE SET
         filename = excluded.filename,
         mime_type = excluded.mime_type,
         size = excluded.size,
         width = excluded.width,
         height = excluded.height,
         alt = excluded.alt,
         caption = excluded.caption,
         storage_key = excluded.storage_key,
         content_hash = excluded.content_hash,
         status = 'ready'`,
      [
        asset.assetId,
        asset.fileName,
        asset.mimeType,
        asset.sizeBytes,
        asset.width,
        asset.height,
        asset.altText,
        asset.caption,
        asset.storageKey,
        asset.contentHash,
      ],
    );
    await run(
      input.env,
      `INSERT INTO ap_asset_records (
         asset_id, current_revision_id, display_name, folder, category, origin,
         visibility, protected, replaceable, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(asset_id) DO UPDATE SET
         current_revision_id = excluded.current_revision_id,
         display_name = excluded.display_name,
         folder = excluded.folder,
         category = excluded.category,
         origin = excluded.origin,
         visibility = excluded.visibility,
         protected = excluded.protected,
         replaceable = excluded.replaceable,
         deleted_at = NULL,
         updated_at = excluded.updated_at`,
      [
        asset.assetId,
        asset.revisionId,
        asset.displayName,
        asset.folder,
        asset.category,
        asset.origin,
        asset.visibility,
        asset.protected ? 1 : 0,
        asset.replaceable ? 1 : 0,
        timestamp,
        timestamp,
      ],
    );
    await run(
      input.env,
      `INSERT INTO ap_asset_revisions (
         revision_id, asset_id, revision_number, storage_key, content_hash, etag,
         file_name, mime_type, size_bytes, width, height, duration_seconds,
         status, scan_status, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', 'clean', ?)
       ON CONFLICT(revision_id) DO UPDATE SET status = 'ready'`,
      [
        asset.revisionId,
        asset.assetId,
        asset.revisionNumber,
        asset.storageKey,
        asset.contentHash,
        asset.etag,
        asset.fileName,
        asset.mimeType,
        asset.sizeBytes,
        asset.width,
        asset.height,
        asset.durationSeconds,
        timestamp,
      ],
    );
    for (const alias of asset.aliases) {
      await run(
        input.env,
        `INSERT INTO ap_asset_aliases (alias, asset_id, origin, protected, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [alias, asset.assetId, asset.origin, asset.protected ? 1 : 0, timestamp, timestamp],
      );
    }
  }
  await run(
    input.env,
    `INSERT INTO ap_asset_release_state (
       environment, current_revision_number, current_asset_hash, current_snapshot_hash,
       active_asset_count, deleted_asset_count, last_changed_at, last_imported_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
     ON CONFLICT(environment) DO UPDATE SET
       current_revision_number = excluded.current_revision_number,
       current_asset_hash = excluded.current_asset_hash,
       current_snapshot_hash = excluded.current_snapshot_hash,
       active_asset_count = excluded.active_asset_count,
       deleted_asset_count = (SELECT COUNT(*) FROM ap_asset_records WHERE deleted_at IS NOT NULL),
       last_changed_at = excluded.last_changed_at,
       last_imported_at = excluded.last_imported_at,
       updated_at = excluded.updated_at`,
    [
      environment,
      input.snapshot.assetRevision,
      input.snapshot.assetHash,
      input.snapshot.snapshotHash,
      input.snapshot.assets.length,
      timestamp,
      timestamp,
      timestamp,
    ],
  );
  return { imported: true, status: await readAssetStatus(input.env) };
};

export const registerAssetRevision = async (input: RegisterAssetRevisionInput) => {
  safeIdentifier(input.assetId, "Asset ID");
  safeIdentifier(input.revisionId, "Revision ID");
  safeFileName(input.fileName);
  assertStorageKey(input);
  if (!input.mimeType.includes("/") || !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) {
    throw new Error("Asset revision metadata is invalid.");
  }
  const environment = resolveEnvironment(input.env);
  const aliases = aliasValues(input.aliases);
  await assertAliasesAvailable(input.env, input.assetId, aliases);
  const current = await first<{
    current_revision_id?: unknown;
    replaceable?: unknown;
    deleted_at?: unknown;
  }>(
    input.env,
    `SELECT current_revision_id, replaceable, deleted_at FROM ap_asset_records WHERE asset_id = ?`,
    [input.assetId],
  );
  const currentRevisionId = typeof current?.current_revision_id === "string" ? current.current_revision_id : null;
  if (currentRevisionId === input.revisionId) return readAssetStatus(input.env);
  if (currentRevisionId && input.expectedRevisionId !== currentRevisionId) {
    throw new Error("Asset revision conflict: expected revision is no longer current.");
  }
  if (currentRevisionId && Number(current?.replaceable) !== 1) {
    throw new Error("This project asset cannot be replaced.");
  }
  const maximum = await first<{ revision_number?: unknown }>(
    input.env,
    `SELECT COALESCE(MAX(revision_number), 0) AS revision_number
       FROM ap_asset_revisions WHERE asset_id = ?`,
    [input.assetId],
  );
  const revisionNumber = Number(maximum?.revision_number ?? 0) + 1;
  const timestamp = new Date().toISOString();

  await run(
    input.env,
    `INSERT INTO media (
       id, filename, mime_type, size, width, height, alt, caption, storage_key,
       content_hash, author_id, status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready')
     ON CONFLICT(id) DO UPDATE SET
       filename = excluded.filename,
       mime_type = excluded.mime_type,
       size = excluded.size,
       width = excluded.width,
       height = excluded.height,
       alt = excluded.alt,
       caption = excluded.caption,
       storage_key = excluded.storage_key,
       content_hash = excluded.content_hash,
       author_id = excluded.author_id,
       status = 'ready'`,
    [
      input.assetId,
      input.fileName,
      input.mimeType,
      input.sizeBytes,
      input.width ?? null,
      input.height ?? null,
      input.altText ?? null,
      input.caption ?? null,
      input.storageKey,
      input.contentHash,
      input.actorId ?? null,
    ],
  );
  await run(
    input.env,
    `INSERT INTO ap_asset_records (
       asset_id, current_revision_id, display_name, folder, category, origin,
       visibility, protected, replaceable, created_by, updated_by, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(asset_id) DO UPDATE SET
       current_revision_id = excluded.current_revision_id,
       display_name = excluded.display_name,
       folder = excluded.folder,
       category = excluded.category,
       visibility = excluded.visibility,
       protected = excluded.protected,
       replaceable = excluded.replaceable,
       deleted_at = NULL,
       updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`,
    [
      input.assetId,
      input.revisionId,
      input.displayName,
      input.folder ?? null,
      input.category ?? null,
      input.origin,
      input.visibility ?? "customer",
      input.protected ? 1 : 0,
      input.replaceable === false ? 0 : 1,
      input.actorId ?? null,
      input.actorId ?? null,
      timestamp,
      timestamp,
    ],
  );
  await run(
    input.env,
    `INSERT INTO ap_asset_revisions (
       revision_id, asset_id, revision_number, storage_key, content_hash, etag,
       file_name, mime_type, size_bytes, width, height, duration_seconds,
       status, scan_status, created_by, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?)`,
    [
      input.revisionId,
      input.assetId,
      revisionNumber,
      input.storageKey,
      input.contentHash,
      input.etag,
      input.fileName,
      input.mimeType,
      input.sizeBytes,
      input.width ?? null,
      input.height ?? null,
      input.durationSeconds ?? null,
      input.scanStatus ?? "clean",
      input.actorId ?? null,
      timestamp,
    ],
  );
  for (const alias of aliases) {
    await run(
      input.env,
      `INSERT INTO ap_asset_aliases (alias, asset_id, origin, protected, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(alias) DO UPDATE SET
         asset_id = excluded.asset_id,
         updated_at = excluded.updated_at`,
      [alias, input.assetId, input.origin, input.protected ? 1 : 0, timestamp, timestamp],
    );
  }
  await run(
    input.env,
    `INSERT INTO ap_asset_events (
       event_id, asset_id, revision_id, operation, actor_type, actor_id, metadata, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `aevt_${crypto.randomUUID().replaceAll("-", "")}`,
      input.assetId,
      input.revisionId,
      currentRevisionId ? "replace" : "create",
      input.actorType,
      input.actorId ?? null,
      JSON.stringify({ previousRevisionId: currentRevisionId }),
      timestamp,
    ],
  );
  await run(
    input.env,
    `INSERT INTO ap_asset_release_state (
       environment, current_revision_number, current_asset_hash, current_snapshot_hash,
       active_asset_count, deleted_asset_count, last_changed_at, updated_at
     ) VALUES (?, 1, NULL, NULL,
       (SELECT COUNT(*) FROM ap_asset_records WHERE deleted_at IS NULL),
       (SELECT COUNT(*) FROM ap_asset_records WHERE deleted_at IS NOT NULL), ?, ?)
     ON CONFLICT(environment) DO UPDATE SET
       current_revision_number = ap_asset_release_state.current_revision_number + 1,
       current_asset_hash = NULL,
       current_snapshot_hash = NULL,
       active_asset_count = (SELECT COUNT(*) FROM ap_asset_records WHERE deleted_at IS NULL),
       deleted_asset_count = (SELECT COUNT(*) FROM ap_asset_records WHERE deleted_at IS NOT NULL),
       last_changed_at = excluded.last_changed_at,
       updated_at = excluded.updated_at`,
    [environment, timestamp, timestamp],
  );
  return readAssetStatus(input.env);
};

export type AssetListItem = {
  assetId: string;
  revisionId: string;
  revisionNumber: number;
  displayName: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  contentHash: string;
  aliases: string[];
  origin: "template" | "user" | "ai";
  visibility: "customer" | "system";
  protected: boolean;
  replaceable: boolean;
  folder: string | null;
  category: string | null;
  altText: string | null;
  caption: string | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  deletedAt: string | null;
  url: string;
};

export const listAssets = async (input: {
  env: AssetRuntimeEnv;
  includeDeleted?: boolean;
  search?: string;
}): Promise<AssetListItem[]> => {
  const values: unknown[] = [];
  const filters = ["r.status = 'ready'"];
  if (!input.includeDeleted) filters.push("a.deleted_at IS NULL");
  if (input.search?.trim()) {
    filters.push("(LOWER(a.display_name) LIKE ? OR LOWER(r.file_name) LIKE ?)");
    const value = `%${input.search.trim().toLowerCase()}%`;
    values.push(value, value);
  }
  const rows = await all<AssetSnapshotRow & { deleted_at?: string | null }>(
    input.env,
    `SELECT
       a.asset_id, a.current_revision_id AS revision_id, r.revision_number,
       r.storage_key, r.content_hash, r.etag, r.file_name, r.mime_type, r.size_bytes,
       a.display_name, a.visibility, a.origin, a.protected, a.replaceable,
       a.folder, a.category, a.deleted_at, m.alt AS alt_text, m.caption,
       r.width, r.height, r.duration_seconds,
       COALESCE((SELECT json_group_array(alias) FROM
         (SELECT alias FROM ap_asset_aliases WHERE asset_id = a.asset_id ORDER BY alias)), '[]') AS aliases
     FROM ap_asset_records a
     JOIN ap_asset_revisions r ON r.revision_id = a.current_revision_id
     JOIN media m ON m.id = a.asset_id
     WHERE ${filters.join(" AND ")}
     ORDER BY a.updated_at DESC, a.asset_id`,
    values,
  );
  return rows.map((row) => {
    const { storageKey: _storageKey, etag: _etag, ...asset } = snapshotItem(row);
    return {
      ...asset,
      deletedAt: typeof row.deleted_at === "string" ? row.deleted_at : null,
      url: assetUrl({ assetId: asset.assetId }, asset.fileName),
    };
  });
};

const bumpAssetState = async (env: AssetRuntimeEnv) => {
  const environment = resolveEnvironment(env);
  const timestamp = new Date().toISOString();
  await run(
    env,
    `INSERT INTO ap_asset_release_state (
       environment, current_revision_number, current_asset_hash, current_snapshot_hash,
       active_asset_count, deleted_asset_count, last_changed_at, updated_at
     ) VALUES (?, 1, NULL, NULL,
       (SELECT COUNT(*) FROM ap_asset_records WHERE deleted_at IS NULL),
       (SELECT COUNT(*) FROM ap_asset_records WHERE deleted_at IS NOT NULL), ?, ?)
     ON CONFLICT(environment) DO UPDATE SET
       current_revision_number = ap_asset_release_state.current_revision_number + 1,
       current_asset_hash = NULL,
       current_snapshot_hash = NULL,
       active_asset_count = (SELECT COUNT(*) FROM ap_asset_records WHERE deleted_at IS NULL),
       deleted_asset_count = (SELECT COUNT(*) FROM ap_asset_records WHERE deleted_at IS NOT NULL),
       last_changed_at = excluded.last_changed_at,
       updated_at = excluded.updated_at`,
    [environment, timestamp, timestamp],
  );
};

const recordAssetEvent = async (input: {
  env: AssetRuntimeEnv;
  assetId: string;
  revisionId?: string | null;
  operation: "metadata_update" | "restore" | "delete";
  actorType: "user" | "agent" | "system" | "unknown";
  actorId?: string | null;
  metadata?: Record<string, unknown>;
}) => run(
  input.env,
  `INSERT INTO ap_asset_events (
     event_id, asset_id, revision_id, operation, actor_type, actor_id, metadata, created_at
   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  [
    `aevt_${crypto.randomUUID().replaceAll("-", "")}`,
    input.assetId,
    input.revisionId ?? null,
    input.operation,
    input.actorType,
    input.actorId ?? null,
    JSON.stringify(input.metadata ?? {}),
    new Date().toISOString(),
  ],
);

export const updateAssetMetadata = async (input: {
  env: AssetRuntimeEnv;
  assetId: string;
  displayName?: string;
  folder?: string | null;
  category?: string | null;
  altText?: string | null;
  caption?: string | null;
  aliases?: string[];
  actorType: "user" | "agent" | "system" | "unknown";
  actorId?: string | null;
}) => {
  safeIdentifier(input.assetId, "Asset ID");
  const current = await first<{ current_revision_id?: unknown; origin?: unknown; protected?: unknown; deleted_at?: unknown }>(
    input.env,
    `SELECT current_revision_id, origin, protected, deleted_at FROM ap_asset_records WHERE asset_id = ?`,
    [input.assetId],
  );
  if (!current?.current_revision_id || current.deleted_at) throw new Error("Project asset was not found.");
  const timestamp = new Date().toISOString();
  await run(
    input.env,
    `UPDATE ap_asset_records SET
       display_name = COALESCE(?, display_name),
       folder = CASE WHEN ? = 1 THEN ? ELSE folder END,
       category = CASE WHEN ? = 1 THEN ? ELSE category END,
       updated_by = ?, updated_at = ?
     WHERE asset_id = ?`,
    [
      input.displayName?.trim() || null,
      input.folder !== undefined ? 1 : 0,
      input.folder ?? null,
      input.category !== undefined ? 1 : 0,
      input.category ?? null,
      input.actorId ?? null,
      timestamp,
      input.assetId,
    ],
  );
  if (input.altText !== undefined || input.caption !== undefined) {
    await run(
      input.env,
      `UPDATE media SET
         alt = CASE WHEN ? = 1 THEN ? ELSE alt END,
         caption = CASE WHEN ? = 1 THEN ? ELSE caption END
       WHERE id = ?`,
      [
        input.altText !== undefined ? 1 : 0,
        input.altText ?? null,
        input.caption !== undefined ? 1 : 0,
        input.caption ?? null,
        input.assetId,
      ],
    );
  }
  if (input.aliases !== undefined) {
    const aliases = aliasValues(input.aliases);
    await assertAliasesAvailable(input.env, input.assetId, aliases);
    await run(input.env, `DELETE FROM ap_asset_aliases WHERE asset_id = ? AND protected = 0`, [input.assetId]);
    for (const alias of aliases) {
      await run(
        input.env,
        `INSERT INTO ap_asset_aliases (alias, asset_id, origin, protected, created_at, updated_at)
         VALUES (?, ?, ?, 0, ?, ?)
         ON CONFLICT(alias) DO UPDATE SET asset_id = excluded.asset_id, updated_at = excluded.updated_at`,
        [alias, input.assetId, current.origin ?? "user", timestamp, timestamp],
      );
    }
  }
  await recordAssetEvent({ ...input, revisionId: String(current.current_revision_id), operation: "metadata_update" });
  await bumpAssetState(input.env);
  return listAssets({ env: input.env, includeDeleted: true }).then((items) => items.find((item) => item.assetId === input.assetId));
};

export const deleteAsset = async (input: {
  env: AssetRuntimeEnv;
  assetId: string;
  actorType: "user" | "agent" | "system" | "unknown";
  actorId?: string | null;
}) => {
  safeIdentifier(input.assetId, "Asset ID");
  const current = await first<{ current_revision_id?: unknown; protected?: unknown; deleted_at?: unknown }>(
    input.env,
    `SELECT current_revision_id, protected, deleted_at FROM ap_asset_records WHERE asset_id = ?`,
    [input.assetId],
  );
  if (!current?.current_revision_id || current.deleted_at) throw new Error("Project asset was not found.");
  if (Number(current.protected) === 1) throw new Error("Protected template assets cannot be deleted.");
  const timestamp = new Date().toISOString();
  await run(input.env, `UPDATE ap_asset_records SET deleted_at = ?, updated_by = ?, updated_at = ? WHERE asset_id = ?`, [timestamp, input.actorId ?? null, timestamp, input.assetId]);
  await recordAssetEvent({ ...input, revisionId: String(current.current_revision_id), operation: "delete" });
  await bumpAssetState(input.env);
  return readAssetStatus(input.env);
};

export const restoreAsset = async (input: {
  env: AssetRuntimeEnv;
  assetId: string;
  actorType: "user" | "agent" | "system" | "unknown";
  actorId?: string | null;
}) => {
  safeIdentifier(input.assetId, "Asset ID");
  const current = await first<{ current_revision_id?: unknown; deleted_at?: unknown }>(
    input.env,
    `SELECT current_revision_id, deleted_at FROM ap_asset_records WHERE asset_id = ?`,
    [input.assetId],
  );
  if (!current?.current_revision_id || !current.deleted_at) throw new Error("Deleted project asset was not found.");
  const timestamp = new Date().toISOString();
  await run(input.env, `UPDATE ap_asset_records SET deleted_at = NULL, updated_by = ?, updated_at = ? WHERE asset_id = ?`, [input.actorId ?? null, timestamp, input.assetId]);
  await recordAssetEvent({ ...input, revisionId: String(current.current_revision_id), operation: "restore" });
  await bumpAssetState(input.env);
  return readAssetStatus(input.env);
};

type DeliveryRevisionRow = {
  asset_id: string;
  revision_id: string;
  storage_key: string;
  content_hash: string;
  file_name: string;
  mime_type: string;
  etag: string;
};

const stableRevision = async (
  env: AssetRuntimeEnv,
  kind: "asset" | "alias",
  value: string,
) => {
  try {
    return await first<DeliveryRevisionRow>(
      env,
      kind === "asset"
        ? `SELECT r.asset_id, r.revision_id, r.storage_key, r.content_hash, r.file_name, r.mime_type, r.etag
           FROM ap_asset_records a
           JOIN ap_asset_revisions r ON r.revision_id = a.current_revision_id
           WHERE a.asset_id = ? AND a.deleted_at IS NULL AND r.status = 'ready'`
        : `SELECT r.asset_id, r.revision_id, r.storage_key, r.content_hash, r.file_name, r.mime_type, r.etag
           FROM ap_asset_aliases l
           JOIN ap_asset_records a ON a.asset_id = l.asset_id
           JOIN ap_asset_revisions r ON r.revision_id = a.current_revision_id
           WHERE l.alias = ? AND a.deleted_at IS NULL AND r.status = 'ready'`,
      [value],
    );
  } catch (_error) {
    return null;
  }
};

const immutableRevision = async (
  env: AssetRuntimeEnv,
  revisionId: string,
  contentHash: string,
) => {
  try {
    return await first<DeliveryRevisionRow>(
      env,
      `SELECT r.asset_id, r.revision_id, r.storage_key, r.content_hash, r.file_name, r.mime_type, r.etag
       FROM ap_asset_revisions r
       JOIN ap_asset_records a ON a.asset_id = r.asset_id
       WHERE r.revision_id = ? AND r.content_hash = ? AND r.status = 'ready' AND a.deleted_at IS NULL`,
      [revisionId, contentHash],
    );
  } catch (_error) {
    return null;
  }
};

const notFoundResponse = () => new Response("Project asset not found.", {
  status: 404,
  headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
});

export const handleAssetDeliveryRequest = async (
  request: Request,
  env: AssetRuntimeEnv,
): Promise<Response> => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed.", { status: 405, headers: { allow: "GET, HEAD" } });
  }
  const segments = new URL(request.url).pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments[0] !== "_assets") return notFoundResponse();
  if ((segments[1] === "assets" || segments[1] === "aliases") && segments[2]) {
    const row = await stableRevision(env, segments[1] === "assets" ? "asset" : "alias", segments[2]);
    if (!row) return notFoundResponse();
    return new Response(null, {
      status: 302,
      headers: {
        location: immutableAssetUrl({
          revisionId: row.revision_id,
          contentHash: row.content_hash,
          fileName: row.file_name,
        }),
        "cache-control": "no-store",
      },
    });
  }
  if (segments[1] === "revisions" && segments[2] && segments[3]) {
    const row = await immutableRevision(env, segments[2], segments[3]);
    const media = env.MEDIA as { get?(key: string): Promise<AssetR2Object | null> } | undefined;
    if (!row || !media?.get) return notFoundResponse();
    const object = await media.get(row.storage_key);
    if (!object) return notFoundResponse();
    const headers = new Headers({
      "cache-control": "public, max-age=31536000, immutable",
      "content-type": row.mime_type,
      etag: object.httpEtag ?? row.etag,
      "x-content-type-options": "nosniff",
    });
    object.writeHttpMetadata?.(headers);
    headers.set("cache-control", "public, max-age=31536000, immutable");
    headers.set("content-type", row.mime_type);
    headers.set("etag", object.httpEtag ?? row.etag);
    headers.set("x-content-type-options", "nosniff");
    if (row.mime_type === "image/svg+xml") {
      headers.set("content-security-policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    }
    return new Response(request.method === "HEAD" ? null : object.body, { status: 200, headers });
  }
  return notFoundResponse();
};

export const maybeHandleProjectAssetRequest = (
  request: Request,
  env: AssetRuntimeEnv,
): Promise<Response> | null => {
  const pathname = new URL(request.url).pathname;
  return pathname === "/_assets" || pathname.startsWith("/_assets/")
    ? handleAssetDeliveryRequest(request, env)
    : null;
};
