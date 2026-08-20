-- Vera Solaro reporting adapters. The generic 0007 views remain an immutable
-- bootstrap contract; this forward migration replaces them with live data.
DROP VIEW IF EXISTS ap_sales_transactions_v1;
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

DROP VIEW IF EXISTS ap_sales_dimensions_v1;
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
