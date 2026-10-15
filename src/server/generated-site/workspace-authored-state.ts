import type { RuntimeEnv } from "../aggregator/runtime.ts";
import { assertWorkspaceAuthoredStateIdentity, canonicalTemplateKey, workspaceAuthoredStateSchemaVersion } from "./template-runtime-identity.ts";
import { canonicalRows, collections, domains, equalityGuard, jsonChunks, quote, select, tables, type Row } from "./workspace-state/domains.ts";
import { exactKeys, fail, record, validateCells, validatePayloads, type BlobReference, type Payload } from "./workspace-state/validation.ts";
import { publicationProof } from "./workspace-state/publication-proof.ts";
export { workspaceCheckpointMaxAggregateBlobBytes, workspaceCheckpointMaxBlobBytes, workspaceCheckpointMaxBlobCount } from "./workspace-state/validation.ts";

export type AuthoredStateEnvelopeV1 = {
  schemaVersion: "workspace-authored-state.v1";
  canonicalTemplateKey: typeof canonicalTemplateKey;
  templateCommitSha: string;
  migrationDigest: string;
  authoredRevision: number;
  exportedAt: string;
  domains: Array<{ kind: string; version: number; digest: string; payload: unknown }>;
  blobs: BlobReference[];
  envelopeDigest: string;
};
export type WorkspaceIdentity = { templateCommitSha: string; migrationDigest: string };
export type WorkspaceOptions = {
  env: RuntimeEnv;
  identity: WorkspaceIdentity;
  /** Trusted canonical blob store; implementations must verify bytes, digest and size. */
  blobs?: { verify(blob: BlobReference): Promise<boolean> };
};
type Statement = { bind(...values: unknown[]): Statement };
type Database = { prepare(sql: string): Statement; batch(statements: Statement[]): Promise<Array<{ results?: Row[] }>> };
type State = { authored_revision: number; content_digest: string; imported_envelope_digest: string | null };
type Snapshot = { payloads: Record<string, Payload>; state: State; registered: Row[]; schemas: Row[][] };
type Sql = [string, unknown[]];
export const workspaceCheckpointMaxBytes = 8*1024*1024;
const assertCapacity = (value: unknown) => {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength>workspaceCheckpointMaxBytes) fail("Checkpoint exceeds the supported 8 MiB capacity limit; retain the workspace.");
};

