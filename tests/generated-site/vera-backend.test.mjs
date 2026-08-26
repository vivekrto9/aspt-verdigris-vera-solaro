import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  bookingSlotStarts,
  canUseFreeReschedule,
  getVeraSelection,
  listVeraCatalog,
  quoteInitialPayment,
  VERA_DEPOSIT_CENTS,
  VERA_HOLD_MINUTES,
} from "../../src/server/vera/catalog.ts";
import { hmacSha256Hex, sha256Hex } from "../../src/server/vera/db.ts";
import {
  confirmVeraNewsletter,
  dispatchDueFollowUps,
  enqueueVeraEmail,
  processEmailOutbox,
  subscribeVeraNewsletter,
  unsubscribeVeraNewsletter,
} from "../../src/server/vera/email.ts";
import {
  completeElapsedVeraBookings,
  processCalendlyWebhook,
  schedulePaidVeraBooking,
  verifyCalendlySignature,
} from "../../src/server/vera/calendly.ts";
import {
  createStripeCheckoutForBooking,
  createStripePaymentIntent,
  createStripeRefund,
  processStripeWebhook,
  verifyStripeSignature,
} from "../../src/server/vera/stripe.ts";
import { deriveVeraBookingConfirmationState } from "../../src/server/vera/booking-confirmation.ts";
import {
  cancelVeraBooking,
  completeVeraReschedule,
  createVeraBooking,
  getVeraBookingStatus,
  updateVeraBookingQuote,
} from "../../src/server/vera/bookings.ts";
import {
  getVeraAccountPortal,
  sendVeraCustomerMessage,
} from "../../src/server/vera/account.ts";
import { submitVeraContact, joinVeraWaitlist } from "../../src/server/vera/engagement.ts";
import {
  normalizeVeraBirthTimeApproximation,
  resolveVeraPlaceDetails,
  VERA_BIRTH_TIME_APPROXIMATIONS,
  verifyVeraBirthPlaceSelection,
} from "../../src/server/vera/places.ts";
import {
  createBookingManageToken,
  createUnsubscribeToken,
  decryptVeraPrivateJson,
  encryptVeraPrivateJson,
  giftCodeHash,
} from "../../src/server/vera/security.ts";
import {
  loginCustomer,
  requestCustomerPasswordReset,
  resetCustomerPassword,
  signupCustomer,
  verifyCustomerEmail,
} from "../../src/server/aggregator/customer-auth.ts";
import { sendSesTransactionalEmail } from "../../src/server/aggregator/notifications/ses.ts";
import { POST as resolveVeraPlaceDetailsRoute } from "../../src/pages/api/astropages/generated-site/vera/places/details.ts";
import {
  GET as getVeraBookingStatusRoute,
  POST as retryVeraBookingSchedulingRoute,
} from "../../src/pages/api/astropages/generated-site/vera/bookings/[id]/status.ts";
import {
  GET as getVeraAccountRoute,
  POST as postVeraAccountRoute,
} from "../../src/pages/api/astropages/generated-site/vera/account/index.ts";
import { GET as getVeraAccountFileRoute } from "../../src/pages/api/astropages/generated-site/vera/account/files/[id].ts";
import { GET as getVeraAvailabilityRoute } from "../../src/pages/api/astropages/generated-site/vera/availability.ts";
import {
  GET as getVeraOperationsReadinessRoute,
  POST as postVeraOperationsRoute,
} from "../../src/pages/api/astropages/generated-site/vera/operations/index.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

const createDatabase = () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  for (const migration of readdirSync(new URL("migrations/", root)).filter((name) => name.endsWith(".sql")).sort()) {
    // D1 applies each migration file inside a single transaction, where
    // PRAGMA foreign_keys is a no-op. Mirror that here so a migration cannot pass
    // the contract and then fail on the real database.
    sqlite.exec("BEGIN");
    sqlite.exec(read(`migrations/${migration}`));
    sqlite.exec("COMMIT");
  }
  const DB = {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      let values = [];
      const wrapper = {
        bind(...next) {
          values = next;
          return wrapper;
        },
        async first() {
          return statement.get(...values) ?? null;
        },
        async all() {
          return { results: statement.all(...values) };
        },
        async run() {
          const result = statement.run(...values);
          return { success: true, meta: { changes: Number(result.changes) } };
        },
      };
      return wrapper;
    },
    async batch(statements) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { sqlite, DB };
};

const placeSelection = async ({
  DB,
  birthDate = "1990-01-02",
  birthTime = "10:30",
  birthTimeUnknown = false,
} = {}) => {
  const env = {
    DB,
    EMDASH_ENCRYPTION_KEY: "contract-encryption-key",
    ASTROPAGES_PLATFORM_GOOGLE_PLACES_API_KEY: "contract-places-key",
    fetch: async (input, init = {}) => {
      assert.ok(init.signal instanceof AbortSignal);
      const url = new URL(String(input));
      assert.equal(url.hostname, "maps.googleapis.com");
      assert.equal(url.searchParams.get("place_id"), "place_contract_trieste");
      assert.equal(url.searchParams.get("key"), "contract-places-key");
      return Response.json({
        status: "OK",
        result: {
          place_id: "place_contract_trieste",
          formatted_address: "Trieste, Italy",
          geometry: { location: { lat: 45.6495, lng: 13.7768 } },
        },
      });
    },
  };
  const result = await resolveVeraPlaceDetails({
    env,
    placeId: "place_contract_trieste",
    birthDate,
    birthTime,
    birthTimeUnknown,
  });
  assert.equal(result.ok, true);
  return { result, env, birthDate, birthTime, birthTimeUnknown };
};

const bookingInput = ({ startAt, placeSelectionToken, idempotencyKey = "booking-contract-0001" }) => ({
  idempotencyKey,
  serviceSlug: "natal",
  mode: "call",
  name: "Booking Customer",
  email: "booking@example.test",
  timezone: "UTC",
  startAt,
  paymentOption: "deposit",
  consentContact: true,
  intake: {
    birthDate: "1990-01-02",
    birthTime: "10:30",
    birthTimeUnknown: false,
    placeSelectionToken,
    focus: "A private contract-test intention.",
  },
});

test("Vera migration establishes the complete authoritative vertical", () => {
  const { sqlite } = createDatabase();
  assert.deepEqual(
    sqlite.prepare("SELECT slug, duration_minutes, price_cents FROM ap_vera_services ORDER BY sort_order").all()
      .map((row) => ({ ...row })),
    [
      { slug: "natal-hour", duration_minutes: 30, price_cents: 24_000 },
      { slug: "year-ahead", duration_minutes: 30, price_cents: 38_500 },
      { slug: "two-charts", duration_minutes: 30, price_cents: 42_000 },
    ],
  );
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM ap_vera_calendly_mappings").get().count, 6);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM ap_vera_calendly_mappings WHERE active = 1").get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM ap_runtime_config WHERE key LIKE 'VERA_CALENDLY_%'").get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM ap_runtime_config WHERE key = 'CALENDLY_EVENT_TYPE_URI'").get().count, 1);
  for (const path of [
    "src/server/vera/catalog.ts",
    "src/server/aggregator/runtime-config.ts",
    "template.manifest.json",
    ".env.example",
    ".dev.vars.example",
    "docs/cloudflare-runtime.md",
  ]) {
    assert.doesNotMatch(read(path), /VERA_CALENDLY_/);
    assert.match(read(path), /CALENDLY_EVENT_TYPE_URI/);
  }
  assert.equal(sqlite.prepare("SELECT value FROM ap_runtime_config WHERE key = 'site.identity'").get().value, "Vera Solaro");
  assert.equal(JSON.parse(sqlite.prepare("SELECT value_json FROM ap_business_settings WHERE key = 'site'").get().value_json).brandName, "Vera Solaro");
  assert.equal(sqlite.prepare("SELECT status FROM ap_vera_newsletter_subscriptions LIMIT 0").all().length, 0);
  const subscriptionColumns = sqlite.prepare("PRAGMA table_info(ap_vera_newsletter_subscriptions)").all().map((row) => row.name);
  assert.ok(subscriptionColumns.includes("confirmation_token_hash"));
  assert.ok(subscriptionColumns.includes("confirmation_expires_at"));
  assert.ok(subscriptionColumns.includes("birth_details_encrypted"));
  const accountColumns = sqlite.prepare("PRAGMA table_info(ap_customer_accounts)").all().map((row) => row.name);
  assert.ok(accountColumns.includes("email_verification_token_hash"));
  assert.ok(accountColumns.includes("email_verification_expires_at"));
  const bookingColumns = sqlite.prepare("PRAGMA table_info(ap_vera_bookings)").all().map((row) => row.name);
  assert.ok(bookingColumns.includes("manage_token_expires_at"));
  for (const table of [
    "ap_vera_rate_limits",
    "ap_vera_email_suppressions",
    "ap_vera_email_outbox",
    "ap_vera_newsletter_campaigns",
    "ap_vera_refunds",
    "ap_vera_invoices",
    "ap_vera_reschedule_requests",
    "ap_vera_reports",
    "ap_vera_private_files",
    "ap_vera_message_threads",
    "ap_vera_follow_ups",
  ]) {
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?").get(table).count, 1, table);
  }
  assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  assert.doesNotMatch(read("migrations/0008_vera_runtime.sql"), /SOLARO26/);
});

test("Vera price, hold, alias, and reschedule rules are server authoritative", async () => {
  assert.equal(VERA_DEPOSIT_CENTS, 8_000);
  assert.equal(VERA_HOLD_MINUTES, 12);
  assert.deepEqual(quoteInitialPayment({ priceCents: 24_000, paymentOption: "deposit" }), {
    priceCents: 24_000,
    giftAppliedCents: 0,
    totalDueCents: 24_000,
    payNowCents: 8_000,
    balanceCents: 24_000,
  });
  assert.deepEqual(quoteInitialPayment({ priceCents: 24_000, giftAvailableCents: 23_975, paymentOption: "full" }), {
    priceCents: 24_000,
    giftAppliedCents: 23_950,
    totalDueCents: 50,
    payNowCents: 50,
    balanceCents: 50,
  });
  assert.equal(bookingSlotStarts("2026-09-01T10:00:00.000Z", 90).length, 3);
  assert.equal(bookingSlotStarts("2026-09-01T10:00:00.000Z", 120).length, 4);
  const start = "2026-09-04T12:00:00.000Z";
  assert.equal(canUseFreeReschedule({ freeRescheduleUsed: false, scheduledStartAt: start, now: new Date("2026-09-01T12:00:00.000Z") }), true);
  assert.equal(canUseFreeReschedule({ freeRescheduleUsed: true, scheduledStartAt: start, now: new Date("2026-09-01T12:00:00.000Z") }), false);
  assert.equal(canUseFreeReschedule({ freeRescheduleUsed: false, scheduledStartAt: start, now: new Date("2026-09-01T12:00:00.001Z") }), false);

  const { sqlite, DB } = createDatabase();
  sqlite.prepare("UPDATE ap_runtime_config SET value = ? WHERE key = ?")
    .run("https://api.calendly.com/event_types/NATALCALL", "CALENDLY_EVENT_TYPE_URI");
  const selection = await getVeraSelection({ DB }, "natal", "call");
  assert.equal(selection.slug, "natal-hour");
  assert.equal(selection.eventTypeUri, "https://api.calendly.com/event_types/NATALCALL");
  sqlite.prepare("UPDATE ap_runtime_config SET value = ? WHERE key = 'STRIPE_PUBLISHABLE_KEY'")
    .run("pk_test_public_contract");
  const catalog = await listVeraCatalog({ DB, STRIPE_SECRET_KEY: "must-not-be-read-as-publishable" });
  assert.equal(catalog.stripePublishableKey, "pk_test_public_contract");
  assert.equal(catalog.activeWaitlistCount, 0);
  assert.doesNotMatch(read("src/server/vera/calendly.ts"), /isSourceScheduleSlot/);
});

test("Stripe and Calendly signed webhook verifiers enforce timestamped HMAC", async () => {
  const body = JSON.stringify({ id: "evt_contract" });
  const timestamp = 1_800_000_000;
  const stripeSecret = "whsec_contract_only";
  const stripeSignature = await hmacSha256Hex(stripeSecret, `${timestamp}.${body}`);
  assert.equal(await verifyStripeSignature({
    body,
    signatureHeader: `t=${timestamp},v1=${stripeSignature}`,
    signingSecret: stripeSecret,
    nowSeconds: timestamp,
  }), true);
  assert.equal(await verifyStripeSignature({
    body,
    signatureHeader: `t=${timestamp},v1=${stripeSignature}`,
    signingSecret: stripeSecret,
    nowSeconds: timestamp + 301,
  }), false);

  const calendlySecret = "calendly_contract_only";
  const calendlySignature = await hmacSha256Hex(calendlySecret, `${timestamp}.${body}`);
  assert.equal(await verifyCalendlySignature({
    body,
    signatureHeader: `t=${timestamp},v1=${calendlySignature}`,
    signingKey: calendlySecret,
    nowSeconds: timestamp,
  }), true);
});

