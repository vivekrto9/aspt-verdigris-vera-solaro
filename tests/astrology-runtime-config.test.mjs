import assert from "node:assert/strict";
import test from "node:test";

// Public defaults seeded for every generated site by the control plane.
const platformDefaults = [
  ["ASTROLOGY_API_BASE_URL", "https://json.astrologyapi.com/v1"],
  ["ASTROLOGY_PDF_API_BASE_URL", "https://pdf.astrologyapi.com"],
  ["ASTROLOGY_DEFAULT_TIMEZONE", "5.5"],
  ["ASTROLOGY_DEFAULT_LANGUAGE", "en"],
  ["ASTROLOGYAPI_CHAT_BASE_URL", "https://json-chat.astrologyapi.com"],
];

test("authenticated runtime config sync accepts and stores every platform default without dropping keys", async () => {
  const { POST } = await import("../src/pages/api/astropages/generated-site/runtime-config/sync.ts");
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: "astropages-control-plane", aud: "astropages-generated-site-runtime-config-sync",
    sub: "control-plane", projectId: "platform-defaults-test", environment: "preview", iat: now, exp: now + 60 };
  const tokenBody = `${encode({ alg: "ES256", typ: "JWT" })}.${encode(claims)}`;
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(tokenBody));
  const token = `${tokenBody}.${Buffer.from(signature).toString("base64url")}`;
  const saved = [];
  const env = { ASTROPAGES_PROJECT_ID: claims.projectId, ASTROPAGES_SITE_ENVIRONMENT: "preview",
    ASTROPAGES_SSO_PUBLIC_JWK: JSON.stringify(await crypto.subtle.exportKey("jwk", pair.publicKey)),
    DB: { prepare(sql) {
      assert.match(sql, /INSERT INTO ap_runtime_config/);
      return { bind(...values) { return { async run() { saved.push(values); } }; } };
    } } };
  const contextFor = (config) => ({ request: new Request("https://preview.example/api/astropages/generated-site/runtime-config/sync", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ environment: "preview", config, disabledKeys: [] }),
  }), locals: { runtime: { env } } });
  const config = platformDefaults.map(([key, value]) => ({ key, value, providerKey: "astrologyapi", status: "active" }));
  const response = await POST(contextFor(config));
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).data.activeCount, platformDefaults.length);
  assert.deepEqual(saved.map(([key, value, providerKey, status]) => [key, value, providerKey, status]),
    config.map(({ key, value, providerKey, status }) => [key, value, providerKey, status]));
  for (const key of ["NOT_A_PLATFORM_RUNTIME_KEY", "X_ASTROLOGYAPI_KEY"]) {
    const rejected = await POST(contextFor([...config, { key, value: "must-not-be-stored" }]));
    assert.equal(rejected.status, 400);
    assert.equal(saved.length, platformDefaults.length, "rejected payload must write no rows");
  }
});

test("manifest declares every signed public platform default", async () => {
  const { readFile } = await import("node:fs/promises");
  const manifest = JSON.parse(await readFile(new URL("../template.manifest.json", import.meta.url), "utf8"));
  for (const [key] of platformDefaults) {
    assert.ok(manifest.secrets.generatedSiteRuntimeConfig.includes(key), key);
  }
});