export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
};
export const workspaceDigest = async (value: unknown): Promise<string> => {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))].map((byte) => byte.toString(16).padStart(2,"0")).join("");
};
const dbFor = (env: RuntimeEnv): Database => {
  const db = env.DB as unknown as Database | undefined;
  if (!db || typeof db.batch !== "function") return fail("an atomic D1 batch database is required; sequential fallback is forbidden.");
  return db;
};
const batch = (db: Database, statements: Sql[]) => {
  if (statements.length>700) fail("Checkpoint exceeds the atomic D1 query budget; retain the workspace.");
  for (const [sql,values] of statements) {
    if (new TextEncoder().encode(sql).byteLength>100_000 || values.length>100 || values.some((value) => typeof value==="string" && new TextEncoder().encode(value).byteLength>2_000_000)) fail("Checkpoint exceeds the atomic D1 statement limits; retain the workspace.");
  }
  return db.batch(statements.map(([sql,values]) => db.prepare(sql).bind(...values)));
};
const assertIdentity = (identity: WorkspaceIdentity) => {
  assertWorkspaceAuthoredStateIdentity({schemaVersion:workspaceAuthoredStateSchemaVersion,canonicalTemplateKey,...identity},identity.templateCommitSha);
  if (!/^[a-f0-9]{64}$/.test(identity.migrationDigest)) fail("trusted migration digest is invalid.");
};
const read = async (db: Database): Promise<Snapshot> => {
  // A single transaction observes every domain and its metadata at one instant.
  const results = await batch(db,[...tables.map((spec): Sql => [select(spec),[]]),["SELECT authored_revision,content_digest,imported_envelope_digest FROM ap_workspace_authored_state WHERE id=1",[]],["SELECT slug FROM _emdash_collections ORDER BY slug",[]],...tables.map((spec): Sql => [`PRAGMA table_info(${quote(spec.name)})`,[]])]);
  const registered = results[tables.length+1].results ?? [];
  if (registered.some((row) => !collections.includes(String(row.slug)))) fail("Unknown authored collection; define an explicit workspace adapter before checkpointing.");
  const state = results[tables.length].results?.[0] as State | undefined;
  if (!state) fail("checkpoint metadata migration is missing.");
  const payloads = Object.fromEntries(domains.map((domain) => [domain.kind,{tables:Object.fromEntries(domain.tables.map((spec) => [spec.name,canonicalRows(spec,results[tables.indexOf(spec)].results ?? [])]))}])) as Record<string,Payload>;
  const schemas=results.slice(tables.length+2).map((result) => result.results ?? []);
  validateCells(payloads,schemas);
  return {payloads,state:state!,registered,schemas};
};
const stateGuard = (state: State): Sql => ["SELECT CASE WHEN EXISTS (SELECT 1 FROM ap_workspace_authored_state WHERE id=1 AND authored_revision=? AND content_digest=? AND imported_envelope_digest IS ?) THEN 1 ELSE abs(-9223372036854775808) END",[state.authored_revision,state.content_digest,state.imported_envelope_digest]];
const guards = (snapshot: Snapshot): Sql[] => [stateGuard(snapshot.state),...tables.flatMap((spec) => equalityGuard(spec,snapshot.payloads[domains.find((domain) => domain.tables.includes(spec))!.kind].tables[spec.name])),...equalityGuard({name:"_emdash_collections",columns:["slug"],keys:["slug"]},snapshot.registered)];
const verifiedBlobs = async (options: WorkspaceOptions, refs: BlobReference[]) => {
  for (const ref of refs) if (!options.blobs || !await options.blobs.verify(ref)) fail("Canonical asset blob is missing or corrupt; persist and verify it before checkpointing.");
};
const describe = async (identity: WorkspaceIdentity, payloads: Record<string,Payload>, blobs: BlobReference[]) => {
  const entries = await Promise.all(domains.map(async (domain) => ({kind:domain.kind,version:1,digest:await workspaceDigest(payloads[domain.kind]),payload:payloads[domain.kind]})));
  const contentDigest = await workspaceDigest({schemaVersion:workspaceAuthoredStateSchemaVersion,canonicalTemplateKey,...identity,domains:entries,blobs});
  return {entries,contentDigest};
};
const fingerprint = (contentDigest: string, authoredRevision: number) => workspaceDigest({contentDigest,authoredRevision});

const observe = async (options: WorkspaceOptions) => {
  assertIdentity(options.identity);
  const db = dbFor(options.env);
  for (let attempt=0;attempt<3;attempt++) {
    const snapshot = await read(db);
    const blobs = validatePayloads(snapshot.payloads);
    await verifiedBlobs(options,blobs);
    const described = await describe(options.identity,snapshot.payloads,blobs);
    const changed = described.contentDigest !== snapshot.state.content_digest;
    const authoredRevision = snapshot.state.authored_revision + (changed && snapshot.state.content_digest ? 1 : 0);
    if (changed) {
      try {
        await batch(db,[...guards(snapshot),["UPDATE ap_workspace_authored_state SET authored_revision=?,content_digest=? WHERE id=1",[authoredRevision,described.contentDigest]]]);
      } catch (error) {
        // Retry only an observation race, never conceal malformed state or I/O errors.
        if (error instanceof Error && /integer overflow/.test(error.message) && attempt<2) continue;
        throw error;
      }
    }
    return {...described,blobs,authoredRevision,fingerprint:await fingerprint(described.contentDigest,authoredRevision)};
  }
  return fail("concurrent authoring changed during observation; retry after freezing writes.");
};
export const inspectWorkspaceAuthoredState = async (options: WorkspaceOptions) => {
  const observed = await observe(options);
  return {schemaVersion:workspaceAuthoredStateSchemaVersion,canonicalTemplateKey,...options.identity,authoredRevision:observed.authoredRevision,fingerprint:observed.fingerprint};
};
export const exportWorkspaceAuthoredState = async (options: WorkspaceOptions): Promise<AuthoredStateEnvelopeV1> => {
  const observed = await observe(options);
  return envelopeFor(options, observed);
};
const envelopeFor = async (options: WorkspaceOptions, observed: Awaited<ReturnType<typeof observe>>): Promise<AuthoredStateEnvelopeV1> => {
  const envelope = {schemaVersion:workspaceAuthoredStateSchemaVersion,canonicalTemplateKey,...options.identity,authoredRevision:observed.authoredRevision,exportedAt:new Date().toISOString(),domains:observed.entries,blobs:observed.blobs};
  const result={...envelope,envelopeDigest:await workspaceDigest(envelope)};
  assertCapacity(result);
  return result;
};