test("booking creation rechecks live Calendly and atomically holds every overlapping segment", async () => {
  const { sqlite, DB } = createDatabase();
  const eventTypeUri = "https://api.calendly.com/event_types/NATALCALL";
  sqlite.prepare("UPDATE ap_runtime_config SET value = ? WHERE key = ?")
    .run(eventTypeUri, "CALENDLY_EVENT_TYPE_URI");
  const startAt = "2030-09-03T10:00:00.000Z";
  const place = await placeSelection({ DB });
  const env = {
    DB,
    ASTROPAGES_SITE_URL: "https://vera.test",
    EMDASH_ENCRYPTION_KEY: "contract-encryption-key",
    CALENDLY_API_TOKEN: "contract-calendly-token",
    fetch: async (input) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, "/event_type_available_times");
      assert.equal(url.searchParams.get("event_type"), eventTypeUri);
      return Response.json({ collection: [{ start_time: startAt, scheduling_url: "https://calendly.com/slot" }] });
    },
  };
  const result = await createVeraBooking({
    env,
    request: new Request("https://vera.test/api", { method: "POST" }),
    input: bookingInput({ startAt, placeSelectionToken: place.result.selectionToken }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.payNowCents, 8_000);
  assert.ok(result.manageToken);
  assert.equal(result.booking.paymentOption, "deposit");
  assert.equal(result.booking.holdExpiresAt, result.holdExpiresAt);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM ap_vera_booking_slot_holds WHERE booking_id = ?")
    .get(result.booking.id).count, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM ap_vera_email_outbox WHERE recipient_email = ?")
    .get("booking@example.test").count, 0);
  const lead = sqlite.prepare("SELECT source, page_path, details_json FROM ap_leads WHERE source_reference_id = ?")
    .get(result.booking.id);
  assert.equal(lead.source, "consultation_booking");
  assert.equal(lead.page_path, "/booking");
  assert.equal(JSON.parse(lead.details_json).paymentOption, "deposit");

  const directStatus = await getVeraBookingStatus({
    env,
    request: new Request("https://vera.test/api"),
    bookingId: result.booking.id,
    manageToken: result.manageToken,
  });
  assert.equal(directStatus.ok, true);
  assert.equal(directStatus.booking.paymentOption, "deposit");
  assert.equal(directStatus.booking.holdExpiresAt, result.holdExpiresAt);

  const queryOnlyStatus = await getVeraBookingStatusRoute({
    request: new Request(
      `https://vera.test/api/astropages/generated-site/vera/bookings/${result.booking.id}/status?manageToken=${result.manageToken}`,
    ),
    params: { id: result.booking.id },
    locals: { runtime: { env } },
  });
  assert.equal(queryOnlyStatus.status, 403);
  assert.equal(queryOnlyStatus.headers.get("cache-control"), "private, no-store");

  const bearerStatus = await getVeraBookingStatusRoute({
    request: new Request(
      `https://vera.test/api/astropages/generated-site/vera/bookings/${result.booking.id}/status`,
      { headers: { authorization: `Bearer ${result.manageToken}` } },
    ),
    params: { id: result.booking.id },
    locals: { runtime: { env } },
  });
  assert.equal(bearerStatus.status, 200);
  assert.equal(bearerStatus.headers.get("cache-control"), "private, no-store");
  const statusPayload = await bearerStatus.json();
  assert.equal(statusPayload.data.booking.paymentOption, "deposit");
  assert.equal(statusPayload.data.booking.holdExpiresAt, result.holdExpiresAt);

  const originalHoldExpiresAt = sqlite.prepare("SELECT hold_expires_at FROM ap_vera_bookings WHERE id = ?")
    .get(result.booking.id).hold_expires_at;
  env.STRIPE_SECRET_KEY = "sk_test_contract";
  env.PUBLIC_STRIPE_PUBLISHABLE_KEY = "pk_test_contract";
  env.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    assert.equal(url.href, "https://api.stripe.com/v1/payment_intents");
    assert.equal(init.method, "POST");
    assert.ok(init.signal instanceof AbortSignal);
    const body = new URLSearchParams(String(init.body));
    assert.equal(body.get("amount"), "8000");
    assert.equal(body.get("metadata[booking_id]"), result.booking.id);
    return Response.json({
      id: "pi_contract_prepared",
      client_secret: "pi_contract_prepared_secret_contract",
      amount: 8_000,
      currency: "usd",
      status: "requires_payment_method",
    });
  };
  const intent = await createStripePaymentIntent({
    env,
    request: new Request("https://vera.test/api", { method: "POST" }),
    bookingId: result.booking.id,
    manageToken: result.manageToken,
    kind: "deposit",
  });
  assert.equal(intent.ok, true);
  const extendedHoldExpiresAt = sqlite.prepare("SELECT hold_expires_at FROM ap_vera_bookings WHERE id = ?")
    .get(result.booking.id).hold_expires_at;
  assert.equal(intent.payment.holdExpiresAt, extendedHoldExpiresAt);
  assert.ok(new Date(extendedHoldExpiresAt).getTime() - new Date(originalHoldExpiresAt).getTime() > 40 * 60_000);
  assert.ok(new Date(extendedHoldExpiresAt).getTime() - Date.now() > 55 * 60_000);
  assert.deepEqual(
    sqlite.prepare("SELECT DISTINCT expires_at FROM ap_vera_booking_slot_holds WHERE booking_id = ?").all(result.booking.id)
      .map((row) => row.expires_at),
    [extendedHoldExpiresAt],
  );

  const realDateNow = Date.now;
  Date.now = () => realDateNow() + 6 * 60_000;
  const duplicate = await createVeraBooking({
    env,
    request: new Request("https://vera.test/api", { method: "POST" }),
    input: {
      ...bookingInput({ startAt, placeSelectionToken: place.result.selectionToken }),
      serviceSlug: "natal-hour",
    },
  }).finally(() => {
    Date.now = realDateNow;
  });
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.alreadyExists, true);
  assert.equal(duplicate.manageToken, result.manageToken);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM ap_vera_bookings").get().count, 1);
});

test("birth place intake is server-resolved and protected by an expiring opaque selection", async () => {
  const { DB } = createDatabase();
  const place = await placeSelection({ DB });
  assert.equal(place.result.place.formattedAddress, "Trieste, Italy");
  assert.equal(place.result.place.timezone, "Europe/Rome");
  const verified = await verifyVeraBirthPlaceSelection({
    env: place.env,
    token: place.result.selectionToken,
    birthDate: place.birthDate,
    birthTime: place.birthTime,
    birthTimeUnknown: false,
  });
  assert.equal(verified.placeId, "place_contract_trieste");
  assert.equal(await verifyVeraBirthPlaceSelection({
    env: place.env,
    token: `${place.result.selectionToken}tampered`,
    birthDate: place.birthDate,
    birthTime: place.birthTime,
    birthTimeUnknown: false,
  }), null);

  const routeSource = read("src/pages/api/astropages/generated-site/vera/places/details.ts");
  assert.match(routeSource, /export const POST/);
  assert.doesNotMatch(routeSource, /export const GET|searchParams/);
  const request = new Request("https://vera.test/api/astropages/generated-site/vera/places/details", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      placeId: "place_contract_trieste",
      sessionToken: "places-session-contract",
      birthDate: place.birthDate,
      birthTime: place.birthTime,
      birthTimeUnknown: false,
    }),
  });
  assert.equal(new URL(request.url).search, "");
  const response = await resolveVeraPlaceDetailsRoute({
    request,
    params: {},
    locals: { runtime: { env: place.env } },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const payload = await response.json();
  assert.equal(payload.status, "ready");
  assert.equal(payload.data.place.formattedAddress, "Trieste, Italy");
  assert.ok(payload.data.selectionToken);
});

test("unknown birth time accepts only the six source approximations and keeps the value encrypted and authorized", async () => {
  assert.deepEqual([...VERA_BIRTH_TIME_APPROXIMATIONS], [
    "Small hours",
    "Morning",
    "Around midday",
    "Afternoon",
    "Evening",
    "No idea at all",
  ]);
  assert.equal(normalizeVeraBirthTimeApproximation("Evening"), "Evening");
  assert.equal(normalizeVeraBirthTimeApproximation("evening"), "");
  assert.equal(normalizeVeraBirthTimeApproximation("Night"), "");

  const { sqlite, DB } = createDatabase();
  const eventTypeUri = "https://api.calendly.com/event_types/NATALCALL";
  sqlite.prepare("UPDATE ap_runtime_config SET value = ? WHERE key = ?")
    .run(eventTypeUri, "CALENDLY_EVENT_TYPE_URI");
  const unknownPlace = await placeSelection({ DB, birthTime: "", birthTimeUnknown: true });
  const knownPlace = await placeSelection({ DB });
  const startAt = "2030-09-03T10:00:00.000Z";
  const env = {
    DB,
    ASTROPAGES_SITE_URL: "https://vera.test",
    EMDASH_ENCRYPTION_KEY: "contract-encryption-key",
    CALENDLY_API_TOKEN: "contract-calendly-token",
    fetch: async (input) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, "/event_type_available_times");
      return Response.json({ collection: [{ start_time: startAt, scheduling_url: "https://calendly.com/slot" }] });
    },
  };
  const unknownInput = {
    ...bookingInput({
      startAt,
      placeSelectionToken: unknownPlace.result.selectionToken,
      idempotencyKey: "booking-unknown-time-contract",
    }),
    intake: {
      birthDate: unknownPlace.birthDate,
      birthTime: "",
      birthTimeUnknown: true,
      birthTimeApproximation: "Evening",
      placeSelectionToken: unknownPlace.result.selectionToken,
      focus: "Private unknown-time contract focus.",
    },
  };
  for (const [idempotencyKey, intake] of [
    ["booking-unknown-missing-contract", { ...unknownInput.intake, birthTimeApproximation: undefined }],
    ["booking-unknown-invalid-contract", { ...unknownInput.intake, birthTimeApproximation: "evening" }],
    ["booking-known-extra-contract", {
      ...bookingInput({ startAt, placeSelectionToken: knownPlace.result.selectionToken }).intake,
      birthTimeApproximation: "Evening",
    }],
  ]) {
    const invalid = await createVeraBooking({
      env,
      request: new Request("https://vera.test/api", { method: "POST" }),
      input: { ...unknownInput, idempotencyKey, intake },
    });
    assert.equal(invalid.status, 400);
  }
  const created = await createVeraBooking({
    env,
    request: new Request("https://vera.test/api", { method: "POST" }),
    input: unknownInput,
  });
  assert.equal(created.ok, true);
  const persisted = sqlite.prepare("SELECT * FROM ap_vera_bookings WHERE id = ?").get(created.booking.id);
  assert.ok(persisted.encrypted_intake.startsWith("v1:"));
  assert.doesNotMatch(persisted.encrypted_intake, /Evening/);
  assert.equal("birth_time_approximation" in persisted, false);
  assert.deepEqual(await decryptVeraPrivateJson(env, persisted.encrypted_intake), {
    birthDate: "1990-01-02",
    birthTime: "",
    birthTimeUnknown: true,
    birthTimeApproximation: "Evening",
    birthPlace: "Trieste, Italy",
    birthPlaceId: "place_contract_trieste",
    birthLatitude: 45.6495,
    birthLongitude: 13.7768,
    birthTimezone: "Europe/Rome",
    birthTimezoneOffset: "UTC+01:00",
    focus: "Private unknown-time contract focus.",
  });
  assert.doesNotMatch(JSON.stringify(persisted), /Evening/);
  assert.doesNotMatch(JSON.stringify(sqlite.prepare("SELECT * FROM ap_leads WHERE source_reference_id = ?").all(created.booking.id)), /Evening/);
  assert.doesNotMatch(JSON.stringify(sqlite.prepare("SELECT * FROM ap_business_events").all()), /Evening/);

  const status = await getVeraBookingStatus({
    env,
    request: new Request("https://vera.test/api"),
    bookingId: created.booking.id,
    manageToken: created.manageToken,
  });
  assert.equal(status.booking.birthTimeUnknown, true);
  assert.equal(status.booking.birthTimeApproximation, "Evening");
  for (const forbidden of ["birthDate", "birthPlace", "birthPlaceId", "birthLatitude", "birthLongitude", "focus"]) {
    assert.equal(forbidden in status.booking, false);
  }

  const session = await createVerifiedAccountSession(sqlite);
  sqlite.prepare("UPDATE ap_vera_bookings SET account_id = ? WHERE id = ?")
    .run(session.accountId, created.booking.id);
  const portal = await getVeraAccountPortal(
    env,
    new Request("https://vera.test/account", { headers: { cookie: session.cookie } }),
  );
  const authorizedIntake = portal.bookings.find((booking) => booking.id === created.booking.id).intake;
  assert.deepEqual(authorizedIntake, {
    birthDate: "1990-01-02",
    birthTime: "",
    birthTimeUnknown: true,
    birthTimeApproximation: "Evening",
    birthPlace: "Trieste, Italy",
  });
  for (const forbidden of ["birthPlaceId", "birthLatitude", "birthLongitude", "birthTimezone", "focus"]) {
    assert.equal(forbidden in authorizedIntake, false);
  }
});

