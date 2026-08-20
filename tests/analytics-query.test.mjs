import assert from "node:assert/strict";
import test from "node:test";

import {
  answerAnalyticsQuery,
  findAnalyticsApi,
} from "../src/server/aggregator/analytics-query.ts";

const captureDb = () => {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return {
        bind(...values) {
          calls.push({ sql, values });
          return {
            async first() {
              if (sql.includes("confirmed_at IS NOT NULL")) return { value: 3 };
              if (sql.includes("status = 'succeeded'")) return { value: 4 };
              if (sql.includes("ap_vera_payment_attempts")) return { value: 5 };
              return { value: 6 };
            },
            async all() {
              if (sql.includes("AS gross_revenue")) {
                return { results: [{ currency: "USD", successful_payments: 4, gross_revenue: 800 }] };
              }
              if (sql.includes("AS refunded_revenue")) {
                return { results: [{ currency: "USD", successful_refunds: 1, refunded_revenue: 80 }] };
              }
              if (sql.includes("FROM ap_vera_newsletter_subscriptions")) {
                return { results: [{ status: "subscribed", subscriptions: 7 }, { status: "pending", subscriptions: 2 }] };
              }
              return { results: [] };
            },
          };
        },
      };
    },
  };
};

test("routes Vera business questions to fixed analytics adapters", () => {
  assert.equal(findAnalyticsApi("booking funnel this month").apiKey, "booking_funnel");
  assert.equal(findAnalyticsApi("booking status breakdown").apiKey, "booking_status_breakdown");
  assert.equal(findAnalyticsApi("booking revenue last 30 days").apiKey, "booking_revenue");
  assert.equal(findAnalyticsApi("top consultation services").apiKey, "booking_service_breakdown");
  assert.equal(findAnalyticsApi("consultation mode split").apiKey, "booking_mode_breakdown");
  assert.equal(findAnalyticsApi("newsletter subscriptions").apiKey, "newsletter_summary");
  assert.equal(findAnalyticsApi("contact requests").apiKey, "contact_summary");
  assert.equal(findAnalyticsApi("active waitlist").apiKey, "waitlist_summary");

  const unsupported = findAnalyticsApi("SELECT * FROM ap_customer_accounts");
  assert.equal(unsupported.mode, "unsupported");
});

test("booking funnel uses aggregate-only fixed D1 queries", async () => {
  const db = captureDb();
  const result = await answerAnalyticsQuery({
    db,
    question: "booking funnel this month",
    now: "2026-08-15T12:00:00.000Z",
  });

  assert.equal(result.title, "Booking funnel");
  assert.deepEqual(result.range, {
    from: "2026-08-01",
    to: "2026-09-01",
    label: "this month",
  });
  assert.deepEqual(result.metrics, [
    { label: "Bookings started", value: 6, unit: "count" },
    { label: "Reached payment", value: 5, unit: "count" },
    { label: "Successful payments", value: 4, unit: "count" },
    { label: "Confirmed bookings", value: 3, unit: "count" },
  ]);

  const sql = db.calls.map((call) => call.sql).join("\n");
  assert.match(sql, /FROM ap_vera_bookings/);
  assert.match(sql, /FROM ap_vera_payment_attempts/);
  assert.doesNotMatch(sql, /customer_name|email|phone|birth|intake|message|payload/i);
  assert.equal(db.calls.every((call) => call.values.every((value) =>
    value === "2026-07-31T22:00:00.000Z" || value === "2026-08-31T22:00:00.000Z"
  )), true);
});

test("calendar ranges are exact and honor the requested business timezone", () => {
  const rome = findAnalyticsApi(
    "booking revenue last 7 days",
    "2026-08-15T22:30:00.000Z",
    "Europe/Rome",
  );
  assert.equal(rome.params.from, "2026-08-10");
  assert.equal(rome.params.to, "2026-08-17");
  assert.equal(rome.params.queryFrom, "2026-08-09T22:00:00.000Z");
  assert.equal(rome.params.queryTo, "2026-08-16T22:00:00.000Z");
  assert.equal(rome.params.timezone, "Europe/Rome");

  const fallback = findAnalyticsApi("booking funnel today", "2026-08-15T12:00:00.000Z", "Not/AZone");
  assert.equal(fallback.params.timezone, "Europe/Rome");
});

test("booking revenue combines successful payments and refunds by currency", async () => {
  const db = captureDb();
  const result = await answerAnalyticsQuery({
    db,
    question: "booking net revenue this year",
    now: "2026-08-15T12:00:00.000Z",
  });

  assert.equal(result.title, "Booking revenue");
  assert.deepEqual(result.rows, [{
    currency: "USD",
    successful_payments: 4,
    gross_revenue: 800,
    successful_refunds: 1,
    refunded_revenue: 80,
    net_revenue: 720,
  }]);
  const sql = db.calls.map((call) => call.sql).join("\n");
  assert.match(sql, /FROM ap_vera_payment_attempts/);
  assert.match(sql, /FROM ap_vera_refunds/);
  assert.doesNotMatch(sql, /customer_name|email|phone|birth|intake|message|payload/i);
});

test("newsletter analytics reports status aggregates without subscriber PII", async () => {
  const db = captureDb();
  const result = await answerAnalyticsQuery({
    db,
    question: "newsletter subscriptions",
  });

  assert.equal(result.title, "Newsletter subscriptions");
  assert.deepEqual(result.metrics, [
    { label: "Subscription records", value: 9, unit: "count" },
    { label: "Confirmed subscribers", value: 7, unit: "count" },
  ]);
  const sql = db.calls.map((call) => call.sql).join("\n");
  assert.match(sql, /FROM ap_vera_newsletter_subscriptions/);
  assert.doesNotMatch(sql, /email|display_name|confirmation|unsubscribe/i);
});

test("known analytics questions fail safely when D1 is unavailable", async () => {
  const result = await answerAnalyticsQuery({ question: "booking revenue" });
  assert.equal(result.title, "Vera Solaro analytics unavailable");
  assert.match(result.answer, /database binding is not available/i);
});
