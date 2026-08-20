CREATE TABLE IF NOT EXISTS ap_asset_records (
  asset_id TEXT PRIMARY KEY REFERENCES media(id) ON DELETE RESTRICT,
  current_revision_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  folder TEXT,
  category TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('template', 'user', 'ai')),
  visibility TEXT NOT NULL DEFAULT 'customer' CHECK (visibility IN ('customer', 'system')),
  protected INTEGER NOT NULL DEFAULT 0 CHECK (protected IN (0, 1)),
  replaceable INTEGER NOT NULL DEFAULT 1 CHECK (replaceable IN (0, 1)),
  deleted_at TEXT,
  created_by TEXT,
  updated_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ap_asset_revisions (
  revision_id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES ap_asset_records(asset_id) ON DELETE CASCADE,
  revision_number INTEGER NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  content_hash TEXT NOT NULL,
  etag TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  width INTEGER,
  height INTEGER,
  duration_seconds REAL,
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('pending', 'ready', 'rejected', 'deleted')),
  scan_status TEXT NOT NULL DEFAULT 'clean' CHECK (scan_status IN ('pending', 'clean', 'infected', 'not_required')),
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (asset_id, revision_number)
);

CREATE TABLE IF NOT EXISTS ap_asset_aliases (
  alias TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES ap_asset_records(asset_id) ON DELETE RESTRICT,
  origin TEXT NOT NULL CHECK (origin IN ('template', 'user', 'ai')),
  protected INTEGER NOT NULL DEFAULT 0 CHECK (protected IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ap_asset_events (
  event_id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES ap_asset_records(asset_id) ON DELETE CASCADE,
  revision_id TEXT REFERENCES ap_asset_revisions(revision_id) ON DELETE SET NULL,
  operation TEXT NOT NULL CHECK (operation IN ('create', 'metadata_update', 'replace', 'restore', 'alias', 'delete', 'import')),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'agent', 'system', 'unknown')),
  actor_id TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ap_asset_release_state (
  environment TEXT PRIMARY KEY CHECK (environment IN ('preview', 'production')),
  current_revision_number INTEGER NOT NULL DEFAULT 0,
  current_asset_hash TEXT,
  current_snapshot_hash TEXT,
  last_snapshot_id TEXT,
  active_asset_count INTEGER NOT NULL DEFAULT 0,
  deleted_asset_count INTEGER NOT NULL DEFAULT 0,
  last_changed_at TEXT,
  last_exported_at TEXT,
  last_imported_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ap_asset_records_active
  ON ap_asset_records(deleted_at, visibility, updated_at);
CREATE INDEX IF NOT EXISTS idx_ap_asset_revisions_asset
  ON ap_asset_revisions(asset_id, revision_number DESC);
CREATE INDEX IF NOT EXISTS idx_ap_asset_aliases_asset
  ON ap_asset_aliases(asset_id);
CREATE INDEX IF NOT EXISTS idx_ap_asset_events_asset
  ON ap_asset_events(asset_id, created_at DESC);