test("pending quote, custom reschedule, follow-ups, and eligible cancellation stay server authoritative", async () => {
  const { sqlite, DB } = createDatabase();
  const eventTypeUri = "https://api.calendly.com/event_types/NATALCALL";
  sqlite.prepare("UPDATE ap_runtime_config SET value = ? WHERE key = ?")
    .run(eventTypeUri, "CALENDLY_EVENT_TYPE_URI");
  const oldStartAt = "2030-09-03T10:00:00.000Z";
  const newStartAt = "2030-09-04T10:00:00.000Z";
  const newEndAt = "2030-09-04T10:30:00.000Z";
  const place = await placeSelection({ DB });
  const env = {
    DB,
    ASTROPAGES_SITE_URL: "https://vera.test",
    EMDASH_ENCRYPTION_KEY: "contract-encryption-key",
    CALENDLY_API_TOKEN: "contract-calendly-token",
    STRIPE_SECRET_KEY: "sk_test_contract",
    fetch: async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/event_type_available_times") {
        return Response.json({ collection: [{ start_time: oldStartAt, scheduling_url: "https://calendly.com/old" }] });
      }
      throw new Error(`Unexpected provider call ${init.method || "GET"} ${url}`);
    },
  };
  const created = await createVeraBooking({
    env,
    request: new Request("https://vera.test/api", { method: "POST" }),
    input: bookingInput({
      startAt: oldStartAt,
      placeSelectionToken: place.result.selectionToken,
      idempotencyKey: "booking-contract-lifecycle",
    }),
  });
  assert.equal(created.ok, true);
  const bookingId = created.booking.id;
  const giftHash = await giftCodeHash("TEST-GIFT-5000");
  sqlite.prepare(`INSERT INTO ap_vera_gift_certificates
    (id, code_hash, status, original_amount_cents, remaining_amount_cents, currency, expires_at, issued_at, updated_at)
    VALUES ('vgift_contract', ?, 'active', 5000, 5000, 'USD', NULL, ?, ?)`)
    .run(giftHash, new Date().toISOString(), new Date().toISOString());
  const quoted = await updateVeraBookingQuote({
    env,
    request: new Request("https://vera.test/api", { method: "POST" }),
    bookingId,
    manageToken: created.manageToken,
    input: { giftCode: "TEST-GIFT-5000", paymentOption: "deposit" },
  });
  assert.equal(quoted.ok, true);
  assert.deepEqual({
    giftAppliedCents: quoted.quote.giftAppliedCents,
    totalDueCents: quoted.quote.totalDueCents,
    payNowCents: quoted.quote.payNowCents,
  }, { giftAppliedCents: 5000, totalDueCents: 19000, payNowCents: 8000 });
  const quotedAgain = await updateVeraBookingQuote({
    env,
    request: new Request("https://vera.test/api", { method: "POST" }),
    bookingId,
    manageToken: created.manageToken,
    input: { giftCode: "TEST-GIFT-5000", paymentOption: "deposit" },
  });
  assert.equal(quotedAgain.ok, true);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM ap_vera_gift_redemptions WHERE booking_id = ?").get(bookingId).count, 1);

  const paymentAt = new Date().toISOString();
  sqlite.prepare(`INSERT INTO ap_vera_payment_attempts
    (id, booking_id, kind, provider, provider_payment_intent_id, idempotency_key,
     amount_cents, currency, status, last_error_code, created_at, updated_at)
    VALUES ('vpay_contract', ?, 'deposit', 'stripe', 'pi_contract_paid', 'payment-contract-lifecycle',
      8000, 'USD', 'requires_payment_method', NULL, ?, ?)`)
    .run(bookingId, paymentAt, paymentAt);
  const locked = await updateVeraBookingQuote({
    env,
    request: new Request("https://vera.test/api", { method: "POST" }),
    bookingId,
    manageToken: created.manageToken,
    input: { paymentOption: "full" },
  });
  assert.equal(locked.ok, false);
  assert.equal(locked.status, 409);
  sqlite.prepare("UPDATE ap_vera_payment_attempts SET status = 'succeeded' WHERE id = 'vpay_contract'").run();
  sqlite.prepare(`UPDATE ap_vera_bookings SET status = 'confirmed', payment_state = 'deposit_paid',
    paid_cents = 8000, balance_cents = 11000, hold_expires_at = NULL,
    calendly_event_uri = 'https://api.calendly.com/scheduled_events/OLD',
    calendly_invitee_uri = 'https://api.calendly.com/scheduled_events/OLD/invitees/ONE',
    calendly_reschedule_url = 'https://calendly.com/resched/old', confirmed_at = ?, updated_at = ?
    WHERE id = ?`).run(paymentAt, paymentAt, bookingId);
  sqlite.prepare("UPDATE ap_vera_booking_slot_holds SET expires_at = NULL WHERE booking_id = ?").run(bookingId);

  env.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/event_type_available_times") {
      return Response.json({ collection: [{ start_time: newStartAt, scheduling_url: "https://calendly.com/new" }] });
    }
    if (url.href === eventTypeUri) {
      return Response.json({ resource: { active: true, duration: 30, locations: [{ kind: "physical" }] } });
    }
    if (url.pathname === "/invitees" && init.method === "POST") {
      return Response.json({
        resource: {
          uri: "https://api.calendly.com/scheduled_events/NEW/invitees/TWO",
          event: {
            uri: "https://api.calendly.com/scheduled_events/NEW",
            start_time: newStartAt,
            end_time: newEndAt,
            location: { join_url: "https://meet.example.test/private" },
          },
          cancel_url: "https://calendly.com/cancel/new",
          reschedule_url: "https://calendly.com/resched/new",
        },
      }, { status: 201 });
    }
    if (url.pathname === "/scheduled_events/OLD/cancellation" && init.method === "POST") {
      return Response.json({ resource: {} });
    }
    throw new Error(`Unexpected provider call ${init.method || "GET"} ${url}`);
  };
  const rescheduled = await completeVeraReschedule({
    env,
    request: new Request("https://vera.test/api", { method: "POST" }),
    bookingId,
    manageToken: created.manageToken,
    newStartAt,
  });
  assert.equal(rescheduled.ok, true);
  assert.equal(rescheduled.actionRequired, false);
  const afterReschedule = sqlite.prepare("SELECT * FROM ap_vera_bookings WHERE id = ?").get(bookingId);
  assert.equal(afterReschedule.selected_start_at, newStartAt);
  assert.equal(afterReschedule.free_reschedule_used, 1);
  assert.equal(afterReschedule.reschedule_count, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM ap_vera_booking_slot_holds WHERE booking_id = ?").get(bookingId).count, 1);
  assert.equal(sqlite.prepare("SELECT status FROM ap_vera_reschedule_requests WHERE booking_id = ?").get(bookingId).status, "completed");
  const balanceFollowUp = sqlite.prepare("SELECT due_at FROM ap_vera_follow_ups WHERE booking_id = ? AND kind = 'balance_reminder'").get(bookingId);
  assert.equal(balanceFollowUp.due_at, "2030-09-05T10:30:00.000Z");
  sqlite.prepare("UPDATE ap_vera_follow_ups SET due_at = '2020-01-01T00:00:00.000Z' WHERE booking_id = ? AND kind = 'intake_reminder'")
    .run(bookingId);
  const dispatched = await dispatchDueFollowUps({ env, now: new Date("2026-08-15T00:00:00.000Z") });
  assert.equal(dispatched.ok, true);
  assert.equal(dispatched.dispatched, 1);

  env.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/scheduled_events/NEW/cancellation" && init.method === "POST") {
      return Response.json({ resource: {} });
    }
    if (url.pathname === "/v1/refunds" && init.method === "POST") {
      assert.equal(new URLSearchParams(String(init.body)).get("amount"), "8000");
      return Response.json({ id: "re_contract_refund", status: "pending" });
    }
    throw new Error(`Unexpected provider call ${init.method || "GET"} ${url}`);
  };
  const cancelled = await cancelVeraBooking({
    env,
    request: new Request("https://vera.test/api", { method: "POST" }),
    bookingId,
    manageToken: created.manageToken,
    reason: "Plans changed",
  });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.refundEligible, true);
  assert.equal(cancelled.refundState, "processing");
  assert.equal(sqlite.prepare("SELECT status FROM ap_vera_refunds WHERE booking_id = ?").get(bookingId).status, "pending");
  assert.equal(sqlite.prepare("SELECT remaining_amount_cents FROM ap_vera_gift_certificates WHERE id = 'vgift_contract'").get().remaining_amount_cents, 5000);
});

test("engagement leads use the approved sources and waitlist returns privacy-safe position", async () => {
  const { sqlite, DB } = createDatabase();
  const request = new Request("https://vera.test/api", { method: "POST" });
  const contact = await submitVeraContact({
    env: { DB },
    request,
    input: {
      name: "Contact Reader",
      email: "contact@example.test",
      topic: "birth-time-help",
      message: "Please help me locate the correct record.",
      consentContact: true,
    },
  });
  assert.equal(contact.ok, true);
  const waiting = await joinVeraWaitlist({
    env: { DB },
    request,
    input: {
      name: "Waiting Reader",
      email: "waiting@example.test",
      serviceSlug: "year",
      mode: "call",
      earliestDate: "2030-09-01",
      latestDate: "2030-10-01",
      shortNotice: true,
      consentContact: true,
    },
  });
  assert.equal(waiting.ok, true);
  assert.equal(waiting.waitPosition, 1);
  assert.equal(waiting.activeWaitlistCount, 1);
  const contactLead = sqlite.prepare("SELECT source, details_json FROM ap_leads WHERE source_reference_id = ?").get(contact.requestId);
  assert.equal(contactLead.source, "contact");
  assert.deepEqual(JSON.parse(contactLead.details_json), { topic: "birth-time-help" });
  const waitLead = sqlite.prepare("SELECT kind, source, page_path, details_json FROM ap_leads WHERE source_reference_id = ?").get(waiting.waitlistId);
  assert.equal(waitLead.kind, "waitlist");
  assert.equal(waitLead.source, "waitlist");
  assert.equal(waitLead.page_path, "/booking");
  assert.equal(JSON.parse(waitLead.details_json).consultationMode, "call");
  assert.equal("message" in JSON.parse(waitLead.details_json), false);
});

