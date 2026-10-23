import assert from "node:assert/strict";
import { webcrypto as crypto } from "node:crypto";
import test from "node:test";

// Public binding names from the control plane's runtimeConfigBindings contract.
const publicBindings = [
  "ACTIVE_ANALYTICS_PROVIDER", "ACTIVE_SCHEDULING_PROVIDER", "ASTROLOGYAPI_CHAT_BASE_URL",
  "ASTROLOGY_API_BASE_URL", "ASTROLOGY_DEFAULT_LANGUAGE", "ASTROLOGY_DEFAULT_TIMEZONE",
  "ASTROLOGY_PDF_API_BASE_URL", "AWS_REGION", "CALENDLY_EVENT_TYPE_URI", "GA4_MEASUREMENT_ID",
  "GMAIL_SENDER_EMAIL", "GMAIL_SENDER_NAME", "GOOGLE_CALENDAR_CALENDAR_ID",
  "GOOGLE_CALENDAR_DEFAULT_TIMEZONE", "MAILCHIMP_AUDIENCE_ID", "MAILCHIMP_SERVER_PREFIX",
  "PAYMENT_PROVIDER", "POSTHOG_HOST", "POSTHOG_PROJECT_API_KEY", "POSTHOG_PROJECT_ID",
  "PUBLIC_GOOGLE_ADS_CONVERSION_LABEL", "PUBLIC_GOOGLE_ADS_TAG_ID", "PUBLIC_GTM_CONTAINER_ID",
  "PUBLIC_META_PIXEL_ID", "RAZORPAY_KEY_ID", "SES_SENDER_EMAIL", "SES_SENDER_NAME",
  "TRANSACTIONAL_EMAIL_PROVIDER", "WATI_ADVISOR_TEMPLATE_NAME", "WATI_API_URL",
  "WATI_CUSTOMER_TEMPLATE_NAME", "WATI_TEMPLATE_NAME",
];

const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

test("signed runtime config sync persists every control-plane public binding and rejects invalid keys before writes", async () => {
  const { runtimeConfigKeys } = await import("../src/server/aggregator/runtime-config.ts");
  const { POST } = await import("../src/pages/api/astropages/generated-site/runtime-config/sync.ts");
  for (const key of publicBindings) {
    assert.ok(runtimeConfigKeys.includes(key), `${key} missing from native allowlist`);
  }

  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: "astropages-control-plane", aud: "astropages-generated-site-runtime-config-sync",
    sub: "control-plane", projectId: "public-config-contract-test", environment: "preview", iat: now, exp: now + 60 };
  const body = `${encode({ alg: "ES256", typ: "JWT" })}.${encode(claims)}`;
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(body));
  const token = `${body}.${Buffer.from(signature).toString("base64url")}`;
  const saved = [];
  const env = { ASTROPAGES_PROJECT_ID: claims.projectId, ASTROPAGES_SITE_ENVIRONMENT: "preview",
    ASTROPAGES_SSO_PUBLIC_JWK: JSON.stringify(await crypto.subtle.exportKey("jwk", pair.publicKey)),
    DB: { prepare(sql) {
      assert.match(sql, /INSERT INTO ap_runtime_config/);
      return { bind(...values) { return { async run() { saved.push(values); } }; } };
    } } };
  const contextFor = (config, disabledKeys = []) => ({ request: new Request("https://preview.example/api/astropages/generated-site/runtime-config/sync", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ environment: "preview", config, disabledKeys }),
  }), locals: { runtime: { env } } });
  const selectedProviders = { TRANSACTIONAL_EMAIL_PROVIDER: "ses", ACTIVE_ANALYTICS_PROVIDER: "posthog", ACTIVE_SCHEDULING_PROVIDER: "calendly", PAYMENT_PROVIDER: "razorpay" };
  const config = publicBindings.map((key) => ({ key, value: selectedProviders[key] ?? `value-for-${key}`, providerKey: "contract-test", status: "active" }));
  const response = await POST(contextFor(config));
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).data.activeCount, publicBindings.length);
  assert.deepEqual(saved.map(([key, value]) => [key, value]), config.map(({ key, value }) => [key, value]));
  for (const key of ["UNSUPPORTED_PUBLIC_BINDING", "STRIPE_SECRET_KEY"]) {
    const rejected = await POST(contextFor([...config, { key, value: "must-not-be-stored" }]));
    assert.equal(rejected.status, 400);
    assert.equal(saved.length, publicBindings.length, "rejected payload must write no rows");
  }
});
