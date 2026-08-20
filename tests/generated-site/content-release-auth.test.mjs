import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const base64UrlEncode = (value) =>
  Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

const createJwt = async ({ privateKey, payload }) => {
  const header = base64UrlEncode(JSON.stringify({ alg: "ES256", typ: "JWT" }));
  const body = base64UrlEncode(JSON.stringify(payload));
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(`${header}.${body}`),
  );
  return `${header}.${body}.${base64UrlEncode(Buffer.from(signature))}`;
};

const contextFor = ({ token, env }) => ({
  request: new Request("https://preview.example/api/astropages/generated-site/content-release/status", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  }),
  locals: {
    runtime: { env },
  },
});

test("content release service auth accepts generated-site callback token", async () => {
  const { requireContentReleaseServiceAuth } = await import(
    "../../src/pages/api/astropages/generated-site/content-release/auth.ts"
  );
  const auth = await requireContentReleaseServiceAuth(
    contextFor({
      token: "callback-token",
      env: {
        ASTROPAGES_CONTROL_PLANE_CALLBACK_TOKEN: "callback-token",
        ASTROPAGES_PROJECT_ID: "project-123",
        ASTROPAGES_SITE_ENVIRONMENT: "preview",
      },
    }),
    "test-feature",
  );

  assert.equal(auth.ok, true);
  assert.equal(auth.claims.projectId, "project-123");
  assert.equal(auth.claims.environment, "preview");
  assert.equal(auth.claims.sub, "generated-site-callback-token");
});

test("content release service auth merges Cloudflare Workers env before checking callback tokens", () => {
  const source = fs.readFileSync(
    new URL("../../src/pages/api/astropages/generated-site/content-release/auth.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /import\("cloudflare:workers"\)/);
  assert.match(source, /getContentReleaseAuthEnv/);
  assert.match(source, /\.\.\.runtimeEnv,[\s\S]*\.\.\.cloudflareEnv/);
});

test("content release service auth rejects invalid bearer tokens", async () => {
  const { requireContentReleaseServiceAuth } = await import(
    "../../src/pages/api/astropages/generated-site/content-release/auth.ts"
  );
  const auth = await requireContentReleaseServiceAuth(
    contextFor({
      token: "wrong-token",
      env: {
        ASTROPAGES_CONTROL_PLANE_CALLBACK_TOKEN: "callback-token",
        ASTROPAGES_PROJECT_ID: "project-123",
        ASTROPAGES_SITE_ENVIRONMENT: "preview",
      },
    }),
    "test-feature",
  );

  assert.equal(auth.ok, false);
  assert.equal(auth.response.status, 401);
});

test("content release service auth keeps runtime-config JWT support", async () => {
  const { publicKey, privateKey } = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", publicKey);
  const now = Math.floor(Date.now() / 1000);
  const token = await createJwt({
    privateKey,
    payload: {
      iss: "astropages-control-plane",
      aud: "astropages-generated-site-runtime-config-sync",
      sub: "control-plane",
      projectId: "project-123",
      environment: "preview",
      iat: now,
      exp: now + 300,
    },
  });

  const { requireContentReleaseServiceAuth } = await import(
    "../../src/pages/api/astropages/generated-site/content-release/auth.ts"
  );
  const auth = await requireContentReleaseServiceAuth(
    contextFor({
      token,
      env: {
        ASTROPAGES_SSO_PUBLIC_JWK: JSON.stringify(publicJwk),
        ASTROPAGES_PROJECT_ID: "project-123",
        ASTROPAGES_SITE_ENVIRONMENT: "preview",
      },
    }),
    "test-feature",
  );

  assert.equal(auth.ok, true);
  assert.equal(auth.claims.projectId, "project-123");
  assert.equal(auth.claims.environment, "preview");
});