test("authenticated account read privately claims only matching unlinked Vera history", async () => {
  const { sqlite, DB } = createDatabase();
  const env = {
    DB,
    ASTROPAGES_SITE_URL: "https://vera.test",
    EMDASH_ENCRYPTION_KEY: "contract-encryption-key",
  };
  const accountRequest = new Request("https://vera.test/signup", { method: "POST" });
  const encryptedIntake = await encryptVeraPrivateJson(env, {
    birthDate: "1990-01-02",
    birthTime: "10:30",
    birthTimeUnknown: false,
    birthPlace: "Trieste, Italy",
    birthPlaceId: "place_contract_trieste",
    birthLatitude: 45.6495,
    birthLongitude: 13.7768,
    birthTimezone: "Europe/Rome",
    birthTimezoneOffset: "UTC+02:00",
    focus: "Private owner-only intention that must not leave the intake allowlist.",
  });
  assert.ok(encryptedIntake);
  sqlite.prepare(`INSERT INTO ap_vera_bookings
    (id, booking_number, request_idempotency_key, account_id, service_slug, mode,
     status, payment_state, payment_option, customer_name, email, normalized_email,
     phone, customer_timezone, selected_start_at, selected_end_at, price_cents,
     gift_applied_cents, total_due_cents, paid_cents, balance_cents, currency,
     gift_certificate_id, manage_token_hash, manage_token_expires_at, encrypted_intake, calendly_event_type_uri,
     hold_expires_at, created_at, updated_at)
    VALUES ('vbooking_claim', 'VS-CLAIM', 'booking-claim-contract', NULL, 'natal-hour', 'call',
      'completed', 'deposit_paid', 'deposit', 'Claimed Reader', 'claim@example.test', 'claim@example.test',
      NULL, 'UTC', '2030-09-01T10:00:00.000Z', '2030-09-01T11:30:00.000Z', 24000,
      0, 24000, 8000, 16000, 'USD', NULL, 'hash', '2099-01-01T00:00:00.000Z', ?,
      'https://api.calendly.com/event_types/NATALCALL', NULL, ?, ?)`)
    .run(encryptedIntake, new Date().toISOString(), new Date().toISOString());
  sqlite.prepare(`INSERT INTO ap_vera_waitlist_entries
    (id, account_id, customer_name, email, normalized_email, phone, service_slug, mode,
     earliest_date, latest_date, short_notice, status, created_at, updated_at)
    VALUES ('vwait_claim', NULL, 'Claimed Reader', 'claim@example.test', 'claim@example.test', NULL,
      'natal-hour', 'call', NULL, NULL, 1, 'active', ?, ?)`)
    .run(new Date().toISOString(), new Date().toISOString());
  const signedUp = await signupCustomer({
    env,
    request: accountRequest,
    displayName: "Claimed Reader",
    email: "claim@example.test",
    password: "contract-password",
    createSession: true,
  });
  // Signup opens the room straight away: the account is usable and the session
  // cookie is issued in the same request, with no email round trip in between.
  assert.equal(signedUp.ok, true);
  assert.equal(signedUp.created, true);
  assert.ok(signedUp.cookies.length > 0);
  assert.ok(signedUp.csrfToken);
  const accountRow = sqlite.prepare("SELECT * FROM ap_customer_accounts WHERE email = ?").get("claim@example.test");
  assert.ok(accountRow.email_verified_at);
  assert.equal(accountRow.email_verification_token_hash, null);
  const unauthenticated = await getVeraAccountPortal(env, new Request("https://vera.test/account"));
  assert.equal(unauthenticated.status, 401);
  const welcomeMail = sqlite.prepare(`SELECT payload_json FROM ap_vera_email_outbox
    WHERE event_type = 'customer.welcome' AND recipient_email = ?`).get("claim@example.test");
  const welcomePayload = JSON.parse(welcomeMail.payload_json);
  assert.equal(new URL(welcomePayload.accountUrl).pathname, "/account");
  assert.equal(welcomePayload.verificationUrl, undefined);

  // A second signup on the same email is a way back in, never a second account,
  // and only when the password given actually matches the one on file.
  const wrongPasswordDuplicate = await signupCustomer({
    env,
    request: accountRequest,
    displayName: "Claimed Reader Latest",
    email: "claim@example.test",
    password: "not-the-contract-password",
    createSession: true,
  });
  assert.equal(wrongPasswordDuplicate.ok, false);
  const returningDuplicate = await signupCustomer({
    env,
    request: accountRequest,
    displayName: "Claimed Reader Latest",
    email: "claim@example.test",
    password: "contract-password",
    createSession: true,
  });
  assert.equal(returningDuplicate.ok, true);
  assert.equal(returningDuplicate.created, false);
  assert.ok(returningDuplicate.cookies.length > 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM ap_customer_accounts WHERE email = ?")
    .get("claim@example.test").count, 1);

  const staleCredentialLogin = await loginCustomer({
    env,
    request: accountRequest,
    email: "claim@example.test",
    password: "newest-contract-password",
  });
  assert.equal(staleCredentialLogin.ok, false);
  const loggedIn = await loginCustomer({
    env,
    request: accountRequest,
    email: "claim@example.test",
    password: "contract-password",
  });
  assert.equal(loggedIn.ok, true);
  const cookie = loggedIn.cookies.map((entry) => entry.split(";")[0]).join("; ");
  const portal = await getVeraAccountPortal(
    env,
    new Request("https://vera.test/account", { headers: { cookie } }),
  );
  assert.equal(portal.ok, true);
  assert.equal(portal.bookings.length, 1);
  assert.equal(portal.waitlist.length, 1);
  assert.deepEqual(portal.bookings[0].intake, {
    birthDate: "1990-01-02",
    birthTime: "10:30",
    birthTimeUnknown: false,
    birthPlace: "Trieste, Italy",
  });
  assert.equal("encrypted_intake" in portal.bookings[0], false);
  assert.equal("birthPlaceId" in portal.bookings[0].intake, false);
  assert.equal("birthLatitude" in portal.bookings[0].intake, false);
  assert.equal("birthLongitude" in portal.bookings[0].intake, false);
  assert.equal("birthTimezone" in portal.bookings[0].intake, false);
  assert.equal("focus" in portal.bookings[0].intake, false);
  const claimedBooking = sqlite.prepare("SELECT account_id, manage_token_hash, manage_token_expires_at FROM ap_vera_bookings WHERE id = 'vbooking_claim'").get();
  assert.equal(claimedBooking.account_id, accountRow.id);
  assert.equal(claimedBooking.manage_token_hash, null);
  assert.equal(claimedBooking.manage_token_expires_at, null);
  assert.equal(sqlite.prepare("SELECT account_id FROM ap_vera_waitlist_entries WHERE id = 'vwait_claim'").get().account_id, accountRow.id);
  assert.equal(portal.threads.length, 1);

  const accountResponse = await getVeraAccountRoute({
    request: new Request("https://vera.test/api/astropages/generated-site/vera/account", { headers: { cookie } }),
    params: {},
    locals: { runtime: { env } },
  });
  assert.equal(accountResponse.status, 200);
  assert.equal(accountResponse.headers.get("cache-control"), "private, no-store");
  const accountPayload = await accountResponse.json();
  assert.deepEqual(accountPayload.data.bookings[0].intake, portal.bookings[0].intake);

  const resendResponse = await postVeraAccountRoute({
    request: new Request("https://vera.test/api/astropages/generated-site/vera/account", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        "x-csrf-token": loggedIn.csrfToken,
      },
      body: JSON.stringify({ action: "resend_receipt", bookingId: "vbooking_claim" }),
    }),
    params: {},
    locals: { runtime: { env } },
  });
  assert.equal(resendResponse.status, 202);
  assert.equal(resendResponse.headers.get("cache-control"), "private, no-store");
  const resendPayload = await resendResponse.json();
  assert.equal(resendPayload.status, "ready");
  const receipt = sqlite.prepare(`SELECT event_type, template_key, recipient_email, payload_json
    FROM ap_vera_email_outbox WHERE idempotency_key LIKE 'receipt-resend:vbooking_claim:%'`).get();
  assert.equal(receipt.event_type, "vera.receipt.issued");
  assert.equal(receipt.template_key, "vera_receipt_en");
  assert.equal(receipt.recipient_email, "claim@example.test");
  assert.equal(
    sqlite.prepare("SELECT event_type FROM ap_email_templates WHERE key = ?").get(receipt.template_key).event_type,
    "vera.receipt.issued",
  );
  assert.deepEqual(Object.keys(JSON.parse(receipt.payload_json)).sort(), [
    "accountUrl",
    "balanceAmount",
    "bookingNumber",
    "customerName",
    "paidAmount",
    "priceAmount",
    "scheduledDateTime",
    "serviceName",
  ]);

  // A signup on a taken email with the wrong password is turned away: it never
  // rewrites the credentials on file and never makes a second account.
  const duplicate = await signupCustomer({
    env,
    request: accountRequest,
    displayName: "Any supplied name",
    email: "claim@example.test",
    password: "different-password",
    createSession: true,
  });
  assert.equal(duplicate.ok, false);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM ap_customer_accounts WHERE email = ?")
    .get("claim@example.test").count, 1);
  assert.equal((await loginCustomer({
    env,
    request: accountRequest,
    email: "claim@example.test",
    password: "contract-password",
  })).ok, true);

  const resetRequested = await requestCustomerPasswordReset({
    env,
    request: new Request("https://vera.test/forgot-password", { method: "POST" }),
    email: "claim@example.test",
  });
  assert.equal(resetRequested.ok, true);
  assert.equal(resetRequested.emailSent, true);
  assert.equal(resetRequested.resetUrl, "");
  const resetMail = sqlite.prepare(`SELECT payload_json FROM ap_vera_email_outbox
    WHERE event_type = 'customer.password_reset' ORDER BY created_at DESC LIMIT 1`).get();
  const resetUrl = new URL(JSON.parse(resetMail.payload_json).resetUrl);
  const resetToken = resetUrl.searchParams.get("token");
  assert.ok(resetToken);
  assert.equal((await resetCustomerPassword({ env, token: resetToken, password: "replacement-password" })).ok, true);
  assert.equal((await resetCustomerPassword({ env, token: resetToken, password: "another-password" })).ok, false);
  assert.equal((await getVeraAccountPortal(
    env,
    new Request("https://vera.test/account", { headers: { cookie } }),
  )).status, 401);
  const recoveredLogin = await loginCustomer({
    env,
    request: accountRequest,
    email: "claim@example.test",
    password: "replacement-password",
  });
  assert.equal(recoveredLogin.ok, true);
  const recoveredCookie = recoveredLogin.cookies.map((entry) => entry.split(";")[0]).join("; ");

  // A deployed origin never hands the link back over the API; only a localhost caller
  // gets the echo, which is the Pandit reference contract.
  const localResetRequested = await requestCustomerPasswordReset({
    env,
    request: new Request("http://localhost:4321/forgot-password", { method: "POST" }),
    email: "claim@example.test",
  });
  assert.equal(localResetRequested.emailSent, true);
  assert.match(localResetRequested.resetUrl, /\/reset-password\?token=[0-9a-f]{64}$/);
  const unknownResetRequested = await requestCustomerPasswordReset({
    env,
    request: new Request("http://localhost:4321/forgot-password", { method: "POST" }),
    email: "nobody@example.test",
  });
  assert.equal(unknownResetRequested.ok, true);
  assert.equal(unknownResetRequested.emailSent, false);
  assert.equal(unknownResetRequested.resetUrl, "");

  const threadId = portal.threads[0].id;
  const messageRequest = new Request("https://vera.test/api/astropages/generated-site/vera/account/messages", {
    method: "POST",
    headers: { cookie: recoveredCookie, "x-csrf-token": recoveredLogin.csrfToken },
  });
  const concurrentMessages = await Promise.all([
    sendVeraCustomerMessage(env, messageRequest, {
      threadId,
      body: "One careful follow-up question.",
    }),
    sendVeraCustomerMessage(env, messageRequest, {
      threadId,
      body: "A simultaneous second question must not be accepted.",
    }),
  ]);
  assert.deepEqual(concurrentMessages.map((result) => result.status).sort(), [201, 409]);
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM ap_vera_messages
    WHERE thread_id = ? AND sender_role = 'customer'`).get(threadId).count, 1);

  sqlite.prepare(`INSERT INTO ap_vera_private_files
    (id, account_id, booking_id, report_id, kind, file_name, content_type,
     size_bytes, storage_key, created_at)
    VALUES ('vfile_range', ?, 'vbooking_claim', NULL, 'recording', 'sitting.mp3',
      'audio/mpeg', 10, 'private/vera/range.mp3', ?)`).run(accountRow.id, new Date().toISOString());
  let storageReads = 0;
  let requestedRange = null;
  env.MEDIA = {
    async get(key, options) {
      storageReads += 1;
      assert.equal(key, "private/vera/range.mp3");
      requestedRange = options?.range ?? null;
      const bytes = new TextEncoder().encode("0123456789");
      const body = requestedRange
        ? bytes.slice(requestedRange.offset, requestedRange.offset + requestedRange.length)
        : bytes;
      return { body };
    },
  };
  const rangeResponse = await getVeraAccountFileRoute({
    request: new Request("https://vera.test/api/astropages/generated-site/vera/account/files/vfile_range", {
      headers: { cookie: recoveredCookie, range: "bytes=2-5" },
    }),
    params: { id: "vfile_range" },
    locals: { runtime: { env } },
  });
  assert.equal(rangeResponse.status, 206);
  assert.equal(rangeResponse.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(rangeResponse.headers.get("accept-ranges"), "bytes");
  assert.equal(rangeResponse.headers.get("content-length"), "4");
  assert.equal(rangeResponse.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(requestedRange, { offset: 2, length: 4 });
  assert.equal(await rangeResponse.text(), "2345");
  const readsBeforeInvalid = storageReads;
  const invalidRangeResponse = await getVeraAccountFileRoute({
    request: new Request("https://vera.test/api/astropages/generated-site/vera/account/files/vfile_range", {
      headers: { cookie: recoveredCookie, range: "bytes=1-2,4-5" },
    }),
    params: { id: "vfile_range" },
    locals: { runtime: { env } },
  });
  assert.equal(invalidRangeResponse.status, 416);
  assert.equal(invalidRangeResponse.headers.get("content-range"), "bytes */10");
  assert.equal(invalidRangeResponse.headers.get("cache-control"), "private, no-store");
  assert.equal(storageReads, readsBeforeInvalid);
});

test("newsletter is double opt-in and suppression is checked at send time", async () => {
  const { sqlite, DB } = createDatabase();
  const env = {
    DB,
    ASTROPAGES_SITE_URL: "https://vera.test",
    EMDASH_ENCRYPTION_KEY: "newsletter-private-data-contract-key",
  };
  const subscribed = await subscribeVeraNewsletter({
    env,
    email: "reader@example.test",
    displayName: "Reader",
    birthDate: "11 February 1994",
    birthTime: "06:42",
  });
  assert.equal(subscribed.ok, true);
  const pending = sqlite.prepare("SELECT * FROM ap_vera_newsletter_subscriptions WHERE normalized_email = ?")
    .get("reader@example.test");
  assert.equal(pending.status, "pending");
  assert.ok(pending.confirmation_token_hash);
  assert.ok(pending.birth_details_encrypted.startsWith("v1:"));
  assert.doesNotMatch(pending.birth_details_encrypted, /1994|06:42/);
  assert.deepEqual(
    await decryptVeraPrivateJson(env, pending.birth_details_encrypted),
    { birthDate: "11 February 1994", birthTime: "06:42" },
  );
  const outbox = sqlite.prepare("SELECT payload_json FROM ap_vera_email_outbox WHERE event_type = 'vera.newsletter.confirm'").get();
  const link = new URL(JSON.parse(outbox.payload_json).confirmationUrl);
  const confirmed = await confirmVeraNewsletter({
    env,
    subscriptionId: link.searchParams.get("id"),
    token: link.searchParams.get("token"),
  });
  assert.equal(confirmed.ok, true);
  assert.equal(sqlite.prepare("SELECT status FROM ap_vera_newsletter_subscriptions WHERE id = ?").get(pending.id).status, "subscribed");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM ap_leads WHERE source_reference_id = ?").get(pending.id).count, 1);

  sqlite.prepare(`INSERT INTO ap_vera_email_suppressions
    (normalized_email, reason, provider_event_id, detail_code, created_at, updated_at)
    VALUES (?, 'manual', NULL, NULL, ?, ?)`)
    .run("reader@example.test", new Date().toISOString(), new Date().toISOString());
  let fetchCalled = false;
  const processed = await processEmailOutbox({
    env: { ...env, fetch: async () => { fetchCalled = true; throw new Error("must not send"); } },
  });
  assert.equal(fetchCalled, false);
  assert.equal(processed.suppressed >= 1, true);
  assert.equal(sqlite.prepare("SELECT status FROM ap_vera_email_outbox LIMIT 1").get().status, "cancelled");
});

test("newsletter unsubscribe suppresses marketing without cancelling transactional or security mail", async () => {
  const { sqlite, DB } = createDatabase();
  const env = {
    DB,
    ASTROPAGES_SITE_URL: "https://vera.test",
    EMDASH_ENCRYPTION_KEY: "newsletter-marketing-only-contract-key",
  };
  await subscribeVeraNewsletter({ env, email: "transactional@example.test", displayName: "Reader" });
  const subscription = sqlite.prepare("SELECT * FROM ap_vera_newsletter_subscriptions WHERE normalized_email = ?")
    .get("transactional@example.test");
  const confirmationPayload = JSON.parse(sqlite.prepare(`SELECT payload_json FROM ap_vera_email_outbox
    WHERE event_type = 'vera.newsletter.confirm' AND recipient_email = ?`).get("transactional@example.test").payload_json);
  const confirmationUrl = new URL(confirmationPayload.confirmationUrl);
  assert.equal((await confirmVeraNewsletter({
    env,
    subscriptionId: confirmationUrl.searchParams.get("id"),
    token: confirmationUrl.searchParams.get("token"),
  })).ok, true);
  await enqueueVeraEmail({
    env,
    eventType: "vera.newsletter.dispatch",
    templateKey: "vera_newsletter_dispatch_en",
    recipientEmail: "transactional@example.test",
    payload: {
      customerName: "Reader",
      campaignSubject: "A monthly note",
      campaignBody: "Marketing body.",
      unsubscribeUrl: "https://vera.test/unsubscribe",
      subscriptionId: subscription.id,
    },
    idempotencyKey: "newsletter-marketing-only-contract",
  });
  await enqueueVeraEmail({
    env,
    eventType: "vera.receipt.issued",
    templateKey: "vera_receipt_en",
    recipientEmail: "transactional@example.test",
    payload: {
      customerName: "Reader",
      bookingNumber: "VS-TRANSACTIONAL",
      serviceName: "The Natal Hour",
      scheduledDateTime: "2030-09-03T10:00:00.000Z",
      priceAmount: "$240.00",
      paidAmount: "$80.00",
      balanceAmount: "$160.00",
      accountUrl: "https://vera.test/account",
    },
    idempotencyKey: "newsletter-transactional-survives-contract",
  });
  const token = await createUnsubscribeToken(env, subscription.id);
  assert.equal((await unsubscribeVeraNewsletter({ env, token })).ok, true);
  assert.deepEqual(sqlite.prepare(`SELECT idempotency_key, status FROM ap_vera_email_outbox
    WHERE idempotency_key IN (?, ?) ORDER BY idempotency_key`).all(
    "newsletter-marketing-only-contract",
    "newsletter-transactional-survives-contract",
  ).map((row) => ({ ...row })), [
    { idempotency_key: "newsletter-marketing-only-contract", status: "cancelled" },
    { idempotency_key: "newsletter-transactional-survives-contract", status: "pending" },
  ]);
  await processEmailOutbox({ env, limit: 20 });
  const transactional = sqlite.prepare(`SELECT status, last_error_code FROM ap_vera_email_outbox
    WHERE idempotency_key = ?`).get("newsletter-transactional-survives-contract");
  assert.equal(transactional.status, "retry");
  assert.equal(transactional.last_error_code, "provider_not_configured");
  assert.equal(sqlite.prepare(`SELECT reason FROM ap_vera_email_suppressions
    WHERE normalized_email = ?`).get("transactional@example.test").reason, "unsubscribe");
});

test("SES provider stalls are bounded and return a sanitized retryable failure", async () => {
  const result = await sendSesTransactionalEmail({
    env: {
      AWS_REGION: "eu-west-1",
      AWS_ACCESS_KEY_ID: "access-contract",
      AWS_SECRET_ACCESS_KEY: "secret-contract",
    },
    message: {
      to: [{ email: "reader@example.test" }],
      sender: { email: "vera@example.test", name: "Vera Solaro" },
      subject: "Contract",
      html: "<p>Contract</p>",
      text: "Contract",
    },
    fetch: async (_input, init = {}) => {
      assert.ok(init.signal instanceof AbortSignal);
      throw new DOMException("timed out with provider details", "AbortError");
    },
  });
  assert.deepEqual(result, { ok: false, message: "AWS SES is temporarily unavailable." });
});

test("Stripe PaymentIntent creation remains provider-gated and does not accept client amounts", async () => {
  const { DB } = createDatabase();
  const result = await createStripePaymentIntent({
    env: { DB },
    request: new Request("https://vera.test/api", { method: "POST" }),
    bookingId: "vbooking_missing",
    manageToken: "missing",
    kind: "deposit",
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missingSecretNames.sort(), ["STRIPE_PUBLISHABLE_KEY", "STRIPE_SECRET_KEY"]);
  assert.doesNotMatch(read("src/server/vera/stripe.ts"), /input\.(amount|amountCents)|body\.(amount|amountCents)/);
});

test("hosted checkout blocks without signed webhook readiness and uses confirmation return URLs", async () => {
  const result = await createStripeCheckoutForBooking({
    env: { STRIPE_SECRET_KEY: "sk_test_checkout_contract" },
    request: new Request("https://vera.test/api", { method: "POST" }),
    bookingId: "vbooking_missing",
    manageToken: "missing",
    kind: "full",
    origin: "https://vera.test",
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missingSecretNames, ["STRIPE_WEBHOOK_SECRET"]);
  const source = read("src/server/vera/stripe.ts");
  assert.match(source, /confirmation\?token=\$\{encodeURIComponent\(manageToken\)\}&payment=processing/);
  assert.match(source, /confirmation\?token=\$\{encodeURIComponent\(manageToken\)\}&payment=cancelled/);
  assert.match(source, /"checkout\.session\.completed", "checkout\.session\.async_payment_succeeded"/);
  assert.match(source, /safeString\(object\.payment_status\) === "paid"/);
  assert.match(source, /Number\(attempt\.amount_cents\) === Number\(object\.amount_total\)/);
  assert.match(source, /safeString\(attempt\.currency\)\.toUpperCase\(\) === safeString\(object\.currency\)\.toUpperCase\(\)/);
  assert.doesNotMatch(source, /cancelUrl: `\$\{origin\}\/booking\/\$\{encodeURIComponent\(bookingId\)\}\/payment/);
});

