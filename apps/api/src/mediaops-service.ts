import { createExcerpt, docToText, markdownToDoc } from "@edgeever/shared";
import type { AuthContext } from "./api-context";
import { AppError } from "./app-error";
import { createId, isoNow } from "./entity-utils";
import { sha256 } from "./hash-utils";
import type { DatabaseAdapter, PreparedStatementAdapter } from "./storage-contract";

export const MEDIAOPS_WORKSPACE_ID = "ws_mediaops";
const MEDIAOPS_NOTEBOOK_ID = "nb_mediaops_inbox";
const editable = ["draft", "in_progress", "changes_requested"];

type TaskRow = {
  id: string; memo_id: string; state: string; version: number;
  holder_user_id: string | null; holder_epoch: number;
  submitted_revision: number | null; submitted_hash: string | null;
  reviewed_by: string | null; created_by: string;
  title: string; revision: number; content_hash: string;
  content_json: string; content_markdown: string; content_text: string;
  tags_json: string;
};

const userId = (auth: AuthContext) => {
  // API/MCP tokens are deliberately excluded. AI will receive a separately
  // authenticated, task-bound service identity, never an interactive role.
  if (auth.kind !== "user" || !auth.actorId) throw new AppError("forbidden", "Interactive user required", 403);
  return auth.actorId;
};
const manager = (auth: AuthContext) => auth.kind === "user" && auth.role === "owner" && Boolean(auth.actorId);
const requireManager = (auth: AuthContext) => {
  if (!manager(auth)) throw new AppError("forbidden", "Manager required", 403);
  return userId(auth);
};

const assignment = async (db: DatabaseAdapter, taskId: string, id: string, role: "editor" | "reviewer") =>
  Boolean(await db.prepare(`SELECT 1 AS allowed FROM mediaops_assignments a JOIN users u ON u.id = a.user_id
    WHERE a.task_id = ? AND a.user_id = ? AND a.role = ? AND a.revoked_at IS NULL AND u.is_disabled = 0`)
    .bind(taskId, id, role).first());

export const readMediaopsTask = async (db: DatabaseAdapter, auth: AuthContext, taskId: string) => {
  const id = userId(auth);
  const row = await db.prepare(`SELECT t.*, m.title, c.revision, c.content_hash, c.content_json,
    c.content_markdown, c.content_text, m.tags_json FROM mediaops_tasks t
    JOIN memos m ON m.id = t.memo_id AND m.workspace_id = ? AND m.is_deleted = 0
    JOIN memo_contents c ON c.memo_id = m.id WHERE t.id = ?`)
    .bind(MEDIAOPS_WORKSPACE_ID, taskId).first<TaskRow>();
  if (!row || (!manager(auth) && !(await assignment(db, taskId, id, "editor")) && !(await assignment(db, taskId, id, "reviewer")))) {
    throw new AppError("not_found", "Task not found", 404);
  }
  return row;
};

export const listMediaopsTasks = async (db: DatabaseAdapter, auth: AuthContext) => {
  const id = userId(auth);
  const rows = await db.prepare(`SELECT t.id, t.memo_id, t.state, t.version, t.holder_user_id,
    t.holder_epoch, t.submitted_revision, t.submitted_hash, m.title, c.revision, c.content_hash
    FROM mediaops_tasks t JOIN memos m ON m.id = t.memo_id AND m.workspace_id = ?
    JOIN memo_contents c ON c.memo_id = m.id
    WHERE ? = 1 OR EXISTS (SELECT 1 FROM mediaops_assignments a JOIN users u ON u.id = a.user_id
      WHERE a.task_id = t.id AND a.user_id = ? AND a.revoked_at IS NULL AND u.is_disabled = 0)
    ORDER BY t.updated_at DESC LIMIT 100`)
    .bind(MEDIAOPS_WORKSPACE_ID, manager(auth) ? 1 : 0, id).all();
  return rows.results;
};

