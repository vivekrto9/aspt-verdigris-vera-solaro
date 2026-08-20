-- The Natal Hour moves to a 30-minute sitting. SQLite cannot ALTER a CHECK
-- constraint, so ap_vera_services has to be rebuilt, and ap_vera_calendly_mappings
-- plus two booking tables hold foreign keys into it.
--
-- D1 applies each migration inside a transaction, where PRAGMA foreign_keys is a
-- no-op, so enforcement is deferred to COMMIT instead. Dropping a referenced parent
-- registers a deferred violation for every child row, and re-creating the table does
-- not clear it — only inserting the parent rows back does. Hence the staging table:
-- empty the parent, drop it, re-create it with the widened CHECK, then restore the
-- rows so each insert resolves the pending references before COMMIT.
--
-- ALTER TABLE ... RENAME is deliberately avoided: SQLite rewrites child FK clauses to
-- follow a renamed parent (legacy_alter_table does not prevent this), which would
-- leave the mappings pointing at the discarded table.
--
-- The 0009 reporting views read ap_vera_services, so they are dropped first and
-- restored verbatim at the end.
PRAGMA defer_foreign_keys = ON;

DROP VIEW IF EXISTS ap_sales_transactions_v1;
DROP VIEW IF EXISTS ap_sales_dimensions_v1;

CREATE TABLE ap_vera_services_stage AS SELECT * FROM ap_vera_services;

DELETE FROM ap_vera_services;
DROP TABLE ap_vera_services;

CREATE TABLE ap_vera_services (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes IN (30, 90, 120)),
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  sort_order INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO ap_vera_services (
  slug, name, duration_minutes, price_cents, currency, active, sort_order,
  created_at, updated_at
)
SELECT
  slug, name, duration_minutes, price_cents, currency, active, sort_order,
  created_at, updated_at
FROM ap_vera_services_stage;

DROP TABLE ap_vera_services_stage;

UPDATE ap_vera_services
SET duration_minutes = 30,
    updated_at = '2026-08-18T00:00:00.000Z'
WHERE slug = 'natal-hour';

-- Restored verbatim from 0009_vera_reporting_views.sql.
CREATE VIEW ap_sales_transactions_v1 AS
WITH refund_totals AS (
  SELECT
    payment_attempt_id,
    COALESCE(SUM(CASE WHEN status = 'succeeded' THEN amount_cents ELSE 0 END), 0) AS refunded_minor
  FROM ap_vera_refunds
  GROUP BY payment_attempt_id
)
SELECT
  payment.id AS transaction_id,
  COALESCE(invoice.invoice_number, booking.booking_number) AS reference,
  'consultation_booking' AS kind_key,
  'Consultation bookings' AS kind_label,
  booking.service_slug AS item_key,
  service.name AS item_label,
  NULL AS owner_key,
  NULL AS owner_label,
  payment.amount_cents AS amount_minor,
  COALESCE(refund.refunded_minor, 0) AS refunded_minor,
  payment.currency AS currency,
  CASE
    WHEN payment.status IN ('creating', 'requires_payment_method', 'requires_action', 'processing') THEN 'pending'
    ELSE payment.status
  END AS payment_status,
  payment.provider AS payment_provider,
  booking.status AS business_status,
  CASE
    WHEN booking.status = 'completed' THEN 'completed'
    WHEN booking.status IN ('confirmed', 'reschedule_pending') THEN 'scheduled'
    WHEN booking.status IN ('cancelled', 'expired', 'refunded') THEN booking.status
    ELSE 'pending'
  END AS fulfillment_status,
  payment.created_at AS created_at,
  CASE WHEN payment.status = 'succeeded' THEN payment.updated_at ELSE NULL END AS paid_at,
  payment.updated_at AS updated_at
FROM ap_vera_payment_attempts payment
JOIN ap_vera_bookings booking ON booking.id = payment.booking_id
JOIN ap_vera_services service ON service.slug = booking.service_slug
LEFT JOIN refund_totals refund ON refund.payment_attempt_id = payment.id
LEFT JOIN ap_vera_invoices invoice ON invoice.payment_attempt_id = payment.id;

CREATE VIEW ap_sales_dimensions_v1 AS
SELECT
  payment.id AS transaction_id,
  'service_slug' AS dimension_key,
  'Consultation service' AS dimension_label,
  service.slug AS value_key,
  service.name AS value_label
FROM ap_vera_payment_attempts payment
JOIN ap_vera_bookings booking ON booking.id = payment.booking_id
JOIN ap_vera_services service ON service.slug = booking.service_slug
UNION ALL
SELECT
  payment.id,
  'consultation_mode' AS dimension_key,
  'Consultation mode' AS dimension_label,
  booking.mode,
  CASE booking.mode WHEN 'in_person' THEN 'In person' ELSE 'Call' END
FROM ap_vera_payment_attempts payment
JOIN ap_vera_bookings booking ON booking.id = payment.booking_id
UNION ALL
SELECT
  payment.id,
  'payment_option' AS dimension_key,
  'Payment option' AS dimension_label,
  booking.payment_option,
  CASE booking.payment_option WHEN 'deposit' THEN 'Deposit' ELSE 'Full payment' END
FROM ap_vera_payment_attempts payment
JOIN ap_vera_bookings booking ON booking.id = payment.booking_id;
