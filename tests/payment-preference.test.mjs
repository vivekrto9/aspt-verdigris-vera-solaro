import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { GET, PATCH } from "../src/pages/api/astropages/generated-site/payment-settings/v1.ts";
import { paymentCountryFromRequest } from "../src/server/aggregator/payment-country.ts";
import { getCurrencyContext, priceCatalogRow, withPaymentRequest } from "../src/server/aggregator/payment-pricing.ts";
import { readPaymentPreference, updatePaymentPreference } from "../src/server/aggregator/payment-preference.ts";
import { listVeraCatalog } from "../src/server/vera/catalog.ts";
import { hmacSha256Hex, sha256Hex } from "../src/server/vera/db.ts";
import { createRazorpayCheckoutForBooking, createRazorpayRefund, processRazorpayWebhook } from "../src/server/vera/razorpay.ts";
import { dispatchDueFollowUps } from "../src/server/vera/email.ts";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const binding = (sqlite) => ({
  prepare(sql) {
    const statement = sqlite.prepare(sql); let values = [];
    const wrapper = {
      bind(...next) { values = next; return wrapper; },
      async first() { return statement.get(...values) ?? null; },
      async all() { return { results: statement.all(...values) }; },
      async run() { const result = statement.run(...values); return { success: true, meta: { changes: Number(result.changes) } }; },
    };
    return wrapper;
  },
  async batch(statements) {
    sqlite.exec("BEGIN IMMEDIATE");
    try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec("COMMIT"); return results; }
    catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  },
});
const database = (t, beforePaymentMigration) => {
  const sqlite = new DatabaseSync(":memory:"); t.after(() => sqlite.close()); sqlite.exec("PRAGMA foreign_keys=ON");
  for (const migration of readdirSync(new URL("migrations/", root)).filter((name) => name.endsWith(".sql")).sort()) {
    if (migration === "0019_payment_preference.sql" && beforePaymentMigration) beforePaymentMigration(sqlite);
    sqlite.exec("BEGIN"); sqlite.exec(read(`migrations/${migration}`)); sqlite.exec("COMMIT");
  }
  return { sqlite, env: { DB: binding(sqlite), ASTROPAGES_PROJECT_ID: "vera-one", ASTROPAGES_SITE_ENVIRONMENT: "preview" } };
};
const countryRequest = (country, url = "https://site.example/readings") => {
  const request = new Request(url); Object.defineProperty(request, "cf", { value: country ? { country } : {} }); return request;
};

const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const publicJwk = JSON.stringify(await crypto.subtle.exportKey("jwk", keys.publicKey));
const path = "/api/astropages/generated-site/payment-settings/v1";
const signed = async ({ method = "GET", body, claims = {}, actualBody } = {}) => {
  const raw = body === undefined ? "" : JSON.stringify(body); const now = Math.floor(Date.now() / 1000);
  const payload = { iss: "astropages-control-plane", aud: "astropages-generated-site-payment-settings", sub: "owner-one", projectId: "vera-one", environment: "preview", role: "owner", jti: crypto.randomUUID(), iat: now, exp: now + 60, method, path, bodyHash: Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw))).toString("hex"), ...claims };
  const input = `${Buffer.from(JSON.stringify({ alg: "ES256", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, new TextEncoder().encode(input));
  return new Request(`https://site.example${path}`, { method, headers: { authorization: `Bearer ${input}.${Buffer.from(signature).toString("base64url")}` }, ...(method === "PATCH" ? { body: actualBody ?? raw } : {}) });
};
const context = (env, request) => ({ request, locals: { runtime: { env: { ...env, ASTROPAGES_SSO_PUBLIC_JWK: publicJwk } } } });

