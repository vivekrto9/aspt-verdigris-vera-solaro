CREATE TABLE IF NOT EXISTS ap_runtime_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  provider_key TEXT,
  scope TEXT NOT NULL DEFAULT 'site',
  status TEXT NOT NULL DEFAULT 'active',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ap_business_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ap_admin_sessions (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  role TEXT NOT NULL,
  email TEXT,
  session_token_hash TEXT NOT NULL UNIQUE,
  csrf_token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ap_admin_sessions_token
  ON ap_admin_sessions (session_token_hash);

CREATE INDEX IF NOT EXISTS idx_ap_admin_sessions_subject
  ON ap_admin_sessions (subject, expires_at);

CREATE TABLE IF NOT EXISTS ap_admin_sso_exchanges (
  id TEXT PRIMARY KEY,
  jti TEXT NOT NULL UNIQUE,
  subject TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  role TEXT NOT NULL,
  target_path TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ap_admin_sso_exchanges_jti
  ON ap_admin_sso_exchanges (jti);

CREATE INDEX IF NOT EXISTS idx_ap_admin_sso_exchanges_project
  ON ap_admin_sso_exchanges (project_id, environment, created_at);

INSERT OR IGNORE INTO ap_business_settings (
  key, value_json, updated_at
) VALUES (
  'site',
  '{"brandName":"Base Template"}',
  '2026-07-01T00:00:00.000Z'
);