test("confirmation state machine separates payment verification from scheduling", () => {
  assert.equal(deriveVeraBookingConfirmationState({ bookingStatus: "pending_payment", paymentState: "unpaid" }), "awaiting_payment");
  assert.equal(deriveVeraBookingConfirmationState({ bookingStatus: "pending_payment", paymentState: "unpaid", paymentAttemptStatus: "processing" }), "processing");
  assert.equal(deriveVeraBookingConfirmationState({ bookingStatus: "pending_payment", paymentState: "unpaid", paymentAttemptStatus: "failed" }), "failed");
  assert.equal(deriveVeraBookingConfirmationState({ bookingStatus: "pending_payment", paymentState: "paid" }), "paid_scheduling");
  assert.equal(deriveVeraBookingConfirmationState({ bookingStatus: "payment_action_required", paymentState: "paid" }), "action_required");
  assert.equal(deriveVeraBookingConfirmationState({ bookingStatus: "confirmed", paymentState: "paid" }), "confirmed");
});

test("public availability rate limiting bounds Calendly calls before provider work", async () => {
  const { sqlite, DB } = createDatabase();
  sqlite.prepare("UPDATE ap_runtime_config SET value = ? WHERE key = ?")
    .run("https://api.calendly.com/event_types/NATALCALL", "CALENDLY_EVENT_TYPE_URI");
  let providerCalls = 0;
  const availabilityCache = new Map();
  const env = {
    DB,
    CALENDLY_API_TOKEN: "calendly-availability-contract",
    SESSION: {
      get(key) { return availabilityCache.get(key) || null; },
      put(key, value) { availabilityCache.set(key, value); },
    },
    fetch: async (_input, init = {}) => {
      assert.ok(init.signal instanceof AbortSignal);
      providerCalls += 1;
      return Response.json({ collection: [] });
    },
  };
  const request = () => new Request(
    "https://vera.test/api/astropages/generated-site/vera/availability?serviceSlug=natal-hour&mode=call&start=2030-09-01T00%3A00%3A00.000Z&end=2030-09-02T00%3A00%3A00.000Z",
    { headers: { "cf-connecting-ip": "203.0.113.42" } },
  );
  for (let index = 0; index < 80; index += 1) {
    const response = await getVeraAvailabilityRoute({
      request: request(),
      params: {},
      locals: { runtime: { env } },
    });
    assert.equal(response.status, 200);
  }
  const limited = await getVeraAvailabilityRoute({
    request: request(),
    params: {},
    locals: { runtime: { env } },
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
  assert.equal(providerCalls, 1);
});

test("Vera operations readiness blocks incomplete runtime and reports ready without exposing secrets", async () => {
  const { sqlite, DB } = createDatabase();
  const authorization = "Bearer vera-readiness-control-contract";
  const blocked = await getVeraOperationsReadinessRoute({
    request: new Request("https://vera.test/api/astropages/generated-site/vera/operations", {
      headers: { authorization },
    }),
    params: {},
    locals: { runtime: { env: { DB, ASTROPAGES_CONTROL_PLANE_CALLBACK_TOKEN: "vera-readiness-control-contract" } } },
  });
  assert.equal(blocked.status, 503);
  const blockedPayload = await blocked.json();
  assert.equal(blockedPayload.status, "blocked-provider");
  assert.equal(blockedPayload.state, "blocked-provider");
  assert.equal(blockedPayload.data.ready, false);
  assert.ok(blockedPayload.data.missingBindingNames.includes("MEDIA"));
  assert.ok(blockedPayload.data.missingSecretNames.includes("STRIPE_SECRET_KEY"));

  const runtimeConfig = new Map([
    ["STRIPE_PUBLISHABLE_KEY", "pk_live_readiness_contract"],
    ["CALENDLY_EVENT_TYPE_URI", "https://api.calendly.com/event_types/NATALCALL"],
    ["SES_SENDER_EMAIL", "vera@example.test"],
    ["SES_SENDER_NAME", "Vera Solaro"],
    ["AWS_REGION", "eu-west-1"],
  ]);
  for (const [key, value] of runtimeConfig) {
    sqlite.prepare(`INSERT INTO ap_runtime_config
      (key, value, provider_key, scope, status, updated_at)
      VALUES (?, ?, 'contract', 'site', 'active', '2026-08-15T00:00:00.000Z')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, status = 'active'`).run(key, value);
  }
  const integrationSecrets = {
    STRIPE_SECRET_KEY: "sk_live_secret_must_not_leak",
    STRIPE_WEBHOOK_SECRET: "whsec_secret_must_not_leak",
    CALENDLY_API_TOKEN: "calendly_token_must_not_leak",
    CALENDLY_WEBHOOK_SIGNING_KEY: "calendly_signing_must_not_leak",
    AWS_ACCESS_KEY_ID: "aws_access_must_not_leak",
    AWS_SECRET_ACCESS_KEY: "aws_secret_must_not_leak",
  };
  const readinessCache = new Map();
  let calendlyValidationCalls = 0;
  const readyEnv = {
    DB,
    MEDIA: { get() {}, put() {}, delete() {} },
    SESSION: {
      get(key) { return readinessCache.get(key) || null; },
      put(key, value) { readinessCache.set(key, value); },
    },
    IMAGES: { input() {}, info() {} },
    ASTROPAGES_PROJECT_ID: "00000000-0000-4000-8000-000000000001",
    ASTROPAGES_SITE_ENVIRONMENT: "production",
    ASTROPAGES_SITE_URL: "https://vera.example.test",
    ASTROPAGES_CONTROL_PLANE_CALLBACK_TOKEN: "vera-readiness-control-contract",
    EMDASH_ENCRYPTION_KEY: "emdash_secret_must_not_leak",
    ...integrationSecrets,
    ASTROPAGES_PLATFORM_GOOGLE_PLACES_API_KEY: {
      async get() { return "google_places_must_not_leak"; },
    },
    fetch: async (input, init = {}) => {
      assert.ok(init.signal instanceof AbortSignal);
      const url = new URL(String(input));
      const path = url.pathname;
      if (url.origin === "https://api.stripe.com" && path === "/v1/webhook_endpoints") {
        return Response.json({
          data: [{
            id: "we_vera_contract",
            url: "https://vera.example.test/api/astropages/generated-site/vera/webhooks/stripe",
            enabled_events: [
              "payment_intent.succeeded",
              "payment_intent.payment_failed",
              "payment_intent.processing",
              "payment_intent.canceled",
              "refund.created",
              "refund.updated",
              "refund.failed",
            ],
            status: "enabled",
            livemode: true,
          }],
          has_more: false,
        });
      }
      if (path === "/users/me") {
        return Response.json({ resource: {
          uri: "https://api.calendly.com/users/VERA",
          current_organization: "https://api.calendly.com/organizations/VERA",
        } });
      }
      if (path === "/webhook_subscriptions") {
        return Response.json({ collection: [{
          callback_url: "https://vera.example.test/api/astropages/generated-site/vera/webhooks/calendly",
          state: "active",
          events: ["invitee.created", "invitee.canceled"],
        }], pagination: {} });
      }
      calendlyValidationCalls += 1;
      return Response.json({
        resource: {
          active: true,
          duration: 30,
        },
      });
    },
  };
  const setup = await postVeraOperationsRoute({
    request: new Request("https://vera.example.test/api/astropages/generated-site/vera/operations", {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        action: "validate_provider_webhooks",
        stripeSigningSecretSha256: await sha256Hex(integrationSecrets.STRIPE_WEBHOOK_SECRET),
        calendlySigningKeySha256: await sha256Hex(integrationSecrets.CALENDLY_WEBHOOK_SIGNING_KEY),
      }),
    }),
    params: {},
    locals: { runtime: { env: readyEnv } },
  });
  assert.equal(setup.status, 200);
  assert.equal((await setup.json()).data.verified, true);
  const ready = await getVeraOperationsReadinessRoute({
    request: new Request("https://vera.example.test/api/astropages/generated-site/vera/operations", {
      headers: { authorization },
    }),
    params: {},
    locals: { runtime: { env: readyEnv } },
  });
  assert.equal(ready.status, 200);
  const readyPayload = await ready.json();
  assert.equal(readyPayload.status, "ready");
  assert.equal(readyPayload.state, "ready");
  assert.equal(readyPayload.data.ready, true);
  assert.equal(readyPayload.data.checks.cloudflare.ready, true);
  assert.equal(readyPayload.data.checks.cloudflare.bindings.EMAIL_QUEUE, false);
  assert.equal(readyPayload.data.missingBindingNames.includes("ASTROPAGES_INTEGRATION_SECRETS_JSON"), false);
  assert.equal(readyPayload.data.checks.posthog.enabled, false);
  assert.equal(readyPayload.data.checks.calendly.liveValidation.source, "provider");
  assert.equal(readyPayload.data.checks.stripe.webhookRegistration.ready, true);
  assert.equal(readyPayload.data.checks.calendly.webhookRegistration.ready, true);
  assert.equal(readyPayload.data.checks.stripe.setupProofReady, true);
  assert.equal(calendlyValidationCalls, 1);
  const serialized = JSON.stringify(readyPayload);
  for (const secret of [
    ...Object.values(integrationSecrets),
    "emdash_secret_must_not_leak",
    "google_places_must_not_leak",
  ]) assert.doesNotMatch(serialized, new RegExp(secret));
  const cached = await getVeraOperationsReadinessRoute({
    request: new Request("https://vera.example.test/api/astropages/generated-site/vera/operations", {
      headers: { authorization },
    }),
    params: {},
    locals: { runtime: { env: readyEnv } },
  });
  assert.equal(cached.status, 200);
  assert.equal((await cached.json()).data.checks.calendly.liveValidation.source, "cache");
  assert.equal(calendlyValidationCalls, 1);
});

test("Vera API routes cover booking, providers, account, engagement, and authenticated operations", () => {
  for (const path of [
    "src/pages/api/astropages/generated-site/vera/catalog.ts",
    "src/pages/api/astropages/generated-site/vera/availability.ts",
    "src/pages/api/astropages/generated-site/vera/bookings/index.ts",
    "src/pages/api/astropages/generated-site/vera/bookings/[id]/payment-intent.ts",
    "src/pages/api/astropages/generated-site/vera/bookings/[id]/quote.ts",
    "src/pages/api/astropages/generated-site/vera/bookings/[id]/reschedule.ts",
    "src/pages/api/astropages/generated-site/vera/places/autocomplete.ts",
    "src/pages/api/astropages/generated-site/vera/places/details.ts",
    "src/pages/api/astropages/generated-site/vera/webhooks/stripe.ts",
    "src/pages/api/astropages/generated-site/vera/webhooks/calendly.ts",
    "src/pages/api/astropages/generated-site/vera/contact.ts",
    "src/pages/api/astropages/generated-site/vera/waitlist.ts",
    "src/pages/api/astropages/generated-site/vera/newsletter/index.ts",
    "src/pages/api/astropages/generated-site/vera/account/index.ts",
    "src/pages/api/astropages/generated-site/vera/account/files/[id].ts",
    "src/pages/api/astropages/generated-site/vera/operations/calendly-mappings.ts",
    "src/pages/api/astropages/generated-site/vera/operations/process-email.ts",
  ]) {
    assert.doesNotThrow(() => read(path), path);
  }
  for (const file of readdirSync(new URL("src/pages/api/astropages/generated-site/vera/operations/", root))) {
    if (!file.endsWith(".ts")) continue;
    assert.match(read(`src/pages/api/astropages/generated-site/vera/operations/${file}`), /requireContentReleaseServiceAuth/);
  }
});

