import { nativeDynamicCollections, nativeEmailMappings, nativeEmailDisplayVariables, nativeGeneratedUrlMappings, nativePrivateEmailSampleKeys, nativeEmailSampleValueTypes, nativeStaticAssetPaths } from "./template-contract.ts";
import { activeLocales } from "../../../data/localization-contract.ts";
import { getBuilderEntryConfig } from "../../../builder/registry.ts";
import { collections, domains, settingKeys, tables, targets, type Row } from "./domains.ts";

export type Payload = { tables: Record<string, Row[]> };
export type BlobReference = { sha256: string; size: number; mimeType: string; canonicalObjectKey: string };
// Checkpoint verification hashes each object in a Worker. Keep individual reads
// aligned with the existing Project Asset write limit and cap retained history so
// a valid-looking checkpoint cannot turn verification into unbounded I/O.
export const workspaceCheckpointMaxBlobCount = 65536;
export const workspaceCheckpointMaxBlobBytes = 10 * 1024 * 1024;
export const workspaceCheckpointMaxAggregateBlobBytes = 128 * 1024 * 1024;
export const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
export const fail = (message: string): never => { throw new Error(`Workspace authored state: ${message}`); };
export const exactKeys = (value: unknown, keys: string[], label: string) => {
  if (!record(value) || Object.keys(value).sort().join("|") !== [...keys].sort().join("|")) fail(`${label} has invalid or unknown fields.`);
};
const locales = new Set(activeLocales.map((locale) => locale.code as string));
// At least as restrictive as the existing email-mapping owner. Normalize key
// punctuation so apiKey, api_key and API-KEY cannot bypass the settings/sample gate.
const sensitive = /password|secret|token|credential|private|payment|card|cvv|session|authorization|oauth|apikey|accesskey|signingkey|encryptionkey|clientkey|birthprofile|birthdetails/i;
const sensitiveKey = (key: string) => sensitive.test(key.replace(/[^a-z0-9]/gi,""));
// Keep runtime checkpoint screening self-contained while recognizing the same
// credential shapes rejected from the signed base seed. Boundaries avoid matching
// ordinary prose containing a credential-looking substring.
export const unsafeRawSecretValue = (value: string) => /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|\bBearer\s+[a-z0-9._-]+|[?&](?:token|access_token|secret|signature|password|key)=|https?:\/\/[^/\s]+:[^/\s]+@|\b(?:sk|rk)_(?:live|test)_[a-z0-9_-]+\b|\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[a-z0-9_-]+\b|\bxox[baprs][_-][a-z0-9_-]+\b|\beyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]+\b/i.test(value);
export const safeJson = (value: unknown, label: string, depth = 0): void => {
  if (depth > 32) fail(`${label} JSON is too deeply nested.`);
  if (Array.isArray(value)) { value.forEach((item) => safeJson(item, label, depth + 1)); return; }
  if (record(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (sensitiveKey(key)) fail(`${label} contains sensitive fields; remove private values before checkpointing.`);
      safeJson(child, label, depth + 1);
    }
  } else if (typeof value === "string" && unsafeRawSecretValue(value)) fail(`${label} contains an unsafe credential-bearing value.`);
};
export const validateBlobReferences = (blobs: BlobReference[]) => {
  if (blobs.length > workspaceCheckpointMaxBlobCount) fail("Canonical asset blob count exceeds the supported checkpoint limit.");
  let aggregateBytes = 0;
  for (const blob of blobs) {
    if (!/^[a-f0-9]{64}$/.test(blob.sha256) || !Number.isSafeInteger(blob.size) || blob.size < 0 || typeof blob.mimeType !== "string" || !blob.mimeType || blob.canonicalObjectKey !== `assets/sha256/${blob.sha256}`) fail("Canonical asset blob metadata is invalid.");
    if (blob.size > workspaceCheckpointMaxBlobBytes) fail("Canonical asset blob exceeds the supported checkpoint size limit.");
    aggregateBytes += blob.size;
    if (aggregateBytes > workspaceCheckpointMaxAggregateBlobBytes) fail("Canonical asset blobs exceed the supported checkpoint aggregate limit.");
  }
};
const json = (value: unknown, label: string, inspectSensitive = true) => {
  if (typeof value !== "string") fail(`${label} must be stored JSON.`);
  let parsed: unknown;
  try { parsed = JSON.parse(value as string); } catch { return fail(`${label} is invalid JSON.`); }
  if (inspectSensitive) safeJson(parsed, label);
  return parsed;
};
const unique = (rows: Row[], keys: string[], label: string) => {
  const seen = new Set<string>();
  for (const row of rows) {
    if (keys.some((key) => row[key] === null)) continue;
    const key = JSON.stringify(keys.map((column) => row[column]));
    if (seen.has(key)) fail(`${label} contains duplicate ${keys.join("/")}.`);
    seen.add(key);
  }
};
const portableText = (value: unknown) => {
  if (!Array.isArray(value) || value.some((block) => !record(block) || typeof block._type !== "string" || (block._type === "block" && (!Array.isArray(block.children) || block.children.some((span) => !record(span) || typeof span._type !== "string" || (span._type === "span" && typeof span.text !== "string")))))) fail("Portable Text must be an array of typed blocks and spans.");
};
const revisionFields = (collection: string) => {
  if (Object.hasOwn(nativeDynamicCollections, collection)) return nativeDynamicCollections[collection].fields;
  const target = targets.find((candidate) => candidate.collection === collection)!;
  const fields = getBuilderEntryConfig(target.collection, target.entry)!.collectionConfig.fields;
  return fields.some((field) => field.slug === "title") ? fields : [{ slug: "title", type: "string", required: true }, ...fields];
};
const validateRevision = (collection: string, data: unknown) => {
  if (!record(data)) return fail("Revision must contain an authored field object.");
  const fields = revisionFields(collection);
  for (const [key, value] of Object.entries(data)) {
    if (key === "_slug") {
      if (typeof value !== "string") fail("Revision slug must be text.");
      continue;
    }
    const field = fields.find((candidate) => candidate.slug === key);
    if (!field) return fail("Revision contains unknown authored fields.");
    // Native optional fields are nullish and revision snapshots may be partial.
    if (value === null && !field.required) continue;
    if (field.type === "string" || field.type === "text") {
      if (typeof value !== "string") fail("Revision text field has an invalid type.");
    } else if (field.type === "portableText") portableText(value);
    else if (field.type === "image") {
      if (typeof value !== "string" && (!record(value) || (typeof value.id !== "string" && typeof value.src !== "string"))) fail(`Revision image field ${collection}.${key} has invalid type ${typeof value}.`);
      if (record(value)) {
        for (const name of ["src", "alt", "provider", "previewUrl", "filename", "mimeType"]) if (name in value && typeof value[name] !== "string") fail("Revision image metadata has an invalid type.");
        for (const name of ["width", "height", "size"]) if (name in value && (typeof value[name] !== "number" || !Number.isFinite(value[name]))) fail("Revision image dimensions have an invalid type.");
        if ("meta" in value && !record(value.meta)) fail("Revision image metadata must be an object.");
      }
    }
    // Field names such as password_label are approved copy, not credential keys.
    safeJson(value, "revision authored value");
  }
};

