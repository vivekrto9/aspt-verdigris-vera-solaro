CREATE TABLE IF NOT EXISTS ap_analytics_deliveries (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ap_email_deliveries (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  provider_message_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ap_booking_preview_policy (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  calendar_ids_json TEXT NOT NULL,
  recipients_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