export const exportWorkspaceCheckpointProof = async (options: WorkspaceOptions) => {
  const observed = await observe(options);
  const envelope = await envelopeFor(options, observed);
  return { envelope, proof: await publicationProof(envelope, observed.fingerprint, workspaceDigest) };
};

const validateEnvelope = async (options: WorkspaceOptions, value: unknown) => {
  assertIdentity(options.identity);
  assertCapacity(value);
  exactKeys(value,["schemaVersion","canonicalTemplateKey","templateCommitSha","migrationDigest","authoredRevision","exportedAt","domains","blobs","envelopeDigest"],"envelope");
  const envelope = value as AuthoredStateEnvelopeV1;
  assertWorkspaceAuthoredStateIdentity(envelope,options.identity.templateCommitSha);
  if (envelope.migrationDigest !== options.identity.migrationDigest) fail("migration schema digest mismatch.");
  if (!Number.isSafeInteger(envelope.authoredRevision) || envelope.authoredRevision<0) fail("authored revision is invalid.");
  if (typeof envelope.exportedAt !== "string" || !Number.isFinite(Date.parse(envelope.exportedAt))) fail("export timestamp is invalid.");
  if (!Array.isArray(envelope.domains) || envelope.domains.length !== domains.length || !Array.isArray(envelope.blobs)) fail("domains/blobs are invalid.");
  const {envelopeDigest,...unsigned} = envelope;
  if (await workspaceDigest(unsigned) !== envelopeDigest) fail("envelope digest mismatch.");
  const payloads: Record<string,Payload> = {};
  for (const domain of envelope.domains) {
    exactKeys(domain,["kind","version","digest","payload"],"domain");
    if (!domains.some((spec) => spec.kind === domain.kind) || domain.kind in payloads || domain.version !== 1) fail("unknown or duplicate domain/schema.");
    if (await workspaceDigest(domain.payload) !== domain.digest) fail("domain digest mismatch.");
    payloads[domain.kind] = domain.payload as Payload;
  }
  const refs = validatePayloads(payloads);
  for (const ref of envelope.blobs) exactKeys(ref,["sha256","size","mimeType","canonicalObjectKey"],"blob");
  if (canonicalJson(refs) !== canonicalJson(envelope.blobs)) fail("Missing, duplicate or mismatched canonical blob references.");
  await verifiedBlobs(options,refs);
  // Requiring canonical ordering removes alternate envelopes for the same rows.
  for (const domain of domains) for (const spec of domain.tables) if (canonicalJson(payloads[domain.kind].tables[spec.name]) !== canonicalJson(canonicalRows(spec,payloads[domain.kind].tables[spec.name]))) fail("Authored rows must use canonical ordering.");
  return {envelope,payloads,refs,...await describe(options.identity,payloads,refs)};
};

