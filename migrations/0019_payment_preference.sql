-- AUTO selects one of two independently configured business prices. No currency
-- value in this migration is derived from another denomination.
INSERT OR IGNORE INTO ap_business_settings (key, value_json, updated_at)
VALUES ('payment_preference', '{"value":"AUTO","schemaVersion":1,"revision":1}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT OR IGNORE INTO ap_business_settings (key, value_json, updated_at)
VALUES ('vera_payment_pricing', '{"deposit_usd_cents":8000,"deposit_inr_cents":650000,"schemaVersion":1}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

ALTER TABLE ap_vera_services ADD COLUMN price_inr_cents INTEGER;
ALTER TABLE ap_vera_services ADD COLUMN price_usd_cents INTEGER;

-- USD is the historical native denomination and is preserved byte-for-byte.
-- INR values are explicit business defaults, deliberately unrelated numerically.
UPDATE ap_vera_services SET
  price_usd_cents = CASE WHEN currency = 'USD' THEN price_cents ELSE price_usd_cents END,
  price_inr_cents = CASE slug
    WHEN 'natal-hour' THEN 1990000
    WHEN 'year-ahead' THEN 3150000
    WHEN 'two-charts' THEN 3490000
    ELSE price_inr_cents
  END;

CREATE TRIGGER ap_vera_service_legacy_price_update
AFTER UPDATE OF price_cents, currency ON ap_vera_services
WHEN NEW.price_cents IS NOT OLD.price_cents OR NEW.currency IS NOT OLD.currency
BEGIN
  UPDATE ap_vera_services SET
    price_inr_cents = CASE WHEN UPPER(NEW.currency) = 'INR' THEN NEW.price_cents ELSE price_inr_cents END,
    price_usd_cents = CASE WHEN UPPER(NEW.currency) = 'USD' THEN NEW.price_cents ELSE price_usd_cents END
  WHERE slug = NEW.slug;
END;

CREATE TRIGGER ap_vera_service_legacy_price_insert
AFTER INSERT ON ap_vera_services
BEGIN
  UPDATE ap_vera_services SET
    price_inr_cents = CASE WHEN UPPER(NEW.currency) = 'INR' THEN COALESCE(NEW.price_inr_cents, NEW.price_cents) ELSE NEW.price_inr_cents END,
    price_usd_cents = CASE WHEN UPPER(NEW.currency) = 'USD' THEN COALESCE(NEW.price_usd_cents, NEW.price_cents) ELSE NEW.price_usd_cents END
  WHERE slug = NEW.slug;
END;

-- The original Vera tables constrained all historical money to USD/Stripe. Rebuild
-- only the four money-bearing tables whose constraints must admit INR/Razorpay.
PRAGMA defer_foreign_keys = ON;
DROP VIEW IF EXISTS ap_sales_transactions_v1;
DROP VIEW IF EXISTS ap_sales_dimensions_v1;

CREATE TABLE ap_vera_bookings_payment_stage AS SELECT * FROM ap_vera_bookings;
CREATE TABLE ap_vera_attempts_payment_stage AS SELECT * FROM ap_vera_payment_attempts;
CREATE TABLE ap_vera_refunds_payment_stage AS SELECT * FROM ap_vera_refunds;
CREATE TABLE ap_vera_invoices_payment_stage AS SELECT * FROM ap_vera_invoices;

DROP TABLE ap_vera_invoices;
DROP TABLE ap_vera_refunds;
DROP TABLE ap_vera_payment_attempts;
DROP TABLE ap_vera_bookings;

CREATE TABLE ap_vera_bookings (
  id TEXT PRIMARY KEY, booking_number TEXT NOT NULL UNIQUE, request_idempotency_key TEXT NOT NULL UNIQUE,
  account_id TEXT, service_slug TEXT NOT NULL, mode TEXT NOT NULL CHECK (mode IN ('call','in_person')),
  status TEXT NOT NULL DEFAULT 'pending_payment' CHECK (status IN ('pending_payment','payment_action_required','confirmed','reschedule_pending','cancelled','expired','completed','refunded')),
  payment_state TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_state IN ('unpaid','deposit_paid','paid','partially_refunded','refunded')),
  payment_option TEXT NOT NULL CHECK (payment_option IN ('deposit','full')),
  customer_name TEXT NOT NULL, email TEXT NOT NULL, normalized_email TEXT NOT NULL, phone TEXT,
  customer_timezone TEXT NOT NULL, selected_start_at TEXT NOT NULL, selected_end_at TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents > 0), deposit_cents INTEGER NOT NULL DEFAULT 8000 CHECK (deposit_cents > 0),
  gift_applied_cents INTEGER NOT NULL DEFAULT 0 CHECK (gift_applied_cents >= 0),
  total_due_cents INTEGER NOT NULL CHECK (total_due_cents >= 0), paid_cents INTEGER NOT NULL DEFAULT 0 CHECK (paid_cents >= 0),
  balance_cents INTEGER NOT NULL CHECK (balance_cents >= 0), currency TEXT NOT NULL CHECK (currency IN ('USD','INR')),
  gift_certificate_id TEXT, manage_token_hash TEXT, manage_token_expires_at TEXT, encrypted_intake TEXT,
  calendly_event_type_uri TEXT NOT NULL, calendly_event_uri TEXT, calendly_invitee_uri TEXT, calendly_cancel_url TEXT,
  calendly_reschedule_url TEXT, calendly_meeting_url TEXT, scheduling_error TEXT,
  free_reschedule_used INTEGER NOT NULL DEFAULT 0 CHECK (free_reschedule_used IN (0,1)), reschedule_count INTEGER NOT NULL DEFAULT 0 CHECK (reschedule_count >= 0),
  hold_expires_at TEXT, confirmed_at TEXT, cancelled_at TEXT, cancellation_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  scheduling_provider TEXT NOT NULL DEFAULT 'calendly', scheduling_calendar_id TEXT, scheduling_timezone TEXT, scheduling_rules_json TEXT,
  scheduling_buffer_before INTEGER NOT NULL DEFAULT 0, scheduling_buffer_after INTEGER NOT NULL DEFAULT 0,
  scheduling_attempted INTEGER NOT NULL DEFAULT 0, scheduling_operation TEXT,
  analytics_client_id TEXT, analytics_provider TEXT, analytics_session_id TEXT,
  FOREIGN KEY (account_id) REFERENCES ap_customer_accounts(id), FOREIGN KEY (service_slug) REFERENCES ap_vera_services(slug),
  FOREIGN KEY (gift_certificate_id) REFERENCES ap_vera_gift_certificates(id)
);

