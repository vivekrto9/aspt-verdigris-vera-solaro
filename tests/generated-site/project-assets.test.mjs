import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

const createD1 = () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE media (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER,
    width INTEGER,
    height INTEGER,
    alt TEXT,
    caption TEXT,
    storage_key TEXT NOT NULL,
    content_hash TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    author_id TEXT,
    status TEXT DEFAULT 'ready' NOT NULL,
    blurhash TEXT,
    dominant_color TEXT
  );`);
  sqlite.exec(read("migrations/0004_project_assets_v1.sql"));
  return {
    sqlite,
    prepare(sql) {
      const prepared = sqlite.prepare(sql);
      let values = [];
      return {
        bind(...nextValues) {
          values = nextValues;
          return this;
        },
        async first() {
          return prepared.get(...values) ?? null;
        },
        async all() {
          return { results: prepared.all(...values) };
        },
        async run() {
          return prepared.run(...values);
        },
      };
    },
  };
};

const createR2 = () => {
  const objects = new Map();
  return {
    objects,
    async get(key) {
      const object = objects.get(key);
      if (!object) return null;
      return {
        body: object.body,
        httpEtag: object.etag,
        writeHttpMetadata(headers) {
          headers.set("content-type", object.contentType);
        },
      };
    },
  };
};

test("project asset migration models identities, immutable revisions, aliases, events, and release state without slots", () => {
  const migration = read("migrations/0004_project_assets_v1.sql");

  assert.match(migration, /CREATE TABLE IF NOT EXISTS ap_asset_records/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS ap_asset_revisions/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS ap_asset_aliases/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS ap_asset_events/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS ap_asset_release_state/);
  assert.doesNotMatch(migration, /asset_slots|slot_key/i);
});

test("asset URLs distinguish opaque identities, optional aliases, and immutable revisions", async () => {
  const { assetUrl, immutableAssetUrl } = await import(
    "../../src/server/generated-site/project-assets.ts"
  );

  assert.equal(
    assetUrl({ assetId: "asset_01JABC" }, "brand mark.svg"),
    "/_assets/assets/asset_01JABC/brand%20mark.svg",
  );
  assert.equal(
    assetUrl({ alias: "brand-logo" }, "brand mark.svg"),
    "/_assets/aliases/brand-logo/brand%20mark.svg",
  );
  assert.equal(
    immutableAssetUrl({
      revisionId: "arev_01JDEF",
      contentHash: "sha256:abc123",
      fileName: "brand mark.svg",
    }),
    "/_assets/revisions/arev_01JDEF/sha256%3Aabc123/brand%20mark.svg",
  );
});

test("asset snapshot includes every active asset and is deterministic independent of query order", async () => {
  const { buildAssetSnapshotFromRows } = await import(
    "../../src/server/generated-site/project-assets.ts"
  );
  const rows = [
    {
      asset_id: "asset_b",
      revision_id: "arev_b2",
      revision_number: 2,
      storage_key: "assets/asset_b/revisions/arev_b2/b.webp",
      content_hash: "sha256:b",
      etag: "etag-b",
      file_name: "b.webp",
      mime_type: "image/webp",
      size_bytes: 20,
      display_name: "B",
      visibility: "customer",
      aliases: "[]",
    },
    {
      asset_id: "asset_a",
      revision_id: "arev_a1",
      revision_number: 1,
      storage_key: "assets/asset_a/revisions/arev_a1/a.png",
      content_hash: "sha256:a",
      etag: "etag-a",
      file_name: "a.png",
      mime_type: "image/png",
      size_bytes: 10,
      display_name: "A",
      visibility: "customer",
      aliases: JSON.stringify(["brand-logo"]),
    },
  ];

  const first = await buildAssetSnapshotFromRows({
    templateKey: "aspt-verdigris-vera-solaro",
    environment: "preview",
    assetRevision: 7,
    rows,
  });
  const second = await buildAssetSnapshotFromRows({
    templateKey: "aspt-verdigris-vera-solaro",
    environment: "preview",
    assetRevision: 7,
    rows: [...rows].reverse(),
  });

  assert.equal(first.assets.length, 2);
  assert.deepEqual(first.assets.map((asset) => asset.assetId), ["asset_a", "asset_b"]);
  assert.equal(first.assetHash, second.assetHash);
  assert.equal(first.snapshotHash, second.snapshotHash);
  assert.equal(first.assets[0].aliases[0], "brand-logo");
});

test("registering a replacement preserves asset identity, advances revision state, and keeps the alias", async () => {
  const { registerAssetRevision, readAssetStatus } = await import(
    "../../src/server/generated-site/project-assets.ts"
  );
  const DB = createD1();
  const env = { ASTROPAGES_SITE_ENVIRONMENT: "preview", DB };

  await registerAssetRevision({
    env,
    assetId: "asset_logo",
    revisionId: "arev_logo_1",
    storageKey: "assets/asset_logo/revisions/arev_logo_1/logo.png",
    contentHash: "sha256:first",
    etag: "etag-first",
    fileName: "logo.png",
    mimeType: "image/png",
    sizeBytes: 100,
    displayName: "Logo",
    origin: "template",
    aliases: ["brand-logo"],
    protected: true,
    replaceable: true,
    actorType: "system",
  });
  await registerAssetRevision({
    env,
    assetId: "asset_logo",
    revisionId: "arev_logo_2",
    expectedRevisionId: "arev_logo_1",
    storageKey: "assets/asset_logo/revisions/arev_logo_2/logo.png",
    contentHash: "sha256:second",
    etag: "etag-second",
    fileName: "logo.png",
    mimeType: "image/png",
    sizeBytes: 120,
    displayName: "Logo",
    origin: "user",
    aliases: ["brand-logo"],
    protected: true,
    replaceable: true,
    actorType: "user",
    actorId: "user_1",
  });

  const current = DB.sqlite.prepare(
    "SELECT asset_id, current_revision_id FROM ap_asset_records WHERE asset_id = ?",
  ).get("asset_logo");
  const media = DB.sqlite.prepare(
    "SELECT id, storage_key, content_hash FROM media WHERE id = ?",
  ).get("asset_logo");
  const revisions = DB.sqlite.prepare(
    "SELECT revision_id, revision_number FROM ap_asset_revisions WHERE asset_id = ? ORDER BY revision_number",
  ).all("asset_logo");
  const status = await readAssetStatus(env);

  assert.equal(current.asset_id, "asset_logo");
  assert.equal(current.current_revision_id, "arev_logo_2");
  assert.equal(media.id, "asset_logo");
  assert.equal(media.storage_key, "assets/asset_logo/revisions/arev_logo_2/logo.png");
  assert.deepEqual(revisions.map((revision) => ({ ...revision })), [
    { revision_id: "arev_logo_1", revision_number: 1 },
    { revision_id: "arev_logo_2", revision_number: 2 },
  ]);
  assert.equal(status.assetRevision, 2);
  assert.equal(status.activeAssetCount, 1);
});

test("replacement rejects a stale expected revision", async () => {
  const { registerAssetRevision } = await import(
    "../../src/server/generated-site/project-assets.ts"
  );
  const env = { ASTROPAGES_SITE_ENVIRONMENT: "preview", DB: createD1() };
  const common = {
    env,
    assetId: "asset_photo",
    storageKey: "assets/asset_photo/revisions/arev_1/photo.webp",
    contentHash: "sha256:one",
    etag: "etag-one",
    fileName: "photo.webp",
    mimeType: "image/webp",
    sizeBytes: 50,
    displayName: "Photo",
    origin: "user",
    aliases: [],
    protected: false,
    replaceable: true,
    actorType: "user",
  };
  await registerAssetRevision({ ...common, revisionId: "arev_1" });

  await assert.rejects(
    registerAssetRevision({
      ...common,
      revisionId: "arev_2",
      expectedRevisionId: "arev_stale",
      storageKey: "assets/asset_photo/revisions/arev_2/photo.webp",
    }),
    /Asset revision conflict/,
  );
});

test("an optional alias can never be reassigned to a different asset", async () => {
  const { registerAssetRevision, updateAssetMetadata } = await import(
    "../../src/server/generated-site/project-assets.ts"
  );
  const env = { ASTROPAGES_SITE_ENVIRONMENT: "preview", DB: createD1() };
  await registerAssetRevision({
    env, assetId: "asset_seed", revisionId: "arev_seed_1",
    storageKey: "assets/asset_seed/revisions/arev_seed_1/logo.svg",
    contentHash: "sha256:seed", etag: "etag-seed", fileName: "logo.svg",
    mimeType: "image/svg+xml", sizeBytes: 20, displayName: "Logo", origin: "template",
    aliases: ["brand-logo"], protected: true, replaceable: true, actorType: "system",
  });
  await assert.rejects(registerAssetRevision({
    env, assetId: "asset_other", revisionId: "arev_other_1",
    storageKey: "assets/asset_other/revisions/arev_other_1/other.svg",
    contentHash: "sha256:other", etag: "etag-other", fileName: "other.svg",
    mimeType: "image/svg+xml", sizeBytes: 20, displayName: "Other", origin: "user",
    aliases: ["brand-logo"], actorType: "user",
  }), /already belongs/i);

  await registerAssetRevision({
    env, assetId: "asset_card", revisionId: "arev_card_1",
    storageKey: "assets/asset_card/revisions/arev_card_1/card.svg",
    contentHash: "sha256:card", etag: "etag-card", fileName: "card.svg",
    mimeType: "image/svg+xml", sizeBytes: 20, displayName: "Card", origin: "user",
    actorType: "user",
  });
  await assert.rejects(updateAssetMetadata({
    env, assetId: "asset_card", aliases: ["brand-logo"], actorType: "user",
  }), /already belongs/i);
});

test("asset metadata, aliases, soft deletion, and restore preserve the stable identity", async () => {
  const {
    deleteAsset,
    listAssets,
    registerAssetRevision,
    restoreAsset,
    updateAssetMetadata,
  } = await import("../../src/server/generated-site/project-assets.ts");
  const DB = createD1();
  const env = { ASTROPAGES_SITE_ENVIRONMENT: "preview", DB };
  await registerAssetRevision({
    env, assetId: "asset_card", revisionId: "arev_card_1",
    storageKey: "assets/asset_card/revisions/arev_card_1/card.webp",
    contentHash: "sha256:card", etag: "etag-card", fileName: "card.webp",
    mimeType: "image/webp", sizeBytes: 50, displayName: "Card", origin: "user",
    aliases: ["feature-card"], actorType: "user", actorId: "user_1",
  });

  await updateAssetMetadata({
    env, assetId: "asset_card", displayName: "Feature card", altText: "Sacred lamp",
    aliases: ["featured-image"], actorType: "user", actorId: "user_1",
  });
  let items = await listAssets({ env });
  assert.equal(items[0].displayName, "Feature card");
  assert.equal(items[0].altText, "Sacred lamp");
  assert.deepEqual(items[0].aliases, ["featured-image"]);
  assert.equal("storageKey" in items[0], false);
  assert.equal("etag" in items[0], false);

  await deleteAsset({ env, assetId: "asset_card", actorType: "user", actorId: "user_1" });
  assert.equal((await listAssets({ env })).length, 0);
  assert.equal((await listAssets({ env, includeDeleted: true }))[0].deletedAt !== null, true);

  await restoreAsset({ env, assetId: "asset_card", actorType: "user", actorId: "user_1" });
  items = await listAssets({ env });
  assert.equal(items[0].assetId, "asset_card");
  assert.equal(items[0].revisionId, "arev_card_1");
});

test("protected template assets are replaceable but cannot be deleted", async () => {
  const { deleteAsset, registerAssetRevision } = await import(
    "../../src/server/generated-site/project-assets.ts"
  );
  const env = { ASTROPAGES_SITE_ENVIRONMENT: "preview", DB: createD1() };
  await registerAssetRevision({
    env, assetId: "asset_seed", revisionId: "arev_seed_1",
    storageKey: "assets/asset_seed/revisions/arev_seed_1/seed.svg",
    contentHash: "sha256:seed", etag: "etag-seed", fileName: "seed.svg",
    mimeType: "image/svg+xml", sizeBytes: 20, displayName: "Seed", origin: "template",
    protected: true, replaceable: true, actorType: "system",
  });
  await assert.rejects(
    deleteAsset({ env, assetId: "asset_seed", actorType: "user", actorId: "user_1" }),
    /protected/i,
  );
});

test("stable delivery redirects without caching and immutable delivery streams the exact R2 revision", async () => {
  const { handleAssetDeliveryRequest, registerAssetRevision } = await import(
    "../../src/server/generated-site/project-assets.ts"
  );
  const DB = createD1();
  const MEDIA = createR2();
  const storageKey = "assets/asset_logo/revisions/arev_logo_1/logo.png";
  MEDIA.objects.set(storageKey, {
    body: new TextEncoder().encode("png-bytes"),
    etag: '"etag-first"',
    contentType: "image/png",
  });
  const env = { ASTROPAGES_SITE_ENVIRONMENT: "preview", DB, MEDIA };
  await registerAssetRevision({
    env,
    assetId: "asset_logo",
    revisionId: "arev_logo_1",
    storageKey,
    contentHash: "sha256:first",
    etag: "etag-first",
    fileName: "logo.png",
    mimeType: "image/png",
    sizeBytes: 9,
    displayName: "Logo",
    origin: "template",
    aliases: ["brand-logo"],
    protected: true,
    replaceable: true,
    actorType: "system",
  });

  const stable = await handleAssetDeliveryRequest(
    new Request("https://preview.test/_assets/aliases/brand-logo/logo.png"),
    env,
  );
  assert.equal(stable.status, 302);
  assert.equal(stable.headers.get("cache-control"), "no-store");
  assert.equal(
    new URL(stable.headers.get("location"), "https://preview.test").pathname,
    "/_assets/revisions/arev_logo_1/sha256%3Afirst/logo.png",
  );

  const immutable = await handleAssetDeliveryRequest(
    new Request("https://preview.test/_assets/revisions/arev_logo_1/sha256%3Afirst/logo.png"),
    env,
  );
  assert.equal(immutable.status, 200);
  assert.equal(immutable.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(immutable.headers.get("content-type"), "image/png");
  assert.equal(await immutable.text(), "png-bytes");
});

test("SVG delivery is sandboxed even when R2 metadata is present", async () => {
  const { handleAssetDeliveryRequest, registerAssetRevision } = await import(
    "../../src/server/generated-site/project-assets.ts"
  );
  const DB = createD1();
  const MEDIA = createR2();
  const storageKey = "assets/asset_mark/revisions/arev_mark_1/mark.svg";
  MEDIA.objects.set(storageKey, {
    body: new TextEncoder().encode("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"),
    etag: '"etag-svg"',
    contentType: "image/svg+xml",
  });
  const env = { ASTROPAGES_SITE_ENVIRONMENT: "preview", DB, MEDIA };
  await registerAssetRevision({
    env, assetId: "asset_mark", revisionId: "arev_mark_1", storageKey,
    contentHash: "sha256:mark", etag: "etag-svg", fileName: "mark.svg",
    mimeType: "image/svg+xml", sizeBytes: 46, displayName: "Mark", origin: "template",
    actorType: "system",
  });
  const response = await handleAssetDeliveryRequest(
    new Request("https://preview.test/_assets/revisions/arev_mark_1/sha256%3Amark/mark.svg"),
    env,
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy"), /sandbox/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});

test("Worker handles project asset delivery before delegating to Astro and leaves other routes untouched", async () => {
  const { maybeHandleProjectAssetRequest } = await import(
    "../../src/server/generated-site/project-assets.ts"
  );
  const source = read("src/worker.ts");

  assert.match(source, /maybeHandleProjectAssetRequest/);
  assert.match(
    source,
    /maybeHandleProjectAssetRequest\(request, env\)[\s\S]*maybeHandleAnalyticsMcpToolCall\(request, env\)/,
  );
  assert.equal(
    await maybeHandleProjectAssetRequest(
      new Request("https://preview.test/not-an-asset"),
      {},
    ),
    null,
  );
});

test("asset export snapshots all active records and stores release hashes without depending on usages", async () => {
  const { buildAssetSnapshot, registerAssetRevision, readAssetStatus } = await import(
    "../../src/server/generated-site/project-assets.ts"
  );
  const DB = createD1();
  const env = { ASTROPAGES_SITE_ENVIRONMENT: "preview", DB };
  for (const [assetId, revisionId, alias] of [
    ["asset_logo", "arev_logo_1", "brand-logo"],
    ["asset_hero", "arev_hero_1", "home-hero"],
  ]) {
    await registerAssetRevision({
      env,
      assetId,
      revisionId,
      storageKey: `assets/${assetId}/revisions/${revisionId}/${assetId}.png`,
      contentHash: `sha256:${assetId}`,
      etag: `etag-${assetId}`,
      fileName: `${assetId}.png`,
      mimeType: "image/png",
      sizeBytes: 10,
      displayName: assetId,
      origin: "template",
      aliases: [alias],
      protected: true,
      replaceable: true,
      actorType: "system",
    });
  }

  const snapshot = await buildAssetSnapshot({
    env,
    templateKey: "aspt-verdigris-vera-solaro",
  });
  const status = await readAssetStatus(env);

  assert.equal(snapshot.assets.length, 2);
  assert.deepEqual(snapshot.assets.map((asset) => asset.assetId), ["asset_hero", "asset_logo"]);
  assert.equal(status.assetHash, snapshot.assetHash);
  assert.equal(status.snapshotHash, snapshot.snapshotHash);
});

test("production import recreates the approved current projection and is idempotent", async () => {
  const {
    buildAssetSnapshot,
    importAssetSnapshot,
    registerAssetRevision,
    readAssetStatus,
  } = await import("../../src/server/generated-site/project-assets.ts");
  const previewDb = createD1();
  const previewEnv = { ASTROPAGES_SITE_ENVIRONMENT: "preview", DB: previewDb };
  await registerAssetRevision({
    env: previewEnv,
    assetId: "asset_logo",
    revisionId: "arev_logo_1",
    storageKey: "assets/asset_logo/revisions/arev_logo_1/logo.png",
    contentHash: "sha256:logo",
    etag: "etag-logo",
    fileName: "logo.png",
    mimeType: "image/png",
    sizeBytes: 10,
    displayName: "Logo",
    origin: "template",
    aliases: ["brand-logo"],
    protected: true,
    replaceable: true,
    actorType: "system",
  });
  const snapshot = await buildAssetSnapshot({
    env: previewEnv,
    templateKey: "aspt-verdigris-vera-solaro",
  });
  const productionDb = createD1();
  const productionEnv = {
    ASTROPAGES_SITE_ENVIRONMENT: "production",
    DB: productionDb,
  };

  const first = await importAssetSnapshot({ env: productionEnv, snapshot });
  const second = await importAssetSnapshot({ env: productionEnv, snapshot });
  const status = await readAssetStatus(productionEnv);
  const record = productionDb.sqlite.prepare(
    "SELECT asset_id, current_revision_id FROM ap_asset_records WHERE asset_id = ?",
  ).get("asset_logo");
  const alias = productionDb.sqlite.prepare(
    "SELECT alias, asset_id FROM ap_asset_aliases WHERE alias = ?",
  ).get("brand-logo");

  assert.equal(first.imported, true);
  assert.equal(second.imported, false);
  assert.equal(record.current_revision_id, "arev_logo_1");
  assert.equal(alias.asset_id, "asset_logo");
  assert.equal(status.assetHash, snapshot.assetHash);
  assert.equal(status.snapshotHash, snapshot.snapshotHash);
});

test("generated-site asset release endpoints are service-authenticated and browser-inaccessible", () => {
  for (const route of ["status", "export", "import"]) {
    const source = read(`src/pages/api/astropages/generated-site/assets/${route}.ts`);
    assert.match(source, /requireContentReleaseServiceAuth/);
    assert.doesNotMatch(source, /context\.locals\.emdash/);
  }
});