export const importWorkspaceAuthoredState = async (options: WorkspaceOptions & { envelope: unknown }) => {
  // Nothing below this line can write until the WHOLE input and every blob pass.
  const validated = await validateEnvelope(options,options.envelope);
  const db = dbFor(options.env);
  const before = await read(db);
  validateCells(validated.payloads,before.schemas);
  const currentRefs = validatePayloads(before.payloads);
  const current = await describe(options.identity,before.payloads,currentRefs);
  const expectedFingerprint = await fingerprint(validated.contentDigest,validated.envelope.authoredRevision);
  if (before.state.imported_envelope_digest === validated.envelope.envelopeDigest && current.contentDigest === validated.contentDigest && before.state.authored_revision === validated.envelope.authoredRevision) return {fingerprint:expectedFingerprint,authoredRevision:validated.envelope.authoredRevision,idempotent:true};
  if (before.state.imported_envelope_digest !== null) fail("Workspace already imported or changed after restoration; use a freshly reconstructed generation, never overwrite newer edits.");
  const statements: Sql[] = [...guards(before),["PRAGMA defer_foreign_keys=ON",[]]];
  // Dependency order matters even with deferred checks (RESTRICT and CASCADE are immediate).
  const deletionOrder = ["_emdash_content_bylines","_emdash_seo","revisions","content_taxonomies","_emdash_menu_items","_emdash_menus","taxonomies","_emdash_taxonomy_defs",...collections.map((name) => `ec_${name}`),"_emdash_bylines","ap_asset_aliases","ap_asset_revisions","ap_asset_records","media","ap_email_templates","ap_email_events","ap_email_variable_mappings","ap_business_settings","ap_vera_calendly_mappings","ap_vera_services"];
  for (const name of deletionOrder) {
    const spec = tables.find((candidate) => candidate.name === name)!;
    // The media subquery must retain the pre-delete canonical IDs.
    const where = name === "media" ? `id IN (SELECT json_extract(value,'$.id') FROM json_each(?))` : spec.where;
    statements.push([`DELETE FROM ${quote(name)}${where ? ` WHERE ${where}` : ""}`,name === "media" ? [JSON.stringify(before.payloads.assets.tables.media)] : []]);
  }
  const insertionOrder = ["media","ap_asset_records","ap_asset_revisions","ap_asset_aliases","_emdash_bylines",...collections.map((name) => `ec_${name}`),"revisions","_emdash_seo","_emdash_content_bylines","_emdash_taxonomy_defs","taxonomies","content_taxonomies","_emdash_menus","_emdash_menu_items","ap_email_events","ap_email_variable_mappings","ap_email_templates","ap_business_settings","ap_vera_services","ap_vera_calendly_mappings"];
  for (const name of insertionOrder) {
    const spec = tables.find((candidate) => candidate.name === name)!;
    const domain = domains.find((candidate) => candidate.tables.includes(spec))!;
    for (const chunk of jsonChunks(spec,validated.payloads[domain.kind].tables[name])) statements.push([`INSERT INTO ${quote(name)} (${spec.columns.map(quote).join(",")}) SELECT ${spec.columns.map((_,index) => `json_extract(value,'$[${index}]')`).join(",")} FROM json_each(?)`,[chunk]]);
  }
  for (const spec of tables) statements.push(...equalityGuard(spec,validated.payloads[domains.find((domain) => domain.tables.includes(spec))!.kind].tables[spec.name]));
  statements.push(["UPDATE ap_workspace_authored_state SET authored_revision=?,content_digest=?,imported_envelope_digest=? WHERE id=1",[validated.envelope.authoredRevision,validated.contentDigest,validated.envelope.envelopeDigest]]);
  await batch(db,statements); // Exactly one SQLite transaction; never chunk or sequentially fall back.
  const inspected = await inspectWorkspaceAuthoredState(options);
  if (inspected.fingerprint !== expectedFingerprint) fail("Imported fingerprint changed before readiness; keep the workspace read-only.");
  return {fingerprint:expectedFingerprint,authoredRevision:validated.envelope.authoredRevision,idempotent:false};
};
