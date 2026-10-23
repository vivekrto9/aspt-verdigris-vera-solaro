import { authoredSettingKeys, nativeDynamicCollections, nativePrivateEmailSampleKeys, nativeCollectionColumns } from "./template-contract.ts";
import { getBuilderReleaseTargets } from "../../../builder/registry.ts";

export type Cell = string | number | null;
export type Row = Record<string, Cell>;
export type Table = { name: string; columns: string[]; keys: string[]; where?: string; select?: string };
export type Domain = { kind: string; tables: Table[] };
export const quote = (name: string) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error("Invalid authored-state identifier.");
  return `"${name}"`;
};
const table = (name: string, columns: string, keys = "id", where?: string): Table => ({ name, columns: columns.split(" "), keys: keys.split(" "), where });
export const targets = getBuilderReleaseTargets();
export const collections = [...new Set([...targets.map((target) => target.collection), ...Object.keys(nativeDynamicCollections)])];
export const settingKeys = authoredSettingKeys;
const settingsWhere = `key IN (${settingKeys.map((key) => `'${key}'`).join(",")})`;
const assetWhere = "id IN (SELECT asset_id FROM ap_asset_records)";

// This is an explicit authored allowlist, not a database dump. User/account IDs,
// audit actors, operational rows, schema definitions and runtime configuration never enter it.
export const domains: Domain[] = [
  { kind: "content", tables: [
    ...collections.map((collection) => table(`ec_${collection}`, nativeCollectionColumns[collection].join(" "))),
    table("revisions", "id collection entry_id data created_at"),
    table("_emdash_seo", "collection content_id seo_title seo_description seo_image seo_canonical seo_no_index created_at updated_at", "collection content_id"),
    table("_emdash_bylines", "id slug display_name bio avatar_media_id website_url is_guest created_at updated_at"),
    table("_emdash_content_bylines", "id collection_slug content_id byline_id sort_order role_label created_at"),
  ] },
  { kind: "navigation", tables: [
    table("_emdash_menus", "id name label created_at updated_at locale translation_group"),
    table("_emdash_menu_items", "id menu_id parent_id sort_order type reference_collection reference_id custom_url label title_attr target css_classes created_at locale translation_group"),
    table("_emdash_taxonomy_defs", "id name label label_singular hierarchical collections created_at locale translation_group"),
    table("taxonomies", "id name slug label parent_id data locale translation_group"),
    table("content_taxonomies", "collection entry_id taxonomy_id", "collection entry_id taxonomy_id"),
  ] },
  { kind: "email", tables: [
    table("ap_email_templates", "key display_name event_type audience locale channel enabled subject preheader html_body text_body required_variables_json sample_payload_json updated_at", "key"),
    table("ap_email_events", "event_type audience email_type enabled schedule_json updated_at", "event_type"),
    table("ap_email_variable_mappings", "variable_key source_type source_path sample_value_json enabled updated_at", "variable_key"),
  ] },
  { kind: "assets", tables: [
    table("media", "id filename mime_type size width height alt caption storage_key content_hash created_at status blurhash dominant_color", "id", assetWhere),
    table("ap_asset_records", "asset_id current_revision_id display_name folder category origin visibility protected replaceable deleted_at created_at updated_at", "asset_id"),
    table("ap_asset_revisions", "revision_id asset_id revision_number storage_key content_hash etag file_name mime_type size_bytes width height duration_seconds status scan_status created_at", "revision_id"),
    table("ap_asset_aliases", "alias asset_id origin protected created_at updated_at", "alias"),
  ] },
  { kind: "business", tables: [
    table("ap_vera_services", "slug name duration_minutes price_cents currency active sort_order created_at updated_at price_inr_cents price_usd_cents", "slug"),
    table("ap_vera_calendly_mappings", "service_slug mode event_type_uri active updated_at", "service_slug mode"),
  ] },
  { kind: "settings", tables: [table("ap_business_settings", "key value_json updated_at", "key", settingsWhere)] },
];
export const tables = domains.flatMap((domain) => domain.tables);
export const select = (spec: Table) => spec.select ?? `SELECT ${spec.columns.map(quote).join(",")} FROM ${quote(spec.name)}${spec.where ? ` WHERE ${spec.where}` : ""}`;

