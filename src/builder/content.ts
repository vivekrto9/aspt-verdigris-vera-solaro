import { isActiveLocale, type SupportedLocale } from "../data/localization-contract.ts";
import {
  getBuilderEntryConfig,
  getBuilderFieldLabel,
  builderSeoFieldSet,
  type BuilderCollectionConfig,
  type BuilderSchemaField,
  type PageContent,
} from "./registry.ts";

export type EmDashContentItem = Record<string, unknown> & {
  id: string;
  data?: Record<string, unknown>;
  liveData?: Record<string, unknown>;
  draftRevisionId?: string | null;
};

export type BuilderDraftChange = {
  field: string;
  label: string;
  group: "content" | "seo";
  state: "added" | "changed" | "cleared";
  publishedValue: string;
  draftValue: string;
};

export type EmDashRuntimeLike = {
  db?: unknown;
  handleContentGet?: (collection: string, entry: string, locale?: string) => Promise<unknown>;
  handleContentCreate?: (
    collection: string,
    input: {
      data: Record<string, unknown>;
      slug?: string;
      status?: string;
      locale?: string;
      translationOf?: string;
    },
  ) => Promise<unknown>;
  handleContentUpdate?: (
    collection: string,
    id: string,
    input: { data?: Record<string, unknown>; status?: string },
  ) => Promise<unknown>;
  handleContentPublish?: (collection: string, id: string, options?: { publishedAt?: string }) => Promise<unknown>;
};

export type BuilderPreviewState = {
  data: PageContent;
  hasSavedDraft: boolean;
};

