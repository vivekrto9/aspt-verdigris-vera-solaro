// Built production Worker with disposable Miniflare D1, exact provider requests and authentic signed webhooks.
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { expectedVeraPrices, veraMoney, verifyVeraCurrencySurfaces } from "./currency-surface-checks.mjs";

const require = createRequire(import.meta.url);
const { Miniflare } = require("miniflare");
const output = resolve("output/playwright/currency-matrix");
mkdirSync(output, { recursive: true });
const sqlLine = (input) => { let result = ""; let quote = ""; for (let index = 0; index < input.length; index++) { const char = input[index]; if (quote) { result += char === "\n" ? " " : char; if (char === quote) { if (input[index + 1] === quote) result += input[++index]; else quote = ""; } } else if (char === "-" && input[index + 1] === "-") { while (index < input.length && input[index] !== "\n") index++; result += " "; } else { if (["'", '"', "`"].includes(char)) quote = char; result += char === "\n" ? " " : char; } } return result; };
const modules = [{ type: "ESModule", path: resolve("dist/server/entry.mjs") }, ...readdirSync("dist/server", { recursive: true }).filter((file) => file.endsWith(".mjs") && file !== "entry.mjs").map((file) => ({ type: "ESModule", path: resolve("dist/server", file) }))];
const cases = [["INR", "US", "INR"], ["USD", "IN", "USD"], ["AUTO", "IN", "INR"], ["AUTO", "NL", "USD"], ["AUTO", undefined, "USD"]];
const results = [];
const browser = await chromium.launch();
try {
  for (const [preference, country, currency] of cases) {
    const providerRequests = [];
    const worker = new Miniflare({
      name: "vera-currency-matrix", modules, modulesRoot: resolve("dist/server"), compatibilityDate: "2026-02-24", compatibilityFlags: ["nodejs_compat"], cf: country ? { country } : {}, d1Databases: ["DB"], kvNamespaces: ["SESSION"], r2Buckets: ["MEDIA"], images: { binding: "IMAGES" },
      assets: { directory: resolve("dist/client"), binding: "ASSETS", routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true } },
      bindings: { EMDASH_ENCRYPTION_KEY: "currency-secret", CALENDLY_EVENT_TYPE_URI: "https://api.calendly.com/event_types/vera_currency_fixture", STRIPE_SECRET_KEY: "sk_test_fixture", STRIPE_WEBHOOK_SECRET: "whsec_fixture", RAZORPAY_KEY_ID: "rzp_test_fixture", RAZORPAY_KEY_SECRET: "fixture", RAZORPAY_WEBHOOK_SECRET: "fixture" },
      outboundService: async (request) => {
        const url = new URL(request.url); const body = await request.text(); providerRequests.push({ url: request.url, body, method: request.method });
        if (url.hostname === "api.razorpay.com" && url.pathname === "/v1/orders") { const sent = JSON.parse(body); return Response.json({ id: "order_currency_contract", amount: sent.amount, currency: sent.currency }); }
        if (url.hostname === "api.stripe.com" && url.pathname === "/v1/checkout/sessions") return Response.json({ id: "cs_currency_contract", url: "https://checkout.stripe.test/currency-contract" });
        return new Response("External request blocked", { status: 503 });
      },
    });
    let context;
    try {
      const base = String(await worker.ready); const database = await worker.getD1Database("DB");
      for (const file of readdirSync("migrations").filter((name) => name.endsWith(".sql")).sort()) { const sql = sqlLine(readFileSync(`migrations/${file}`, "utf8")); if (sql.trim()) await database.exec(sql); }
      await database.prepare("UPDATE ap_business_settings SET value_json=? WHERE key='payment_preference'").bind(JSON.stringify({ value: preference, schemaVersion: 1, revision: 2 })).run();
      await database.exec("UPDATE ap_vera_services SET price_usd_cents=200,price_cents=200 WHERE slug='natal-hour'; UPDATE ap_vera_services SET price_inr_cents=10000 WHERE slug='natal-hour'");
      const amount = expectedVeraPrices(currency)[0]; const deposit = currency === "INR" ? 650_000 : 8_000; const bookingId = `vbooking_${currency.toLowerCase()}_matrix`; const expiresMs = Date.now() + 86_400_000; const token = `v2.${expiresMs}.${createHmac("sha256", "currency-secret").update(`vera-booking-manage:v2:${bookingId}:${expiresMs}`).digest("hex")}`; const tokenHash = createHash("sha256").update(token).digest("hex"); const now = new Date().toISOString(); const start = new Date(Date.now() + 172_800_000).toISOString(); const end = new Date(Date.now() + 174_600_000).toISOString(); const expiry = new Date(expiresMs).toISOString();
      await database.prepare(`INSERT INTO ap_vera_bookings (id,booking_number,request_idempotency_key,service_slug,mode,status,payment_state,payment_option,customer_name,email,normalized_email,customer_timezone,selected_start_at,selected_end_at,price_cents,deposit_cents,gift_applied_cents,total_due_cents,paid_cents,balance_cents,currency,manage_token_hash,manage_token_expires_at,calendly_event_type_uri,hold_expires_at,created_at,updated_at) VALUES (?,?,?,'natal-hour','call','pending_payment','unpaid','full','Currency Reader','currency@example.test','currency@example.test','UTC',?,?,?,?,0,?,0,?,?,?,?,?,?,?,?)`).bind(bookingId, `VS-${currency}-MATRIX`, `matrix-${currency}`, start, end, amount, deposit, amount, amount, currency, tokenHash, expiry, "https://api.calendly.com/event_types/CONTRACT", expiry, now, now).run();
      context = await browser.newContext({ viewport: { width: 1440, height: 900 } }); await context.route("**/*", (route) => new URL(route.request().url()).origin === new URL(base).origin ? route.continue() : route.abort()); const page = await context.newPage(); page.setDefaultTimeout(30_000); const errors = []; page.on("pageerror", (error) => errors.push(error.message)); const label = `${preference}-${country ?? "unknown"}`;
      const surface = await verifyVeraCurrencySurfaces({ page, request: context.request, base, currency, label, output, browserErrors: errors });
      const confirmationUrl = new URL(`/booking/${bookingId}/confirmation?token=${encodeURIComponent(token)}`, base).href;
      assert.equal((await page.goto(confirmationUrl, { waitUntil: "networkidle" }))?.status(), 200, `${label} pending confirmation`);
      assert.equal(await page.locator("[data-booking-state-price]").innerText(), veraMoney(amount, currency), `${label} pending price`);
      assert.equal(await page.locator("[data-booking-state-paid]").innerText(), veraMoney(0, currency), `${label} pending paid`);
      const checkoutResponse = await context.request.post(new URL(`/api/astropages/generated-site/vera/bookings/${bookingId}/checkout-session`, base).href, { data: { manageToken: token, kind: "full" } }); const checkout = await checkoutResponse.json(); assert.equal(checkoutResponse.status(), 200, `${label} checkout ${JSON.stringify(checkout)}`); assert.equal(checkout.data.checkout.amountCents, amount); assert.equal(checkout.data.checkout.currency, currency); assert.equal(checkout.data.checkout.provider ?? (currency === "USD" ? "stripe" : ""), currency === "INR" ? "razorpay" : "stripe");
      const attempt = await database.prepare("SELECT * FROM ap_vera_payment_attempts WHERE booking_id=?").bind(bookingId).first();
      let webhookResponse;
      if (currency === "INR") { const sent = JSON.parse(providerRequests.at(-1).body); assert.equal(sent.amount, amount); assert.equal(sent.currency, "INR"); const body = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: "pay_currency_contract", order_id: "order_currency_contract", amount, currency: "INR", notes: { bookingId, attemptId: attempt.id } } } } }); const signature = createHmac("sha256", "fixture").update(body).digest("hex"); webhookResponse = await context.request.post(new URL("/api/astropages/generated-site/webhooks/payment/razorpay", base).href, { data: body, headers: { "content-type": "application/json", "x-razorpay-signature": signature, "x-razorpay-event-id": `evt-${label}` } }); }
      else { const form = new URLSearchParams(providerRequests.at(-1).body); assert.equal(Number(form.get("line_items[0][price_data][unit_amount]")), amount); assert.equal(form.get("line_items[0][price_data][currency]"), "usd"); const body = JSON.stringify({ id: `evt_${preference.toLowerCase()}_${country ?? "unknown"}`, type: "checkout.session.completed", data: { object: { id: "cs_currency_contract", payment_intent: "pi_currency_contract", payment_status: "paid", amount_total: amount, currency: "usd", metadata: { booking_id: bookingId, attempt_id: attempt.id } } } }); const timestamp = Math.floor(Date.now() / 1000); const signature = createHmac("sha256", "whsec_fixture").update(`${timestamp}.${body}`).digest("hex"); webhookResponse = await context.request.post(new URL("/api/astropages/generated-site/webhooks/payment/stripe", base).href, { data: body, headers: { "content-type": "application/json", "stripe-signature": `t=${timestamp},v1=${signature}` } }); }
      assert.equal(webhookResponse.status(), 200, `${label} signed webhook`); const paid = await database.prepare("SELECT paid_cents,currency FROM ap_vera_bookings WHERE id=?").bind(bookingId).first(); assert.equal(paid.paid_cents, amount); assert.equal(paid.currency, currency); assert.equal((await database.prepare("SELECT COUNT(*) AS count FROM ap_vera_invoices WHERE booking_id=?").bind(bookingId).first()).count, 1);
      assert.equal((await page.goto(confirmationUrl, { waitUntil: "networkidle" }))?.status(), 200, `${label} paid confirmation`);
      const paidAmount = page.locator("[data-booking-state-paid], [data-booking-confirmed-paid]").first();
      assert.equal(await paidAmount.innerText(), veraMoney(amount, currency), `${label} paid display`);
      assert.deepEqual(errors, [], `${label} browser errors`); results.push({ preference, country: country ?? "unknown", ...surface, checkoutProvider: currency === "INR" ? "razorpay" : "stripe", signedWebhook: true, invoice: true });
    } finally { await context?.close(); await worker.dispose(); }
  }
} finally { await browser.close(); }
writeFileSync(`${output}/results.json`, JSON.stringify({ runtime: "built production Worker", cases: results, customIndependentPrices: { INR: 10000, USD: 200 }, authenticSignedWebhooks: true, status: "PASS" }, null, 2));
assert.equal(results.length, cases.length);
console.log("PASS: built Worker five-case Vera currency/provider/webhook matrix.");
