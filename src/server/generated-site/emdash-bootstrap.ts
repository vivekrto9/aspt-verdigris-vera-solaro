import {
  getBuilderEntryConfig,
  getBuilderReleaseTargets,
  type BuilderCollectionConfig,
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
import { ensureContentReleaseTables } from "./content-release.ts";

type D1Statement = {
  bind(...values: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
  run(): Promise<unknown>;
};

type BootstrapTarget = ReturnType<typeof getBuilderReleaseTargets>[number];
type BatchStatement = readonly [sql: string, values?: readonly unknown[]];

const activeLocaleCodes = activeLocales.map(
  (locale) => locale.code,
) as SupportedLocale[];
const bootstrapTemplateKey = "aspt-verdigris-vera-solaro";
const bootstrapStateTable = "ap_emdash_bootstrap_state";

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

const run = (env: RuntimeEnv, sql: string, values: readonly unknown[] = []) =>
  statement(env, sql)
    .bind(...values)
    .run();

const runBatch = async (env: RuntimeEnv, statements: BatchStatement[]) => {
  const filtered = statements.filter(([sql]) => sql.trim().length > 0);
  if (filtered.length === 0) return;
  const db = env.DB as unknown as {
    prepare(sql: string): D1Statement;
    batch?(statements: D1Statement[]): Promise<unknown>;
  } | undefined;
  if (typeof db?.batch === "function") {
    await db.batch(
      filtered.map(([sql, values = []]) =>
        db.prepare(sql).bind(...values),
      ),
    );
    return;
  }
  for (const [sql, values = []] of filtered) {
    await run(env, sql, values);
  }
};

const identifier = (value: string) => {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) {
    throw new Error(`Unsafe EmDash bootstrap identifier: ${value}`);
  }
  return `"${value}"`;
};

const contentTableName = (collection: string) => `ec_${collection}`;
const contentTable = (collection: string) =>
  identifier(contentTableName(collection));

const uniqueFields = (fields: BuilderSchemaField[]) =>
  fields.filter((field, index, allFields) =>
    allFields.findIndex((candidate) => candidate.slug === field.slug) === index,
  );

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value);
};

const toHex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const sha256Hex = async (value: unknown) =>
  `sha256:${toHex(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(value)),
  ))}`;

const columnTypeFor = (field: BuilderSchemaField) =>
  field.type === "text" || field.type === "string" ? "TEXT" : "TEXT";