const insertProviderBooking = (sqlite, {
  id,
  accountId = null,
  status = "confirmed",
  paymentState = "deposit_paid",
  selectedStartAt = "2030-09-03T10:00:00.000Z",
  selectedEndAt = "2030-09-03T11:30:00.000Z",
  priceCents = 24_000,
  totalDueCents = 24_000,
  paidCents = 8_000,
  balanceCents = 16_000,
  calendlyEventUri = null,
  calendlyInviteeUri = null,
  schedulingError = null,
} = {}) => {
  const now = "2026-08-15T00:00:00.000Z";
  sqlite.prepare(`INSERT INTO ap_vera_bookings
    (id, booking_number, request_idempotency_key, account_id, service_slug, mode,
     status, payment_state, payment_option, customer_name, email, normalized_email,
     customer_timezone, selected_start_at, selected_end_at, price_cents,
     gift_applied_cents, total_due_cents, paid_cents, balance_cents, currency,
     calendly_event_type_uri, calendly_event_uri, calendly_invitee_uri,
     scheduling_error, confirmed_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'natal-hour', 'call', ?, ?, 'deposit',
      'Provider Reader', 'provider@example.test', 'provider@example.test', 'UTC',
      ?, ?, ?, 0, ?, ?, ?, 'USD',
      'https://api.calendly.com/event_types/NATALCALL', ?, ?, ?, ?, ?, ?)`).run(
    id,
    `VS-${String(id).replace(/[^A-Za-z0-9]/g, "").slice(-16).toUpperCase()}`,
    `provider-contract-${id}`,
    accountId,
    status,
    paymentState,
    selectedStartAt,
    selectedEndAt,
    priceCents,
    totalDueCents,
    paidCents,
    balanceCents,
    calendlyEventUri,
    calendlyInviteeUri,
    schedulingError,
    ["confirmed", "completed", "reschedule_pending"].includes(status) ? now : null,
    now,
    now,
  );
};

test("paid bookings that need Calendly help queue one managed customer email", async () => {
  const { sqlite, DB } = createDatabase();
  const bookingId = "vbooking_action_email";
  insertProviderBooking(sqlite, {
    id: bookingId,
    status: "pending_payment",
    paymentState: "paid",
    paidCents: 24_000,
    balanceCents: 0,
  });
  const env = { DB, ASTROPAGES_SITE_URL: "https://vera.test" };

  const firstAttempt = await schedulePaidVeraBooking(env, bookingId);
  assert.equal(firstAttempt.ok, false);
  assert.equal(sqlite.prepare("SELECT status FROM ap_vera_bookings WHERE id = ?").get(bookingId).status, "payment_action_required");

  await schedulePaidVeraBooking(env, bookingId);
  const emails = sqlite.prepare(`SELECT event_type, template_key, payload_json, idempotency_key
    FROM ap_vera_email_outbox WHERE recipient_email = 'provider@example.test'`).all();
  assert.equal(emails.length, 1);
  assert.equal(emails[0].event_type, "vera.booking.scheduling_action_required");
  assert.equal(emails[0].template_key, "vera_booking_action_required_en");
  assert.equal(emails[0].idempotency_key, `booking-scheduling-action-required:${bookingId}`);
  assert.deepEqual(JSON.parse(emails[0].payload_json), {
    customerName: "Provider Reader",
    bookingNumber: "VS-OKINGACTIONEMAIL",
    serviceName: "The Natal Hour",
    selectedSlot: "2030-09-03T10:00:00.000Z",
    confirmationUrl: `https://vera.test/booking/${bookingId}/confirmation`,
  });
});

test("service-authenticated operations list and idempotently retry concrete Calendly reconciliation states", async () => {
  const { sqlite, DB } = createDatabase();
  const bookingId = "vbooking_staffretry";
  insertProviderBooking(sqlite, {
    id: bookingId,
    status: "payment_action_required",
    schedulingError: "Calendly returned HTTP 503.",
  });
  sqlite.prepare(`INSERT INTO ap_vera_booking_events
    (id, booking_id, event_type, actor_type, metadata_json, created_at)
    VALUES ('vbe_staff_retry_failure', ?, 'calendly.schedule_failed', 'system', '{}', ?)`).run(
    bookingId,
    "2026-08-15T00:00:00.000Z",
  );
  let providerCreates = 0;
  const env = {
    DB,
    ASTROPAGES_CONTROL_PLANE_CALLBACK_TOKEN: "vera-operations-contract",
    CALENDLY_API_TOKEN: "calendly-operations-contract",
    fetch: async (input, init = {}) => {
      assert.ok(init.signal instanceof AbortSignal);
      const url = new URL(String(input));
      if (url.pathname === "/event_types/NATALCALL") {
        return Response.json({ resource: { locations: [{ kind: "zoom" }] } });
      }
      assert.equal(url.pathname, "/invitees");
      providerCreates += 1;
      return Response.json({ resource: {
        uri: "https://api.calendly.com/scheduled_events/STAFF1/invitees/STAFFINV1",
        event: {
          uri: "https://api.calendly.com/scheduled_events/STAFF1",
          start_time: "2030-09-03T10:00:00.000Z",
          end_time: "2030-09-03T11:30:00.000Z",
          location: { join_url: "https://meet.example.test/staff" },
        },
      } });
    },
  };
  const call = (body) => postVeraOperationsRoute({
    request: new Request("https://vera.test/api/astropages/generated-site/vera/operations", {
      method: "POST",
      headers: { authorization: "Bearer vera-operations-contract", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    params: {},
    locals: { runtime: { env } },
  });
  const listed = await call({ action: "list_calendly_reconciliations" });
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).data.reconciliation.items[0].state, "provider_create_retryable");
  const operation = {
    action: "resolve_calendly_reconciliation",
    bookingId,
    resolution: "retry_create",
    operationId: "staff-retry-contract-1",
  };
  const resolved = await call(operation);
  assert.equal(resolved.status, 200);
  assert.equal((await resolved.json()).data.reconciliation.state, "scheduled");
  assert.equal(sqlite.prepare("SELECT status FROM ap_vera_bookings WHERE id = ?").get(bookingId).status, "confirmed");
  const duplicate = await call(operation);
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).data.reconciliation.state, "already_confirmed");
  assert.equal(providerCreates, 1);
});

const calendlyWebhook = async (env, event) => {
  const body = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await hmacSha256Hex(
    env.CALENDLY_WEBHOOK_SIGNING_KEY,
    `${timestamp}.${body}`,
  );
  return processCalendlyWebhook({
    env,
    body,
    signatureHeader: `t=${timestamp},v1=${signature}`,
  });
};

const stripeWebhook = async (env, event) => {
  const body = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await hmacSha256Hex(env.STRIPE_WEBHOOK_SECRET, `${timestamp}.${body}`);
  return processStripeWebhook({
    env,
    body,
    signatureHeader: `t=${timestamp},v1=${signature}`,
  });
};

test("scheduled lifecycle atomically completes elapsed bookings without disturbing follow-ups", async () => {
  const { sqlite, DB } = createDatabase();
  insertProviderBooking(sqlite, {
    id: "vbooking_elapsed",
    selectedStartAt: "2030-09-03T10:00:00.000Z",
    selectedEndAt: "2030-09-03T11:30:00.000Z",
  });
  insertProviderBooking(sqlite, {
    id: "vbooking_future",
    selectedStartAt: "2030-09-04T10:00:00.000Z",
    selectedEndAt: "2030-09-04T11:30:00.000Z",
  });
  sqlite.prepare(`INSERT INTO ap_vera_follow_ups
    (id, booking_id, kind, due_at, status, outbox_id, created_at, updated_at)
    VALUES ('vfollow_elapsed', 'vbooking_elapsed', 'post_session',
      '2030-09-04T11:30:00.000Z', 'pending', NULL, ?, ?)`).run(
    "2026-08-15T00:00:00.000Z",
    "2026-08-15T00:00:00.000Z",
  );

  const firstPass = await completeElapsedVeraBookings(
    { DB },
    new Date("2030-09-03T12:00:00.000Z"),
  );
  assert.equal(firstPass.ok, true);
  assert.equal(firstPass.completed, 1);
  assert.equal(sqlite.prepare("SELECT status FROM ap_vera_bookings WHERE id = 'vbooking_elapsed'").get().status, "completed");
  assert.equal(sqlite.prepare("SELECT status FROM ap_vera_bookings WHERE id = 'vbooking_future'").get().status, "confirmed");
  assert.equal(sqlite.prepare("SELECT status FROM ap_vera_follow_ups WHERE id = 'vfollow_elapsed'").get().status, "pending");
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM ap_vera_booking_events
    WHERE booking_id = 'vbooking_elapsed' AND event_type = 'booking.completed'`).get().count, 1);

  const duplicatePass = await completeElapsedVeraBookings(
    { DB },
    new Date("2030-09-03T12:00:00.000Z"),
  );
  assert.equal(duplicatePass.completed, 0);
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM ap_vera_booking_events
    WHERE booking_id = 'vbooking_elapsed' AND event_type = 'booking.completed'`).get().count, 1);
});

