import { activeLocales, type SupportedLocale } from "../data/localization-contract.ts";
import {
  veraEntries,
  veraPageTargets,
  type VeraContent,
  type VeraEntryDefinition,
} from "../data/vera/content.ts";

export type BuilderFieldType = "string" | "text";

export type BuilderSchemaField = {
  slug: string;
  type: BuilderFieldType;
  label: string;
  required?: boolean;
};

export type PageContent = Record<string, string>;

export type BuilderCollectionConfig = {
  slug: string;
  label: string;
  labelSingular: string;
  supports: Array<"drafts" | "revisions" | "preview">;
  fields: BuilderSchemaField[];
};

export type BuilderEntryConfig = {
  collectionConfig: BuilderCollectionConfig;
  editableFields: BuilderSchemaField[];
  defaultsByLocale: Record<SupportedLocale, PageContent>;
};

export type BuilderContentTarget = {
  collection: string;
  entry: string;
};

export type BuilderReleaseTarget = BuilderContentTarget & {
  fields: string[];
};

const seoFields = [
  "seo_title",
  "seo_description",
  "seo_canonical_path",
  "seo_robots",
  "og_title",
  "og_description",
  "og_image",
  "og_image_alt",
  "twitter_card",
  "twitter_title",
  "twitter_description",
  "twitter_image",
];

const longTextPatterns = [
  "_body",
  "_about",
  "_description",
  "_intro",
  "_paragraph",
  "_note",
  "_dek",
  "_bio",
  "_text",
  "_outro",
  "testimonial_",
  "disclaimer_",
  "summary_",
  "faq_",
  "footer_note",
  "seo_description",
  "og_description",
  "twitter_description",
];

const labelFor = (field: string) =>
  field
    .replace(/^seo_/, "SEO ")
    .replace(/^og_/, "Open Graph ")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .replace("Cta", "CTA");

const fieldType = (field: string): BuilderFieldType =>
  longTextPatterns.some((pattern) => field.includes(pattern)) ? "text" : "string";

const schemaFieldsFor = (defaults: PageContent): BuilderSchemaField[] =>
  Object.keys(defaults).map((field) => ({
    slug: field,
    type: fieldType(field),
    label: labelFor(field),
    required: ["title", "hero_title", "brand_name", "seo_title"].includes(field),
  }));

const withLocaleDefaults = (defaults: VeraContent) =>
  Object.fromEntries(
    activeLocales.map((locale) => [locale.code, { ...defaults }]),
  ) as Record<SupportedLocale, PageContent>;

const definitionsByCollection = new Map<string, VeraEntryDefinition[]>();
for (const definition of veraEntries) {
  const definitions = definitionsByCollection.get(definition.collection) ?? [];
  definitions.push(definition);
  definitionsByCollection.set(definition.collection, definitions);
}

const collectionConfigs = new Map<string, BuilderCollectionConfig>();
for (const [collection, definitions] of definitionsByCollection) {
  const defaults = Object.assign({}, ...definitions.map((definition) => definition.defaults));
  const label = definitions[0]?.label ?? labelFor(collection);
  collectionConfigs.set(collection, {
    slug: collection,
    label,
    labelSingular: label.replace(/s$/, ""),
    supports: ["drafts", "revisions", "preview"],
    fields: schemaFieldsFor(defaults),
  });
}

const entryMap = new Map<string, BuilderEntryConfig>();
for (const definition of veraEntries) {
  const collectionConfig = collectionConfigs.get(definition.collection);
  if (!collectionConfig) continue;
  entryMap.set(`${definition.collection}/${definition.entry}`, {
    collectionConfig,
    editableFields: schemaFieldsFor(definition.defaults),
    defaultsByLocale: withLocaleDefaults(definition.defaults),
  });
}

export const builderSeoFields = seoFields;
export const builderSeoFieldSet = new Set(seoFields);
export const chromeTarget = { collection: "site_chrome", entry: "main" } as const;

const releaseTargets: BuilderReleaseTarget[] = veraEntries.map((definition) => ({
  collection: definition.collection,
  entry: definition.entry,
  fields: Object.keys(definition.defaults),
}));

export const getBuilderEntryConfig = (collection: string, entry: string) =>
  entryMap.get(`${collection}/${entry}`);

export const getBuilderPageTargets = (page: string): BuilderContentTarget[] =>
  (veraPageTargets[page] ?? veraPageTargets.home).map((target) => ({ ...target }));

export const getBuilderReleaseTargets = (): BuilderReleaseTarget[] =>
  releaseTargets.map((target) => ({
    collection: target.collection,
    entry: target.entry,
    fields: [...target.fields],
  }));

const targetHasField = (target: BuilderContentTarget, field: string) =>
  getBuilderEntryConfig(target.collection, target.entry)?.editableFields.some(
    (schemaField) => schemaField.slug === field,
  ) ?? false;

export const getBuilderFieldTarget = (
  field: string,
  page?: string,
): BuilderContentTarget | undefined => {
  if (page === "chrome") {
    return targetHasField(chromeTarget, field) ? { ...chromeTarget } : undefined;
  }

  if (page) {
    return getBuilderPageTargets(page).find((target) => targetHasField(target, field));
  }

  for (const [key, config] of entryMap) {
    if (!config.editableFields.some((schemaField) => schemaField.slug === field)) continue;
    const [collection, entry] = key.split("/");
    return { collection, entry };
  }
  return undefined;
};

export const isBuilderEditableField = (field: string, page?: string) =>
  Boolean(getBuilderFieldTarget(field, page));

export const getBuilderFieldLabel = (field: string) => labelFor(field);