export const createMediaopsTask = async (db: DatabaseAdapter, auth: AuthContext, title: string) => {
  const actor = requireManager(auth);
  if (!title.trim() || title.length > 300) throw new AppError("bad_request", "Invalid title", 400);
  const taskId = createId("motask"), memoId = createId("memo"), now = isoNow();
  const contentJson = markdownToDoc("");
  const contentHash = await sha256(JSON.stringify(contentJson));
  const isolationMarker = createId("cas");
  try { await db.batch([
    db.prepare(`INSERT OR IGNORE INTO workspaces (id, name, is_personal) VALUES (?, 'XD MediaOps', 0)`)
      .bind(MEDIAOPS_WORKSPACE_ID),
    db.prepare(`INSERT OR IGNORE INTO notebooks (id, workspace_id, name, slug, sort_order)
      VALUES (?, ?, 'MediaOps', 'mediaops', 0)`)
      .bind(MEDIAOPS_NOTEBOOK_ID, MEDIAOPS_WORKSPACE_ID),
    db.prepare(`INSERT INTO mediaops_cas_assertions (id, marker) VALUES (?, CASE WHEN
      (SELECT is_personal FROM workspaces WHERE id = ?) = 0
      AND NOT EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ?)
      AND (SELECT workspace_id FROM notebooks WHERE id = ?) = ? THEN 1 ELSE 0 END)`)
      .bind(isolationMarker, MEDIAOPS_WORKSPACE_ID, MEDIAOPS_WORKSPACE_ID,
        MEDIAOPS_NOTEBOOK_ID, MEDIAOPS_WORKSPACE_ID),
    db.prepare(`DELETE FROM mediaops_cas_assertions WHERE id = ?`).bind(isolationMarker),
    db.prepare(`INSERT INTO memos (id, workspace_id, notebook_id, title, excerpt, created_by, updated_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, '', ?, ?, ?, ?)`)
      .bind(memoId, MEDIAOPS_WORKSPACE_ID, MEDIAOPS_NOTEBOOK_ID, title.trim(), actor, actor, now, now),
    db.prepare(`INSERT INTO memo_contents (memo_id, content_json, content_markdown, content_text, content_hash, revision, created_at, updated_at)
      VALUES (?, ?, '', '', ?, 0, ?, ?)`)
      .bind(memoId, JSON.stringify(contentJson), contentHash, now, now),
    db.prepare(`INSERT INTO mediaops_tasks (id, memo_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(taskId, memoId, actor, now, now),
  ]); } catch (error) {
    if (String(error).includes("mediaops_cas_assertions") || String(error).includes("CHECK constraint failed")) {
      throw new AppError("workspace_conflict", "MediaOps workspace identity is unsafe", 409);
    }
    throw error;
  }
  return readMediaopsTask(db, auth, taskId);
};

export const assignMediaopsUser = async (db: DatabaseAdapter, auth: AuthContext, taskId: string, assignee: string, role: "editor" | "reviewer") => {
  requireManager(auth);
  await readMediaopsTask(db, auth, taskId);
  if (!(["editor", "reviewer"] as string[]).includes(role)) throw new AppError("bad_request", "Invalid role", 400);
  const active = await db.prepare(`SELECT id FROM users WHERE id = ? AND is_disabled = 0`).bind(assignee).first();
  if (!active) throw new AppError("not_found", "User not found", 404);
  await db.prepare(`INSERT INTO mediaops_assignments (task_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(task_id,user_id,role) DO UPDATE SET revoked_at = NULL`)
    .bind(taskId, assignee, role, isoNow()).run();
};

const assertOne = (db: DatabaseAdapter, id: string) => [
  db.prepare(`INSERT INTO mediaops_cas_assertions (id, marker) VALUES (?, CASE WHEN changes() = 1 THEN 1 ELSE 0 END)`).bind(id),
  db.prepare(`DELETE FROM mediaops_cas_assertions WHERE id = ?`).bind(id),
];

export const runMediaopsCas = async (db: DatabaseAdapter, update: PreparedStatementAdapter, following: PreparedStatementAdapter[]) => {
  const marker = createId("cas");
  try {
    const [result] = await db.batch([update, ...assertOne(db, marker), ...following]);
    // Defense in depth: the constraint above is the actual rollback gate.
    if (Number(result?.meta?.changes) !== 1) throw new Error("CAS adapter returned inconsistent changes");
  } catch (error) {
    if (String(error).includes("mediaops_cas_assertions") || String(error).includes("CHECK constraint failed")) {
      throw new AppError("revision_conflict", "Task changed; reload before saving", 409);
    }
    throw error;
  }
};

export const transferMediaopsHolder = async (db: DatabaseAdapter, auth: AuthContext, taskId: string, nextHolder: string, expectedVersion: number) => {
  const actor = userId(auth), row = await readMediaopsTask(db, auth, taskId);
  if (!manager(auth) && row.holder_user_id !== actor && !(row.holder_user_id === null && nextHolder === actor)) {
    throw new AppError("forbidden", "Current holder or unclaimed assigned editor required", 403);
  }
  if (!editable.includes(row.state)) throw new AppError("state_conflict", "Task is not editable", 409);
  if (!(await assignment(db, taskId, nextHolder, "editor"))) throw new AppError("forbidden", "Next holder is not assigned", 403);
  const now = isoNow();
  await runMediaopsCas(db, db.prepare(`UPDATE mediaops_tasks SET holder_user_id = ?, holder_epoch = holder_epoch + 1,
    version = version + 1, state = 'in_progress', updated_at = ? WHERE id = ? AND version = ?
    AND (holder_user_id IS ? OR ? = 1) AND state IN ('draft','in_progress','changes_requested')
    AND EXISTS (SELECT 1 FROM mediaops_assignments a JOIN users u ON u.id = a.user_id
      WHERE a.task_id = mediaops_tasks.id AND a.user_id = ? AND a.role = 'editor' AND a.revoked_at IS NULL AND u.is_disabled = 0)`)
    .bind(nextHolder, now, taskId, expectedVersion, row.holder_user_id, manager(auth) ? 1 : 0, nextHolder), [
    db.prepare(`INSERT INTO mediaops_events (id, task_id, actor_id, action, memo_revision, created_at) VALUES (?, ?, ?, 'holder.transfer', ?, ?)`)
      .bind(createId("moevent"), taskId, actor, row.revision, now),
  ]);
  return readMediaopsTask(db, auth, taskId);
};

export const revokeMediaopsUser = async (db: DatabaseAdapter, auth: AuthContext, taskId: string, assignee: string, role: "editor" | "reviewer") => {
  const actor = requireManager(auth), row = await readMediaopsTask(db, auth, taskId), now = isoNow();
  await runMediaopsCas(db, db.prepare(`UPDATE mediaops_assignments SET revoked_at = ?
    WHERE task_id = ? AND user_id = ? AND role = ? AND revoked_at IS NULL`)
    .bind(now, taskId, assignee, role), [
    db.prepare(`UPDATE mediaops_tasks SET holder_user_id = CASE WHEN ? = 'editor' AND holder_user_id = ? THEN NULL ELSE holder_user_id END,
      holder_epoch = holder_epoch + 1, version = version + 1, updated_at = ? WHERE id = ?`)
      .bind(role, assignee, now, taskId),
    db.prepare(`INSERT INTO mediaops_events (id, task_id, actor_id, action, memo_revision, created_at) VALUES (?, ?, ?, 'assignment.revoke', ?, ?)`)
      .bind(createId("moevent"), taskId, actor, row.revision, now),
  ]);
};

export const saveMediaopsArticle = async (db: DatabaseAdapter, auth: AuthContext, taskId: string, input: {
  expectedRevision: number; expectedHash: string; holderEpoch: number; markdown: string;
}) => {
  const actor = userId(auth), row = await readMediaopsTask(db, auth, taskId);
  if (row.holder_user_id !== actor || !editable.includes(row.state) || !(await assignment(db, taskId, actor, "editor"))) {
    throw new AppError("forbidden", "Active editor holder required", 403);
  }
  if (input.markdown.length > 2_000_000) throw new AppError("bad_request", "Article too large", 400);
  const doc = markdownToDoc(input.markdown), contentText = docToText(doc), now = isoNow();
  const hash = await sha256(input.markdown + JSON.stringify(doc));
  const nextRevision = input.expectedRevision + 1;
  await runMediaopsCas(db, db.prepare(`UPDATE memo_contents SET content_json = ?, content_markdown = ?, content_text = ?,
    content_hash = ?, revision = revision + 1, updated_at = ?
    WHERE memo_id = ? AND revision = ? AND content_hash = ?
    AND EXISTS (SELECT 1 FROM mediaops_tasks t JOIN memos m ON m.id = t.memo_id
      JOIN mediaops_assignments a ON a.task_id = t.id AND a.user_id = ? AND a.role = 'editor' AND a.revoked_at IS NULL
      JOIN users u ON u.id = a.user_id AND u.is_disabled = 0
      WHERE t.id = ? AND t.memo_id = memo_contents.memo_id AND m.workspace_id = ?
        AND t.holder_user_id = ? AND t.holder_epoch = ? AND t.state IN ('draft','in_progress','changes_requested'))`)
    .bind(JSON.stringify(doc), input.markdown, contentText, hash, now, row.memo_id,
      input.expectedRevision, input.expectedHash, actor, taskId, MEDIAOPS_WORKSPACE_ID, actor, input.holderEpoch), [
    db.prepare(`INSERT INTO memo_revisions (id, memo_id, revision, title, tags_json, content_json, content_markdown,
      content_text, content_hash, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(createId("rev"), row.memo_id, row.revision, row.title, row.tags_json, row.content_json,
        row.content_markdown, row.content_text, row.content_hash, actor, now),
    db.prepare(`UPDATE memos SET excerpt = ?, updated_by = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`)
      .bind(createExcerpt(contentText), actor, now, row.memo_id, MEDIAOPS_WORKSPACE_ID),
    db.prepare(`UPDATE mediaops_tasks SET version = version + 1, updated_at = ? WHERE id = ?`)
      .bind(now, taskId),
    db.prepare(`INSERT INTO mediaops_events (id, task_id, actor_id, action, memo_revision, created_at)
      VALUES (?, ?, ?, 'article.save', ?, ?)`)
      .bind(createId("moevent"), taskId, actor, nextRevision, now),
  ]);
  return readMediaopsTask(db, auth, taskId);
};

export const submitMediaopsTask = async (db: DatabaseAdapter, auth: AuthContext, taskId: string, input: {
  expectedVersion: number; revision: number; hash: string; holderEpoch: number;
}) => {
  const actor = userId(auth), row = await readMediaopsTask(db, auth, taskId);
  if (row.holder_user_id !== actor || !(await assignment(db, taskId, actor, "editor"))) throw new AppError("forbidden", "Active editor holder required", 403);
  const now = isoNow();
  await runMediaopsCas(db, db.prepare(`UPDATE mediaops_tasks SET state = 'submitted', version = version + 1,
    submitted_revision = ?, submitted_hash = ?, holder_user_id = NULL, holder_epoch = holder_epoch + 1, updated_at = ?
    WHERE id = ? AND version = ? AND holder_user_id = ? AND holder_epoch = ?
      AND state IN ('draft','in_progress','changes_requested')
      AND EXISTS (SELECT 1 FROM memo_contents c WHERE c.memo_id = mediaops_tasks.memo_id AND c.revision = ? AND c.content_hash = ?)
      AND EXISTS (SELECT 1 FROM mediaops_assignments a JOIN users u ON u.id = a.user_id
        WHERE a.task_id = mediaops_tasks.id AND a.user_id = ? AND a.role = 'editor' AND a.revoked_at IS NULL AND u.is_disabled = 0)`)
    .bind(input.revision, input.hash, now, taskId, input.expectedVersion, actor, input.holderEpoch,
      input.revision, input.hash, actor), [
    db.prepare(`INSERT INTO mediaops_events (id, task_id, actor_id, action, memo_revision, created_at)
      VALUES (?, ?, ?, 'task.submit', ?, ?)`)
      .bind(createId("moevent"), taskId, actor, input.revision, now),
  ]);
  return readMediaopsTask(db, auth, taskId);
};

export const reviewMediaopsTask = async (db: DatabaseAdapter, auth: AuthContext, taskId: string,
  decision: "reviewed" | "changes_requested", expectedVersion: number) => {
  const actor = userId(auth), row = await readMediaopsTask(db, auth, taskId);
  if (!manager(auth) && !(await assignment(db, taskId, actor, "reviewer"))) throw new AppError("forbidden", "Reviewer required", 403);
  const now = isoNow();
  await runMediaopsCas(db, db.prepare(`UPDATE mediaops_tasks SET state = ?, reviewed_by = ?, version = version + 1,
    holder_epoch = holder_epoch + 1, updated_at = ? WHERE id = ? AND version = ? AND state = 'submitted'
    AND EXISTS (SELECT 1 FROM memo_contents c WHERE c.memo_id = mediaops_tasks.memo_id
      AND c.revision = mediaops_tasks.submitted_revision AND c.content_hash = mediaops_tasks.submitted_hash)
    AND (? = 1 OR EXISTS (SELECT 1 FROM mediaops_assignments a JOIN users u ON u.id = a.user_id
      WHERE a.task_id = mediaops_tasks.id AND a.user_id = ? AND a.role = 'reviewer'
        AND a.revoked_at IS NULL AND u.is_disabled = 0))`)
    .bind(decision, actor, now, taskId, expectedVersion, manager(auth) ? 1 : 0, actor), [
    db.prepare(`INSERT INTO mediaops_events (id, task_id, actor_id, action, memo_revision, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(createId("moevent"), taskId, actor, `task.${decision}`, row.submitted_revision, now),
  ]);
  return readMediaopsTask(db, auth, taskId);
};

export const approveMediaopsTask = async (db: DatabaseAdapter, auth: AuthContext, taskId: string, expectedVersion: number) => {
  const actor = requireManager(auth), row = await readMediaopsTask(db, auth, taskId), now = isoNow();
  const approvalId = createId("approval");
  await runMediaopsCas(db, db.prepare(`UPDATE mediaops_tasks SET state = 'approved', version = version + 1,
    holder_user_id = NULL, holder_epoch = holder_epoch + 1, updated_at = ?
    WHERE id = ? AND version = ? AND state = 'reviewed' AND reviewed_by IS NOT NULL
    AND EXISTS (SELECT 1 FROM memo_contents c WHERE c.memo_id = mediaops_tasks.memo_id
      AND c.revision = mediaops_tasks.submitted_revision AND c.content_hash = mediaops_tasks.submitted_hash)`)
    .bind(now, taskId, expectedVersion), [
    db.prepare(`INSERT INTO mediaops_approvals (id, task_id, memo_id, revision, content_hash, title,
      content_json, content_markdown, approved_by, approved_at)
      SELECT ?, t.id, m.id, c.revision, c.content_hash, m.title, c.content_json,
        c.content_markdown, ?, ? FROM mediaops_tasks t JOIN memos m ON m.id = t.memo_id
        JOIN memo_contents c ON c.memo_id = m.id WHERE t.id = ? AND t.state = 'approved'
        AND c.revision = t.submitted_revision AND c.content_hash = t.submitted_hash`)
      .bind(approvalId, actor, now, taskId),
    db.prepare(`INSERT INTO mediaops_events (id, task_id, actor_id, action, memo_revision, created_at)
      VALUES (?, ?, ?, 'task.approve', ?, ?)`)
      .bind(createId("moevent"), taskId, actor, row.submitted_revision, now),
  ]);
  return readMediaopsTask(db, auth, taskId);
};

export const restoreMediaopsRevision = async (db: DatabaseAdapter, auth: AuthContext, taskId: string, input: {
  revisionId: string; expectedRevision: number; expectedHash: string; expectedVersion: number;
}) => {
  const actor = requireManager(auth), row = await readMediaopsTask(db, auth, taskId), now = isoNow();
  const previous = await db.prepare(`SELECT r.content_json, r.content_markdown, r.content_text, r.content_hash
    FROM memo_revisions r JOIN memos m ON m.id = r.memo_id
    WHERE r.id = ? AND r.memo_id = ? AND m.workspace_id = ?`)
    .bind(input.revisionId, row.memo_id, MEDIAOPS_WORKSPACE_ID)
    .first<{ content_json: string; content_markdown: string; content_text: string; content_hash: string }>();
  if (!previous) throw new AppError("not_found", "Revision not found", 404);
  await runMediaopsCas(db, db.prepare(`UPDATE memo_contents SET content_json = ?, content_markdown = ?,
    content_text = ?, content_hash = ?, revision = revision + 1, updated_at = ?
    WHERE memo_id = ? AND revision = ? AND content_hash = ?
    AND EXISTS (SELECT 1 FROM mediaops_tasks t JOIN memos m ON m.id = t.memo_id
      WHERE t.id = ? AND t.memo_id = memo_contents.memo_id AND m.workspace_id = ? AND t.version = ?)`)
    .bind(previous.content_json, previous.content_markdown, previous.content_text, previous.content_hash,
      now, row.memo_id, input.expectedRevision, input.expectedHash, taskId, MEDIAOPS_WORKSPACE_ID, input.expectedVersion), [
    db.prepare(`INSERT INTO memo_revisions (id, memo_id, revision, title, tags_json, content_json,
      content_markdown, content_text, content_hash, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(createId("rev"), row.memo_id, row.revision, row.title, row.tags_json, row.content_json,
        row.content_markdown, row.content_text, row.content_hash, actor, now),
    db.prepare(`UPDATE memos SET excerpt = ?, updated_by = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`)
      .bind(createExcerpt(previous.content_text), actor, now, row.memo_id, MEDIAOPS_WORKSPACE_ID),
    db.prepare(`UPDATE mediaops_tasks SET state = 'changes_requested', reviewed_by = NULL,
      submitted_revision = NULL, submitted_hash = NULL, holder_user_id = NULL,
      holder_epoch = holder_epoch + 1, version = version + 1, updated_at = ? WHERE id = ?`)
      .bind(now, taskId),
    db.prepare(`INSERT INTO mediaops_events (id, task_id, actor_id, action, memo_revision, created_at)
      VALUES (?, ?, ?, 'revision.restore', ?, ?)`)
      .bind(createId("moevent"), taskId, actor, row.revision + 1, now),
  ]);
  return readMediaopsTask(db, auth, taskId);
};
