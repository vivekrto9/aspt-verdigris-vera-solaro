import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const {
  createLead,
  isSupportedLeadSource,
  linkBusinessLead,
  linkNewsletterLead,
  markLeadConvertedBySourceReference,
  normalizeLeadEmail,
  normalizeLeadPhone,
} = await import("../../src/server/aggregator/lead-records.ts");

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

const captureDb = () => {
  const calls = [];
  const leads = new Map();
  return {
    calls,
    prepare(sql) {
      return {
        bind(...values) {
          const call = { sql, values };
          calls.push(call);
          return {
            async first() {
              if (!sql.includes("SELECT id FROM ap_leads")) return null;
              const id = leads.get(values[0]);
              return id ? { id } : null;
            },
            async run() {
              if (sql.includes("INSERT INTO ap_leads")) {
                const existingId = leads.get(values[22]);
                leads.set(values[22], existingId ?? values[0]);
              }
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
};

test("leads.v1 keeps the canonical tables with Vera's privacy-safe sources", () => {
  const manifest = JSON.parse(read("astropages/leads.manifest.json"));
  const migration = read("migrations/0005_leads.sql");

  assert.equal(manifest.semanticModel, "leads.v1");
  assert.equal(manifest.table, "ap_leads");
  assert.equal(manifest.eventsTable, "ap_business_events");
  assert.deepEqual(manifest.kinds, ["consultation", "waitlist", "newsletter", "contact"]);
  assert.deepEqual(Object.keys(manifest.sources), ["consultation_booking", "waitlist", "newsletter", "contact"]);
  assert.doesNotMatch(JSON.stringify(manifest.sources), /birth|message|notes|intake/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS ap_business_events/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS ap_leads/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS idx_ap_leads_dedupe/);
});

test("Vera business flows emit only manifest-declared lead sources", () => {
  const engagement = read("src/server/vera/engagement.ts");
  const bookings = read("src/server/vera/bookings.ts");
  assert.match(engagement, /kind:\s*"contact",\s*\n\s*source:\s*"contact"/);
  assert.match(engagement, /kind:\s*"waitlist",\s*\n\s*source:\s*"waitlist"/);
  assert.doesNotMatch(engagement, /source:\s*"support"/);
  assert.match(bookings, /source:\s*"consultation_booking"/);
  assert.match(bookings, /details:\s*\{[\s\S]*?paymentOption,[\s\S]*?amountCents:/);
});

test("lead contact normalization and validation reject unsafe submissions", async () => {
  assert.equal(normalizeLeadEmail("  USER@Example.COM "), "user@example.com");
  assert.equal(normalizeLeadPhone(" +91 98765-43210 "), "+919876543210");
  assert.equal(isSupportedLeadSource("consultation_booking"), true);
  assert.equal(isSupportedLeadSource("arbitrary-form"), false);

  const DB = captureDb();
  assert.deepEqual(
    await createLead({ env: { DB }, submission: { kind: "contact", email: "not-an-email", consentContact: true } }),
    { ok: false, message: "Please enter a valid email address." },
  );
  assert.deepEqual(
    await createLead({ env: { DB }, submission: { kind: "contact", email: "user@example.com" } }),
    { ok: false, message: "Contact consent is required." },
  );
  assert.equal(DB.calls.length, 0);
});

test("lead creation allowlists JSON, records a privacy-safe event, and deduplicates retries", async () => {
  const DB = captureDb();
  const submission = {
    kind: "consultation",
    source: "consultation_booking",
    formKey: "consultation-checkout",
    pagePath: "/book",
    locale: "en",
    fullName: "Customer",
    email: "Customer@Example.com",
    phone: "+91 98765 43210",
    consentContact: true,
    consentMarketing: false,
    idempotencyKey: "request-123",
    attribution: { utmSource: "campaign", password: "must-not-persist" },
    details: {
      bookingNumber: "CB-100",
      serviceSlug: "natal-hour",
      paymentOption: "deposit",
      amountCents: 8000,
      birthDate: "1990-01-01",
      message: "must-not-persist",
      privateNotes: "must-not-persist",
    },
  };

  const first = await createLead({ env: { DB }, submission });
  const second = await createLead({ env: { DB }, submission });

  assert.equal(first.ok, true);
  assert.equal(first.alreadyExists, false);
  assert.deepEqual(second, { ok: true, leadId: first.leadId, alreadyExists: true });

  const insert = DB.calls.find((call) => call.sql.includes("INSERT INTO ap_leads"));
  assert.equal(insert.values[8], "customer@example.com");
  assert.equal(insert.values[10], "+919876543210");
  assert.equal(insert.values[22], "consultation:idem:request-123");
  assert.deepEqual(JSON.parse(insert.values[19]), { utmSource: "campaign" });
  assert.deepEqual(JSON.parse(insert.values[20]), {
    bookingNumber: "CB-100",
    serviceSlug: "natal-hour",
    paymentOption: "deposit",
    amountCents: 8000,
  });

  const events = DB.calls.filter((call) => call.sql.includes("INSERT INTO ap_business_events"));
  assert.equal(events.length, 1);
  assert.deepEqual(JSON.parse(events[0].values[4]), {
    kind: "consultation",
    source: "consultation_booking",
    formKey: "consultation-checkout",
  });
});

test("business, newsletter, and conversion helpers use deterministic source references", async () => {
  const DB = captureDb();
  const linked = await linkBusinessLead({
    env: { DB },
    submission: {
      kind: "consultation",
      source: "consultation_booking",
      formKey: "booking-checkout",
      fullName: "Customer",
      email: "customer@example.com",
      sourceReferenceType: "consultation_booking",
      sourceReferenceId: "booking_1",
      details: { bookingNumber: "VS-1", serviceSlug: "natal-hour" },
    },
  });
  assert.equal(linked.ok, true);
  assert.ok(DB.calls.find((call) => call.sql.includes("INSERT INTO ap_leads")).values.includes("consultation_booking:booking_1"));

  await linkNewsletterLead({
    env: { DB },
    email: "NEWS@example.com",
    locale: "en",
    source: "newsletter",
    subscriptionId: "newsletter_1",
  });
  assert.ok(DB.calls.some((call) => call.values.includes("newsletter:news@example.com")));

  assert.deepEqual(
    await markLeadConvertedBySourceReference({
      env: { DB },
      sourceReferenceType: "consultation_booking",
      sourceReferenceId: "booking_1",
      conversionReference: "pay_1",
    }),
    { changed: true },
  );
  const conversion = DB.calls.find((call) => call.sql.includes("SET status = 'converted'"));
  assert.deepEqual(conversion.values.slice(-2), ["consultation_booking", "booking_1"]);
});

test("business lead linking and conversion do not break existing flows before migration", async () => {
  const DB = {
    prepare() {
      throw new Error("D1_ERROR: no such table: ap_leads");
    },
  };

  assert.deepEqual(
    await linkBusinessLead({
      env: { DB },
      submission: {
        kind: "contact",
        source: "contact",
        formKey: "contact",
        email: "customer@example.com",
        sourceReferenceType: "contact_request",
        sourceReferenceId: "contact_1",
      },
    }),
    { ok: false, message: "Lead linking was skipped.", skipped: true },
  );

  assert.deepEqual(
    await markLeadConvertedBySourceReference({
      env: { DB },
      sourceReferenceType: "consultation_booking",
      sourceReferenceId: "booking_1",
      conversionReference: "pay_1",
    }),
    { changed: false, skipped: true },
  );
});
