CREATE TABLE IF NOT EXISTS ap_content_revision_log (
  id TEXT PRIMARY KEY,
  revision_number INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('content_studio', 'openhands_mcp', 'emdash_rest', 'admin', 'system_import')),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'agent', 'system', 'unknown')),
  actor_id TEXT,
  operation TEXT NOT NULL CHECK (operation IN ('create', 'update', 'publish', 'unpublish', 'delete', 'import')),
  collection TEXT NOT NULL,
  entry TEXT NOT NULL,
  locale TEXT NOT NULL DEFAULT 'en',
  changed_fields TEXT NOT NULL DEFAULT '[]',
  content_hash TEXT,
  snapshot_hash TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ap_content_environment_state (
  environment TEXT PRIMARY KEY,
  current_revision_number INTEGER NOT NULL DEFAULT 0,
  current_published_hash TEXT,
  current_snapshot_hash TEXT,
  last_snapshot_id TEXT,
  last_changed_at TEXT,
  last_exported_at TEXT,
  last_imported_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ap_emdash_bootstrap_state (
  template_key TEXT PRIMARY KEY,
  template_version TEXT,
  builder_registry_hash TEXT NOT NULL,
  expected_collections INTEGER NOT NULL,
  expected_fields INTEGER NOT NULL,
  expected_entries INTEGER NOT NULL,
  completed_at TEXT NOT NULL,
  last_full_verified_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ap_content_revision_log_revision
  ON ap_content_revision_log (revision_number);

CREATE INDEX IF NOT EXISTS idx_ap_content_revision_log_target
  ON ap_content_revision_log (collection, entry, locale, created_at);

CREATE INDEX IF NOT EXISTS idx_ap_content_revision_log_source
  ON ap_content_revision_log (source, created_at);
