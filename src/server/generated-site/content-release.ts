import {
  contentItem,
  type EmDashContentItem,
  pageContentData,
  type EmDashRuntimeLike,
} from "../../builder/content.ts";
import {
  getBuilderEntryConfig,
  getBuilderReleaseTargets,
  type BuilderSchemaField,
} from "../../builder/registry.ts";
import {
  activeLocales,
  type SupportedLocale,
} from "../../data/localization-contract.ts";
import {
  createId,
  nowIso,
  safeString,
  type RuntimeEnv,
} from "../aggregator/runtime.ts";

export type ContentReleaseSource =
  | "content_studio"
  | "openhands_mcp"
  | "emdash_rest"
  | "admin"
  | "system_import";

export type ContentReleaseActorType = "user" | "agent" | "system" | "unknown";

export type ContentReleaseOperation =
  | "create"
  | "update"
  | "publish"
  | "unpublish"
  | "delete"
  | "import";

export type ContentSnapshotEntry = {
  collection: string;
  entry: string;
  locale: SupportedLocale;
  data: Record<string, string>;
  publishedAt: string | null;
};

export type ContentReleaseSnapshot = {
  schemaVersion: 1;
  templateKey: "aspt-verdigris-vera-solaro";
  environment: "preview" | "production";
  contentRevision: number;
  snapshotHash: string;
  contentHash: string;
  exportedAt: string;
  summary: ContentReleaseSummary;
  entries: ContentSnapshotEntry[];
};

export type ContentReleaseSummary = {
  entries: number;
  fields: number;
  pages: number;
  seoFields: number;
  contentFields: number;
  locales: SupportedLocale[];
};

export type ContentReleaseStatus = {
  environment: "preview" | "production";
  contentRevision: number;
  publishedContentHash: string;
  snapshotHash: string;
  draftCount: number;
  changedEntries: number;
  changedFields: number;
  lastChangedAt: string | null;
  summary: ContentReleaseSummary;
};

type D1Statement = {
  bind(...values: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
  run(): Promise<unknown>;
};

type BatchStatement = readonly [sql: string, values?: readonly unknown[]];

const encoder = new TextEncoder();
const activeLocaleCodes = activeLocales.map(
  (locale) => locale.code,
) as SupportedLocale[];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const statement = (env: RuntimeEnv, sql: string) => {
  if (!env.DB) throw new Error("D1 database binding is not configured.");
  return env.DB.prepare(sql) as unknown as D1Statement;
};

const first = <T extends Record<string, unknown> = Record<string, unknown>>(
  env: RuntimeEnv,
  sql: string,
  values: unknown[] = [],
) =>
  statement(env, sql)
    .bind(...values)
    .first<T>();

const all = async <T extends Record<string, unknown> = Record<string, unknown>>(
  env: RuntimeEnv,
  sql: string,
  values: unknown[] = [],
) => {
  const result = await statement(env, sql)
    .bind(...values)
    .all<T>();
  return result.results ?? [];
};

const run = (env: RuntimeEnv, sql: string, values: unknown[] = []) =>
  statement(env, sql)
    .bind(...values)
    .run();

const runBatch = async (
  env: RuntimeEnv,
  statements: BatchStatement[],
  batchSize = 50,
) => {
  const filtered = statements.filter(([sql]) => sql.trim().length > 0);
  if (filtered.length === 0) return;
  const db = env.DB as unknown as {
    prepare(sql: string): D1Statement;
    batch?(statements: D1Statement[]): Promise<unknown>;
  } | undefined;
  if (typeof db?.batch === "function") {
    for (let index = 0; index < filtered.length; index += batchSize) {
      const chunk = filtered.slice(index, index + batchSize);
      await db.batch(
        chunk.map(([sql, values = []]) => db.prepare(sql).bind(...values)),
      );
    }
    return;
  }
  for (const [sql, values = []] of filtered) {
    await run(env, sql, [...values]);
  }
};

const identifier = (value: string) => {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) {
    throw new Error(`Unsafe content release identifier: ${value}`);
  }
  return `"${value}"`;
};

