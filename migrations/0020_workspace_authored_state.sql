-- Generation-bound checkpoint metadata; no customer or credential rows.
CREATE TABLE IF NOT EXISTS ap_workspace_authored_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  authored_revision INTEGER NOT NULL DEFAULT 0 CHECK (authored_revision >= 0),
  content_digest TEXT NOT NULL DEFAULT '',
  imported_envelope_digest TEXT
);
INSERT OR IGNORE INTO ap_workspace_authored_state(id) VALUES (1);
