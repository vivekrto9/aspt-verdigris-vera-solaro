ALTER TABLE ap_customer_accounts
  ADD COLUMN email_verification_token_hash TEXT;

ALTER TABLE ap_customer_accounts
  ADD COLUMN email_verification_expires_at TEXT;

CREATE INDEX IF NOT EXISTS idx_ap_customer_accounts_verification
  ON ap_customer_accounts (email_verification_token_hash);

CREATE TABLE IF NOT EXISTS ap_vera_rate_limits (
  scope TEXT NOT NULL,
  identity_hash TEXT NOT NULL,
  window_started_at TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, identity_hash, window_started_at)
);

CREATE INDEX IF NOT EXISTS idx_ap_vera_rate_limits_updated
  ON ap_vera_rate_limits (updated_at);

CREATE TABLE IF NOT EXISTS ap_vera_services (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes IN (90, 120)),
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  sort_order INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO ap_vera_services (
  slug, name, duration_minutes, price_cents, currency, active, sort_order,
  created_at, updated_at
) VALUES
  ('natal-hour', 'The Natal Hour', 90, 24000, 'USD', 1, 10, '2026-08-15T00:00:00.000Z', '2026-08-15T00:00:00.000Z'),
  ('year-ahead', 'The Year Ahead', 120, 38500, 'USD', 1, 20, '2026-08-15T00:00:00.000Z', '2026-08-15T00:00:00.000Z'),
  ('two-charts', 'Two Charts', 120, 42000, 'USD', 1, 30, '2026-08-15T00:00:00.000Z', '2026-08-15T00:00:00.000Z');

CREATE TABLE IF NOT EXISTS ap_vera_calendly_mappings (
  service_slug TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('call', 'in_person')),
  event_type_uri TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (service_slug, mode),
  FOREIGN KEY (service_slug) REFERENCES ap_vera_services (slug)
);

INSERT OR IGNORE INTO ap_vera_calendly_mappings (
  service_slug, mode, event_type_uri, active, updated_at
) VALUES
  ('natal-hour', 'call', NULL, 1, '2026-08-15T00:00:00.000Z'),
  ('natal-hour', 'in_person', NULL, 1, '2026-08-15T00:00:00.000Z'),
  ('year-ahead', 'call', NULL, 1, '2026-08-15T00:00:00.000Z'),
  ('year-ahead', 'in_person', NULL, 1, '2026-08-15T00:00:00.000Z'),
  ('two-charts', 'call', NULL, 1, '2026-08-15T00:00:00.000Z'),
  ('two-charts', 'in_person', NULL, 1, '2026-08-15T00:00:00.000Z');

INSERT OR IGNORE INTO ap_runtime_config (
  key, value, provider_key, scope, status, updated_at
) VALUES
  ('VERA_CALENDLY_NATAL_HOUR_CALL_URI', '', 'calendly', 'site', 'active', '2026-08-15T00:00:00.000Z'),
  ('VERA_CALENDLY_NATAL_HOUR_IN_PERSON_URI', '', 'calendly', 'site', 'active', '2026-08-15T00:00:00.000Z'),
  ('VERA_CALENDLY_YEAR_AHEAD_CALL_URI', '', 'calendly', 'site', 'active', '2026-08-15T00:00:00.000Z'),
  ('VERA_CALENDLY_YEAR_AHEAD_IN_PERSON_URI', '', 'calendly', 'site', 'active', '2026-08-15T00:00:00.000Z'),
  ('VERA_CALENDLY_TWO_CHARTS_CALL_URI', '', 'calendly', 'site', 'active', '2026-08-15T00:00:00.000Z'),
  ('VERA_CALENDLY_TWO_CHARTS_IN_PERSON_URI', '', 'calendly', 'site', 'active', '2026-08-15T00:00:00.000Z'),
  ('STRIPE_PUBLISHABLE_KEY', '', 'stripe', 'site', 'active', '2026-08-15T00:00:00.000Z');

INSERT INTO ap_runtime_config (
  key, value, provider_key, scope, status, updated_at
) VALUES (
  'site.identity', 'Vera Solaro', NULL, 'site', 'active', '2026-08-15T00:00:00.000Z'
)
ON CONFLICT(key) DO UPDATE SET
  value = 'Vera Solaro', status = 'active', updated_at = excluded.updated_at;

INSERT OR IGNORE INTO ap_business_settings (key, value_json, updated_at)
VALUES ('site', '{"brandName":"Vera Solaro"}', '2026-08-15T00:00:00.000Z');

UPDATE ap_business_settings
SET value_json = json_set(value_json, '$.brandName', 'Vera Solaro'),
    updated_at = '2026-08-15T00:00:00.000Z'
WHERE key = 'site';

