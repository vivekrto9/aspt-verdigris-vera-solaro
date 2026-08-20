-- Generic event timeline required by the canonical AstroPages leads contract.
CREATE TABLE IF NOT EXISTS ap_business_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  booking_id TEXT,
  customer_id TEXT,
  locale TEXT NOT NULL DEFAULT 'en',
  causation_id TEXT,
  correlation_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ap_business_events_aggregate
  ON ap_business_events (aggregate_type, aggregate_id, created_at);

-- Canonical AstroPages leads contract (leads.v1).
-- Keep this table definition aligned with derived AstroPages templates.
CREATE TABLE IF NOT EXISTS ap_leads (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'qualified', 'converted', 'lost', 'spam')),
  kind TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'website',
  form_key TEXT NOT NULL DEFAULT '',
  page_path TEXT NOT NULL DEFAULT '',
  locale TEXT NOT NULL DEFAULT 'en',
  full_name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  normalized_email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  normalized_phone TEXT NOT NULL DEFAULT '',
  whatsapp TEXT NOT NULL DEFAULT '',
  normalized_whatsapp TEXT NOT NULL DEFAULT '',
  consent_contact INTEGER NOT NULL DEFAULT 0,
  consent_marketing INTEGER NOT NULL DEFAULT 0,
  consent_at TEXT,
  customer_account_id TEXT,
  customer_profile_id TEXT,
  source_reference_type TEXT NOT NULL DEFAULT '',
  source_reference_id TEXT NOT NULL DEFAULT '',
  attribution_json TEXT NOT NULL DEFAULT '{}',
  details_json TEXT NOT NULL DEFAULT '{}',
  idempotency_key TEXT NOT NULL DEFAULT '',
  dedupe_key TEXT NOT NULL,
  conversion_reference TEXT NOT NULL DEFAULT '',
  status_changed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ap_leads_dedupe
  ON ap_leads (dedupe_key);

CREATE INDEX IF NOT EXISTS idx_ap_leads_status
  ON ap_leads (status, updated_at);

CREATE INDEX IF NOT EXISTS idx_ap_leads_kind
  ON ap_leads (kind, created_at);

CREATE INDEX IF NOT EXISTS idx_ap_leads_email
  ON ap_leads (normalized_email);

CREATE INDEX IF NOT EXISTS idx_ap_leads_created
  ON ap_leads (created_at);
