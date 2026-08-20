CREATE TABLE IF NOT EXISTS ap_customer_accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  phone TEXT,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  default_language TEXT NOT NULL DEFAULT 'English',
  email_verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ap_customer_accounts_email
  ON ap_customer_accounts (email);

CREATE TABLE IF NOT EXISTS ap_customer_sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  session_token_hash TEXT NOT NULL,
  csrf_token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES ap_customer_accounts (id)
);

CREATE INDEX IF NOT EXISTS idx_ap_customer_sessions_token
  ON ap_customer_sessions (session_token_hash);

CREATE INDEX IF NOT EXISTS idx_ap_customer_sessions_account
  ON ap_customer_sessions (account_id);

CREATE TABLE IF NOT EXISTS ap_customer_password_resets (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  reset_token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES ap_customer_accounts (id)
);

CREATE INDEX IF NOT EXISTS idx_ap_customer_password_resets_token
  ON ap_customer_password_resets (reset_token_hash);

CREATE INDEX IF NOT EXISTS idx_ap_customer_password_resets_account
  ON ap_customer_password_resets (account_id);
