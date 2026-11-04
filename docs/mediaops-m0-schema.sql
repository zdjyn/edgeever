-- DESIGN DRAFT ONLY. Do not place in migrations/ or apply to production.
-- Requires a reviewed migration number, an existing non-personal MediaOps workspace,
-- and tests for D1/SQLite foreign-key and transactional behavior.
CREATE TABLE mediaops_tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','in_progress','submitted','changes_requested','approved','cancelled')),
  current_memo_id TEXT REFERENCES memos(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by TEXT NOT NULL REFERENCES users(id),
  submitted_by TEXT REFERENCES users(id),
  submitted_at TEXT,
  reviewed_by TEXT REFERENCES users(id),
  reviewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_mediaops_tasks_workspace_state ON mediaops_tasks(workspace_id,state,updated_at DESC);
CREATE TABLE mediaops_task_assignments (
  task_id TEXT NOT NULL REFERENCES mediaops_tasks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('editor','reviewer')),
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id,user_id,role)
);
CREATE INDEX idx_mediaops_assignments_user ON mediaops_task_assignments(user_id,revoked_at,task_id);
CREATE TABLE mediaops_task_memos (
  task_id TEXT NOT NULL REFERENCES mediaops_tasks(id) ON DELETE CASCADE,
  memo_id TEXT NOT NULL UNIQUE REFERENCES memos(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id,memo_id)
);
CREATE TABLE mediaops_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES mediaops_tasks(id) ON DELETE CASCADE,
  memo_id TEXT REFERENCES memos(id),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT,
  from_revision INTEGER,
  to_revision INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_mediaops_events_task ON mediaops_events(task_id,created_at DESC);
-- Application transaction must assert tasks.workspace_id = memos.workspace_id
-- and workspaces.is_personal = 0; SQLite cross-table CHECK cannot enforce these.
