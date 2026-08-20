CREATE TABLE IF NOT EXISTS ap_email_templates (
  key TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  event_type TEXT NOT NULL,
  audience TEXT NOT NULL,
  locale TEXT NOT NULL DEFAULT 'en',
  channel TEXT NOT NULL DEFAULT 'email',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  subject TEXT NOT NULL,
  preheader TEXT NOT NULL DEFAULT '',
  html_body TEXT NOT NULL,
  text_body TEXT NOT NULL,
  required_variables_json TEXT NOT NULL,
  sample_payload_json TEXT NOT NULL,
  updated_by TEXT NOT NULL DEFAULT 'system',
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ap_email_templates_event
  ON ap_email_templates (event_type, channel, enabled, locale);

CREATE TABLE IF NOT EXISTS ap_email_events (
  event_type TEXT PRIMARY KEY,
  audience TEXT NOT NULL,
  email_type TEXT NOT NULL DEFAULT 'transactional'
    CHECK (email_type IN ('transactional', 'scheduled', 'reminder', 'follow_up', 'notification', 'marketing')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  schedule_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ap_email_variable_mappings (
  variable_key TEXT PRIMARY KEY,
  source_type TEXT NOT NULL
    CHECK (source_type IN ('event_payload', 'business_setting', 'generated_url')),
  source_path TEXT NOT NULL,
  sample_value_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ap_email_templates_event_audience_locale
  ON ap_email_templates(event_type, audience, locale);

INSERT OR IGNORE INTO ap_email_events (
  event_type, audience, email_type, enabled, schedule_json, updated_at
) VALUES
  ('customer.welcome', 'customer', 'transactional', 1, '{}', '2026-07-27T00:00:00.000Z');

INSERT OR IGNORE INTO ap_email_variable_mappings (
  variable_key, source_type, source_path, enabled, updated_at
) VALUES
  ('customerName', 'event_payload', 'customerName', 1, '2026-07-27T00:00:00.000Z'),
  ('siteUrl', 'generated_url', 'urls.site', 1, '2026-07-27T00:00:00.000Z'),
  ('supportFooter', 'business_setting', 'notificationSettings.supportFooter', 1, '2026-07-27T00:00:00.000Z');

INSERT OR IGNORE INTO ap_email_templates (
  key, display_name, event_type, audience, locale, channel, enabled, subject,
  preheader, html_body, text_body, required_variables_json,
  sample_payload_json, updated_by, updated_at
) VALUES (
  'customer_welcome_en',
  'Customer welcome',
  'customer.welcome',
  'customer',
  'en',
  'email',
  1,
  'Welcome, {{customerName}}',
  'Your account is ready.',
  '<p>Hello {{customerName}},</p><p>Welcome. Your account is ready.</p><p><a href="{{siteUrl}}">Visit the website</a></p><p>{{supportFooter}}</p>',
  'Hello {{customerName}}, welcome. Your account is ready. Visit: {{siteUrl}}. {{supportFooter}}',
  '["customerName","siteUrl","supportFooter"]',
  '{"customerName":"Asha","siteUrl":"https://example.com","supportFooter":"For support, reply to this email."}',
  'system',
  '2026-07-27T00:00:00.000Z'
);

UPDATE ap_email_events
SET enabled = 1
WHERE event_type IN (
  SELECT DISTINCT event_type FROM ap_email_templates WHERE enabled = 1
);