test("Calendly webhooks audit duplicates and never apply native cancellation, reschedule, or terminal resurrection", async () => {
  const { sqlite, DB } = createDatabase();
  const env = { DB, CALENDLY_WEBHOOK_SIGNING_KEY: "calendly-webhook-contract" };
  const eventUri = "https://api.calendly.com/scheduled_events/CURRENT1";
  const inviteeUri = `${eventUri}/invitees/INVITEE1`;
  insertProviderBooking(sqlite, {
    id: "vbooking_calendly_policy",
    paymentState: "paid",
    paidCents: 24_000,
    balanceCents: 0,
    calendlyEventUri: eventUri,
    calendlyInviteeUri: inviteeUri,
  });
  const created = {
    event: "invitee.created",
    payload: {
      uri: inviteeUri,
      event: eventUri,
      tracking: { utm_content: "vbooking_calendly_policy" },
      rescheduled: false,
    },
  };
  assert.equal((await calendlyWebhook(env, created)).status, 200);
  assert.equal((await calendlyWebhook(env, created)).message, "Calendly event already processed.");
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM ap_vera_booking_events
    WHERE booking_id = 'vbooking_calendly_policy' AND event_type = 'invitee.created'`).get().count, 1);

  const cancelled = {
    ...created,
    event: "invitee.canceled",
  };
  const cancellationResult = await calendlyWebhook(env, cancelled);
  assert.equal(cancellationResult.status, 202);
  const afterCancellation = sqlite.prepare(`SELECT status, payment_state, cancelled_at
    FROM ap_vera_bookings WHERE id = 'vbooking_calendly_policy'`).get();
  assert.equal(afterCancellation.status, "payment_action_required");
  assert.equal(afterCancellation.payment_state, "paid");
  assert.equal(afterCancellation.cancelled_at, null);

  insertProviderBooking(sqlite, {
    id: "vbooking_calendly_terminal",
    status: "completed",
    paymentState: "paid",
    paidCents: 24_000,
    balanceCents: 0,
    calendlyEventUri: "https://api.calendly.com/scheduled_events/TERMINAL1",
    calendlyInviteeUri: "https://api.calendly.com/scheduled_events/TERMINAL1/invitees/TERMINALINV1",
  });
  const terminalEvent = {
    event: "invitee.created",
    payload: {
      uri: "https://api.calendly.com/scheduled_events/NEWTERMINAL/invitees/NEWINVITEE",
      event: "https://api.calendly.com/scheduled_events/NEWTERMINAL",
      tracking: { utm_content: "vbooking_calendly_terminal" },
    },
  };
  assert.equal((await calendlyWebhook(env, terminalEvent)).status, 200);
  const terminal = sqlite.prepare(`SELECT status, calendly_event_uri FROM ap_vera_bookings
    WHERE id = 'vbooking_calendly_terminal'`).get();
  assert.equal(terminal.status, "completed");
  assert.equal(terminal.calendly_event_uri, "https://api.calendly.com/scheduled_events/TERMINAL1");

  const oldEventUri = "https://api.calendly.com/scheduled_events/OLDRESCHEDULE";
  const oldInviteeUri = `${oldEventUri}/invitees/OLDINVITEE`;
  insertProviderBooking(sqlite, {
    id: "vbooking_native_reschedule",
    status: "reschedule_pending",
    calendlyEventUri: oldEventUri,
    calendlyInviteeUri: oldInviteeUri,
  });
  sqlite.prepare(`INSERT INTO ap_vera_reschedule_requests
    (id, booking_id, status, policy, previous_start_at, replacement_start_at,
     provider_reschedule_url, authorized_at, completed_at)
    VALUES ('vreschedule_native', 'vbooking_native_reschedule', 'authorized',
      'one_free_until_72h', '2030-09-03T10:00:00.000Z', NULL, NULL, ?, NULL)`).run(
    "2026-08-15T00:00:00.000Z",
  );
  const nativeReschedule = {
    event: "invitee.created",
    payload: {
      uri: "https://api.calendly.com/scheduled_events/NATIVENEW/invitees/NATIVEINVITEE",
      event: "https://api.calendly.com/scheduled_events/NATIVENEW",
      tracking: { utm_content: "vbooking_native_reschedule" },
      rescheduled: true,
      old_invitee: { uri: oldInviteeUri },
      new_invitee: { uri: "https://api.calendly.com/scheduled_events/NATIVENEW/invitees/NATIVEINVITEE" },
    },
  };
  assert.equal((await calendlyWebhook(env, nativeReschedule)).status, 202);
  const native = sqlite.prepare(`SELECT status, calendly_event_uri FROM ap_vera_bookings
    WHERE id = 'vbooking_native_reschedule'`).get();
  assert.equal(native.status, "payment_action_required");
  assert.equal(native.calendly_event_uri, oldEventUri);
  assert.equal(sqlite.prepare("SELECT status FROM ap_vera_reschedule_requests WHERE id = 'vreschedule_native'").get().status, "authorized");
});

test("authenticated scheduling retry is expiring-token aware, single-flight, recoverable, and idempotent", async () => {
  const { sqlite, DB } = createDatabase();
  const bookingId = "vbooking_retry_scheduling";
  const startAt = "2030-09-03T10:00:00.000Z";
  const endAt = "2030-09-03T11:30:00.000Z";
  insertProviderBooking(sqlite, {
    id: bookingId,
    status: "payment_action_required",
    schedulingError: "Calendly returned HTTP 503.",
    selectedStartAt: startAt,
    selectedEndAt: endAt,
  });
  sqlite.prepare(`INSERT INTO ap_vera_payment_attempts
    (id, booking_id, kind, provider, provider_payment_intent_id, idempotency_key,
     amount_cents, currency, status, last_error_code, created_at, updated_at)
    VALUES ('vpay_retry', ?, 'deposit', 'stripe', 'pi_retry_contract',
      'retry-payment-contract', 8000, 'USD', 'succeeded', NULL, ?, ?)`).run(
    bookingId,
    "2026-08-15T00:00:00.000Z",
    "2026-08-15T00:00:00.000Z",
  );
  sqlite.prepare(`INSERT INTO ap_vera_booking_events
    (id, booking_id, event_type, actor_type, metadata_json, created_at)
    VALUES ('vbe_retry_failure', ?, 'calendly.schedule_failed', 'system', '{}', ?)`).run(
    bookingId,
    "2026-08-15T00:00:00.000Z",
  );

  let providerPosts = 0;
  let providerMode = "deferred_failure";
  let signalProviderStarted;
  const providerStarted = new Promise((resolve) => { signalProviderStarted = resolve; });
  let releaseProviderFailure;
  const env = {
    DB,
    EMDASH_ENCRYPTION_KEY: "retry-manage-token-contract",
    CALENDLY_API_TOKEN: "calendly-api-contract",
    fetch: async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/event_types/NATALCALL") {
        return Response.json({ resource: { locations: [{ kind: "zoom" }] } });
      }
      assert.equal(url.href, "https://api.calendly.com/invitees");
      assert.equal(init.method, "POST");
      providerPosts += 1;
      if (providerMode === "deferred_failure") {
        signalProviderStarted();
        return await new Promise((resolve) => {
          releaseProviderFailure = () => resolve(Response.json(
            { message: "Calendly maintenance" },
            { status: 503 },
          ));
        });
      }
      return Response.json({
        resource: {
          uri: "https://api.calendly.com/scheduled_events/RETRY1/invitees/RETRYINV1",
          event: {
            uri: "https://api.calendly.com/scheduled_events/RETRY1",
            start_time: startAt,
            end_time: endAt,
            location: { join_url: "https://meet.example.test/retry" },
          },
          cancel_url: "https://calendly.com/cancellations/retry",
          reschedule_url: "https://calendly.com/reschedulings/retry",
        },
      });
    },
  };
  const manageTokenExpiresAt = "2030-08-15T00:00:00.000Z";
  const manageToken = await createBookingManageToken(env, bookingId, manageTokenExpiresAt);
  sqlite.prepare(`UPDATE ap_vera_bookings
    SET manage_token_hash = ?, manage_token_expires_at = ? WHERE id = ?`).run(
    await sha256Hex(manageToken),
    manageTokenExpiresAt,
    bookingId,
  );
  assert.equal(await createBookingManageToken(env, bookingId), manageToken);
  const postRetry = (token = manageToken) => retryVeraBookingSchedulingRoute({
    request: new Request(`https://vera.test/api/astropages/generated-site/vera/bookings/${bookingId}/status`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "retry_scheduling" }),
    }),
    params: { id: bookingId },
    locals: { runtime: { env } },
  });

  const expiredAt = Date.now() - 60_000;
  const expiredSignature = await hmacSha256Hex(
    env.EMDASH_ENCRYPTION_KEY,
    `vera-booking-manage:v2:${bookingId}:${expiredAt}`,
  );
  assert.equal((await postRetry(`v2.${expiredAt}.${expiredSignature}`)).status, 403);
  assert.equal(providerPosts, 0);

  const firstAttemptPromise = postRetry();
  try {
    await Promise.race([
      providerStarted,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("Calendly retry provider call did not start within one second.")),
        1_000,
      )),
    ]);
    const concurrentAttempt = await postRetry();
    assert.equal(concurrentAttempt.status, 409);
    assert.equal(providerPosts, 1);
  } finally {
    releaseProviderFailure?.();
  }
  const failedAttempt = await firstAttemptPromise;
  assert.equal(failedAttempt.status, 502);
  assert.match(
    sqlite.prepare("SELECT scheduling_error FROM ap_vera_bookings WHERE id = ?").get(bookingId).scheduling_error,
    /HTTP 503|maintenance/i,
  );

  providerMode = "success";
  const recovered = await postRetry();
  assert.equal(recovered.status, 200);
  assert.equal(recovered.headers.get("cache-control"), "private, no-store");
  const recoveredPayload = await recovered.json();
  assert.equal(recoveredPayload.data.booking.status, "confirmed");
  assert.deepEqual(recoveredPayload.data.reconciliation, {
    state: "scheduled",
    providerCreateAttempted: true,
  });
  assert.equal(providerPosts, 2);

  const duplicate = await postRetry();
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).data.reconciliation.state, "already_confirmed");
  assert.equal(providerPosts, 2);
  for (const sourcePath of ["src/server/vera/calendly.ts", "src/server/vera/stripe.ts"]) {
    const source = read(sourcePath);
    assert.doesNotMatch(source, /account\?booking|searchParams\.set\(["']manage["']/);
  }
});

const createVerifiedAccountSession = async (sqlite) => {
  const accountId = "acct_balance_contract";
  const sessionToken = "session-balance-contract-token";
  const csrfToken = "csrf-balance-contract-token";
  const now = "2026-08-15T00:00:00.000Z";
  sqlite.prepare(`INSERT INTO ap_customer_accounts
    (id, email, display_name, phone, password_hash, password_salt,
     default_language, email_verified_at, created_at, updated_at)
    VALUES (?, 'balance@example.test', 'Balance Reader', NULL, 'hash', 'salt',
      'English', ?, ?, ?)`).run(accountId, now, now, now);
  sqlite.prepare(`INSERT INTO ap_customer_sessions
    (id, account_id, session_token_hash, csrf_token_hash, expires_at,
     last_seen_at, revoked_at, created_at)
    VALUES ('csess_balance_contract', ?, ?, ?, '2035-08-15T00:00:00.000Z', ?, NULL, ?)`).run(
    accountId,
    await sha256Hex(sessionToken),
    await sha256Hex(csrfToken),
    now,
    now,
  );
  return {
    accountId,
    sessionToken,
    csrfToken,
    cookie: `ap_customer_session=${sessionToken}; ap_customer_csrf=${csrfToken}`,
  };
};

test("authenticated owners can idempotently pay authoritative confirmed and completed balances", async () => {
  const { sqlite, DB } = createDatabase();
  const session = await createVerifiedAccountSession(sqlite);
  insertProviderBooking(sqlite, { id: "vbooking_balance_confirmed", accountId: session.accountId });
  insertProviderBooking(sqlite, {
    id: "vbooking_balance_completed",
    accountId: session.accountId,
    status: "completed",
    selectedStartAt: "2026-08-01T10:00:00.000Z",
    selectedEndAt: "2026-08-01T11:30:00.000Z",
  });
  insertProviderBooking(sqlite, {
    id: "vbooking_balance_action_required",
    accountId: session.accountId,
    status: "payment_action_required",
    schedulingError: "Provider reconciliation is required.",
  });
  insertProviderBooking(sqlite, {
    id: "vbooking_balance_canceled_intent",
    accountId: session.accountId,
  });
  let providerCreates = 0;
  let providerRetrieves = 0;
  const intents = new Map();
  const env = {
    DB,
    EMDASH_ENCRYPTION_KEY: "balance-manage-token-contract",
    STRIPE_SECRET_KEY: "sk_test_balance_contract",
    PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_balance_contract",
    fetch: async (input, init = {}) => {
      const url = new URL(String(input));
      if (init.method === "GET") {
        providerRetrieves += 1;
        return Response.json(intents.get(url.pathname.split("/").pop()));
      }
      const body = new URLSearchParams(String(init.body));
      const bookingId = body.get("metadata[booking_id]");
      const intent = {
        id: bookingId === "vbooking_balance_completed"
          ? "pi_balance_completed"
          : bookingId === "vbooking_balance_canceled_intent"
            ? "pi_balance_canceled"
            : "pi_balance_confirmed",
        client_secret: `secret_${bookingId}`,
        amount: Number(body.get("amount")),
        currency: "usd",
        status: bookingId === "vbooking_balance_canceled_intent" ? "canceled" : "requires_payment_method",
      };
      assert.equal(intent.amount, 16_000);
      assert.equal(body.get("metadata[payment_kind]"), "balance");
      providerCreates += 1;
      intents.set(intent.id, intent);
      return Response.json(intent);
    },
  };
  const balanceRequest = (includeCsrf = true) => new Request("https://vera.test/api", {
    method: "POST",
    headers: {
      cookie: session.cookie,
      ...(includeCsrf ? { "x-csrf-token": session.csrfToken } : {}),
    },
  });

  const missingCsrf = await createStripePaymentIntent({
    env,
    request: balanceRequest(false),
    bookingId: "vbooking_balance_confirmed",
    manageToken: "",
    kind: "balance",
  });
  assert.equal(missingCsrf.status, 403);
  assert.equal(providerCreates, 0);

  const wrongStatus = await createStripePaymentIntent({
    env,
    request: balanceRequest(),
    bookingId: "vbooking_balance_action_required",
    manageToken: "",
    kind: "balance",
  });
  assert.equal(wrongStatus.status, 409);
  assert.equal(providerCreates, 0);

  const confirmed = await createStripePaymentIntent({
    env,
    request: balanceRequest(),
    bookingId: "vbooking_balance_confirmed",
    manageToken: "",
    kind: "balance",
  });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.payment.amountCents, 16_000);
  const confirmedDuplicate = await createStripePaymentIntent({
    env,
    request: balanceRequest(),
    bookingId: "vbooking_balance_confirmed",
    manageToken: "",
    kind: "balance",
  });
  assert.equal(confirmedDuplicate.payment.paymentIntentId, confirmed.payment.paymentIntentId);
  const confirmedAttempt = sqlite.prepare(`SELECT id FROM ap_vera_payment_attempts
    WHERE booking_id = 'vbooking_balance_confirmed'`).get();
  sqlite.prepare(`INSERT INTO ap_vera_refunds
    (id, booking_id, payment_attempt_id, provider_refund_id, amount_cents,
     currency, reason, status, idempotency_key, created_at, updated_at)
    VALUES ('vrefund_balance_pending', 'vbooking_balance_confirmed', ?, NULL,
      1000, 'USD', 'contract', 'pending', 'balance-pending-contract', ?, ?)`).run(
    confirmedAttempt.id,
    "2026-08-15T00:00:00.000Z",
    "2026-08-15T00:00:00.000Z",
  );
  const refundBlocked = await createStripePaymentIntent({
    env,
    request: balanceRequest(),
    bookingId: "vbooking_balance_confirmed",
    manageToken: "",
    kind: "balance",
  });
  assert.equal(refundBlocked.status, 409);
  assert.equal(providerCreates, 1);

  const completed = await createStripePaymentIntent({
    env,
    request: balanceRequest(),
    bookingId: "vbooking_balance_completed",
    manageToken: "",
    kind: "balance",
  });
  assert.equal(completed.ok, true);
  assert.equal(completed.payment.amountCents, 16_000);
  const canceledIntent = await createStripePaymentIntent({
    env,
    request: balanceRequest(),
    bookingId: "vbooking_balance_canceled_intent",
    manageToken: "",
    kind: "balance",
  });
  assert.equal(canceledIntent.ok, true);
  assert.equal(sqlite.prepare(`SELECT status FROM ap_vera_payment_attempts
    WHERE booking_id = 'vbooking_balance_canceled_intent'`).get().status, "cancelled");
  assert.equal(providerCreates, 3);
  assert.equal(providerRetrieves, 1);
  assert.deepEqual(
    sqlite.prepare(`SELECT booking_id, amount_cents FROM ap_vera_payment_attempts
      WHERE kind = 'balance' ORDER BY booking_id`).all().map((row) => ({ ...row })),
    [
      { booking_id: "vbooking_balance_canceled_intent", amount_cents: 16_000 },
      { booking_id: "vbooking_balance_completed", amount_cents: 16_000 },
      { booking_id: "vbooking_balance_confirmed", amount_cents: 16_000 },
    ],
  );
  assert.equal(sqlite.prepare("SELECT status FROM ap_vera_bookings WHERE id = 'vbooking_balance_confirmed'").get().status, "confirmed");
  assert.equal(sqlite.prepare("SELECT status FROM ap_vera_bookings WHERE id = 'vbooking_balance_completed'").get().status, "completed");

  const manageToken = await createBookingManageToken(env, "vbooking_balance_confirmed");
  const tokenOnly = await createStripePaymentIntent({
    env,
    request: new Request("https://vera.test/api", {
      method: "POST",
      headers: { authorization: `Bearer ${manageToken}` },
    }),
    bookingId: "vbooking_balance_confirmed",
    manageToken,
    kind: "balance",
  });
  assert.equal(tokenOnly.status, 403);
});