INSERT INTO ap_vera_bookings SELECT
  id, booking_number, request_idempotency_key, account_id, service_slug, mode, status, payment_state, payment_option,
  customer_name, email, normalized_email, phone, customer_timezone, selected_start_at, selected_end_at,
  price_cents, 8000, gift_applied_cents, total_due_cents, paid_cents, balance_cents, currency,
  gift_certificate_id, manage_token_hash, manage_token_expires_at, encrypted_intake, calendly_event_type_uri,
  calendly_event_uri, calendly_invitee_uri, calendly_cancel_url, calendly_reschedule_url, calendly_meeting_url,
  scheduling_error, free_reschedule_used, reschedule_count, hold_expires_at, confirmed_at, cancelled_at,
  cancellation_reason, created_at, updated_at, scheduling_provider, scheduling_calendar_id, scheduling_timezone,
  scheduling_rules_json, scheduling_buffer_before, scheduling_buffer_after, scheduling_attempted, scheduling_operation,
  analytics_client_id, analytics_provider, analytics_session_id
FROM ap_vera_bookings_payment_stage;

CREATE INDEX idx_ap_vera_bookings_account ON ap_vera_bookings(account_id, created_at DESC);
CREATE INDEX idx_ap_vera_bookings_email ON ap_vera_bookings(normalized_email, created_at DESC);
CREATE INDEX idx_ap_vera_bookings_slot ON ap_vera_bookings(selected_start_at, status);
CREATE INDEX idx_ap_vera_bookings_expiry ON ap_vera_bookings(status, hold_expires_at);

