PRAGMA foreign_keys = ON;

CREATE TABLE mediaops_tasks (
  id TEXT PRIMARY KEY,
  memo_id TEXT NOT NULL UNIQUE REFERENCES memos(id) ON DELETE RESTRICT,
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','in_progress','changes_requested','submitted','reviewed','approved','cancelled')),
  version INTEGER NOT NULL DEFAULT 1,
  holder_user_id TEXT REFERENCES users(id),
  holder_epoch INTEGER NOT NULL DEFAULT 0,
  submitted_revision INTEGER,
  submitted_hash TEXT,
  reviewed_by TEXT REFERENCES users(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_mediaops_tasks_holder ON mediaops_tasks(holder_user_id, state);

CREATE TABLE mediaops_assignments (
  task_id TEXT NOT NULL REFERENCES mediaops_tasks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('editor','reviewer','ai')),
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id,user_id,role)
);
CREATE INDEX idx_mediaops_assignments_user ON mediaops_assignments(user_id,revoked_at,task_id);

CREATE TABLE mediaops_approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES mediaops_tasks(id) ON DELETE RESTRICT,
  memo_id TEXT NOT NULL REFERENCES memos(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  title TEXT NOT NULL,
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  content_markdown TEXT NOT NULL,
  approved_by TEXT NOT NULL REFERENCES users(id),
  approved_at TEXT NOT NULL
);
CREATE TRIGGER trg_mediaops_approvals_immutable_update BEFORE UPDATE ON mediaops_approvals BEGIN SELECT RAISE(ABORT, 'approved snapshot is immutable'); END;
CREATE TRIGGER trg_mediaops_approvals_immutable_delete BEFORE DELETE ON mediaops_approvals BEGIN SELECT RAISE(ABORT, 'approved snapshot is immutable'); END;

CREATE TABLE mediaops_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES mediaops_tasks(id) ON DELETE RESTRICT,
  actor_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  memo_revision INTEGER,
  created_at TEXT NOT NULL
);
-- A failed CHECK immediately after a conditional UPDATE aborts the D1/SQLite
-- batch transaction. The successful assertion row is deleted in that batch.
CREATE TABLE mediaops_cas_assertions (id TEXT PRIMARY KEY, marker INTEGER NOT NULL CHECK (marker = 1));