test("migration defaults to AUTO and preserves custom USD and historical money", (t) => {
  const { sqlite } = database(t, (db) => {
    db.prepare("UPDATE ap_vera_services SET price_cents=27123 WHERE slug='natal-hour'").run();
    db.prepare("INSERT INTO ap_business_settings(key,value_json,updated_at) VALUES('payment_preference','{\"value\":\"INR\",\"schemaVersion\":1,\"revision\":7}','original')").run();
  });
  assert.equal(sqlite.prepare("SELECT value_json FROM ap_business_settings WHERE key='payment_preference'").get().value_json, '{"value":"INR","schemaVersion":1,"revision":7}');
  const price = sqlite.prepare("SELECT price_cents,price_usd_cents,price_inr_cents FROM ap_vera_services WHERE slug='natal-hour'").get();
  assert.deepEqual({ ...price }, { price_cents: 27123, price_usd_cents: 27123, price_inr_cents: 1990000 });
  assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});

test("legacy price edits affect only their declared denomination", (t) => {
  const { sqlite } = database(t);
  sqlite.exec("UPDATE ap_vera_services SET price_cents=299, currency='USD' WHERE slug='natal-hour'");
  assert.deepEqual({ ...sqlite.prepare("SELECT price_inr_cents,price_usd_cents FROM ap_vera_services WHERE slug='natal-hour'").get() }, { price_inr_cents: 1990000, price_usd_cents: 299 });
});

test("signed settings API round-trips preferences and enforces authorization and CAS", async (t) => {
  const { env } = database(t);
  const initial = await GET(context(env, await signed())); assert.equal((await initial.json()).data.payment_preference, "AUTO");
  const updated = await PATCH(context(env, await signed({ method: "PATCH", body: { payment_preference: "INR", expectedRevision: 1 } })));
  assert.equal(updated.status, 200); assert.equal((await updated.json()).data.revision, 2);
  await assert.rejects(() => updatePaymentPreference(env, { payment_preference: "USD", expectedRevision: 1 }), { code: "PAYMENT_REVISION_CONFLICT" });
  assert.equal((await GET(context(env, new Request(`https://site.example${path}`)))).status, 401);
  assert.equal((await PATCH(context(env, await signed({ method: "PATCH", body: { payment_preference: "USD", expectedRevision: 2 }, claims: { role: "viewer" } })))).status, 403);
});

test("forced and AUTO resolution trusts only request-scoped Cloudflare geography", async (t) => {
  const { sqlite, env } = database(t);
  assert.equal((await getCurrencyContext(withPaymentRequest(env, countryRequest("IN")))).currency, "INR");
  assert.equal((await getCurrencyContext(withPaymentRequest(env, countryRequest("NL")))).currency, "USD");
  assert.equal((await getCurrencyContext(withPaymentRequest(env, new Request("http://localhost/readings", { headers: { "cf-ipcountry": "IN" } })))).currency, "USD");
  assert.equal(paymentCountryFromRequest(new Request("https://site.example", { headers: { "cf-ipcountry": "IN" } }), false), undefined);
  sqlite.exec("UPDATE ap_business_settings SET value_json='{\"value\":\"USD\",\"schemaVersion\":1,\"revision\":2}' WHERE key='payment_preference'");
  assert.equal((await getCurrencyContext(withPaymentRequest(env, countryRequest("IN")))).currency, "USD");
});

test("catalog and arbitrary prices select exact independent amounts and fail closed", async (t) => {
  const { sqlite, env } = database(t);
  const inr = await listVeraCatalog(withPaymentRequest(env, countryRequest("IN")));
  assert.deepEqual(inr.services.map(({ priceCents, currency }) => [priceCents, currency]), [[1990000,"INR"],[3150000,"INR"],[3490000,"INR"]]);
  assert.equal(inr.depositCents, 650000);
  const row = { price_inr_cents: 10000, price_usd_cents: 200 };
  assert.equal((await priceCatalogRow(withPaymentRequest(env, countryRequest("IN")), row)).price_cents, 10000);
  sqlite.exec("UPDATE ap_business_settings SET value_json='{\"value\":\"USD\",\"schemaVersion\":1,\"revision\":2}' WHERE key='payment_preference'");
  assert.equal((await priceCatalogRow(withPaymentRequest(env, countryRequest("IN")), row)).price_cents, 200);
  await assert.rejects(() => priceCatalogRow(withPaymentRequest(env, countryRequest("IN")), { ...row, price_usd_cents: null }), { code: "PAYMENT_PRICE_UNAVAILABLE" });
});