CREATE TABLE IF NOT EXISTS ap_vera_gift_certificates (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'depleted', 'expired', 'void')),
  original_amount_cents INTEGER NOT NULL CHECK (original_amount_cents > 0),
  remaining_amount_cents INTEGER NOT NULL CHECK (remaining_amount_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  expires_at TEXT,
  issued_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ap_vera_gifts_status
  ON ap_vera_gift_certificates (status, expires_at);

CREATE TABLE IF NOT EXISTS ap_vera_bookings (
  id TEXT PRIMARY KEY,
  booking_number TEXT NOT NULL UNIQUE,
  request_idempotency_key TEXT NOT NULL UNIQUE,
  account_id TEXT,
  service_slug TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('call', 'in_person')),
  status TEXT NOT NULL DEFAULT 'pending_payment'
    CHECK (status IN (
      'pending_payment', 'payment_action_required', 'confirmed',
      'reschedule_pending', 'cancelled', 'expired', 'completed', 'refunded'
    )),
  payment_state TEXT NOT NULL DEFAULT 'unpaid'
    CHECK (payment_state IN ('unpaid', 'deposit_paid', 'paid', 'partially_refunded', 'refunded')),
  payment_option TEXT NOT NULL CHECK (payment_option IN ('deposit', 'full')),
  customer_name TEXT NOT NULL,
  email TEXT NOT NULL,
  normalized_email TEXT NOT NULL,
  phone TEXT,
  customer_timezone TEXT NOT NULL,
  selected_start_at TEXT NOT NULL,
  selected_end_at TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  gift_applied_cents INTEGER NOT NULL DEFAULT 0 CHECK (gift_applied_cents >= 0),
  total_due_cents INTEGER NOT NULL CHECK (total_due_cents >= 0),
  paid_cents INTEGER NOT NULL DEFAULT 0 CHECK (paid_cents >= 0),
  balance_cents INTEGER NOT NULL CHECK (balance_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  gift_certificate_id TEXT,
  manage_token_hash TEXT,
  manage_token_expires_at TEXT,
  encrypted_intake TEXT,
  calendly_event_type_uri TEXT NOT NULL,
  calendly_event_uri TEXT,
  calendly_invitee_uri TEXT,
  calendly_cancel_url TEXT,
  calendly_reschedule_url TEXT,
  calendly_meeting_url TEXT,
  scheduling_error TEXT,
  free_reschedule_used INTEGER NOT NULL DEFAULT 0 CHECK (free_reschedule_used IN (0, 1)),
  reschedule_count INTEGER NOT NULL DEFAULT 0 CHECK (reschedule_count >= 0),
  hold_expires_at TEXT,
  confirmed_at TEXT,
  cancelled_at TEXT,
  cancellation_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES ap_customer_accounts (id),
  FOREIGN KEY (service_slug) REFERENCES ap_vera_services (slug),
  FOREIGN KEY (gift_certificate_id) REFERENCES ap_vera_gift_certificates (id)
);

CREATE INDEX IF NOT EXISTS idx_ap_vera_bookings_account
  ON ap_vera_bookings (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ap_vera_bookings_email
  ON ap_vera_bookings (normalized_email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ap_vera_bookings_slot
  ON ap_vera_bookings (selected_start_at, status);
CREATE INDEX IF NOT EXISTS idx_ap_vera_bookings_expiry
  ON ap_vera_bookings (status, hold_expires_at);

CREATE TABLE IF NOT EXISTS ap_vera_booking_slot_holds (
  slot_start_at TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (booking_id) REFERENCES ap_vera_bookings (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ap_vera_holds_booking
  ON ap_vera_booking_slot_holds (booking_id);
CREATE INDEX IF NOT EXISTS idx_ap_vera_holds_expiry
  ON ap_vera_booking_slot_holds (expires_at);

CREATE TABLE IF NOT EXISTS ap_vera_booking_events (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL DEFAULT 'system'
    CHECK (actor_type IN ('customer', 'staff', 'provider', 'system')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (booking_id) REFERENCES ap_vera_bookings (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ap_vera_booking_events
  ON ap_vera_booking_events (booking_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ap_vera_reschedule_requests (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'authorized'
    CHECK (status IN ('authorized', 'completed', 'expired', 'denied', 'cancelled')),
  policy TEXT NOT NULL DEFAULT 'one_free_until_72h',
  previous_start_at TEXT NOT NULL,
  replacement_start_at TEXT,
  provider_reschedule_url TEXT,
  authorized_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (booking_id) REFERENCES ap_vera_bookings (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ap_vera_reschedules_booking
  ON ap_vera_reschedule_requests (booking_id, authorized_at DESC);

CREATE TABLE IF NOT EXISTS ap_vera_payment_attempts (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('deposit', 'full', 'balance')),
  provider TEXT NOT NULL DEFAULT 'stripe' CHECK (provider = 'stripe'),
  provider_payment_intent_id TEXT UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  status TEXT NOT NULL DEFAULT 'creating'
    CHECK (status IN (
      'creating', 'requires_payment_method', 'requires_action', 'processing',
      'succeeded', 'failed', 'cancelled'
    )),
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (booking_id) REFERENCES ap_vera_bookings (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ap_vera_payment_attempts_booking
  ON ap_vera_payment_attempts (booking_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_ap_vera_payment_selection_lock
BEFORE UPDATE OF payment_option, gift_certificate_id, gift_applied_cents, total_due_cents
ON ap_vera_bookings
WHEN (
  OLD.payment_option != NEW.payment_option OR
  IFNULL(OLD.gift_certificate_id, '') != IFNULL(NEW.gift_certificate_id, '') OR
  OLD.gift_applied_cents != NEW.gift_applied_cents OR
  OLD.total_due_cents != NEW.total_due_cents
) AND EXISTS (
  SELECT 1 FROM ap_vera_payment_attempts attempt
  WHERE attempt.booking_id = OLD.id
    AND (
      attempt.provider_payment_intent_id IS NOT NULL OR
      attempt.status NOT IN ('failed', 'cancelled')
    )
)
BEGIN
  SELECT RAISE(ABORT, 'vera_payment_selection_locked');
END;

CREATE TABLE IF NOT EXISTS ap_vera_payment_events (
  id TEXT PRIMARY KEY,
  provider_event_id TEXT NOT NULL UNIQUE,
  provider_payment_intent_id TEXT NOT NULL,
  booking_id TEXT,
  event_type TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  FOREIGN KEY (booking_id) REFERENCES ap_vera_bookings (id)
);

CREATE INDEX IF NOT EXISTS idx_ap_vera_payment_events_intent
  ON ap_vera_payment_events (provider_payment_intent_id, processed_at DESC);

CREATE TABLE IF NOT EXISTS ap_vera_refunds (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL,
  payment_attempt_id TEXT NOT NULL,
  provider_refund_id TEXT UNIQUE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'succeeded', 'failed', 'cancelled')),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (booking_id) REFERENCES ap_vera_bookings (id),
  FOREIGN KEY (payment_attempt_id) REFERENCES ap_vera_payment_attempts (id)
);

CREATE INDEX IF NOT EXISTS idx_ap_vera_refunds_booking
  ON ap_vera_refunds (booking_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ap_vera_invoices (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL,
  payment_attempt_id TEXT NOT NULL UNIQUE,
  invoice_number TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('paid', 'partially_refunded', 'refunded')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  provider_payment_intent_id TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (booking_id) REFERENCES ap_vera_bookings (id),
  FOREIGN KEY (payment_attempt_id) REFERENCES ap_vera_payment_attempts (id)
);

CREATE INDEX IF NOT EXISTS idx_ap_vera_invoices_booking
  ON ap_vera_invoices (booking_id, issued_at DESC);

CREATE TABLE IF NOT EXISTS ap_vera_gift_redemptions (
  id TEXT PRIMARY KEY,
  gift_certificate_id TEXT NOT NULL,
  booking_id TEXT NOT NULL UNIQUE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  status TEXT NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved', 'applied', 'released')),
  created_at TEXT NOT NULL,
  applied_at TEXT,
  released_at TEXT,
  FOREIGN KEY (gift_certificate_id) REFERENCES ap_vera_gift_certificates (id),
  FOREIGN KEY (booking_id) REFERENCES ap_vera_bookings (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ap_vera_gift_redemptions_gift
  ON ap_vera_gift_redemptions (gift_certificate_id, status);

CREATE TRIGGER IF NOT EXISTS trg_ap_vera_gift_reserve
BEFORE INSERT ON ap_vera_gift_redemptions
WHEN NEW.status = 'reserved'
BEGIN
  UPDATE ap_vera_gift_certificates
  SET remaining_amount_cents = remaining_amount_cents - NEW.amount_cents,
      status = (CASE
        WHEN remaining_amount_cents - NEW.amount_cents = 0 THEN 'depleted'
        ELSE 'active'
      END),
      updated_at = NEW.created_at
  WHERE id = NEW.gift_certificate_id
    AND status = 'active'
    AND (expires_at IS NULL OR expires_at > NEW.created_at)
    AND remaining_amount_cents >= NEW.amount_cents;
  SELECT (CASE WHEN changes() != 1 THEN RAISE(ABORT, 'vera_gift_unavailable') END);
END;

CREATE TRIGGER IF NOT EXISTS trg_ap_vera_gift_release
AFTER UPDATE OF status ON ap_vera_gift_redemptions
WHEN OLD.status IN ('reserved', 'applied') AND NEW.status = 'released'
BEGIN
  UPDATE ap_vera_gift_certificates
  SET remaining_amount_cents = remaining_amount_cents + NEW.amount_cents,
      status = 'active',
      updated_at = COALESCE(NEW.released_at, NEW.created_at)
  WHERE id = NEW.gift_certificate_id AND status != 'void';
END;

CREATE TABLE IF NOT EXISTS ap_vera_waitlist_entries (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  customer_name TEXT NOT NULL,
  email TEXT NOT NULL,
  normalized_email TEXT NOT NULL,
  phone TEXT,
  service_slug TEXT,
  mode TEXT CHECK (mode IN ('call', 'in_person')),
  earliest_date TEXT,
  latest_date TEXT,
  short_notice INTEGER NOT NULL DEFAULT 1 CHECK (short_notice IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'contacted', 'booked', 'closed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES ap_customer_accounts (id),
  FOREIGN KEY (service_slug) REFERENCES ap_vera_services (slug)
);

CREATE INDEX IF NOT EXISTS idx_ap_vera_waitlist_active
  ON ap_vera_waitlist_entries (status, service_slug, mode, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ap_vera_waitlist_dedupe
  ON ap_vera_waitlist_entries (normalized_email, IFNULL(service_slug, ''), IFNULL(mode, ''))
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS ap_vera_contact_requests (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  customer_name TEXT NOT NULL,
  email TEXT NOT NULL,
  normalized_email TEXT NOT NULL,
  phone TEXT,
  topic TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'in_progress', 'resolved', 'spam')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES ap_customer_accounts (id)
);

CREATE INDEX IF NOT EXISTS idx_ap_vera_contacts_status
  ON ap_vera_contact_requests (status, created_at DESC);

CREATE TABLE IF NOT EXISTS ap_vera_newsletter_subscriptions (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  normalized_email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  locale TEXT NOT NULL DEFAULT 'en',
  source TEXT NOT NULL DEFAULT 'website',
  birth_details_encrypted TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'subscribed', 'unsubscribed', 'suppressed')),
  consent_at TEXT NOT NULL,
  confirmation_token_hash TEXT,
  confirmation_expires_at TEXT,
  confirmation_sent_at TEXT,
  confirmed_at TEXT,
  unsubscribed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ap_vera_newsletter_status
  ON ap_vera_newsletter_subscriptions (status, created_at);

CREATE TABLE IF NOT EXISTS ap_vera_email_suppressions (
  normalized_email TEXT PRIMARY KEY,
  reason TEXT NOT NULL CHECK (reason IN ('bounce', 'complaint', 'manual', 'unsubscribe')),
  provider_event_id TEXT,
  detail_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ap_vera_newsletter_campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  template_key TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'scheduled', 'dispatching', 'sent', 'cancelled')),
  scheduled_for TEXT,
  dispatch_cursor TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  FOREIGN KEY (template_key) REFERENCES ap_email_templates (key)
);

CREATE INDEX IF NOT EXISTS idx_ap_vera_campaigns_due
  ON ap_vera_newsletter_campaigns (status, scheduled_for);

CREATE TABLE IF NOT EXISTS ap_vera_newsletter_deliveries (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  outbox_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sent', 'failed', 'cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (campaign_id, subscription_id),
  FOREIGN KEY (campaign_id) REFERENCES ap_vera_newsletter_campaigns (id) ON DELETE CASCADE,
  FOREIGN KEY (subscription_id) REFERENCES ap_vera_newsletter_subscriptions (id)
);

CREATE TABLE IF NOT EXISTS ap_vera_email_outbox (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  template_key TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  recipient_name TEXT,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'retry', 'sent', 'dead', 'cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 10),
  available_at TEXT NOT NULL,
  locked_at TEXT,
  sent_at TEXT,
  provider_message_id TEXT,
  last_error_code TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (template_key) REFERENCES ap_email_templates (key)
);

CREATE INDEX IF NOT EXISTS idx_ap_vera_outbox_due
  ON ap_vera_email_outbox (status, available_at, created_at);

CREATE TABLE IF NOT EXISTS ap_vera_private_files (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  booking_id TEXT,
  report_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('chart', 'recording', 'report_pdf', 'worksheet', 'document')),
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  storage_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES ap_customer_accounts (id),
  FOREIGN KEY (booking_id) REFERENCES ap_vera_bookings (id),
  FOREIGN KEY (report_id) REFERENCES ap_vera_reports (id)
);

CREATE INDEX IF NOT EXISTS idx_ap_vera_private_files_account
  ON ap_vera_private_files (account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ap_vera_reports (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  booking_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  encrypted_payload TEXT,
  published_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES ap_customer_accounts (id),
  FOREIGN KEY (booking_id) REFERENCES ap_vera_bookings (id)
);

CREATE INDEX IF NOT EXISTS idx_ap_vera_reports_account
  ON ap_vera_reports (account_id, published_at DESC);

CREATE TABLE IF NOT EXISTS ap_vera_message_threads (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  booking_id TEXT,
  subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES ap_customer_accounts (id),
  FOREIGN KEY (booking_id) REFERENCES ap_vera_bookings (id)
);

CREATE INDEX IF NOT EXISTS idx_ap_vera_threads_account
  ON ap_vera_message_threads (account_id, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ap_vera_threads_booking
  ON ap_vera_message_threads (booking_id)
  WHERE booking_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ap_vera_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  sender_role TEXT NOT NULL CHECK (sender_role IN ('customer', 'vera', 'system')),
  body TEXT NOT NULL,
  read_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (thread_id) REFERENCES ap_vera_message_threads (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ap_vera_messages_thread
  ON ap_vera_messages (thread_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ap_vera_messages_one_customer_question
  ON ap_vera_messages (thread_id)
  WHERE sender_role = 'customer';

CREATE TABLE IF NOT EXISTS ap_vera_follow_ups (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('balance_reminder', 'intake_reminder', 'session_reminder', 'post_session')),
  due_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'queued', 'sent', 'cancelled')),
  outbox_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (booking_id, kind, due_at),
  FOREIGN KEY (booking_id) REFERENCES ap_vera_bookings (id)
);

INSERT OR IGNORE INTO ap_email_events (
  event_type, audience, email_type, enabled, schedule_json, updated_at
) VALUES
  ('vera.booking.confirmed', 'customer', 'transactional', 1, '{}', '2026-08-15T00:00:00.000Z'),
  ('vera.booking.rescheduled', 'customer', 'transactional', 1, '{}', '2026-08-15T00:00:00.000Z'),
  ('vera.booking.cancelled', 'customer', 'transactional', 1, '{}', '2026-08-15T00:00:00.000Z'),
  ('vera.booking.balance_reminder', 'customer', 'reminder', 1, '{"relativeTo":"scheduledEndAt","offsetHours":24,"deadlineHours":72}', '2026-08-15T00:00:00.000Z'),
  ('vera.booking.intake_reminder', 'customer', 'reminder', 1, '{"relativeTo":"scheduledStartAt","offsetHours":-336}', '2026-08-15T00:00:00.000Z'),
  ('vera.booking.session_reminder', 'customer', 'reminder', 1, '{"relativeTo":"scheduledStartAt","offsetHours":-24}', '2026-08-15T00:00:00.000Z'),
  ('vera.booking.post_session', 'customer', 'follow_up', 1, '{"relativeTo":"scheduledEndAt","offsetHours":24}', '2026-08-15T00:00:00.000Z'),
  ('vera.report.ready', 'customer', 'notification', 1, '{}', '2026-08-15T00:00:00.000Z'),
  ('vera.gift.issued', 'customer', 'transactional', 1, '{}', '2026-08-15T00:00:00.000Z'),
  ('vera.newsletter.confirm', 'subscriber', 'transactional', 1, '{}', '2026-08-15T00:00:00.000Z'),
  ('vera.newsletter.dispatch', 'subscriber', 'marketing', 1, '{}', '2026-08-15T00:00:00.000Z'),
  ('vera.receipt.issued', 'customer', 'transactional', 1, '{}', '2026-08-15T00:00:00.000Z'),
  ('customer.password_reset', 'customer', 'transactional', 1, '{}', '2026-08-15T00:00:00.000Z');

INSERT OR IGNORE INTO ap_email_variable_mappings (
  variable_key, source_type, source_path, enabled, updated_at
) VALUES
  ('bookingNumber', 'event_payload', 'bookingNumber', 1, '2026-08-15T00:00:00.000Z'),
  ('serviceName', 'event_payload', 'serviceName', 1, '2026-08-15T00:00:00.000Z'),
  ('scheduledDateTime', 'event_payload', 'scheduledDateTime', 1, '2026-08-15T00:00:00.000Z'),
  ('accountUrl', 'event_payload', 'accountUrl', 1, '2026-08-15T00:00:00.000Z'),
  ('balanceAmount', 'event_payload', 'balanceAmount', 1, '2026-08-15T00:00:00.000Z'),
  ('priceAmount', 'event_payload', 'priceAmount', 1, '2026-08-15T00:00:00.000Z'),
  ('paidAmount', 'event_payload', 'paidAmount', 1, '2026-08-15T00:00:00.000Z'),
  ('giftCode', 'event_payload', 'giftCode', 1, '2026-08-15T00:00:00.000Z'),
  ('giftAmount', 'event_payload', 'giftAmount', 1, '2026-08-15T00:00:00.000Z'),
  ('meetingDetails', 'event_payload', 'meetingDetails', 1, '2026-08-15T00:00:00.000Z'),
  ('reportTitle', 'event_payload', 'reportTitle', 1, '2026-08-15T00:00:00.000Z'),
  ('confirmationUrl', 'event_payload', 'confirmationUrl', 1, '2026-08-15T00:00:00.000Z'),
  ('verificationUrl', 'event_payload', 'verificationUrl', 1, '2026-08-15T00:00:00.000Z'),
  ('resetUrl', 'event_payload', 'resetUrl', 1, '2026-08-15T00:00:00.000Z'),
  ('campaignBody', 'event_payload', 'campaignBody', 1, '2026-08-15T00:00:00.000Z'),
  ('unsubscribeUrl', 'generated_url', 'urls.unsubscribe', 1, '2026-08-15T00:00:00.000Z');

UPDATE ap_email_templates
SET display_name = 'Customer welcome',
    event_type = 'customer.welcome',
    audience = 'customer',
    locale = 'en',
    channel = 'email',
    enabled = 1,
    subject = 'Start your reading room.',
    preheader = 'Keep every chart, recording, written summary and receipt in one quiet place.',
    html_body = '<p>Dear {{customerName}},</p><p>Keep every chart, recording, written summary and receipt in one quiet place.</p><p><a href="{{verificationUrl}}">Create my account</a></p>',
    text_body = 'Dear {{customerName}}, Keep every chart, recording, written summary and receipt in one quiet place. Create my account {{verificationUrl}}',
    required_variables_json = '["customerName","verificationUrl"]',
    sample_payload_json = '{"customerName":"Marguerite","verificationUrl":"https://example.com/api/astropages/generated-site/customer-auth/signup?verify=example"}',
    updated_by = 'system',
    updated_at = '2026-08-15T00:00:00.000Z'
WHERE key = 'customer_welcome_en';

INSERT OR IGNORE INTO ap_email_templates (
  key, display_name, event_type, audience, locale, channel, enabled, subject,
  preheader, html_body, text_body, required_variables_json,
  sample_payload_json, updated_by, updated_at
) VALUES (
  'customer_password_reset_en',
  'Customer password reset',
  'customer.password_reset',
  'customer',
  'en',
  'email',
  1,
  'Find your way back.',
  'Enter the email kept with your sittings. A reset link is valid for one hour.',
  '<p>Dear {{customerName}},</p><p>Choose a new password.</p><p>Reset links expire after one hour.</p><p><a href="{{resetUrl}}">Update my password</a></p>',
  'Dear {{customerName}}, Choose a new password. Reset links expire after one hour. Update my password {{resetUrl}}',
  '["customerName","resetUrl"]',
  '{"customerName":"Marguerite","resetUrl":"https://example.com/reset-password?token=example"}',
  'system',
  '2026-08-15T00:00:00.000Z'
);

INSERT OR IGNORE INTO ap_email_templates (
  key, display_name, event_type, audience, locale, channel, enabled, subject,
  preheader, html_body, text_body, required_variables_json,
  sample_payload_json, updated_by, updated_at
) VALUES (
  'vera_receipt_en',
  'Vera receipt',
  'vera.receipt.issued',
  'customer',
  'en',
  'email',
  1,
  'Receipt · {{bookingNumber}}',
  'Consulting astrologer · Via delle Stelle 12, 34121 Trieste, Italy',
  '<p>Vera Solaro</p><p>Consulting astrologer<br>Via delle Stelle 12, 34121 Trieste, Italy<br>P.IVA 00745620321</p><p>Receipt<br>{{bookingNumber}}</p><p>Billed to<br>{{customerName}}</p><p>Sitting<br>{{serviceName}}<br>{{scheduledDateTime}}</p><p>Total for the sitting<br>{{priceAmount}}</p><p>Paid to date<br>{{paidAmount}}</p><p>Balance due<br>{{balanceAmount}}</p><p>Payable within three days of the sitting</p><p><a href="{{accountUrl}}">Back to your sittings</a></p>',
  'Vera Solaro Consulting astrologer Via delle Stelle 12, 34121 Trieste, Italy P.IVA 00745620321 Receipt {{bookingNumber}} Billed to {{customerName}} Sitting {{serviceName}} {{scheduledDateTime}} Total for the sitting {{priceAmount}} Paid to date {{paidAmount}} Balance due {{balanceAmount}} Payable within three days of the sitting Back to your sittings {{accountUrl}}',
  '["customerName","bookingNumber","serviceName","scheduledDateTime","priceAmount","paidAmount","balanceAmount","accountUrl"]',
  '{"customerName":"Marguerite","bookingNumber":"VS-013-YA","serviceName":"The Year Ahead","scheduledDateTime":"Thursday 13 August 2026, 3:30pm","priceAmount":"$385","paidAmount":"$80","balanceAmount":"$305","accountUrl":"https://example.com/account"}',
  'system',
  '2026-08-15T00:00:00.000Z'
);

INSERT OR IGNORE INTO ap_email_templates (
  key, display_name, event_type, audience, locale, channel, enabled, subject,
  preheader, html_body, text_body, required_variables_json,
  sample_payload_json, updated_by, updated_at
) VALUES
  (
    'vera_booking_confirmed_en', 'Vera booking confirmed', 'vera.booking.confirmed',
    'customer', 'en', 'email', 1,
    'Your sitting is held — {{scheduledDateTime}}', 'The hour is yours.',
    '<p>Dear {{customerName}}, thank you — it''s held.</p><p>Your {{serviceName}} is held for <strong>{{scheduledDateTime}}</strong>.</p><p>Reference<br>{{bookingNumber}}</p><p>Balance after<br>{{balanceAmount}}</p><p><a href="{{accountUrl}}">Manage this sitting →</a></p>',
    'Dear {{customerName}}, thank you — it''s held. Your {{serviceName}} is held for {{scheduledDateTime}}. Reference {{bookingNumber}} Balance after {{balanceAmount}} Manage this sitting → {{accountUrl}}',
    '["customerName","bookingNumber","serviceName","scheduledDateTime","balanceAmount","accountUrl"]',
    '{"customerName":"Marguerite","bookingNumber":"VS-013-YA","serviceName":"The Year Ahead","scheduledDateTime":"Thursday 13 August · 3:30pm","balanceAmount":"$305","accountUrl":"https://example.com/account"}',
    'system', '2026-08-15T00:00:00.000Z'
  ),
  (
    'vera_booking_rescheduled_en', 'Vera booking rescheduled', 'vera.booking.rescheduled',
    'customer', 'en', 'email', 1,
    'Your sitting now stands at {{scheduledDateTime}}.', 'Vera has been told, the calendar is updated, and a fresh confirmation is on its way to you.',
    '<p>Dear {{customerName}},</p><p>Your sitting now stands at <strong>{{scheduledDateTime}}</strong>. Vera has been told, the calendar is updated, and a fresh confirmation is on its way to you.</p><p>The sitting<br>{{serviceName}}</p><p>Reference<br>{{bookingNumber}}</p><p><a href="{{accountUrl}}">Back to your sittings</a></p>',
    'Dear {{customerName}}, Your sitting now stands at {{scheduledDateTime}}. Vera has been told, the calendar is updated, and a fresh confirmation is on its way to you. The sitting {{serviceName}} Reference {{bookingNumber}} Back to your sittings {{accountUrl}}',
    '["customerName","bookingNumber","serviceName","scheduledDateTime","accountUrl"]',
    '{"customerName":"Marguerite","bookingNumber":"VS-013-YA","serviceName":"The Year Ahead","scheduledDateTime":"Thursday 13 August · 3:30pm","accountUrl":"https://example.com/account"}',
    'system', '2026-08-15T00:00:00.000Z'
  ),
  (
    'vera_booking_cancelled_en', 'Vera booking cancelled', 'vera.booking.cancelled',
    'customer', 'en', 'email', 1,
    'Cancelled', 'Vera has your chart in the drawer if you''d like to come back to it.',
    '<p>Dear {{customerName}},</p><p>The sitting<br>{{serviceName}}</p><p>Reference<br>{{bookingNumber}}</p><p>Vera has your chart in the drawer if you''d like to come back to it.</p><p><a href="{{accountUrl}}">Back to your sittings</a></p>',
    'Dear {{customerName}}, The sitting {{serviceName}} Reference {{bookingNumber}} Vera has your chart in the drawer if you''d like to come back to it. Back to your sittings {{accountUrl}}',
    '["customerName","bookingNumber","serviceName","accountUrl"]',
    '{"customerName":"Marguerite","bookingNumber":"VS-013-YA","serviceName":"The Year Ahead","accountUrl":"https://example.com/account"}',
    'system', '2026-08-15T00:00:00.000Z'
  ),
  (
    'vera_gift_issued_en', 'Vera gift certificate', 'vera.gift.issued',
    'customer', 'en', 'email', 1,
    'Gift certificate', 'The recipient books their own hour and gives their own birth details.',
    '<p>Dear {{customerName}},</p><p>The recipient books their own hour and gives their own birth details. The code goes in at payment.</p><p>{{giftAmount}}</p><p>Gift certificate<br><strong>{{giftCode}}</strong></p><p><a href="{{siteUrl}}">See the readings</a></p>',
    'Dear {{customerName}}, The recipient books their own hour and gives their own birth details. The code goes in at payment. {{giftAmount}} Gift certificate {{giftCode}} See the readings {{siteUrl}}',
    '["customerName","giftAmount","giftCode","siteUrl"]',
    '{"customerName":"friend","giftAmount":"$80","giftCode":"Gift certificate","siteUrl":"https://example.com"}',
    'system', '2026-08-15T00:00:00.000Z'
  ),
  (
    'vera_newsletter_confirm_en', 'Vera newsletter confirmation', 'vera.newsletter.confirm',
    'subscriber', 'en', 'email', 1,
    'Is this you?', 'Vera will send one note to confirm it''s really you. Nothing until you click it.',
    '<p>Dear {{customerName}},</p><p>Somebody put this address down for my monthly letter.</p><p><a href="{{confirmationUrl}}">Yes, it''s me — add me to the list</a></p><p>If it wasn''t you, do nothing whatsoever.</p><p>Vera</p><p>Via delle Stelle 12, Trieste · You are receiving this once, to confirm an address. No list has been joined yet.</p>',
    'Dear {{customerName}}, Somebody put this address down for my monthly letter. Yes, it''s me — add me to the list {{confirmationUrl}} If it wasn''t you, do nothing whatsoever. Vera Via delle Stelle 12, Trieste · You are receiving this once, to confirm an address. No list has been joined yet.',
    '["customerName","confirmationUrl"]',
    '{"customerName":"Marguerite","confirmationUrl":"https://example.com/newsletter/confirm"}',
    'system', '2026-08-15T00:00:00.000Z'
  ),
  (
    'vera_newsletter_dispatch_en', 'Vera newsletter dispatch', 'vera.newsletter.dispatch',
    'subscriber', 'en', 'email', 1,
    '{{campaignSubject}}', 'One letter a month. No horoscopes.',
    '<p>Dear {{customerName}},</p>{{campaignBody}}<p>Vera</p><p>Leaving the list is one click at the foot of any letter.</p><p><a href="{{unsubscribeUrl}}">Unsubscribe whenever the mood strikes.</a></p>',
    'Dear {{customerName}}, {{campaignBody}} Vera Leaving the list is one click at the foot of any letter. Unsubscribe whenever the mood strikes. {{unsubscribeUrl}}',
    '["customerName","campaignSubject","campaignBody","unsubscribeUrl"]',
    '{"customerName":"friend","campaignSubject":"Mars in Virgo, and the oldest argument we have","campaignBody":"It is thirty-four degrees in Trieste and the greengrocer downstairs has given up entirely, so this letter is being written on the floor of the reading room, which is the only cool surface in the building. Take that as the tone.","unsubscribeUrl":"https://example.com/unsubscribe"}',
    'system', '2026-08-15T00:00:00.000Z'
  );

INSERT OR IGNORE INTO ap_email_variable_mappings (
  variable_key, source_type, source_path, enabled, updated_at
) VALUES
  ('campaignSubject', 'event_payload', 'campaignSubject', 1, '2026-08-15T00:00:00.000Z');

INSERT OR IGNORE INTO ap_email_templates (
  key, display_name, event_type, audience, locale, channel, enabled, subject,
  preheader, html_body, text_body, required_variables_json,
  sample_payload_json, updated_by, updated_at
) VALUES
  (
    'vera_balance_reminder_en', 'Vera balance reminder', 'vera.booking.balance_reminder',
    'customer', 'en', 'email', 1,
    'Balance outstanding', 'Due within three days of the sitting',
    '<p>Dear {{customerName}},</p><p>Balance of {{balanceAmount}} due within three days of the sitting.</p><p>Reference<br>{{bookingNumber}}</p><p><a href="{{accountUrl}}">Back to your sittings</a></p>',
    'Dear {{customerName}}, Balance of {{balanceAmount}} due within three days of the sitting. Reference {{bookingNumber}} Back to your sittings {{accountUrl}}',
    '["customerName","bookingNumber","balanceAmount","accountUrl"]',
    '{"customerName":"Marguerite","bookingNumber":"VS-013-YA","balanceAmount":"$305","accountUrl":"https://example.com/account"}',
    'system', '2026-08-15T00:00:00.000Z'
  ),
  (
    'vera_intake_reminder_en', 'Vera intake reminder', 'vera.booking.intake_reminder',
    'customer', 'en', 'email', 1,
    'Confirm your birth details', 'Birth details stay private to Vera',
    '<p>Dear {{customerName}},</p><p>To draw a chart she needs your name, your date, time and place of birth, and an email address. That is the whole of it.</p><p>The sitting<br>{{scheduledDateTime}}</p><p>Reference<br>{{bookingNumber}}</p><p><a href="{{accountUrl}}">Manage this sitting →</a></p>',
    'Dear {{customerName}}, To draw a chart she needs your name, your date, time and place of birth, and an email address. That is the whole of it. The sitting {{scheduledDateTime}} Reference {{bookingNumber}} Manage this sitting → {{accountUrl}}',
    '["customerName","bookingNumber","scheduledDateTime","accountUrl"]',
    '{"customerName":"Marguerite","bookingNumber":"VS-013-YA","scheduledDateTime":"Thursday 13 August · 3:30pm","accountUrl":"https://example.com/account"}',
    'system', '2026-08-15T00:00:00.000Z'
  ),
  (
    'vera_session_reminder_en', 'Vera session reminder', 'vera.booking.session_reminder',
    'customer', 'en', 'email', 1,
    'Before we sit', 'Nothing else to prepare',
    '<p>Dear {{customerName}},</p><p>The sitting<br>{{serviceName}}<br>{{scheduledDateTime}}</p><p>{{meetingDetails}}</p><p>Bring three dated events</p><p>A move, a loss, and something that changed your work. Years are enough.</p><p>Nothing else to prepare</p><p>No reading list, no questions to draft. Come as you are, with an hour to spare afterwards.</p><p><a href="{{accountUrl}}">Manage this sitting →</a></p>',
    'Dear {{customerName}}, The sitting {{serviceName}} {{scheduledDateTime}} {{meetingDetails}} Bring three dated events A move, a loss, and something that changed your work. Years are enough. Nothing else to prepare No reading list, no questions to draft. Come as you are, with an hour to spare afterwards. Manage this sitting → {{accountUrl}}',
    '["customerName","serviceName","scheduledDateTime","meetingDetails","accountUrl"]',
    '{"customerName":"Marguerite","serviceName":"The Year Ahead","scheduledDateTime":"Thursday 13 August · 3:30pm","meetingDetails":"Reading room, Via delle Stelle 12 — second floor","accountUrl":"https://example.com/account"}',
    'system', '2026-08-15T00:00:00.000Z'
  ),
  (
    'vera_post_session_en', 'Vera post-session follow-up', 'vera.booking.post_session',
    'customer', 'en', 'email', 1,
    'After the sitting', 'What arrives, when, and what to do with it six months later.',
    '<p>Dear {{customerName}},</p><p>The sitting<br>{{serviceName}}</p><p>The hand-drawn wheel (in your hands, or in the post), an audio recording the same evening, and a written summary posted within the week. Every reading also includes one follow-up question by email, answered properly.</p><p>Every sitting includes one question, answered properly and in writing. It doesn''t expire — people have used theirs four years later, which Vera considers entirely reasonable.</p><p><a href="{{accountUrl}}">Open the reading room</a></p>',
    'Dear {{customerName}}, The sitting {{serviceName}} The hand-drawn wheel (in your hands, or in the post), an audio recording the same evening, and a written summary posted within the week. Every reading also includes one follow-up question by email, answered properly. Every sitting includes one question, answered properly and in writing. It doesn''t expire — people have used theirs four years later, which Vera considers entirely reasonable. Open the reading room {{accountUrl}}',
    '["customerName","serviceName","accountUrl"]',
    '{"customerName":"Marguerite","serviceName":"The Year Ahead","accountUrl":"https://example.com/account"}',
    'system', '2026-08-15T00:00:00.000Z'
  ),
  (
    'vera_report_ready_en', 'Vera private report ready', 'vera.report.ready',
    'customer', 'en', 'email', 1,
    'The written summary', 'Everything from that sitting lives here permanently.',
    '<p>Dear {{customerName}},</p><p>Everything from this sitting</p><p>{{reportTitle}}</p><p>Everything from that sitting lives here permanently.</p><p><a href="{{accountUrl}}">Open the reading room</a></p>',
    'Dear {{customerName}}, Everything from this sitting {{reportTitle}} Everything from that sitting lives here permanently. Open the reading room {{accountUrl}}',
    '["customerName","reportTitle","accountUrl"]',
    '{"customerName":"Marguerite","reportTitle":"The written summary","accountUrl":"https://example.com/account"}',
    'system', '2026-08-15T00:00:00.000Z'
  );