const ensureContentTable = async (
  env: RuntimeEnv,
  config: BuilderCollectionConfig,
) => {
  const table = contentTable(config.slug);
  const fieldColumns = uniqueFields(config.fields)
    .map((field) => field.slug)
    .filter((field) => field !== "id" && field !== "title");
  const fieldColumnDefinitions = fieldColumns
    .map((field) => `${identifier(field)} TEXT`)
    .join(",\n      ");
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
      ${fieldColumnDefinitions ? `${fieldColumnDefinitions},` : ""}
      UNIQUE(slug, locale)
    )`,
  );
  // Runtime bootstrap must not widen existing content tables during deploy or
  // page/editor requests. Fresh tables are created with all registry fields;
  // future schema shape changes belong in explicit migrations.
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

const ensureCollectionMetadata = async (
  env: RuntimeEnv,
  config: BuilderCollectionConfig,
) => {
  const now = nowIso();
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
      "astropages-bootstrap",
      now,
      now,
    ],
  );
  const collection = await first<{ id: string }>(
    env,
    "SELECT id FROM _emdash_collections WHERE slug = ? LIMIT 1",
    [config.slug],
  );
  if (!collection?.id) {
    throw new Error(`Failed to prepare EmDash collection metadata for ${config.slug}.`);
  }
  return collection.id;
};

const ensureFieldMetadata = async (
  env: RuntimeEnv,
  collectionId: string,
  fields: BuilderSchemaField[],
) => {
  const now = nowIso();
  const statements = uniqueFields(fields).map((field, sortOrder) => [
      `INSERT OR IGNORE INTO _emdash_fields (
        id, collection_id, slug, label, type, column_type, "required", "unique",
        default_value, validation, widget, options, sort_order, searchable,
        translatable, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?)`,
      [
        createId("field"),
        collectionId,
        field.slug,
        field.label,
        field.type,
        columnTypeFor(field),
        field.required ? 1 : 0,
        0,
        sortOrder,
        field.slug.startsWith("seo_") ? 1 : 0,
        1,
        now,
      ],
    ] as const);
  await runBatch(env, statements);
};

const contentDataFor = (
  target: BootstrapTarget,
  locale: SupportedLocale,
) => {
  const config = getBuilderEntryConfig(target.collection, target.entry);
  const defaults = config?.defaultsByLocale[locale] ?? {};
  return Object.fromEntries(
    target.fields
      .map((field) => [field, safeString(defaults[field])])
      .filter(([, value]) => value.length > 0),
  ) as Record<string, string>;
};

const mergeMissingContentFields = (
  existing: Record<string, unknown>,
  data: Record<string, string>,
) =>
  Object.keys(data)
    .sort()
    .filter((field) => safeString(existing[field]).length === 0 && data[field].length > 0);

const upsertPublishedEntry = async ({
  env,
  locale,
  sourceEntryId,
  target,
}: {
  env: RuntimeEnv;
  target: BootstrapTarget;
  locale: SupportedLocale;
  sourceEntryId?: string | null;
}) => {
  const data = contentDataFor(target, locale);
  const table = contentTable(target.collection);
  const existing = await first<Record<string, unknown> & { id: string }>(
    env,
    `SELECT * FROM ${table} WHERE slug = ? AND locale = ? LIMIT 1`,
    [target.entry, locale],
  );
  const now = nowIso();
  const entryId = existing?.id ?? createId("ec");
  const translationGroup = sourceEntryId ?? entryId;
  const fields = Object.keys(data).sort();

  if (existing) {
    const missingFields = mergeMissingContentFields(existing, data);
    if (missingFields.length === 0) return entryId;

    const revisionId = createId("rev");
    const revisionData = Object.fromEntries(
      fields.map((field) => [field, safeString(existing[field]) || data[field] || ""]),
    );
    const assignments = missingFields.map((field) => `${identifier(field)} = ?`);
    await runBatch(env, [
      [
        "INSERT INTO revisions (id, collection, entry_id, data, author_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        [
          revisionId,
          target.collection,
          entryId,
          JSON.stringify(revisionData),
          "astropages-bootstrap",
          now,
        ],
      ],
      [
        `UPDATE ${table} SET
        ${assignments.join(", ")},
        status = COALESCE(status, 'published'),
        live_revision_id = COALESCE(live_revision_id, ?),
        draft_revision_id = NULL,
        published_at = COALESCE(published_at, ?),
        updated_at = ?,
        translation_group = COALESCE(translation_group, ?),
        version = COALESCE(version, 0) + 1
       WHERE id = ?`,
        [
          ...missingFields.map((field) => data[field]),
          revisionId,
          now,
          now,
          translationGroup,
          entryId,
        ],
      ],
    ]);
    return entryId;
  }

  const revisionId = createId("rev");
  const baseColumns = [
    "id",
    "slug",
    "status",
    "created_at",
    "updated_at",
    "published_at",
    "version",
    "live_revision_id",
    "draft_revision_id",
    "locale",
    "translation_group",
  ];
  const columns = [...baseColumns, ...fields];
  await runBatch(env, [
    [
      "INSERT INTO revisions (id, collection, entry_id, data, author_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [
        revisionId,
        target.collection,
        entryId,
        JSON.stringify(data),
        "astropages-bootstrap",
        now,
      ],
    ],
    [
      `INSERT INTO ${table} (${columns.map(identifier).join(", ")})
       VALUES (${columns.map(() => "?").join(", ")})`,
      [
        entryId,
        target.entry,
        "published",
        now,
        now,
        now,
        1,
        revisionId,
        null,
        locale,
        translationGroup,
        ...fields.map((field) => data[field]),
      ],
    ],
  ]);
  return entryId;
};

export type AstroPagesEmDashBootstrapReadiness = {
  ready: boolean;
  mode: "fast" | "deep";
  registryHash: string;
  expectedCollections: number;
  expectedFields: number;
  expectedEntries: number;
  missingTables: string[];
  missingCollections: string[];
  missingFields: Array<{ collection: string; field: string }>;
  missingEntries: Array<{ collection: string; entry: string; locale: SupportedLocale }>;
};

const uniqueTargets = () => getBuilderReleaseTargets();

const uniqueCollectionConfigs = () => {
  const configs = new Map<string, BuilderCollectionConfig>();
  for (const target of uniqueTargets()) {
    const config = getBuilderEntryConfig(target.collection, target.entry);
    if (config) configs.set(config.collectionConfig.slug, config.collectionConfig);
  }
  return [...configs.values()];
};

const bootstrapContract = async () => {
  const targets = uniqueTargets();
  const collectionConfigs = uniqueCollectionConfigs();
  const expectedCollections = collectionConfigs.length;
  const expectedFields = collectionConfigs.reduce(
    (count, config) => count + uniqueFields(config.fields).length,
    0,
  );
  const expectedEntries = targets.length * activeLocaleCodes.length;
  const registry = targets
    .map((target) => {
      const config = getBuilderEntryConfig(target.collection, target.entry);
      return {
        collection: target.collection,
        entry: target.entry,
        fields: [...target.fields].sort(),
        collectionFields: uniqueFields(config?.collectionConfig.fields ?? [])
          .map((field) => ({
            slug: field.slug,
            label: field.label,
            type: field.type,
            required: Boolean(field.required),
          }))
          .sort((left, right) => left.slug.localeCompare(right.slug)),
        defaultsByLocale: Object.fromEntries(
          activeLocaleCodes.map((locale) => [
            locale,
            Object.fromEntries(
              [...target.fields]
                .sort()
                .map((field) => [
                  field,
                  safeString(config?.defaultsByLocale[locale]?.[field]),
                ]),
            ),
          ]),
        ),
      };
    })
    .sort((left, right) =>
      `${left.collection}/${left.entry}`.localeCompare(`${right.collection}/${right.entry}`),
    );

  return {
    templateKey: bootstrapTemplateKey,
    registryHash: await sha256Hex({
      templateKey: bootstrapTemplateKey,
      locales: activeLocaleCodes,
      registry,
    }),
    expectedCollections,
    expectedFields,
    expectedEntries,
  };
};

type BootstrapContract = Awaited<ReturnType<typeof bootstrapContract>>;

export const readAstroPagesEmDashBootstrapContract = bootstrapContract;

type BootstrapStateRow = {
  template_key: string;
  template_version: string | null;
  builder_registry_hash: string;
  expected_collections: number;
  expected_fields: number;
  expected_entries: number;
  completed_at: string;
  last_full_verified_at: string;
};

const ensureBootstrapStateTable = async (env: RuntimeEnv) => {
  await run(
    env,
    `CREATE TABLE IF NOT EXISTS ${bootstrapStateTable} (
      template_key TEXT PRIMARY KEY,
      template_version TEXT,
      builder_registry_hash TEXT NOT NULL,
      expected_collections INTEGER NOT NULL,
      expected_fields INTEGER NOT NULL,
      expected_entries INTEGER NOT NULL,
      completed_at TEXT NOT NULL,
      last_full_verified_at TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  );
};