const insertInrBooking = async (sqlite, env) => {
  const id = "vbooking_inr_contract"; const now = new Date().toISOString(); const expiry = new Date(Date.now() + 86_400_000).toISOString();
  const tokenExpiry = Date.now() + 86_400_000; const signature = await hmacSha256Hex(env.EMDASH_ENCRYPTION_KEY, `vera-booking-manage:v2:${id}:${tokenExpiry}`); const token = `v2.${tokenExpiry}.${signature}`;
  sqlite.prepare(`INSERT INTO ap_vera_bookings (id,booking_number,request_idempotency_key,service_slug,mode,status,payment_state,payment_option,customer_name,email,normalized_email,customer_timezone,selected_start_at,selected_end_at,price_cents,deposit_cents,gift_applied_cents,total_due_cents,paid_cents,balance_cents,currency,manage_token_hash,manage_token_expires_at,calendly_event_type_uri,hold_expires_at,created_at,updated_at) VALUES (?,?,?,'natal-hour','call','pending_payment','unpaid','full','INR Reader','inr@example.test','inr@example.test','UTC',?,?,1990000,650000,0,1990000,0,1990000,'INR',?,?,?, ?,?,?)`).run(id,"VS-INR-CONTRACT","inr-contract-key",new Date(Date.now()+172800000).toISOString(),new Date(Date.now()+174600000).toISOString(),await sha256Hex(token),expiry,"https://api.calendly.com/event_types/CONTRACT",expiry,now,now);
  return { id, token };
};