export type BuilderValidationResult =
  | {
      ok: true;
      collection: string;
      entry: string;
      locale: SupportedLocale;
      changes: Record<string, string>;
      collectionConfig: BuilderCollectionConfig;
      editableFields: BuilderSchemaField[];
      defaults: PageContent;
    }
  | {
      ok: false;
      error: string;
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const resultData = (result: unknown): Record<string, unknown> | undefined => {
  if (!isRecord(result) || result.success !== true || !isRecord(result.data)) return undefined;
  return result.data;
};

export const resultError = (result: unknown) => {
  if (!isRecord(result) || result.success !== false || !isRecord(result.error)) return undefined;
  return {
    code: typeof result.error.code === "string" ? result.error.code : "UNKNOWN_ERROR",
    message: typeof result.error.message === "string" ? result.error.message : "Unknown EmDash error",
  };
};

export const contentItem = (result: unknown): EmDashContentItem | undefined => {
  const data = resultData(result);
  return isRecord(data?.item) && typeof data.item.id === "string"
    ? (data.item as EmDashContentItem)
    : undefined;
};

const textOnlyData = (value: Record<string, unknown> | undefined): PageContent => {
  const next: PageContent = {};
  for (const [key, fieldValue] of Object.entries(value ?? {})) {
    if (!key.startsWith("_") && typeof fieldValue === "string") {
      next[key] = fieldValue;
    }
  }
  return next;
};

export const pageContentData = textOnlyData;

const storageData = (content: PageContent): PageContent => ({ ...content });

export const encodeBuilderStorageData = storageData;
export const decodeBuilderStorageData = pageContentData;

export const ensureBuilderCollectionSchema = async (
  emdash: EmDashRuntimeLike,
  collectionConfig: BuilderCollectionConfig,
) => {
  if (!emdash.db) {
    throw new Error("EmDash schema registry is not configured.");
  }

  const { SchemaRegistry } = await import("emdash");
  const registry = new SchemaRegistry(emdash.db as ConstructorParameters<typeof SchemaRegistry>[0]);
  let collection = await registry.getCollectionWithFields(collectionConfig.slug);
  if (!collection) {
    await registry.createCollection({
      slug: collectionConfig.slug,
      label: collectionConfig.label,
      labelSingular: collectionConfig.labelSingular,
      supports: collectionConfig.supports,
    });
    collection = await registry.getCollectionWithFields(collectionConfig.slug);
  }

  const existingFields = new Set(collection?.fields?.map((field) => field.slug) ?? []);
  const failedFields: string[] = [];
  for (const field of collectionConfig.fields) {
    if (existingFields.has(field.slug)) continue;
    try {
      await registry.createField(collectionConfig.slug, field);
      existingFields.add(field.slug);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failedFields.push(`${field.slug}: ${message}`);
    }
  }

  if (failedFields.length > 0) {
    throw new Error(
      `Failed to sync EmDash schema for collection "${collectionConfig.slug}". Missing fields: ${failedFields.join("; ")}`,
    );
  }
};

export const validateBuilderChanges = (
  collection: unknown,
  entry: unknown,
  locale: unknown,
  changes: unknown,
): BuilderValidationResult | undefined => {
  if (typeof collection !== "string" || typeof entry !== "string" || !isRecord(changes)) {
    return undefined;
  }

  const resolvedLocale = typeof locale === "string" ? locale : "en";
  if (!isActiveLocale(resolvedLocale)) {
    return { ok: false, error: `Locale is not active for this generated site: ${resolvedLocale}` };
  }
  const config = getBuilderEntryConfig(collection, entry);
  if (!config) return undefined;

  const schemaFields = new Map(config.editableFields.map((field) => [field.slug, field]));
  const textChanges: Record<string, string> = {};
  for (const [field, value] of Object.entries(changes)) {
    const schemaField = schemaFields.get(field);
    if (!schemaField) {
      return { ok: false, error: `Field is not in the Builder schema: ${field}` };
    }
    if (schemaField.type !== "string" && schemaField.type !== "text") {
      return { ok: false, error: `Field is not a Builder text field: ${field}` };
    }
    if (typeof value !== "string") {
      return { ok: false, error: `Field value must be text: ${field}` };
    }
    if (schemaField.required && value.trim().length === 0) {
      return { ok: false, error: `Field value is required: ${field}` };
    }
    textChanges[field] = value;
  }

  return {
    ok: true,
    collection,
    entry,
    locale: resolvedLocale,
    changes: textChanges,
    collectionConfig: config.collectionConfig,
    editableFields: config.editableFields,
    defaults: config.defaultsByLocale[resolvedLocale],
  };
};

export const mergeBuilderChanges = (
  defaults: PageContent,
  existing: Record<string, unknown> | undefined,
  changes: Record<string, string>,
  schemaFields: Iterable<BuilderSchemaField>,
): PageContent => {
  const base = { ...defaults, ...pageContentData(existing) };
  const next: PageContent = {};

  for (const field of schemaFields) {
    const value = changes[field.slug] ?? base[field.slug];
    next[field.slug] = typeof value === "string" ? value : "";
  }

  return next;
};

const comparableText = (value: unknown) => (typeof value === "string" ? value : "");

export const buildDraftChanges = (
  item: EmDashContentItem | undefined,
  schemaFields: Iterable<BuilderSchemaField>,
): BuilderDraftChange[] => {
  if (!item?.draftRevisionId) return [];

  const draftData = pageContentData(item.data);
  const liveData = pageContentData(item.liveData);
  const changes: BuilderDraftChange[] = [];

  for (const field of schemaFields) {
    const draftValue = comparableText(draftData[field.slug]);
    const publishedValue = comparableText(liveData[field.slug]);
    if (draftValue === publishedValue) continue;

    changes.push({
      field: field.slug,
      label: getBuilderFieldLabel(field.slug),
      group: builderSeoFieldSet.has(field.slug) ? "seo" : "content",
      state: publishedValue.length === 0 ? "added" : draftValue.length === 0 ? "cleared" : "changed",
      publishedValue,
      draftValue,
    });
  }

  return changes;
};

const localeCreateInput = (
  entry: string,
  locale: SupportedLocale,
  defaults: PageContent,
  translationOf?: string,
) => ({
  slug: entry,
  status: "draft",
  locale,
  translationOf,
  data: storageData(defaults),
});

export const ensureSourceEntryForTranslation = async (
  collection: string,
  entry: string,
  emdash: EmDashRuntimeLike,
): Promise<EmDashContentItem | undefined> => {
  const existingSource = contentItem(await emdash.handleContentGet?.(collection, entry, "en"));
  if (existingSource) return existingSource;

  const sourceDefaults = getBuilderEntryConfig(collection, entry)?.defaultsByLocale.en;
  if (!sourceDefaults) return undefined;
  const createdSource = await emdash.handleContentCreate?.(
    collection,
    localeCreateInput(entry, "en", sourceDefaults),
  );
  return contentItem(createdSource);
};

export const initializeBuilderDraftFromSeedDefaults = async (
  collection: string,
  entry: string,
  locale: SupportedLocale,
  emdash?: EmDashRuntimeLike,
): Promise<BuilderPreviewState> => {
  const config = getBuilderEntryConfig(collection, entry);
  const defaults = config?.defaultsByLocale[locale] ?? {};

  if (!config || !emdash?.handleContentGet) {
    return { data: defaults, hasSavedDraft: false };
  }

  const item = contentItem(await emdash.handleContentGet(collection, entry, locale));

  if (!item) return { data: defaults, hasSavedDraft: false };

  return {
    data: { ...defaults, ...pageContentData(item.data) },
    hasSavedDraft: Boolean(item.draftRevisionId),
  };
};

const readPublishedBuilderContent = async (
  collection: string,
  entry: string,
  locale: SupportedLocale,
  defaults: PageContent,
): Promise<BuilderPreviewState | undefined> => {
  const { getEmDashEntry } = await import("emdash");
  const { entry: emdashEntry } = await getEmDashEntry<string, PageContent>(collection, entry, { locale });
  if (!emdashEntry?.data) return undefined;

  return {
    data: { ...defaults, ...pageContentData(emdashEntry.data) },
    hasSavedDraft: false,
  };
};

export const resolveBuilderPageContent = async ({
  collection = "pages",
  entry = "home",
  locale,
  builderEnabled,
  emdash,
}: {
  collection?: string;
  entry?: string;
  locale: SupportedLocale;
  builderEnabled: boolean;
  emdash?: EmDashRuntimeLike;
}): Promise<BuilderPreviewState> => {
  const config = getBuilderEntryConfig(collection, entry);
  const defaults = config?.defaultsByLocale[locale] ?? {};

  if (builderEnabled) {
    if (emdash?.handleContentGet) {
      try {
        return await initializeBuilderDraftFromSeedDefaults(collection, entry, locale, emdash);
      } catch {
        // Keep authenticated edit preview read-only even when the full EmDash
        // preview runtime cannot load draft content for this request.
      }
    }

    try {
      const published = await readPublishedBuilderContent(collection, entry, locale, defaults);
      if (published) return published;
    } catch {
      // EmDash content can be absent before first template setup; keep source fallback.
    }

    return { data: defaults, hasSavedDraft: false };
  }

  try {
    const published = await readPublishedBuilderContent(collection, entry, locale, defaults);
    if (published) return published;
  } catch {
    // EmDash content can be absent before first template setup; keep source fallback.
  }

  return { data: defaults, hasSavedDraft: false };
};