test("Stripe refund events are monotonic across duplicate and out-of-order delivery", async () => {
  const { sqlite, DB } = createDatabase();
  insertProviderBooking(sqlite, {
    id: "vbooking_refund_order",
    paymentState: "paid",
    priceCents: 8_000,
    totalDueCents: 8_000,
    paidCents: 8_000,
    balanceCents: 0,
  });
  const now = "2026-08-15T00:00:00.000Z";
  sqlite.prepare(`INSERT INTO ap_vera_payment_attempts
    (id, booking_id, kind, provider, provider_payment_intent_id, idempotency_key,
     amount_cents, currency, status, last_error_code, created_at, updated_at)
    VALUES ('vpay_refund_order', 'vbooking_refund_order', 'full', 'stripe',
      'pi_refund_order', 'refund-order-payment', 8000, 'USD', 'succeeded', NULL, ?, ?)`).run(now, now);
  sqlite.prepare(`INSERT INTO ap_vera_refunds
    (id, booking_id, payment_attempt_id, provider_refund_id, amount_cents,
    currency, reason, status, idempotency_key, created_at, updated_at)
    VALUES ('vrefund_order', 'vbooking_refund_order', 'vpay_refund_order',
      NULL, 8000, 'USD', 'contract', 'pending', 'refund-order', ?, ?)`).run(now, now);
  const env = { DB, STRIPE_WEBHOOK_SECRET: "whsec_refund_order_contract" };
  const refundEvent = (id, status) => ({
    id,
    type: "refund.updated",
    data: {
      object: {
        id: "re_refund_order",
        payment_intent: "pi_refund_order",
        amount: 8_000,
        currency: "usd",
        status,
        metadata: {
          booking_id: "vbooking_refund_order",
          refund_id: "vrefund_order",
        },
      },
    },
  });
  assert.equal((await stripeWebhook(env, refundEvent("evt_refund_action", "requires_action"))).status, 200);
  assert.equal(sqlite.prepare("SELECT provider_refund_id FROM ap_vera_refunds WHERE id = 'vrefund_order'").get().provider_refund_id, "re_refund_order");
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM ap_vera_booking_events
    WHERE booking_id = 'vbooking_refund_order' AND event_type = 'refund.action_required'`).get().count, 1);

  assert.equal((await stripeWebhook(env, refundEvent("evt_refund_canceled", "canceled"))).status, 200);
  assert.equal(sqlite.prepare("SELECT status FROM ap_vera_refunds WHERE id = 'vrefund_order'").get().status, "cancelled");

  assert.equal((await stripeWebhook(env, refundEvent("evt_refund_succeeded", "succeeded"))).status, 200);
  assert.equal(sqlite.prepare("SELECT status FROM ap_vera_refunds WHERE id = 'vrefund_order'").get().status, "succeeded");
  assert.equal(sqlite.prepare("SELECT status FROM ap_vera_bookings WHERE id = 'vbooking_refund_order'").get().status, "refunded");

  assert.equal((await stripeWebhook(env, refundEvent("evt_refund_stale_failed", "failed"))).status, 200);
  assert.equal(sqlite.prepare("SELECT status FROM ap_vera_refunds WHERE id = 'vrefund_order'").get().status, "succeeded");
  assert.equal(sqlite.prepare("SELECT status FROM ap_vera_bookings WHERE id = 'vbooking_refund_order'").get().status, "refunded");
  assert.equal((await stripeWebhook(env, refundEvent("evt_refund_stale_failed", "failed"))).message, "Stripe event already processed.");
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM ap_vera_payment_events
    WHERE provider_event_id = 'evt_refund_stale_failed'`).get().count, 1);
});

test("late Stripe success preserves terminal state and creates one deterministic refund recovery", async () => {
  const { sqlite, DB } = createDatabase();
  insertProviderBooking(sqlite, {
    id: "vbooking_late_terminal",
    status: "cancelled",
    paymentState: "unpaid",
    priceCents: 8_000,
    totalDueCents: 8_000,
    paidCents: 0,
    balanceCents: 8_000,
  });
  sqlite.prepare(`UPDATE ap_vera_bookings SET cancelled_at = ?, cancellation_reason = 'customer_request'
    WHERE id = 'vbooking_late_terminal'`).run("2026-08-15T00:00:00.000Z");
  const now = "2026-08-15T00:00:00.000Z";
  sqlite.prepare(`INSERT INTO ap_vera_payment_attempts
    (id, booking_id, kind, provider, provider_payment_intent_id, idempotency_key,
     amount_cents, currency, status, last_error_code, created_at, updated_at)
    VALUES ('vpay_late_terminal', 'vbooking_late_terminal', 'full', 'stripe',
      'pi_late_terminal', 'late-terminal-payment', 8000, 'USD', 'processing', NULL, ?, ?)`).run(now, now);
  let refundCreates = 0;
  const env = {
    DB,
    STRIPE_WEBHOOK_SECRET: "whsec_late_terminal_contract",
    STRIPE_SECRET_KEY: "sk_test_late_terminal_contract",
    fetch: async (input, init = {}) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, "/v1/refunds");
      const body = new URLSearchParams(String(init.body));
      assert.equal(body.get("payment_intent"), "pi_late_terminal");
      assert.equal(body.get("amount"), "8000");
      refundCreates += 1;
      return Response.json({ id: "re_late_terminal", status: "pending" });
    },
  };
  const event = {
    id: "evt_late_terminal_success",
    type: "payment_intent.succeeded",
    data: {
      object: {
        id: "pi_late_terminal",
        amount_received: 8_000,
        currency: "usd",
      },
    },
  };
  const processed = await stripeWebhook(env, event);
  assert.equal(processed.status, 200);
  assert.equal(processed.message, "Late terminal payment recorded and submitted for refund.");
  assert.equal(sqlite.prepare("SELECT status FROM ap_vera_bookings WHERE id = 'vbooking_late_terminal'").get().status, "cancelled");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM ap_vera_refunds WHERE booking_id = 'vbooking_late_terminal'").get().count, 1);
  assert.equal(sqlite.prepare("SELECT status FROM ap_vera_refunds WHERE booking_id = 'vbooking_late_terminal'").get().status, "pending");
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM ap_vera_booking_events
    WHERE booking_id = 'vbooking_late_terminal'
      AND event_type = 'payment.late_terminal_refund_submitted'`).get().count, 1);
  assert.equal(refundCreates, 1);

  assert.equal((await stripeWebhook(env, event)).message, "Stripe event already processed.");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM ap_vera_refunds WHERE booking_id = 'vbooking_late_terminal'").get().count, 1);
  assert.equal(refundCreates, 1);
});

test("ambiguous Calendly creates and historical audits cannot trigger another provider create", async () => {
  const { sqlite, DB } = createDatabase();
  const now = "2026-08-15T00:00:00.000Z";
  const env = {
    DB,
    EMDASH_ENCRYPTION_KEY: "ambiguous-calendly-manage-contract",
    CALENDLY_API_TOKEN: "calendly-api-contract",
    providerPosts: 0,
    fetch: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/event_types/NATALCALL") {
        return Response.json({ resource: { locations: [{ kind: "zoom" }] } });
      }
      env.providerPosts += 1;
      throw new TypeError("connection reset after request upload");
    },
  };
  const prepareRetryBooking = async ({ bookingId, auditCreatedAt = now }) => {
    insertProviderBooking(sqlite, {
      id: bookingId,
      status: "payment_action_required",
      schedulingError: "Calendly returned HTTP 503.",
    });
    sqlite.prepare(`INSERT INTO ap_vera_payment_attempts
      (id, booking_id, kind, provider, provider_payment_intent_id, idempotency_key,
       amount_cents, currency, status, last_error_code, created_at, updated_at)
      VALUES (?, ?, 'deposit', 'stripe', ?, ?, 8000, 'USD', 'succeeded', NULL, ?, ?)`).run(
      `vpay_${bookingId}`,
      bookingId,
      `pi_${bookingId}`,
      `payment-${bookingId}`,
      now,
      now,
    );
    sqlite.prepare(`INSERT INTO ap_vera_booking_events
      (id, booking_id, event_type, actor_type, metadata_json, created_at)
      VALUES (?, ?, 'calendly.schedule_failed', 'system', '{}', ?)`).run(
      `vbe_${bookingId}`,
      bookingId,
      auditCreatedAt,
    );
    const expiresAt = "2030-08-15T00:00:00.000Z";
    const token = await createBookingManageToken(env, bookingId, expiresAt);
    sqlite.prepare(`UPDATE ap_vera_bookings
      SET manage_token_hash = ?, manage_token_expires_at = ? WHERE id = ?`).run(
      await sha256Hex(token),
      expiresAt,
      bookingId,
    );
    return token;
  };
  const postRetry = (bookingId, token) => retryVeraBookingSchedulingRoute({
    request: new Request(`https://vera.test/api/astropages/generated-site/vera/bookings/${bookingId}/status`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ action: "retry_scheduling" }),
    }),
    params: { id: bookingId },
    locals: { runtime: { env } },
  });

  const ambiguousId = "vbooking_ambiguous_calendly";
  const ambiguousToken = await prepareRetryBooking({ bookingId: ambiguousId });
  assert.equal((await postRetry(ambiguousId, ambiguousToken)).status, 502);
  assert.equal(env.providerPosts, 1);
  assert.match(
    sqlite.prepare("SELECT scheduling_error FROM ap_vera_bookings WHERE id = ?").get(ambiguousId).scheduling_error,
    /outcome is unknown/i,
  );
  assert.equal((await postRetry(ambiguousId, ambiguousToken)).status, 409);
  assert.equal(env.providerPosts, 1);

  const historicalId = "vbooking_historical_calendly";
  const historicalToken = await prepareRetryBooking({
    bookingId: historicalId,
    auditCreatedAt: "2026-08-14T00:00:00.000Z",
  });
  assert.equal((await postRetry(historicalId, historicalToken)).status, 409);
  assert.equal(env.providerPosts, 1);
});

test("Stripe refunds aggregate attempts and safely reconcile an ambiguous request with the original idempotency key", async () => {
  const { sqlite, DB } = createDatabase();
  const now = "2026-08-15T00:00:00.000Z";
  insertProviderBooking(sqlite, {
    id: "vbooking_multi_refund",
    paymentState: "paid",
    paidCents: 24_000,
    balanceCents: 0,
  });
  for (const [id, kind, intent, amount, createdAt] of [
    ["vpay_refund_deposit", "deposit", "pi_refund_deposit", 8_000, "2026-08-14T00:00:00.000Z"],
    ["vpay_refund_balance", "balance", "pi_refund_balance", 16_000, now],
  ]) {
    sqlite.prepare(`INSERT INTO ap_vera_payment_attempts
      (id, booking_id, kind, provider, provider_payment_intent_id, idempotency_key,
       amount_cents, currency, status, last_error_code, created_at, updated_at)
      VALUES (?, 'vbooking_multi_refund', ?, 'stripe', ?, ?, ?, 'USD',
        'succeeded', NULL, ?, ?)`).run(id, kind, intent, `key-${id}`, amount, createdAt, createdAt);
  }
  let providerRefunds = 0;
  let ambiguousRequests = 0;
  const ambiguousIdempotencyKeys = [];
  const providerAmounts = [];
  const env = {
    DB,
    STRIPE_SECRET_KEY: "sk_test_refund_contract",
    fetch: async (_input, init = {}) => {
      const body = new URLSearchParams(String(init.body));
      if (body.get("metadata[booking_id]") === "vbooking_ambiguous_refund") {
        ambiguousRequests += 1;
        ambiguousIdempotencyKeys.push(init.headers["idempotency-key"]);
        if (ambiguousRequests === 1) throw new TypeError("connection reset after refund upload");
        return Response.json({
          id: "re_ambiguous_refund",
          status: "succeeded",
          payment_intent: "pi_ambiguous_refund",
          amount: 8_000,
          currency: "usd",
          metadata: {
            booking_id: "vbooking_ambiguous_refund",
            refund_id: body.get("metadata[refund_id]"),
          },
        });
      }
      providerRefunds += 1;
      providerAmounts.push(Number(body.get("amount")));
      return Response.json({ id: `re_multi_refund_${providerRefunds}`, status: "pending" });
    },
  };
  const aggregate = await createStripeRefund({
    env,
    bookingId: "vbooking_multi_refund",
    amountCents: 24_000,
    reason: "Eligible full cancellation.",
  });
  assert.equal(aggregate.ok, true);
  assert.equal(aggregate.refunds.length, 2);
  assert.deepEqual(providerAmounts, [16_000, 8_000]);
  assert.equal(sqlite.prepare(`SELECT SUM(amount_cents) AS total FROM ap_vera_refunds
    WHERE booking_id = 'vbooking_multi_refund'`).get().total, 24_000);

  insertProviderBooking(sqlite, {
    id: "vbooking_ambiguous_refund",
    paymentState: "paid",
    priceCents: 8_000,
    totalDueCents: 8_000,
    paidCents: 8_000,
    balanceCents: 0,
  });
  sqlite.prepare(`INSERT INTO ap_vera_payment_attempts
    (id, booking_id, kind, provider, provider_payment_intent_id, idempotency_key,
     amount_cents, currency, status, last_error_code, created_at, updated_at)
    VALUES ('vpay_ambiguous_refund', 'vbooking_ambiguous_refund', 'full', 'stripe',
      'pi_ambiguous_refund', 'key-ambiguous-refund', 8000, 'USD',
      'succeeded', NULL, ?, ?)`).run(now, now);
  const ambiguous = await createStripeRefund({
    env,
    bookingId: "vbooking_ambiguous_refund",
    amountCents: 8_000,
    reason: "Ambiguous transport contract.",
  });
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.message, /outcome is unknown/i);
  assert.equal(sqlite.prepare(`SELECT status FROM ap_vera_refunds
    WHERE booking_id = 'vbooking_ambiguous_refund'`).get().status, "pending");
  const duplicate = await createStripeRefund({
    env,
    bookingId: "vbooking_ambiguous_refund",
    amountCents: 8_000,
    reason: "Ambiguous transport contract.",
  });
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.alreadyExists, true);
  assert.equal(duplicate.reconciled, true);
  assert.equal(duplicate.status, 200);
  assert.equal(ambiguousRequests, 2);
  assert.equal(ambiguousIdempotencyKeys[0], ambiguousIdempotencyKeys[1]);
  assert.match(ambiguousIdempotencyKeys[0], /^vera-refund:/);
  assert.deepEqual({ ...sqlite.prepare(`SELECT status, provider_refund_id FROM ap_vera_refunds
    WHERE booking_id = 'vbooking_ambiguous_refund'`).get() }, {
    status: "succeeded",
    provider_refund_id: "re_ambiguous_refund",
  });
  assert.deepEqual({ ...sqlite.prepare(`SELECT status, payment_state FROM ap_vera_bookings
    WHERE id = 'vbooking_ambiguous_refund'`).get() }, {
    status: "refunded",
    payment_state: "refunded",
  });
});