test("Razorpay checkout, failure, capture, refund and replay use authoritative saved INR", async (t) => {
  const { sqlite, env } = database(t); Object.assign(env, { EMDASH_ENCRYPTION_KEY: "contract-key", RAZORPAY_KEY_SECRET: "rzp-secret", RAZORPAY_WEBHOOK_SECRET: "rzp-webhook" });
  sqlite.prepare("INSERT INTO ap_runtime_config(key,value,provider_key,scope,status,updated_at) VALUES('RAZORPAY_KEY_ID','rzp_test_contract','razorpay','site','active',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(new Date().toISOString());
  env.fetch = async (_input, init) => { const sent = JSON.parse(init.body); assert.equal(sent.amount, 1990000); assert.equal(sent.currency, "INR"); return Response.json({ id: "order_contract", amount: sent.amount, currency: sent.currency }); };
  const booking = await insertInrBooking(sqlite, env);
  const checkout = await createRazorpayCheckoutForBooking({ env, request: new Request("https://site.example/api", { method: "POST" }), bookingId: booking.id, manageToken: booking.token, kind: "full" });
  assert.equal(checkout.ok, true, checkout.message); assert.equal(checkout.checkout.amountCents, 1990000);
  const payment = { id: "pay_contract", order_id: "order_contract", amount: 1990000, currency: "INR", notes: { bookingId: booking.id, attemptId: sqlite.prepare("SELECT id FROM ap_vera_payment_attempts WHERE booking_id=?").get(booking.id).id } };
  const body = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: payment } } });
  assert.equal((await processRazorpayWebhook({ env, body, signatureHeader: "bad" })).status, 403);
  const wrongBody = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { ...payment, amount: 10000 } } } });
  assert.equal((await processRazorpayWebhook({ env, body: wrongBody, signatureHeader: await hmacSha256Hex(env.RAZORPAY_WEBHOOK_SECRET, wrongBody), eventIdHeader: "rzp-wrong" })).status, 409);
  const failedBody = JSON.stringify({ event: "payment.failed", payload: { payment: { entity: { ...payment, error: { code: "BAD_REQUEST_ERROR" } } } } });
  assert.equal((await processRazorpayWebhook({ env, body: failedBody, signatureHeader: await hmacSha256Hex(env.RAZORPAY_WEBHOOK_SECRET, failedBody), eventIdHeader: "rzp-failed" })).ok, true);
  assert.equal(sqlite.prepare("SELECT paid_cents FROM ap_vera_bookings WHERE id=?").get(booking.id).paid_cents, 0);
  const signature = await hmacSha256Hex(env.RAZORPAY_WEBHOOK_SECRET, body);
  assert.equal((await processRazorpayWebhook({ env, body, signatureHeader: signature, eventIdHeader: "rzp-event-1" })).ok, true);
  assert.equal((await processRazorpayWebhook({ env, body, signatureHeader: signature, eventIdHeader: "rzp-event-1" })).message, "Razorpay event already processed.");
  assert.equal(sqlite.prepare("SELECT paid_cents FROM ap_vera_bookings WHERE id=?").get(booking.id).paid_cents, 1990000);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM ap_vera_invoices WHERE booking_id=?").get(booking.id).count, 1);
  env.fetch = async (input, init) => {
    assert.match(String(input), /\/payments\/pay_contract\/refund$/);
    const sent = JSON.parse(init.body); assert.equal(sent.amount, 1990000);
    return Response.json({ id: "rfnd_currency_contract", payment_id: "pay_contract", amount: sent.amount, status: "pending" });
  };
  const refund = await createRazorpayRefund({ env, bookingId: booking.id, amountCents: 1990000, reason: "contract refund" });
  assert.equal(refund.ok, true, refund.message);
  const refundBody = JSON.stringify({ event: "refund.processed", payload: { refund: { entity: { id: "rfnd_currency_contract", payment_id: "pay_contract", amount: 1990000, currency: "INR" } } } });
  const refundSignature = await hmacSha256Hex(env.RAZORPAY_WEBHOOK_SECRET, refundBody);
  assert.equal((await processRazorpayWebhook({ env, body: refundBody, signatureHeader: refundSignature, eventIdHeader: "rzp-refund" })).ok, true);
  assert.equal(sqlite.prepare("SELECT payment_state FROM ap_vera_bookings WHERE id=?").get(booking.id).payment_state, "refunded");
  assert.equal(sqlite.prepare("SELECT status FROM ap_vera_invoices WHERE booking_id=?").get(booking.id).status, "refunded");
});

test("balance reminder displays the saved booking currency", async (t) => {
  const { sqlite, env } = database(t);
  env.ASTROPAGES_SITE_URL = "https://site.example";
  const booking = await insertInrBooking(sqlite, { EMDASH_ENCRYPTION_KEY: "contract-key" });
  const now = new Date().toISOString();
  sqlite.prepare("INSERT INTO ap_vera_follow_ups (id,booking_id,kind,due_at,status,created_at,updated_at) VALUES (?,?,'balance_reminder',?,'pending',?,?)")
    .run("vfollow_inr_contract", booking.id, now, now, now);
  assert.equal((await dispatchDueFollowUps({ env, now: new Date(now) })).dispatched, 1);
  const mail = sqlite.prepare("SELECT payload_json FROM ap_vera_email_outbox WHERE idempotency_key='follow-up:vfollow_inr_contract'").get();
  assert.equal(JSON.parse(mail.payload_json).balanceAmount, "₹19,900.00");
});

test("currency implementation contains no conversion arithmetic or fallback", () => {
  const sources = ["migrations/0019_payment_preference.sql","src/server/aggregator/payment-pricing.ts","src/server/vera/catalog.ts"].map(read).join("\n").replace(/^--.*$/gm, "");
  assert.doesNotMatch(sources, /price_(?:cents|inr_cents|usd_cents)\s*[*/]|exchange.?rate|fx.?rate/i);
  assert.match(sources, /row\[currency === "INR" \? "price_inr_cents" : "price_usd_cents"\]/);
});