export const validatePayloads = (payloads: Record<string, Payload>): BlobReference[] => {
  exactKeys(payloads, domains.map((domain) => domain.kind), "domains");
  const rows: Record<string, Row[]> = {};
  for (const domain of domains) {
    const payload = payloads[domain.kind];
    exactKeys(payload, ["tables"], `${domain.kind} payload`);
    exactKeys(payload.tables, domain.tables.map((spec) => spec.name), `${domain.kind} tables`);
    for (const spec of domain.tables) {
      const data = payload.tables[spec.name];
      if (!Array.isArray(data)) fail(`${spec.name} rows are invalid.`);
      rows[spec.name] = data;
      for (const row of data) {
        exactKeys(row, spec.columns, spec.name);
        for (const value of Object.values(row)) if (value !== null && typeof value !== "string" && (typeof value !== "number" || !Number.isFinite(value))) fail(`${spec.name} contains an invalid cell.`);
        for (const key of spec.keys) if (typeof row[key] !== "string" || !row[key]) fail(`${spec.name} identity is invalid.`);
        if ("locale" in row && !locales.has(String(row.locale))) fail(`${spec.name} locale is invalid.`);
        for (const key of ["enabled","protected","replaceable","seo_no_index","is_guest","hierarchical"]) if (key in row && ![0,1].includes(Number(row[key]))) fail(`${spec.name} boolean is invalid.`);
        if ("origin" in row && !["template","user","ai"].includes(String(row.origin))) fail("Asset origin is invalid.");
        if ("visibility" in row && !["customer","system"].includes(String(row.visibility))) fail("Asset visibility is invalid.");
      }
      unique(data, spec.keys, spec.name);
    }
  }
  const has = (table: string, key: string, value: unknown) => rows[table].some((row) => row[key] === value);
  const entry = (collection: unknown, id: unknown) => typeof collection === "string" && collections.includes(collection) && has(`ec_${collection}`, "id", id);
  const contentRef = (collection: unknown, id: unknown) => typeof collection === "string" && collections.includes(collection) && rows[`ec_${collection}`].some((row) => row.id === id || row.translation_group === id);
  const revisions = rows.revisions;
  for (const collection of collections) {
    const spec = tables.find((table) => table.name === `ec_${collection}`)!;
    unique(rows[spec.name], ["slug", "locale"], spec.name);
    for (const row of rows[spec.name]) {
      if (!["draft", "published", "scheduled"].includes(String(row.status))) fail(`${spec.name} status is invalid.`);
      if (!Number.isSafeInteger(row.version) || Number(row.version) < 1) fail(`${spec.name} revision version is invalid.`);
      if (!Object.hasOwn(nativeDynamicCollections, collection) && !targets.some((target) => target.collection === collection && target.entry === row.slug)) fail(`${spec.name} has an unknown Builder entry.`);
      for (const pointer of [row.live_revision_id, row.draft_revision_id]) if (pointer !== null && !revisions.some((revision) => revision.id === pointer && revision.collection === collection && revision.entry_id === row.id)) fail(`${spec.name} has an invalid revision pointer.`);
      if (row.primary_byline_id !== null && !has("_emdash_bylines", "id", row.primary_byline_id)) fail("Content references a missing byline.");
      if (Object.hasOwn(nativeDynamicCollections, collection) && row.content !== undefined && row.content !== null) portableText(json(row.content, "dynamic Portable Text"));
    }
  }
  for (const revision of revisions) {
    if (!entry(revision.collection, revision.entry_id)) fail("Unknown collection or missing revision entry.");
    const data = json(revision.data, "revision", false);
    validateRevision(String(revision.collection), data);
  }
  for (const row of rows._emdash_seo) if (!entry(row.collection,row.content_id)) fail("SEO references an unknown collection or entry.");
  unique(rows._emdash_bylines,["slug"],"bylines");
  unique(rows._emdash_content_bylines,["collection_slug","content_id","byline_id"],"byline links");
  for (const row of rows._emdash_content_bylines) if (!entry(row.collection_slug,row.content_id) || !has("_emdash_bylines","id",row.byline_id)) fail("Invalid content byline relationship.");
  unique(rows._emdash_menus,["name","locale"],"menus");
  for (const row of rows._emdash_menu_items) {
    if (!has("_emdash_menus","id",row.menu_id)) fail("Menu item references a missing menu.");
    if (row.parent_id !== null && !rows._emdash_menu_items.some((parent) => parent.id === row.parent_id && parent.menu_id === row.menu_id)) fail("Invalid menu parent.");
    if (row.reference_collection !== null && !contentRef(row.reference_collection,row.reference_id)) fail("Menu references an unknown content translation group.");
  }
  unique(rows._emdash_taxonomy_defs,["name","locale"],"taxonomy definitions");
  for (const row of rows._emdash_taxonomy_defs) {
    if (row.collections !== null) {
      const assigned = json(row.collections,"taxonomy collections");
      if (!Array.isArray(assigned) || assigned.some((collection) => !collections.includes(String(collection)))) fail("Taxonomy references an unknown collection.");
    }
  }
  unique(rows.taxonomies,["name","slug","locale"],"taxonomy terms");
  for (const row of rows.taxonomies) {
    if (!has("_emdash_taxonomy_defs","name",row.name)) fail("Taxonomy definition is missing.");
    if (row.parent_id !== null && !has("taxonomies","id",row.parent_id)) fail("Taxonomy parent is missing.");
    if (row.data !== null) json(row.data,"taxonomy data");
  }
  for (const row of rows.content_taxonomies) if (!entry(row.collection,row.entry_id) || !rows.taxonomies.some((term) => term.id === row.taxonomy_id || term.translation_group === row.taxonomy_id)) fail("Invalid content taxonomy relationship.");
  // Native identities are template keys; an event may have customer and business templates.
  // Native system templates explicitly use a formatted immutable display amount.
  const mappingKeys = new Set([...nativeEmailMappings.map(([key]) => key), ...nativeEmailDisplayVariables]);
  const sample = (value: unknown) => {
    if (!record(value)) return fail("Email sample must be an object.");
    if (Object.keys(value).some((key) => !mappingKeys.has(key) || nativePrivateEmailSampleKeys.includes(key))) fail("Email sample contains an unknown sample field.");
    for (const [key, child] of Object.entries(value)) {
      if (typeof child !== nativeEmailSampleValueTypes[key]) fail("Email sample has an invalid native display type.");
      safeJson(child,"email sample value");
    }
  };
  for (const row of rows.ap_email_templates) {
    for (const value of Object.values(row)) if (typeof value === "string" && unsafeRawSecretValue(value)) fail("Email template contains an unsafe credential-bearing value.");
    if (!has("ap_email_events","event_type",row.event_type) || row.channel !== "email") fail("Email template event/channel is invalid.");
    const required = json(row.required_variables_json,"email variables");
    if (!Array.isArray(required) || required.some((key) => !mappingKeys.has(String(key)))) fail("Email variable mapping is missing.");
    sample(json(row.sample_payload_json,"email sample",false));
    if ("draft_content_json" in row && row.draft_content_json !== null) {
      const draft = json(row.draft_content_json,"email draft");
      if (!record(draft)) fail("Email draft must be an object.");
      const draftFields=["key","displayName","eventType","audience","locale","channel","enabled","subject","preheader","htmlBody","textBody","requiredVariables","samplePayload","baseLiveHash","updatedAt"];
      if (record(draft) && Object.keys(draft).some((key) => !draftFields.includes(key))) fail("Email draft contains unknown fields.");
      if (record(draft)) {
        for (const field of ["key","displayName","eventType","audience","locale","channel","subject","preheader","htmlBody","textBody","updatedAt"]) if (field in draft && typeof draft[field] !== "string") fail("Email draft text field has an invalid type.");
        if ("enabled" in draft && typeof draft.enabled !== "boolean") fail("Email draft enabled must be boolean.");
        if ("baseLiveHash" in draft && draft.baseLiveHash !== null && typeof draft.baseLiveHash !== "string") fail("Email draft base hash must be text or null.");
        if ("key" in draft && draft.key !== row.key) fail("Email draft key does not match its template.");
        if ("channel" in draft && draft.channel !== "email") fail("Email draft channel is invalid.");
        if ("eventType" in draft && !has("ap_email_events","event_type",draft.eventType)) fail("Email draft references a missing event.");
        if ("requiredVariables" in draft && (!Array.isArray(draft.requiredVariables) || draft.requiredVariables.some((key) => typeof key !== "string" || !mappingKeys.has(key)))) fail("Email draft variable mapping is missing or invalid.");
      }
      if (record(draft) && draft.samplePayload !== undefined) sample(draft.samplePayload);
      if (record(draft) && draft.locale !== undefined && !locales.has(String(draft.locale))) fail("Email draft locale is invalid.");
    }
  }
  for (const row of rows.ap_email_events) {
    if (!["transactional","scheduled","reminder","follow_up","notification","marketing"].includes(String(row.email_type))) fail("Email event type is invalid.");
    json(row.schedule_json,"email schedule");
  }
  for (const row of rows.ap_email_variable_mappings) {
    if (!nativeEmailMappings.some(([key,type,path]) => row.variable_key === key && row.source_type === type && row.source_path === path)) fail("Unknown or unsafe email mapping tuple.");
    if (!["event_payload","business_setting","generated_url"].includes(String(row.source_type))) fail("Email mapping source type is invalid.");
    if (row.source_type === "business_setting" && !/^notificationSettings\.(businessName|senderName|supportEmail|supportFooter)$/.test(String(row.source_path))) fail("Unsafe email business-setting mapping.");
    if (row.source_type === "generated_url" && !nativeGeneratedUrlMappings.some((name) => row.source_path === `urls.${name}`)) fail("Unsafe generated URL mapping.");
    if (nativePrivateEmailSampleKeys.includes(String(row.variable_key)) && row.sample_value_json !== null) fail("Email mapping sample contains private values.");
    if (row.sample_value_json !== null && typeof json(row.sample_value_json,"email mapping sample") !== nativeEmailSampleValueTypes[String(row.variable_key)]) fail("Email mapping sample has an invalid native display type.");
  }
  for (const row of rows.ap_vera_services) {
    if (!row.slug || typeof row.slug !== "string" || !Number.isSafeInteger(row.duration_minutes) || Number(row.duration_minutes) <= 0 ||
        !Number.isSafeInteger(row.price_inr_cents) || Number(row.price_inr_cents) <= 0 ||
        !Number.isSafeInteger(row.price_usd_cents) || Number(row.price_usd_cents) <= 0 ||
        ![0,1].includes(Number(row.active))) fail("Vera service or independent price is invalid.");
  }
  for (const row of rows.ap_vera_calendly_mappings) {
    if (!has("ap_vera_services", "slug", row.service_slug) || !["call", "in_person"].includes(String(row.mode)) ||
        ![0,1].includes(Number(row.active)) ||
        (row.event_type_uri !== null && (typeof row.event_type_uri !== "string" || unsafeRawSecretValue(row.event_type_uri)))) fail("Vera scheduling mapping is invalid.");
  }
  for (const row of rows.ap_business_settings) {
    if (!settingKeys.includes(String(row.key))) fail("Unknown business setting.");
    json(row.value_json,"business setting");
  }
  const blobs = new Map<string,BlobReference>();
  for (const row of rows.ap_asset_revisions) {
    if (!has("ap_asset_records","asset_id",row.asset_id)) fail("Asset revision has no asset.");
    if (!Number.isSafeInteger(row.revision_number) || Number(row.revision_number)<1 || !Number.isSafeInteger(row.size_bytes) || Number(row.size_bytes)<0) fail("Asset revision/size is invalid.");
    if (!["ready","pending","rejected","deleted"].includes(String(row.status)) || !["clean","pending","infected","not_required"].includes(String(row.scan_status))) fail("Asset status is invalid.");
    const sha256 = String(row.content_hash).replace(/^sha256:/,"");
    if (!/^[a-f0-9]{64}$/.test(sha256)) fail("Asset blob digest is invalid.");
    const blob = { sha256, size:Number(row.size_bytes), mimeType:String(row.mime_type), canonicalObjectKey:`assets/sha256/${sha256}` };
    const previous = blobs.get(sha256);
    if (previous && (previous.size !== blob.size || previous.mimeType !== blob.mimeType)) fail("Conflicting asset blob metadata.");
    blobs.set(sha256,blob);
  }
  unique(rows.ap_asset_revisions,["asset_id","revision_number"],"asset revisions");
  // Preserve the native storage-key uniqueness contract; blob bytes deduplicate independently.
  unique(rows.ap_asset_revisions,["storage_key"],"asset revisions");
  for (const row of rows.ap_asset_records) if (!has("media","id",row.asset_id) || !rows.ap_asset_revisions.some((revision) => revision.revision_id === row.current_revision_id && revision.asset_id === row.asset_id)) fail("Asset current revision/media is missing.");
  for (const row of rows.ap_asset_aliases) if (!has("ap_asset_records","asset_id",row.asset_id) || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(String(row.alias))) fail("Asset alias is invalid.");
  const mediaRef = (value: unknown) => {
    if (value === null || value === "") return;
    if (typeof value === "string" && value.startsWith("{")) { mediaRef(json(value,"media"));return; }
    if (record(value) && typeof value.src === "string" && value.provider === undefined) {
      safeJson(value,"media reference");
      mediaRef(value.src);
      return;
    }
    if (record(value) && value.provider === "external" && typeof value.src === "string") {
      safeJson(value,"external media reference");
      mediaRef(value.src);
      return;
    }
    if (record(value) && value.provider === "local" && typeof value.id === "string") {
      if (!has("ap_asset_records","asset_id",value.id) || (record(value.meta) && value.meta.storageKey !== undefined && !rows.ap_asset_revisions.some((revision) => revision.asset_id === value.id && revision.storage_key === (value.meta as Record<string,unknown>).storageKey))) fail("Legacy EmDash media object: map it to a canonical Project Asset before checkpointing.");
      safeJson(value,"Project Asset media reference");return;
    }
    if (typeof value !== "string") return fail("Legacy EmDash media must be mapped to a canonical Project Asset.");
    if (nativeStaticAssetPaths.includes(value)) return;
    let reference = value;
    if (/^https?:\/\//i.test(value)) {
      let url: URL;
      try { url = new URL(value); } catch { return fail("Authored media URL is invalid."); }
      if (!decodeURIComponent(url.pathname).startsWith("/_emdash/") && !decodeURIComponent(url.pathname).startsWith("/_assets/")) {
        safeJson(value,"public media URL");
        return;
      }
      if (url.pathname.startsWith("/_assets/")) reference = `${url.pathname}${url.search}${url.hash}`;
    }
    if (has("ap_asset_records","asset_id",value)) return;
    const match = reference.match(/^\/_assets\/(assets|aliases|revisions)\/([^/?#]+)\/([^?#]+)(?:[?#].*)?$/);
    if (match) {
      const id=decodeURIComponent(match[2]);
      if (match[1] === "assets" && has("ap_asset_records","asset_id",id)) return;
      if (match[1] === "aliases" && has("ap_asset_aliases","alias",id)) return;
      if (match[1] === "revisions" && rows.ap_asset_revisions.some((revision) => revision.revision_id===id && revision.content_hash===decodeURIComponent(match[3].split("/")[0]))) return;
    }
    fail("Legacy EmDash media reference: map it to a canonical Project Asset before checkpointing.");
  };
  const scanMedia = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(scanMedia); return; }
    if (!record(value)) return;
    if (value.provider === "local" || value.provider === "external") { mediaRef(value);return; }
    for (const [key,child] of Object.entries(value)) {
      if (["featured_image","avatar_media_id","seo_image","og_image","twitter_image","mediaId","media_id"].includes(key)) mediaRef(child);
      else if (key === "asset" && record(child) && child._ref !== undefined) mediaRef(child._ref);
      else scanMedia(child);
    }
  };
  for (const collection of Object.keys(nativeDynamicCollections)) for (const row of rows[`ec_${collection}`]) { if (row.featured_image !== undefined) mediaRef(row.featured_image); if (row.content !== undefined && row.content !== null) scanMedia(json(row.content,"dynamic content")); }
  for (const row of revisions) scanMedia(json(row.data,"revision",false));
  for (const row of rows._emdash_bylines) mediaRef(row.avatar_media_id);
  for (const row of rows._emdash_seo) mediaRef(row.seo_image);
  for (const target of targets) for (const row of rows[`ec_${target.collection}`]) for (const field of target.fields) if (field === "og_image" || field === "twitter_image") mediaRef(row[field]);
  for (const collection of collections) for (const row of rows[`ec_${collection}`]) for (const value of Object.values(row)) if (typeof value === "string" && /^[\[{]/.test(value)) {
    let parsed:unknown;
    try { parsed=JSON.parse(value); } catch { continue; /* Ordinary Builder copy is not parsed as JSON. */ }
    scanMedia(parsed);
  }
  const references = [...blobs.values()].sort((a,b) => a.sha256.localeCompare(b.sha256));
  validateBlobReferences(references);
  return references;
};

// SQLite affinities alone silently coerce values. Validate against the running,
// trusted table schema before issuing any write, in addition to domain semantics.
export const validateCells = (payloads: Record<string,Payload>, schemas: Row[][]) => {
  for (let index=0;index<tables.length;index++) {
    const spec=tables[index];
    const schema=schemas[index];
    const expected=new Set([...spec.columns,"author_id","created_by","updated_by","user_id"]);
    if (schema.some((column) => !expected.has(String(column.name))) || spec.columns.some((name) => !schema.some((column) => column.name===name))) fail(`${spec.name} running schema has unknown or missing columns: extra=${schema.filter((column) => !expected.has(String(column.name))).map((column) => column.name)}, missing=${spec.columns.filter((name) => !schema.some((column) => column.name===name))}.`);
    const payload=payloads[domains.find((domain) => domain.tables.includes(spec))!.kind];
    for (const row of payload.tables[spec.name]) for (const column of schema) {
      const name=String(column.name);if (!spec.columns.includes(name)) continue;
      const value=row[name];
      if (value===null) { if(column.notnull===1 || column.pk) fail(`${spec.name}.${name} cannot be null.`);continue; }
      const type=String(column.type).toUpperCase();
      if (type.includes("INT") && !Number.isSafeInteger(value)) fail(`${spec.name}.${name} requires an integer.`);
      if (/REAL|FLOAT|DOUBLE/.test(type) && typeof value!=="number") fail(`${spec.name}.${name} requires a number.`);
      if (/TEXT|CHAR|CLOB/.test(type) && typeof value!=="string") fail(`${spec.name}.${name} requires text.`);
    }
  }
};