CREATE TABLE ap_vera_payment_attempts (
  id TEXT PRIMARY KEY, booking_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('deposit','full','balance')),
  provider TEXT NOT NULL DEFAULT 'stripe' CHECK (provider IN ('stripe','razorpay')), provider_payment_intent_id TEXT UNIQUE,
  provider_order_id TEXT UNIQUE, idempotency_key TEXT NOT NULL UNIQUE, amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL CHECK (currency IN ('USD','INR')),
  status TEXT NOT NULL DEFAULT 'creating' CHECK (status IN ('creating','requires_payment_method','requires_action','processing','succeeded','failed','cancelled')),
  last_error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY (booking_id) REFERENCES ap_vera_bookings(id) ON DELETE CASCADE
);
INSERT INTO ap_vera_payment_attempts (id,booking_id,kind,provider,provider_payment_intent_id,provider_order_id,idempotency_key,amount_cents,currency,status,last_error_code,created_at,updated_at)
SELECT id,booking_id,kind,provider,provider_payment_intent_id,NULL,idempotency_key,amount_cents,currency,status,last_error_code,created_at,updated_at FROM ap_vera_attempts_payment_stage;
CREATE INDEX idx_ap_vera_payment_attempts_booking ON ap_vera_payment_attempts(booking_id, created_at DESC);

CREATE TABLE ap_vera_refunds (
  id TEXT PRIMARY KEY, booking_id TEXT NOT NULL, payment_attempt_id TEXT NOT NULL, provider_refund_id TEXT UNIQUE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0), currency TEXT NOT NULL CHECK (currency IN ('USD','INR')),
  reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','failed','cancelled')),
  idempotency_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY (booking_id) REFERENCES ap_vera_bookings(id), FOREIGN KEY (payment_attempt_id) REFERENCES ap_vera_payment_attempts(id)
);
INSERT INTO ap_vera_refunds SELECT * FROM ap_vera_refunds_payment_stage;
CREATE INDEX idx_ap_vera_refunds_booking ON ap_vera_refunds(booking_id, created_at DESC);

CREATE TABLE ap_vera_invoices (
  id TEXT PRIMARY KEY, booking_id TEXT NOT NULL, payment_attempt_id TEXT NOT NULL UNIQUE, invoice_number TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('paid','partially_refunded','refunded')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0), currency TEXT NOT NULL CHECK (currency IN ('USD','INR')),
  provider_payment_intent_id TEXT NOT NULL, issued_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY (booking_id) REFERENCES ap_vera_bookings(id), FOREIGN KEY (payment_attempt_id) REFERENCES ap_vera_payment_attempts(id)
);
INSERT INTO ap_vera_invoices SELECT * FROM ap_vera_invoices_payment_stage;
CREATE INDEX idx_ap_vera_invoices_booking ON ap_vera_invoices(booking_id, issued_at DESC);

DROP TABLE ap_vera_bookings_payment_stage;
DROP TABLE ap_vera_attempts_payment_stage;
DROP TABLE ap_vera_refunds_payment_stage;
DROP TABLE ap_vera_invoices_payment_stage;

CREATE TRIGGER trg_ap_vera_payment_selection_lock BEFORE UPDATE OF payment_option,gift_certificate_id,gift_applied_cents,total_due_cents ON ap_vera_bookings
WHEN (OLD.payment_option != NEW.payment_option OR IFNULL(OLD.gift_certificate_id,'') != IFNULL(NEW.gift_certificate_id,'') OR OLD.gift_applied_cents != NEW.gift_applied_cents OR OLD.total_due_cents != NEW.total_due_cents)
AND EXISTS (SELECT 1 FROM ap_vera_payment_attempts attempt WHERE attempt.booking_id = OLD.id AND (attempt.provider_payment_intent_id IS NOT NULL OR attempt.status NOT IN ('failed','cancelled')))
BEGIN SELECT RAISE(ABORT, 'vera_payment_selection_locked'); END;

CREATE TRIGGER ap_vera_booking_reservation_insert AFTER INSERT ON ap_vera_bookings WHEN NEW.status NOT IN ('cancelled','expired','refunded','completed')
BEGIN INSERT INTO ap_vera_scheduling_reservations(id,booking_id,start_ms,end_ms,expires_at) VALUES (NEW.id,NEW.id,CAST(ROUND((julianday(NEW.selected_start_at)-2440587.5)*86400000) AS INTEGER)-NEW.scheduling_buffer_before*60000,CAST(ROUND((julianday(NEW.selected_end_at)-2440587.5)*86400000) AS INTEGER)+NEW.scheduling_buffer_after*60000,CASE WHEN NEW.payment_state IN ('paid','deposit_paid') THEN NULL ELSE NEW.hold_expires_at END); END;

