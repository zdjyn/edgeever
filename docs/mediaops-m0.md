# XD MediaOps M0 technical design

Status: proposal on feature/mediaops-m0. No production migration or deployment has run.

## Value, risk, rollback
Enable separate contractor accounts to hand off articles by task without real-time editing. The highest risks are cross-workspace disclosure, stale writes, and the fork updater replacing custom code or migrating production. Rollback before rollout is to discard this feature branch. After a future rollout, revoke MediaOps assignments and disable its routes; data rollback requires a tested backup/restore plan. Existing client platforms and old-to-new database upgrade remain unverified.

## Decision: controlled MediaOps API
Keep each account's existing personal workspace and its one-membership invariant. Create one non-personal MediaOps workspace owned by the operator, but do not add contractors to workspace_members or switch their AuthContext.workspaceId. Add task-scoped MediaOps routes and one central authorizeTask(actor, task, memo, action) function. All MediaOps rows must be inaccessible through the normal workspace-scoped routes. A privileged operator service creates articles directly inside the MediaOps workspace. Explicit copy-in must copy permitted attachments and reject private internal links. This has less impact than general multi-workspace support, which would alter authentication, sync, search, offline mirrors, all clients, MCP, and exports.

## Minimal model
- mediaops_tasks: id, workspace_id, title, state, current_memo_id, version, created_by, submitted_by, submitted_at, reviewed_by, reviewed_at, created_at, updated_at. workspace_id must identify the one non-personal MediaOps workspace.
- mediaops_task_assignments: task_id, user_id, role (editor, reviewer), revoked_at, created_at. The instance owner is manager through server-side user identity, not a client claim.
- mediaops_task_memos: task_id, memo_id, created_at. A memo belongs to one task; require matching workspace_id for both.
- mediaops_events: append-only actor, action, task, memo, old/new state, old/new revision, timestamp. Do not store article body or credentials here.
- Reuse memos, memo_contents, memo_revisions, memo_edit_sessions, resources and users. Do not duplicate content.

Roles: manager assigns/revokes and may submit/review; editor reads and edits only assigned tasks in draft or changes_requested; reviewer reads assigned tasks and approves/requests changes only when submitted. Disabled users and revoked assignments fail every request. Private/SmartGym access remains tied to the original personal workspace.

State machine: draft -> in_progress -> submitted -> approved; submitted -> changes_requested -> in_progress. Manager may cancel non-approved work; approval is terminal in M0. Each transition uses expected task version and expected memo revision, records actor and event, and returns 409 on mismatch. Submission records the persisted server revision. The server cannot inspect a browser IndexedDB queue: the client must flush and await acknowledgement, then submit that revision; the server checks only its own committed revision/hash.

## Permission matrix
| Action | Manager | Assigned editor | Assigned reviewer | Other account |
|---|---|---|---|---|
| Task list/detail, article, revisions, permitted attachments | Yes | Own task | Own task | No |
| Create/assign/revoke/cancel | Yes | No | No | No |
| Edit article in editable states | Yes | Yes | No | No |
| Submit | Yes | Yes | No | No |
| Approve/request changes | Yes | No | Yes | No |
| Restore revision | Yes with expected current revision | No | No | No |
| Delete/share/export/MCP/normal sync | Separate explicit manager policy; disabled in M0 | No | No | No |

Authorization belongs at every service entry, including direct resource fetch. Return 404 for unassigned task/memo IDs to avoid enumeration. Check account disabled and revoked_at on every request. Never trust a supplied workspace_id, role, task state, or memo_id without joining server records.

## Atomic writes
For article save, begin a transaction, verify assignment/state and edit-session binding, conditionally UPDATE memo_contents with WHERE memo_id=? AND revision=? AND content_hash=?, require changes()==1, then update memo metadata and task version/event, and commit. Any zero-row update, authorization change, or failed write rolls back all statements and returns 409 or 403. D1 batch atomicity and affected-row reporting must be verified against the actual adapter; do not infer success from a pre-read. Revision restore follows the same conditional write and task authorization, snapshots the overwritten state, and records an event. Do not expose the current unrestricted restore endpoint to contractors.

## Upstream updates
The existing scheduled updater can push main and trigger production deployment; the default mirror mode may overwrite custom code. Before merging M0, replace that path on this fork with a workflow that fetches upstream into a candidate branch, opens a review PR, runs CI and migration tests against disposable data, and requires a human-approved merge. Disable scheduled direct push/deploy on this fork. Preserve custom changes during merge; never reset product files to an upstream snapshot. An approved main merge remains a separate production deployment decision because the current deploy script performs remote migration.

## Acceptance
See mediaops-m0-tests.md. Keep staging credentials, D1 UUIDs and production resource IDs out of Git. No schema file under migrations/ is committed during M0; the SQL draft is intentionally non-executable until approved.