// Sample payloads can contain mutable private values. Keep native definitions,
// required-variable metadata and mappings, but exclude these values from every
// snapshot, transactional equality guard and reconstructed checkpoint.
const privateSamplePaths = nativePrivateEmailSampleKeys.map((key) => `'$.${key}'`).join(",");
const emailTemplates = tables.find((spec) => spec.name === "ap_email_templates")!;
emailTemplates.select = `SELECT ${emailTemplates.columns.map((column) => column === "sample_payload_json"
  ? `json_remove(sample_payload_json,${privateSamplePaths}) AS sample_payload_json`
  : column === "draft_content_json"
    ? `CASE WHEN draft_content_json IS NULL THEN NULL ELSE json_remove(draft_content_json,'$.updatedBy',${nativePrivateEmailSampleKeys.map((key) => `'$.samplePayload.${key}'`).join(",")}) END AS draft_content_json`
    : quote(column)).join(",")} FROM ap_email_templates`;
const emailMappings = tables.find((spec) => spec.name === "ap_email_variable_mappings")!;
emailMappings.select = `SELECT ${emailMappings.columns.map((column) => column === "sample_value_json"
  ? `CASE WHEN variable_key IN (${nativePrivateEmailSampleKeys.map((key) => `'${key}'`).join(",")}) THEN NULL ELSE sample_value_json END AS sample_value_json`
  : quote(column)).join(",")} FROM ap_email_variable_mappings`;

// Native EmDash resolves an implicit author byline through users. Materialize that
// public authoring relationship without copying either user rows or account IDs.
// D1 permits at most five terms per compound SELECT. Nest groups so the full
// projection (including transactional equality guards) remains one statement.
const boundedUnionAll = (terms: string[]): string => {
  while (terms.length > 5) {
    const groups: string[] = [];
    for (let i = 0; i < terms.length; i += 5) {
      groups.push(`SELECT * FROM (${terms.slice(i, i + 5).join(" UNION ALL ")})`);
    }
    terms = groups;
  }
  return terms.join(" UNION ALL ");
};
const links = tables.find((spec) => spec.name === "_emdash_content_bylines")!;
links.select = boundedUnionAll([select(links), ...collections.map((collection) => `SELECT
  'workspace-byline:${collection}:' || c.id AS id, '${collection}' AS collection_slug,
  c.id AS content_id, b.id AS byline_id, 0 AS sort_order, NULL AS role_label,
  c.created_at AS created_at FROM ${quote(`ec_${collection}`)} c
  JOIN _emdash_bylines b ON b.user_id = c.author_id
  WHERE NOT EXISTS (SELECT 1 FROM _emdash_content_bylines l WHERE l.collection_slug='${collection}' AND l.content_id=c.id)` )]);

export const canonicalRows = (spec: Table, rows: Row[]) => rows.map((row) => Object.fromEntries(spec.columns.map((column) => [column, row[column] ?? null])) as Row)
  .sort((left, right) => JSON.stringify(spec.keys.map((key) => left[key])).localeCompare(JSON.stringify(spec.keys.map((key) => right[key])), "en"));

// Called within the same transaction as writes/CAS. An integer-overflow assertion
// aborts SQLite's batch if any stored column, missing row or extra row diverges.
export const jsonChunks = (spec: Table, rows: Row[]): string[] => {
  const chunks: string[] = [];
  let current: string[] = []; let size=2;
  for (const row of rows) {
    const encoded = JSON.stringify(spec.columns.map((column) => row[column]));
    const bytes = new TextEncoder().encode(encoded).byteLength;
    if (bytes>1_900_000) throw new Error("Workspace authored row exceeds the supported D1 checkpoint size.");
    if (size+bytes+1>1_900_000 && current.length) { chunks.push(`[${current.join(",")}]`); current=[]; size=2; }
    current.push(encoded); size+=bytes+1;
  }
  if (current.length) chunks.push(`[${current.join(",")}]`);
  return chunks;
};
export const equalityGuard = (spec: Table, rows: Row[]): Array<[string, unknown[]]> => {
  const columns = spec.columns.map(quote).join(",");
  const expected = spec.columns.map((_, index) => `json_extract(value, '$[${index}]')`).join(",");
  return [[`SELECT CASE WHEN (SELECT COUNT(*) FROM (${select(spec)})) != ? THEN abs(-9223372036854775808) ELSE 1 END`,[rows.length]],...jsonChunks(spec,rows).map((chunk): [string,unknown[]] => [`WITH actual AS (${select(spec)}), expected AS (SELECT ${expected} FROM json_each(?))
    SELECT CASE WHEN EXISTS (SELECT * FROM expected EXCEPT SELECT ${columns} FROM actual)
      THEN abs(-9223372036854775808) ELSE 1 END AS verified`,[chunk]])];
};