const readBootstrapState = async (env: RuntimeEnv) =>
  first<BootstrapStateRow>(
    env,
    `SELECT template_key, template_version, builder_registry_hash, expected_collections,
            expected_fields, expected_entries, completed_at, last_full_verified_at
       FROM ${bootstrapStateTable}
      WHERE template_key = ?
      LIMIT 1`,
    [bootstrapTemplateKey],
  );

const stateMatchesContract = (
  state: BootstrapStateRow | null,
  contract: BootstrapContract,
) =>
  Boolean(
    state &&
    state.builder_registry_hash === contract.registryHash &&
    Number(state.expected_collections) === contract.expectedCollections &&
    Number(state.expected_fields) === contract.expectedFields &&
    Number(state.expected_entries) === contract.expectedEntries,
  );

const writeBootstrapState = async (env: RuntimeEnv, contract: BootstrapContract) => {
  const now = nowIso();
  await ensureBootstrapStateTable(env);
  await run(
    env,
    `INSERT INTO ${bootstrapStateTable} (
      template_key, template_version, builder_registry_hash, expected_collections,
      expected_fields, expected_entries, completed_at, last_full_verified_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(template_key) DO UPDATE SET
      template_version = excluded.template_version,
      builder_registry_hash = excluded.builder_registry_hash,
      expected_collections = excluded.expected_collections,
      expected_fields = excluded.expected_fields,
      expected_entries = excluded.expected_entries,
      last_full_verified_at = excluded.last_full_verified_at,
      updated_at = excluded.updated_at`,
    [
      bootstrapTemplateKey,
      null,
      contract.registryHash,
      contract.expectedCollections,
      contract.expectedFields,
      contract.expectedEntries,
      now,
      now,
      now,
    ],
  );
};