CREATE TRIGGER ap_vera_booking_reservation_update AFTER UPDATE OF status,payment_state,selected_start_at,selected_end_at,hold_expires_at ON ap_vera_bookings
BEGIN
  DELETE FROM ap_vera_scheduling_reservations WHERE booking_id=NEW.id AND NEW.status IN ('cancelled','expired','refunded','completed');
  INSERT INTO ap_vera_scheduling_reservations(id,booking_id,start_ms,end_ms,expires_at)
  SELECT NEW.id,NEW.id,CAST(ROUND((julianday(NEW.selected_start_at)-2440587.5)*86400000) AS INTEGER)-NEW.scheduling_buffer_before*60000,CAST(ROUND((julianday(NEW.selected_end_at)-2440587.5)*86400000) AS INTEGER)+NEW.scheduling_buffer_after*60000,CASE WHEN NEW.payment_state IN ('paid','deposit_paid') THEN NULL ELSE NEW.hold_expires_at END
  WHERE NEW.status NOT IN ('cancelled','expired','refunded','completed') ON CONFLICT(id) DO UPDATE SET start_ms=excluded.start_ms,end_ms=excluded.end_ms,expires_at=excluded.expires_at;
END;

CREATE VIEW ap_sales_transactions_v1 AS
WITH refund_totals AS (SELECT payment_attempt_id,COALESCE(SUM(CASE WHEN status='succeeded' THEN amount_cents ELSE 0 END),0) AS refunded_minor FROM ap_vera_refunds GROUP BY payment_attempt_id)
SELECT payment.id AS transaction_id,COALESCE(invoice.invoice_number,booking.booking_number) AS reference,'consultation_booking' AS kind_key,'Consultation bookings' AS kind_label,booking.service_slug AS item_key,service.name AS item_label,NULL AS owner_key,NULL AS owner_label,payment.amount_cents AS amount_minor,COALESCE(refund.refunded_minor,0) AS refunded_minor,payment.currency AS currency,CASE WHEN payment.status IN ('creating','requires_payment_method','requires_action','processing') THEN 'pending' ELSE payment.status END AS payment_status,payment.provider AS payment_provider,booking.status AS business_status,CASE WHEN booking.status='completed' THEN 'completed' WHEN booking.status IN ('confirmed','reschedule_pending') THEN 'scheduled' WHEN booking.status IN ('cancelled','expired','refunded') THEN booking.status ELSE 'pending' END AS fulfillment_status,payment.created_at AS created_at,CASE WHEN payment.status='succeeded' THEN payment.updated_at ELSE NULL END AS paid_at,payment.updated_at AS updated_at
FROM ap_vera_payment_attempts payment JOIN ap_vera_bookings booking ON booking.id=payment.booking_id JOIN ap_vera_services service ON service.slug=booking.service_slug LEFT JOIN refund_totals refund ON refund.payment_attempt_id=payment.id LEFT JOIN ap_vera_invoices invoice ON invoice.payment_attempt_id=payment.id;

CREATE VIEW ap_sales_dimensions_v1 AS
SELECT payment.id AS transaction_id,'service_slug' AS dimension_key,'Consultation service' AS dimension_label,service.slug AS value_key,service.name AS value_label FROM ap_vera_payment_attempts payment JOIN ap_vera_bookings booking ON booking.id=payment.booking_id JOIN ap_vera_services service ON service.slug=booking.service_slug
UNION ALL SELECT payment.id,'consultation_mode','Consultation mode',booking.mode,CASE booking.mode WHEN 'in_person' THEN 'In person' ELSE 'Call' END FROM ap_vera_payment_attempts payment JOIN ap_vera_bookings booking ON booking.id=payment.booking_id
UNION ALL SELECT payment.id,'payment_option','Payment option',booking.payment_option,CASE booking.payment_option WHEN 'deposit' THEN 'Deposit' ELSE 'Full payment' END FROM ap_vera_payment_attempts payment JOIN ap_vera_bookings booking ON booking.id=payment.booking_id;
