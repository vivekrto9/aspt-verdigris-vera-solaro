import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  executeSalesMcpMethod,
  SalesMcpMethodError,
} from "../src/server/aggregator/sales-mcp.ts";

const root = new URL("../", import.meta.url);

const migratedDatabase = () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const migration of readdirSync(new URL("migrations/", root)).filter((name) => name.endsWith(".sql")).sort()) {
    // D1 applies each migration file inside a single transaction.
    sqlite.exec("BEGIN");
    sqlite.exec(readFileSync(new URL(`migrations/${migration}`, root), "utf8"));
    sqlite.exec("COMMIT");
  }
  sqlite.exec(`
    INSERT INTO ap_vera_bookings (
      id, booking_number, request_idempotency_key, service_slug, mode,
      status, payment_state, payment_option, customer_name, email,
      normalized_email, customer_timezone, selected_start_at, selected_end_at,
      price_cents, total_due_cents, paid_cents, balance_cents, currency,
      manage_token_hash, calendly_event_type_uri, confirmed_at, created_at, updated_at
    ) VALUES (
      'booking-1', 'VS-100', 'request-1', 'natal-hour', 'call',
      'confirmed', 'deposit_paid', 'deposit', 'Private client', 'client@example.com',
      'client@example.com', 'Europe/Rome', '2026-09-01T10:00:00.000Z', '2026-09-01T11:30:00.000Z',
      24000, 24000, 8000, 16000, 'USD',
      'manage-hash', 'https://api.calendly.com/event_types/example', '2026-08-15T10:03:00.000Z',
      '2026-08-15T10:00:00.000Z', '2026-08-15T10:03:00.000Z'
    );
    INSERT INTO ap_vera_payment_attempts (
      id, booking_id, kind, provider, provider_payment_intent_id,
      idempotency_key, amount_cents, currency, status, created_at, updated_at
    ) VALUES (
      'payment-1', 'booking-1', 'deposit', 'stripe', 'pi_example',
      'payment-idem-1', 8000, 'USD', 'succeeded',
      '2026-08-15T10:01:00.000Z', '2026-08-15T10:02:00.000Z'
    );
    INSERT INTO ap_vera_refunds (
      id, booking_id, payment_attempt_id, provider_refund_id, amount_cents,
      currency, reason, status, idempotency_key, created_at, updated_at
    ) VALUES (
      'refund-1', 'booking-1', 'payment-1', 're_example', 1000,
      'USD', 'customer_request', 'succeeded', 'refund-idem-1',
      '2026-08-16T10:00:00.000Z', '2026-08-16T10:01:00.000Z'
    );
    INSERT INTO ap_vera_invoices (
      id, booking_id, payment_attempt_id, invoice_number, status,
      amount_cents, currency, provider_payment_intent_id, issued_at, updated_at
    ) VALUES (
      'invoice-1', 'booking-1', 'payment-1', 'VSI-100', 'partially_refunded',
      8000, 'USD', 'pi_example', '2026-08-15T10:02:00.000Z', '2026-08-16T10:01:00.000Z'
    );
  `);
  const DB = {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      return {
        bind(...values) {
          return {
            async first() {
              return statement.get(...values) ?? null;
            },
            async all() {
              return { results: statement.all(...values) };
            },
          };
        },
      };
    },
  };
  return { sqlite, DB };
};

test("forward reporting migration maps only Vera consultation payments", () => {
  const { sqlite } = migratedDatabase();
  const transaction = sqlite.prepare("SELECT * FROM ap_sales_transactions_v1").get();
  assert.equal(transaction.transaction_id, "payment-1");
  assert.equal(transaction.reference, "VSI-100");
  assert.equal(transaction.kind_key, "consultation_booking");
  assert.equal(transaction.item_key, "natal-hour");
  assert.equal(transaction.item_label, "The Natal Hour");
  assert.equal(transaction.amount_minor, 8000);
  assert.equal(transaction.refunded_minor, 1000);
  assert.equal(transaction.payment_status, "succeeded");
  assert.equal(transaction.owner_key, null);
  assert.equal(transaction.owner_label, null);

  const dimensions = sqlite.prepare(
    "SELECT dimension_key, value_key, value_label FROM ap_sales_dimensions_v1 ORDER BY dimension_key",
  ).all();
  assert.deepEqual(dimensions.map((row) => ({ ...row })), [
    { dimension_key: "consultation_mode", value_key: "call", value_label: "Call" },
    { dimension_key: "payment_option", value_key: "deposit", value_label: "Deposit" },
    { dimension_key: "service_slug", value_key: "natal-hour", value_label: "The Natal Hour" },
  ]);
});

test("Sales MCP exposes Vera services and refund-aware metrics", async () => {
  const { DB } = migratedDatabase();
  const schema = await executeSalesMcpMethod(DB, "sales_schema", {});
  assert.deepEqual(schema.transactionKinds.map((kind) => kind.key), ["consultation_booking"]);
  assert.deepEqual(schema.entityTypes.map((entity) => entity.key), ["item"]);
  for (const key of ["service_slug", "consultation_mode", "payment_option"]) {
    assert.equal(schema.dimensions.some((dimension) => dimension.key === key), true);
  }

  const gross = await executeSalesMcpMethod(DB, "sales_metric", {
    metric: "gross_revenue",
    range: { from: "2026-08-01", to: "2026-08-31" },
  });
  const net = await executeSalesMcpMethod(DB, "sales_metric", {
    metric: "net_revenue",
    range: { from: "2026-08-01", to: "2026-08-31" },
  });
  assert.equal(gross.value, 8000);
  assert.equal(net.value, 7000);
  assert.equal(gross.currency, "USD");

  await assert.rejects(
    executeSalesMcpMethod(DB, "sales_metric", {
      metric: "transaction_count",
      range: { from: "2026-08-01", to: "2026-08-31" },
      filters: { transactionKind: "product_order" },
    }),
    (error) => error instanceof SalesMcpMethodError && error.code === "INVALID_SALES_ARGUMENTS",
  );
});