export const readAstroPagesEmDashBootstrapStatus = async ({
  env,
  mode = "fast",
}: {
  env: RuntimeEnv;
  mode?: "fast" | "deep";
}): Promise<AstroPagesEmDashBootstrapReadiness> => {
  const targets = uniqueTargets();
  const collectionConfigs = uniqueCollectionConfigs();
  const contract = await bootstrapContract();
  const requiredTables = [
    "_emdash_collections",
    "_emdash_fields",
    "revisions",
    bootstrapStateTable,
    ...collectionConfigs.map((config) => contentTableName(config.slug)),
  ];
  const tablePlaceholders = requiredTables.map(() => "?").join(", ");
  const tableRows = await all<{ name: string }>(
    env,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${tablePlaceholders})`,
    requiredTables,
  );
  const existingTables = new Set(tableRows.map((row) => row.name));
  const missingTables = requiredTables.filter((table) => !existingTables.has(table));

  const missingCollections: string[] = [];
  const missingFields: Array<{ collection: string; field: string }> = [];
  const missingEntries: Array<{ collection: string; entry: string; locale: SupportedLocale }> = [];

  if (!existingTables.has("_emdash_collections") || !existingTables.has("_emdash_fields")) {
    return {
      ready: false,
      mode,
      registryHash: contract.registryHash,
      expectedCollections: contract.expectedCollections,
      expectedFields: contract.expectedFields,
      expectedEntries: contract.expectedEntries,
      missingTables,
      missingCollections: collectionConfigs.map((config) => config.slug),
      missingFields: [],
      missingEntries: targets.flatMap((target) =>
        activeLocaleCodes.map((locale) => ({
          collection: target.collection,
          entry: target.entry,
          locale,
        })),
      ),
    };
  }

  if (mode === "fast") {
    if (!existingTables.has(bootstrapStateTable)) {
      return {
        ready: false,
        mode,
        registryHash: contract.registryHash,
        expectedCollections: contract.expectedCollections,
        expectedFields: contract.expectedFields,
        expectedEntries: contract.expectedEntries,
        missingTables,
        missingCollections: collectionConfigs.map((config) => config.slug),
        missingFields: [],
        missingEntries: [],
      };
    }
    const state = await readBootstrapState(env);
    const ready = missingTables.length === 0 && stateMatchesContract(state, contract);
    return {
      ready,
      mode,
      registryHash: contract.registryHash,
      expectedCollections: contract.expectedCollections,
      expectedFields: contract.expectedFields,
      expectedEntries: contract.expectedEntries,
      missingTables,
      missingCollections: ready ? [] : collectionConfigs.map((config) => config.slug),
      missingFields: [],
      missingEntries: [],
    };
  }

  const collectionSlugs = collectionConfigs.map((config) => config.slug);
  const collectionRows = await all<{ id: string; slug: string }>(
    env,
    `SELECT id, slug FROM _emdash_collections WHERE slug IN (${collectionSlugs.map(() => "?").join(", ")})`,
    collectionSlugs,
  );
  const collectionIdBySlug = new Map(collectionRows.map((row) => [row.slug, row.id]));
  for (const config of collectionConfigs) {
    if (!collectionIdBySlug.has(config.slug)) {
      missingCollections.push(config.slug);
      missingFields.push(
        ...uniqueFields(config.fields).map((field) => ({
          collection: config.slug,
          field: field.slug,
        })),
      );
    }
  }

  const collectionIds = [...collectionIdBySlug.values()];
  const fieldRows = collectionIds.length > 0
    ? await all<{ collection: string; field: string }>(
      env,
      `SELECT c.slug AS collection, f.slug AS field
       FROM _emdash_fields f
       JOIN _emdash_collections c ON c.id = f.collection_id
       WHERE f.collection_id IN (${collectionIds.map(() => "?").join(", ")})`,
      collectionIds,
    )
    : [];
  const fieldKeys = new Set(fieldRows.map((row) => `${row.collection}/${row.field}`));
  for (const config of collectionConfigs) {
    if (!collectionIdBySlug.has(config.slug)) continue;
    for (const field of uniqueFields(config.fields)) {
      if (!fieldKeys.has(`${config.slug}/${field.slug}`)) {
        missingFields.push({ collection: config.slug, field: field.slug });
      }
    }
  }

  const targetsByCollection = new Map<string, BootstrapTarget[]>();
  for (const target of targets) {
    targetsByCollection.set(target.collection, [
      ...(targetsByCollection.get(target.collection) ?? []),
      target,
    ]);
  }

  await Promise.all([...targetsByCollection.entries()].map(async ([collection, collectionTargets]) => {
    if (!existingTables.has(contentTableName(collection))) {
      for (const target of collectionTargets) {
        for (const locale of activeLocaleCodes) {
          missingEntries.push({
            collection: target.collection,
            entry: target.entry,
            locale,
          });
        }
      }
      return;
    }
    const entries = [...new Set(collectionTargets.map((target) => target.entry))];
    const entryRows = await all<{ slug: string; locale: SupportedLocale }>(
      env,
      `SELECT slug, locale FROM ${contentTable(collection)}
       WHERE status = 'published'
         AND slug IN (${entries.map(() => "?").join(", ")})
         AND locale IN (${activeLocaleCodes.map(() => "?").join(", ")})`,
      [...entries, ...activeLocaleCodes],
    );
    const entryKeys = new Set(entryRows.map((row) => `${row.slug}/${row.locale}`));
    for (const target of collectionTargets) {
      for (const locale of activeLocaleCodes) {
        if (!entryKeys.has(`${target.entry}/${locale}`)) {
          missingEntries.push({
            collection: target.collection,
            entry: target.entry,
            locale,
          });
        }
      }
    }
  }));

  return {
    ready:
      missingTables.length === 0 &&
      missingCollections.length === 0 &&
      missingFields.length === 0 &&
      missingEntries.length === 0,
    mode,
    registryHash: contract.registryHash,
    expectedCollections: contract.expectedCollections,
    expectedFields: contract.expectedFields,
    expectedEntries: contract.expectedEntries,
    missingTables,
    missingCollections,
    missingFields,
    missingEntries,
  };
};

export const bootstrapAstroPagesEmDashContent = async ({
  env,
  cursor = 0,
  limit,
  mode = "auto",
}: {
  env: RuntimeEnv;
  cursor?: number;
  limit?: number;
  mode?: "auto" | "full";
}) => {
  await ensureContentReleaseTables(env);
  const contract = await bootstrapContract();
  await ensureBootstrapStateTable(env);
  const targets = getBuilderReleaseTargets();
  if (mode === "auto") {
    const state = await readBootstrapState(env);
    if (stateMatchesContract(state, contract)) {
      return {
        status: "ready" as const,
        skipped: true,
        registryHash: contract.registryHash,
        collections: 0,
        fields: 0,
        entries: 0,
        locales: activeLocaleCodes,
        cursor: 0,
        processedTargets: 0,
        totalTargets: targets.length,
        nextCursor: null,
      };
    }
  }
  const start = Math.max(0, Math.trunc(cursor));
  const safeLimit =
    typeof limit === "number" && Number.isFinite(limit) && limit > 0
      ? Math.trunc(limit)
      : targets.length;
  const batchTargets = targets.slice(start, start + safeLimit);
  let collections = 0;
  let fields = 0;
  let entries = 0;

  for (const target of batchTargets) {
    const config = getBuilderEntryConfig(target.collection, target.entry);
    if (!config) continue;
    await ensureContentTable(env, config.collectionConfig);
    const collectionId = await ensureCollectionMetadata(env, config.collectionConfig);
    await ensureFieldMetadata(env, collectionId, config.collectionConfig.fields);
    collections += 1;
    fields += uniqueFields(config.collectionConfig.fields).length;

    let sourceEntryId: string | null = null;
    for (const locale of activeLocaleCodes) {
      const entryId = await upsertPublishedEntry({
        env,
        target,
        locale,
        sourceEntryId,
      });
      if (locale === "en") sourceEntryId = entryId;
      entries += 1;
    }
  }
  if (start + batchTargets.length >= targets.length) {
    await writeBootstrapState(env, contract);
  }

  return {
    status: "ready" as const,
    skipped: false,
    registryHash: contract.registryHash,
    collections,
    fields,
    entries,
    locales: activeLocaleCodes,
    cursor: start,
    processedTargets: batchTargets.length,
    totalTargets: targets.length,
    nextCursor:
      start + batchTargets.length < targets.length
        ? start + batchTargets.length
        : null,
  };
};