const contentTableName = (collection: string) => `ec_${collection}`;

const contentTable = (collection: string) =>
  identifier(contentTableName(collection));

const missingTable = (error: unknown) =>
  error instanceof Error && /no such table/i.test(error.message);

const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
};

export const sha256Hex = async (value: unknown) => {
  const input = typeof value === "string" ? value : stableStringify(value);
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
};

export const resolveContentReleaseEnvironment = (
  env: RuntimeEnv,
): "preview" | "production" => {
  const value = safeString(env.ASTROPAGES_SITE_ENVIRONMENT);
  if (value === "preview" || value === "production") return value;
  throw new Error(
    "ASTROPAGES_SITE_ENVIRONMENT must be preview or production for content release.",
  );
};

export const ensureContentReleaseTables = async (env: RuntimeEnv) => {
  await run(
    env,
    `CREATE TABLE IF NOT EXISTS ap_content_revision_log (
      id TEXT PRIMARY KEY,
      revision_number INTEGER NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('content_studio', 'openhands_mcp', 'emdash_rest', 'admin', 'system_import')),
      actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'agent', 'system', 'unknown')),
      actor_id TEXT,
      operation TEXT NOT NULL CHECK (operation IN ('create', 'update', 'publish', 'unpublish', 'delete', 'import')),
      collection TEXT NOT NULL,
      entry TEXT NOT NULL,
      locale TEXT NOT NULL DEFAULT 'en',
      changed_fields TEXT NOT NULL DEFAULT '[]',
      content_hash TEXT,
      snapshot_hash TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  );
  await run(
    env,
    `CREATE TABLE IF NOT EXISTS ap_content_environment_state (
      environment TEXT PRIMARY KEY,
      current_revision_number INTEGER NOT NULL DEFAULT 0,
      current_published_hash TEXT,
      current_snapshot_hash TEXT,
      last_snapshot_id TEXT,
      last_changed_at TEXT,
      last_exported_at TEXT,
      last_imported_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  );
};

const allowedFieldsFor = (collection: string, entry: string) =>
  new Set(
    getBuilderEntryConfig(collection, entry)?.editableFields.map(
      (field) => field.slug,
    ) ?? [],
  );

const pickAllowedTextData = (
  value: unknown,
  fields: Iterable<string>,
): Record<string, string> => {
  const allowed = new Set(fields);
  const data = pageContentData(isRecord(value) ? value : undefined);
  return Object.fromEntries(
    Object.entries(data)
      .filter(([key]) => allowed.has(key))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
};

const publishedDataForItem = (
  item: Record<string, unknown> | undefined,
  fields: Iterable<string>,
) =>
  pickAllowedTextData(
    isRecord(item?.liveData) ? item.liveData : item?.data,
    fields,
  );

const readEntry = async (
  emdash: EmDashRuntimeLike,
  collection: string,
  entry: string,
  locale: SupportedLocale,
) => contentItem(await emdash.handleContentGet?.(collection, entry, locale));

const existingContentTableNames = async (
  env: RuntimeEnv,
  collections: Iterable<string>,
) => {
  const names = [...new Set([...collections].map(contentTableName))].sort();
  if (names.length === 0) return new Set<string>();
  try {
    const rows = await all<{ name: string }>(
      env,
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
       AND name IN (${names.map(() => "?").join(", ")})`,
      names,
    );
    return new Set(rows.map((row) => row.name).filter(Boolean));
  } catch (error) {
    if (missingTable(error)) return new Set<string>();
    throw error;
  }
};

const readReleaseEntriesFromD1 = async (
  env: RuntimeEnv,
  targets: ReturnType<typeof getBuilderReleaseTargets>,
) => {
  const targetsByCollection = new Map<string, typeof targets>();
  for (const target of targets) {
    targetsByCollection.set(target.collection, [
      ...(targetsByCollection.get(target.collection) ?? []),
      target,
    ]);
  }
  const existingTables = await existingContentTableNames(
    env,
    targetsByCollection.keys(),
  );
  const items = new Map<string, EmDashContentItem>();

  for (const [collection, collectionTargets] of targetsByCollection) {
    if (!existingTables.has(contentTableName(collection))) continue;
    const slugs = [...new Set(collectionTargets.map((target) => target.entry))].sort();
    const locales = activeLocaleCodes;
    if (slugs.length === 0 || locales.length === 0) continue;
    const rows = await all<Record<string, unknown>>(
      env,
      `SELECT * FROM ${contentTable(collection)}
       WHERE slug IN (${slugs.map(() => "?").join(", ")})
       AND locale IN (${locales.map(() => "?").join(", ")})
       AND deleted_at IS NULL`,
      [...slugs, ...locales],
    );
    for (const row of rows) {
      const entry = safeString(row.slug);
      const locale = safeString(row.locale) as SupportedLocale;
      if (!entry || !activeLocaleCodes.includes(locale)) continue;
      const allowed = allowedFieldsFor(collection, entry);
      const data = pickAllowedTextData(row, allowed);
      items.set(`${collection}/${entry}/${locale}`, {
        ...row,
        id: safeString(row.id) || `${collection}-${entry}-${locale}`,
        slug: entry,
        locale,
        data,
        liveData: data,
        draftRevisionId: safeString(row.draft_revision_id) || null,
        publishedAt: typeof row.published_at === "string" ? row.published_at : null,
      });
    }
  }

  return items;
};

const publishedAtForItem = (item: Record<string, unknown> | undefined) =>
  typeof item?.publishedAt === "string"
    ? item.publishedAt
    : typeof item?.published_at === "string"
      ? item.published_at
      : null;

const ensureContentEntryTable = async (
  env: RuntimeEnv,
  config: NonNullable<ReturnType<typeof getBuilderEntryConfig>>["collectionConfig"],
) => {
  const table = contentTable(config.slug);
  const tableName = contentTableName(config.slug);
  const baseColumnDefinitions = [
    "id TEXT PRIMARY KEY",
    "slug TEXT",
    "status TEXT DEFAULT 'draft'",
    "author_id TEXT",
    "primary_byline_id TEXT",
    "created_at TEXT DEFAULT (datetime('now'))",
    "updated_at TEXT DEFAULT (datetime('now'))",
    "published_at TEXT",
    "scheduled_at TEXT",
    "deleted_at TEXT",
    "version INTEGER DEFAULT 1",
    "live_revision_id TEXT",
    "draft_revision_id TEXT",
    "locale TEXT DEFAULT 'en' NOT NULL",
    "translation_group TEXT",
    "title TEXT NOT NULL DEFAULT ''",
    "UNIQUE(slug, locale)",
  ];
  const baseColumnNames = new Set(
    baseColumnDefinitions
      .map((definition) => definition.split(/\s+/)[0])
      .filter((name) => /^[a-z_][a-z0-9_]*$/.test(name)),
  );
  const fieldColumns = config.fields
    .map((field) => field.slug)
    .filter((field, index, fields) =>
      !baseColumnNames.has(field) && fields.indexOf(field) === index,
    );
  const existingTable = await first<{ name: string }>(
    env,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    [tableName],
  );

  if (!existingTable) {
    await run(
      env,
      `CREATE TABLE ${table} (
        ${[
          ...baseColumnDefinitions,
          ...fieldColumns.map((field) => `${identifier(field)} TEXT`),
        ].join(",\n        ")}
      )`,
    );
  }

  await run(
    env,
    `CREATE TABLE IF NOT EXISTS ${table} (
      id TEXT PRIMARY KEY,
      slug TEXT,
      status TEXT DEFAULT 'draft',
      author_id TEXT,
      primary_byline_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      published_at TEXT,
      scheduled_at TEXT,
      deleted_at TEXT,
      version INTEGER DEFAULT 1,
      live_revision_id TEXT,
      draft_revision_id TEXT,
      locale TEXT DEFAULT 'en' NOT NULL,
      translation_group TEXT,
      title TEXT NOT NULL DEFAULT '',
      UNIQUE(slug, locale)
    )`,
  );
  const existingColumns = new Set(
    (
      await all<{ name: string }>(
        env,
        `PRAGMA table_info(${table})`,
      )
    )
      .map((row) => row.name)
      .filter(Boolean),
  );
  for (const field of fieldColumns) {
    if (existingColumns.has(field)) continue;
    try {
      await run(env, `ALTER TABLE ${table} ADD COLUMN ${identifier(field)} TEXT`);
    } catch (error) {
      if (!(error instanceof Error) || !/duplicate column/i.test(error.message)) {
        throw error;
      }
    }
  }
  await run(
    env,
    `CREATE TABLE IF NOT EXISTS revisions (
      id TEXT PRIMARY KEY,
      collection TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      data TEXT NOT NULL,
      author_id TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
  );
};

const upsertCollectionMetadata = async (
  env: RuntimeEnv,
  config: NonNullable<ReturnType<typeof getBuilderEntryConfig>>["collectionConfig"],
) => {
  try {
    await run(
      env,
      `INSERT OR IGNORE INTO _emdash_collections (
        id, slug, label, label_singular, supports, source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        createId("col"),
        config.slug,
        config.label,
        config.labelSingular,
        JSON.stringify(config.supports),
        "astropages-content-release",
        nowIso(),
        nowIso(),
      ],
    );
  } catch (error) {
    if (!missingTable(error)) throw error;
  }
};

const summarizeEntries = (
  entries: ContentSnapshotEntry[],
  fieldsByTarget: Map<string, BuilderSchemaField[]>,
): ContentReleaseSummary => {
  const locales = [
    ...new Set(entries.map((entry) => entry.locale)),
  ].sort() as SupportedLocale[];
  const fields = entries.reduce(
    (count, entry) => count + Object.keys(entry.data).length,
    0,
  );
  let seoFields = 0;
  for (const entry of entries) {
    const targetFields =
      fieldsByTarget.get(`${entry.collection}/${entry.entry}`) ?? [];
    const seoSet = new Set(
      targetFields
        .map((field) => field.slug)
        .filter(
          (field) =>
            field.startsWith("seo_") ||
            field.startsWith("og_") ||
            field.startsWith("twitter_"),
        ),
    );
    seoFields += Object.keys(entry.data).filter((field) =>
      seoSet.has(field),
    ).length;
  }
  return {
    entries: entries.length,
    fields,
    pages: new Set(entries.map((entry) => entry.entry)).size,
    seoFields,
    contentFields: fields - seoFields,
    locales,
  };
};

const readContentReleaseRevisionRows = async (env: RuntimeEnv) => {
  try {
    return await all<{
      collection: string;
      entry: string;
      locale: string;
      changed_fields: string;
      content_hash?: string | null;
    }>(
      env,
      `SELECT collection, entry, locale, changed_fields, content_hash
       FROM ap_content_revision_log
       WHERE revision_number > 0
       ORDER BY revision_number ASC`,
    );
  } catch (error) {
    if (missingTable(error)) return [];
    throw error;
  }
};

const contentHashFromRevisionRows = async (
  revisionRows: Array<{
    collection: string;
    entry: string;
    locale: string;
    content_hash?: string | null;
  }>,
) => {
  const latestByEntry = new Map<string, string>();
  for (const row of revisionRows) {
    if (!row.content_hash) continue;
    latestByEntry.set(
      `${row.collection}/${row.entry}/${row.locale}`,
      row.content_hash,
    );
  }
  if (latestByEntry.size === 0) return null;
  return sha256Hex({
    entries: [...latestByEntry.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([entry, hash]) => ({ entry, hash })),
  });
};

const changedTargetsFromRevisionRows = (
  targets: ReturnType<typeof getBuilderReleaseTargets>,
  revisionRows: Array<{ collection: string; entry: string }>,
) => {
  const changedKeys = new Set(
    revisionRows.map((row) => `${row.collection}/${row.entry}`),
  );
  if (changedKeys.size === 0) return targets;
  return targets.filter((target) =>
    changedKeys.has(`${target.collection}/${target.entry}`),
  );
};

export const buildContentReleaseSnapshot = async ({
  emdash,
  env,
  ensureTables = true,
}: {
  emdash?: EmDashRuntimeLike;
  env: RuntimeEnv;
  ensureTables?: boolean;
}): Promise<ContentReleaseSnapshot> => {
  if (ensureTables) {
    await ensureContentReleaseTables(env);
  }
  const environment = resolveContentReleaseEnvironment(env);
  const revisionRows = await readContentReleaseRevisionRows(env);
  const targets = changedTargetsFromRevisionRows(
    getBuilderReleaseTargets(),
    revisionRows,
  );
  const entries: ContentSnapshotEntry[] = [];
  const fieldsByTarget = new Map<string, BuilderSchemaField[]>();
  const directItems = await readReleaseEntriesFromD1(env, targets);

  for (const target of targets) {
    const config = getBuilderEntryConfig(target.collection, target.entry);
    if (!config) continue;
    fieldsByTarget.set(
      `${target.collection}/${target.entry}`,
      config.editableFields,
    );
    for (const locale of activeLocaleCodes) {
      const item =
        directItems.get(`${target.collection}/${target.entry}/${locale}`) ??
        (emdash?.handleContentGet
          ? await readEntry(emdash, target.collection, target.entry, locale)
          : undefined);
      const data = publishedDataForItem(item, target.fields);
      if (Object.keys(data).length === 0) continue;
      entries.push({
        collection: target.collection,
        entry: target.entry,
        locale,
        data,
        publishedAt: publishedAtForItem(item),
      });
    }
  }

  entries.sort((a, b) =>
    `${a.collection}/${a.entry}/${a.locale}`.localeCompare(
      `${b.collection}/${b.entry}/${b.locale}`,
    ),
  );
  const contentRevision = Number(
    (
      await first(
        env,
        "SELECT COALESCE(MAX(revision_number), 0) AS revision FROM ap_content_revision_log",
      )
    )?.revision ?? 0,
  );
  const summary = summarizeEntries(entries, fieldsByTarget);
  const contentHash =
    (await contentHashFromRevisionRows(revisionRows)) ??
    (await sha256Hex({ entries }));
  const snapshotWithoutHash = {
    schemaVersion: 1 as const,
    templateKey: "aspt-verdigris-vera-solaro" as const,
    environment,
    contentRevision,
    contentHash,
    exportedAt: nowIso(),
    summary,
    entries,
  };
  const snapshotHash = await sha256Hex({
    schemaVersion: snapshotWithoutHash.schemaVersion,
    templateKey: snapshotWithoutHash.templateKey,
    environment,
    contentRevision,
    contentHash,
    entries,
  });

  return {
    ...snapshotWithoutHash,
    snapshotHash,
  };
};

const readEnvironmentState = async (
  env: RuntimeEnv,
  environment: "preview" | "production",
) => {
  try {
    return await first<{
      current_revision_number?: number | null;
      current_published_hash?: string | null;
      current_snapshot_hash?: string | null;
      last_changed_at?: string | null;
    }>(
      env,
      `SELECT current_revision_number, current_published_hash, current_snapshot_hash, last_changed_at
       FROM ap_content_environment_state
       WHERE environment = ?`,
      [environment],
    );
  } catch (error) {
    if (missingTable(error)) return null;
    throw error;
  }
};

const summarizeRevisionRows = (
  revisionRows: Array<{
    collection: string;
    entry: string;
    locale: string;
    changed_fields: string;
    content_hash?: string | null;
  }>,
) => {
  let changedFields = 0;
  let seoFields = 0;
  const changedEntries = new Set<string>();
  const locales = new Set<SupportedLocale>();
  for (const row of revisionRows) {
    changedEntries.add(`${row.collection}/${row.entry}/${row.locale}`);
    if (activeLocaleCodes.includes(row.locale as SupportedLocale)) {
      locales.add(row.locale as SupportedLocale);
    }
    const targetFields =
      getBuilderEntryConfig(row.collection, row.entry)?.editableFields ?? [];
    const seoSet = new Set(
      targetFields
        .map((field) => field.slug)
        .filter(
          (field) =>
            field.startsWith("seo_") ||
            field.startsWith("og_") ||
            field.startsWith("twitter_"),
        ),
    );
    try {
      const parsed = JSON.parse(row.changed_fields);
      if (Array.isArray(parsed)) {
        changedFields += parsed.length;
        seoFields += parsed.filter((field) => seoSet.has(String(field))).length;
      }
    } catch {
      // Ignore malformed historical metadata.
    }
  }
  return {
    changedEntries: changedEntries.size,
    changedFields,
    summary: {
      entries: changedEntries.size,
      fields: changedFields,
      pages: new Set([...changedEntries].map((key) => key.split("/")[1])).size,
      seoFields,
      contentFields: Math.max(0, changedFields - seoFields),
      locales: [...locales].sort() as SupportedLocale[],
    },
  };
};

export const readContentReleaseStatus = async ({
  env,
}: {
  emdash?: EmDashRuntimeLike;
  env: RuntimeEnv;
}): Promise<ContentReleaseStatus> => {
  const environment = resolveContentReleaseEnvironment(env);
  const state = await readEnvironmentState(env, environment);
  const revisionRows = await readContentReleaseRevisionRows(env);
  const revisionSummary = summarizeRevisionRows(revisionRows);
  const emptyContentHash = await sha256Hex({ entries: [] });
  const publishedContentHash =
    state?.current_published_hash ??
    (await contentHashFromRevisionRows(revisionRows)) ??
    emptyContentHash;

  return {
    environment,
    contentRevision: Number(state?.current_revision_number ?? 0),
    publishedContentHash,
    snapshotHash: state?.current_snapshot_hash ?? publishedContentHash,
    draftCount: 0,
    changedEntries: revisionSummary.changedEntries,
    changedFields: revisionSummary.changedFields,
    lastChangedAt: state?.last_changed_at ?? null,
    summary: revisionSummary.summary,
  };
};

const nextRevisionNumber = async (env: RuntimeEnv) =>
  Number(
    (
      await first(
        env,
        "SELECT COALESCE(MAX(revision_number), 0) + 1 AS revision FROM ap_content_revision_log",
      )
    )?.revision ?? 1,
  );

const updateEnvironmentState = async ({
  env,
  environment,
  revisionNumber,
  contentHash,
  snapshotHash,
  imported,
}: {
  env: RuntimeEnv;
  environment: "preview" | "production";
  revisionNumber: number;
  contentHash?: string | null;
  snapshotHash?: string | null;
  imported?: boolean;
}) => {
  const timestamp = nowIso();
  await run(
    env,
    `INSERT INTO ap_content_environment_state (
      environment,
      current_revision_number,
      current_published_hash,
      current_snapshot_hash,
      last_changed_at,
      last_exported_at,
      last_imported_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(environment) DO UPDATE SET
      current_revision_number = excluded.current_revision_number,
      current_published_hash = COALESCE(excluded.current_published_hash, ap_content_environment_state.current_published_hash),
      current_snapshot_hash = COALESCE(excluded.current_snapshot_hash, ap_content_environment_state.current_snapshot_hash),
      last_changed_at = excluded.last_changed_at,
      last_exported_at = excluded.last_exported_at,
      last_imported_at = COALESCE(excluded.last_imported_at, ap_content_environment_state.last_imported_at),
      updated_at = excluded.updated_at`,
    [
      environment,
      revisionNumber,
      contentHash ?? null,
      snapshotHash ?? null,
      timestamp,
      timestamp,
      imported ? timestamp : null,
      timestamp,
    ],
  );
};

export const recordContentRevision = async ({
  actorId,
  actorType,
  changedFields,
  collection,
  contentHash,
  entry,
  env,
  locale,
  metadata,
  operation,
  snapshotHash,
  source,
}: {
  env: RuntimeEnv;
  source: ContentReleaseSource;
  actorType: ContentReleaseActorType;
  actorId?: string | null;
  operation: ContentReleaseOperation;
  collection: string;
  entry: string;
  locale?: string | null;
  changedFields: string[];
  contentHash?: string | null;
  snapshotHash?: string | null;
  metadata?: Record<string, unknown>;
}) => {
  await ensureContentReleaseTables(env);
  const environment = resolveContentReleaseEnvironment(env);
  const revisionNumber = await nextRevisionNumber(env);
  await run(
    env,
    `INSERT INTO ap_content_revision_log (
      id,
      revision_number,
      source,
      actor_type,
      actor_id,
      operation,
      collection,
      entry,
      locale,
      changed_fields,
      content_hash,
      snapshot_hash,
      metadata,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      createId("apcr"),
      revisionNumber,
      source,
      actorType,
      actorId ?? null,
      operation,
      collection,
      entry,
      locale || "en",
      JSON.stringify([...new Set(changedFields)].sort()),
      contentHash ?? null,
      snapshotHash ?? null,
      JSON.stringify(metadata ?? {}),
      nowIso(),
    ],
  );
  await updateEnvironmentState({
    env,
    environment,
    revisionNumber,
    contentHash,
    snapshotHash,
    imported: operation === "import",
  });
};

export const importContentReleaseSnapshot = async ({
  env,
  snapshot,
}: {
  env: RuntimeEnv;
  snapshot: ContentReleaseSnapshot;
}) => {
  await ensureContentReleaseTables(env);
  const environment = resolveContentReleaseEnvironment(env);
  const currentState = await readEnvironmentState(env, environment);
  if (
    currentState?.current_snapshot_hash === snapshot.snapshotHash &&
    currentState?.current_published_hash === snapshot.contentHash
  ) {
    return {
      importedEntries: 0,
      snapshotHash: snapshot.snapshotHash,
      contentHash: snapshot.contentHash,
    };
  }
  const targets: Array<{
    collection: string;
    entry: string;
    locale: SupportedLocale;
    data: Record<string, string>;
    publishedAt: string | null;
  }> = [];

  for (const entry of snapshot.entries) {
    const config = getBuilderEntryConfig(entry.collection, entry.entry);
    if (!config) continue;
    const allowedFields = allowedFieldsFor(entry.collection, entry.entry);
    const data = pickAllowedTextData(entry.data, allowedFields);
    targets.push({
      collection: entry.collection,
      entry: entry.entry,
      locale: entry.locale,
      data,
      publishedAt: entry.publishedAt,
    });
  }

  const targetsByCollection = new Map<string, typeof targets>();
  for (const target of targets) {
    targetsByCollection.set(target.collection, [
      ...(targetsByCollection.get(target.collection) ?? []),
      target,
    ]);
  }
  const existingTables = await existingContentTableNames(
    env,
    targetsByCollection.keys(),
  );
  for (const [collection, collectionTargets] of targetsByCollection) {
    const config = getBuilderEntryConfig(
      collection,
      collectionTargets[0]?.entry ?? "",
    );
    if (!config) continue;
    if (!existingTables.has(contentTableName(collection))) {
      await ensureContentEntryTable(env, config.collectionConfig);
    }
    await upsertCollectionMetadata(env, config.collectionConfig);
  }

  const existingIds = new Map<string, string>();
  for (const [collection, collectionTargets] of targetsByCollection) {
    const slugs = [...new Set(collectionTargets.map((target) => target.entry))].sort();
    const locales = [...new Set(collectionTargets.map((target) => target.locale))].sort();
    const rows = await all<{ id: string; slug: string; locale: string }>(
      env,
      `SELECT id, slug, locale FROM ${contentTable(collection)}
       WHERE slug IN (${slugs.map(() => "?").join(", ")})
       AND locale IN (${locales.map(() => "?").join(", ")})
       AND deleted_at IS NULL`,
      [...slugs, ...locales],
    );
    for (const row of rows) {
      existingIds.set(`${collection}/${row.slug}/${row.locale}`, row.id);
    }
  }

  const revisionNumber = await nextRevisionNumber(env);
  const timestamp = nowIso();
  const writes: BatchStatement[] = [];
  for (const target of targets) {
    const key = `${target.collection}/${target.entry}/${target.locale}`;
    const existingId = existingIds.get(key);
    const entryId = existingId ?? createId("ec");
    const revisionId = createId("rev");
    const fields = Object.keys(target.data).sort();
    writes.push([
      "INSERT INTO revisions (id, collection, entry_id, data, author_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [
        revisionId,
        target.collection,
        entryId,
        JSON.stringify(target.data),
        "astropages-control-plane",
        timestamp,
      ],
    ]);
    if (existingId) {
      const assignments = fields.map((field) => `${identifier(field)} = ?`);
      writes.push([
        `UPDATE ${contentTable(target.collection)} SET
          ${assignments.length ? `${assignments.join(", ")},` : ""}
          status = 'published',
          live_revision_id = ?,
          draft_revision_id = NULL,
          published_at = COALESCE(?, published_at, ?),
          updated_at = ?,
          version = COALESCE(version, 0) + 1
         WHERE id = ?`,
        [
          ...fields.map((field) => target.data[field]),
          revisionId,
          target.publishedAt,
          timestamp,
          timestamp,
          entryId,
        ],
      ]);
    } else {
      const baseColumns = [
        "id", "slug", "status", "created_at", "updated_at", "published_at",
        "version", "live_revision_id", "draft_revision_id", "locale", "translation_group",
      ];
      const columns = [...baseColumns, ...fields];
      writes.push([
        `INSERT INTO ${contentTable(target.collection)} (${columns.map(identifier).join(", ")})
         VALUES (${columns.map(() => "?").join(", ")})`,
        [
          entryId,
          target.entry,
          "published",
          timestamp,
          timestamp,
          target.publishedAt ?? timestamp,
          1,
          revisionId,
          null,
          target.locale,
          entryId,
          ...fields.map((field) => target.data[field]),
        ],
      ]);
    }
    writes.push([
      `INSERT INTO ap_content_revision_log (
        id, revision_number, source, actor_type, actor_id, operation, collection,
        entry, locale, changed_fields, content_hash, snapshot_hash, metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        createId("apcr"),
        revisionNumber,
        "system_import",
        "system",
        "astropages-control-plane",
        "import",
        target.collection,
        target.entry,
        target.locale,
        JSON.stringify(fields),
        snapshot.contentHash,
        snapshot.snapshotHash,
        JSON.stringify({
          importedSnapshotHash: snapshot.snapshotHash,
          sourceEnvironment: snapshot.environment,
        }),
        timestamp,
      ],
    ]);
  }
  await runBatch(env, writes);
  await updateEnvironmentState({
    env,
    environment,
    revisionNumber,
    contentHash: snapshot.contentHash,
    snapshotHash: snapshot.snapshotHash,
    imported: true,
  });

  return {
    importedEntries: targets.length,
    snapshotHash: snapshot.snapshotHash,
    contentHash: snapshot.contentHash,
  };
};

export const inferContentReleaseSource = (
  request: Request,
): {
  source: ContentReleaseSource;
  actorType: ContentReleaseActorType;
  actorId: string | null;
} => {
  const url = new URL(request.url);
  const explicitSource = request.headers.get("x-astropages-content-source");
  const explicitActor = request.headers.get("x-astropages-actor-id");
  if (
    explicitSource === "content_studio" ||
    url.pathname.includes("/editor/content-field")
  ) {
    return {
      source: "content_studio",
      actorType: "user",
      actorId: explicitActor,
    };
  }
  if (
    explicitSource === "openhands_mcp" ||
    url.pathname === "/_emdash/api/mcp"
  ) {
    return {
      source: "openhands_mcp",
      actorType: "agent",
      actorId: explicitActor ?? "openhands",
    };
  }
  if (url.pathname.includes("/astropages/admin")) {
    return { source: "admin", actorType: "user", actorId: explicitActor };
  }
  return {
    source: "emdash_rest",
    actorType: explicitActor ? "user" : "unknown",
    actorId: explicitActor,
  };
};

export const fieldsChangedBetween = (
  before: unknown,
  after: unknown,
  fields: Iterable<string>,
) => {
  const allowed = [...fields];
  const beforeData = pickAllowedTextData(before, allowed);
  const afterData = pickAllowedTextData(after, allowed);
  return allowed.filter((field) => beforeData[field] !== afterData[field]);
};
