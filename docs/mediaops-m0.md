# XD MediaOps M0 technical design

Status: proposal on feature/mediaops-m0. No production migration or deployment has run.

## M0 implementation update
The approved architecture is the controlled MediaOps API. Migration 0088 creates task assignments, one holder with a monotonically increasing holder epoch, immutable approval snapshots, events, and a CAS assertion table. The manager first creates the separate non-personal workspace and notebook atomically with a task, so an upgrade alone does not change existing workspace counts. Editor and reviewer assignments are independent; AI is reserved as a distinct assignment role, but API/MCP agents are denied until a task-bound service credential flow is designed and tested. A manager alone gives final approval. Reviewers may mark a submission reviewed or request changes. Editors may write in draft, in_progress, or changes_requested only while holding the active turn; approval requires a reviewed submission. Any later revision requires a new submission and approval, while the previous approved snapshot remains immutable.

The save batch conditionally updates memo_contents by old revision/hash, active holder epoch, task state, assignment, enabled user, and MediaOps workspace. The immediately following SQL assertion checks SQLite changes() = 1; its CHECK failure aborts the whole D1 batch, including revisions, metadata, and events. The self-hosted SQLite adapter uses a transaction for the same batch. Cloudflare documents D1 batch as a transaction that rolls back when a statement fails: https://developers.cloudflare.com/d1/worker-api/d1-database/#batch. Actual remote D1 behavior is still a staging gate; local SQLite tests do not replace it.

The browser page at /mediaops is intentionally basic and uses explicit Save. It keeps unsaved text visible after a conflict and blocks Submit until it matches the last server response. It cannot inspect or promise anything about another device's IndexedDB queue. Task assignment and holder transfer are already API operations; a fuller manager UI and offline queue integration remain future work.

## Current-main updater safety plan (requires separate owner approval)
The guard committed on this feature branch has no effect on current main. The owner should separately approve either disabling the scheduled Update deployed EdgeEver workflow on GitHub or a minimal PR to main containing only the fork-specific guard, with no Cloudflare changes. Until one action is approved and executed, the current main updater can still overwrite customized code. After that safety gate, add a candidate-branch workflow that fetches upstream, opens a PR, and requires CI, upgrade tests and human review. Do not run the current manual updater or deploy command as a staging operation: deploy:ci performs remote migration. The candidate PR workflow itself must not push main or call a Cloudflare deploy hook.

## Staging isolation gate
The tracked config is a template, not an observed deployment. Before any Cloudflare mutation, record the actual production Worker name/routes, D1 UUID, R2 and preview bucket, build/deploy command, and secret names in a private inventory. Create new staging resources only after separate approval. Give staging a newly generated secret value; secret names alone cannot prove secret-value separation. Fill a local copy of the template with the new D1 UUID and run verify-mediaops-staging.mjs against the private production inventory. Explicitly select that config for every staging migration and deploy invocation; never use the repository's generic deploy:ci, db:migrate:remote, or Cloudflare Builds production connection. Capture read-only production health/version and resource metadata before and after synthetic staging tests. Real isolation remains unverified until these checks run against both actual environments.

## Value, risk, rollback
Enable separate contractor accounts to hand off articles by task without real-time editing. The highest risks are cross-workspace disclosure, stale writes, and the fork updater replacing custom code or migrating production. Rollback before rollout is to discard this feature branch. After a future rollout, revoke MediaOps assignments and disable its routes; data rollback requires a tested backup/restore plan. Existing client platforms and old-to-new database upgrade remain unverified.

## Decision: controlled MediaOps API
Keep each account's existing personal workspace and its one-membership invariant. Create one non-personal MediaOps workspace on first task creation, but do not add contractors to workspace_members or switch their AuthContext.workspaceId. Task-scoped routes and the MediaOps service enforce access; normal workspace routes cannot reach these rows. M0 creates new articles directly in MediaOps. Copy-in from a private workspace is not implemented and requires a separate attachment and internal-link security design. This is narrower than general multi-workspace support, which would alter authentication, sync, search, offline mirrors, all clients, MCP, and exports.

## Minimal model
- mediaops_tasks: one memo per task, state, version, one holder_user_id and holder_epoch, submitted revision/hash and reviewer.
- mediaops_assignments: task_id, user_id, role, revoked_at. Manager derives from the authenticated owner role; AI role is reserved but inactive.
- mediaops_approvals: immutable copy of approved title, document JSON/Markdown, exact revision/hash, approver and time. A later revision requires a new approval record.
- mediaops_events: append-only task action, actor, memo revision and time. No article body or credentials.
- mediaops_cas_assertions: transient SQL assertion rows inserted and removed inside each batch; a failed CHECK rolls back the batch.
- Reuse memos, memo_contents, memo_revisions, memo_edit_sessions, resources and users. Do not duplicate content.

Roles: manager assigns/revokes, reviews, and alone gives final approval; an assigned editor holding the active turn edits and submits; an assigned reviewer marks submitted work reviewed or requests changes. API/MCP agents are denied in M0. Disabled users and revoked assignments fail every request. Private/SmartGym access remains tied to the original personal workspace.

State machine: draft -> in_progress -> submitted -> reviewed -> approved; submitted -> changes_requested -> in_progress. Manager revision restore also moves work to changes_requested without changing the immutable approval snapshot. Cancellation has no M0 endpoint. Each transition uses expected task version and expected memo revision, records actor and event, and returns 409 on mismatch. Submission records the persisted server revision. The server cannot inspect a browser IndexedDB queue: the client must flush and await acknowledgement, then submit that revision; the server checks only its own committed revision/hash.

## Permission matrix
| Action | Manager | Assigned editor | Assigned reviewer | Other account |
|---|---|---|---|---|
| Task list/detail and article | Yes | Own task | Own task | No |
| Create/assign/revoke | Yes | No | No | No |
| Edit article in editable states | Only if assigned editor and holder | Yes, when holder | No | No |
| Submit | Only if assigned editor and holder | Yes, when holder | No | No |
| Mark reviewed/request changes | Yes | No | Yes | No |
| Final approval of reviewed submission | Yes | No | No | No |
| Restore revision | Yes with expected current revision | No | No | No |
| Delete/share/export/MCP/normal sync/attachments | No dedicated M0 endpoint | No | No | No |

Authorization belongs at every service entry, including direct resource fetch. Return 404 for unassigned task/memo IDs to avoid enumeration. Check account disabled and revoked_at on every request. Never trust a supplied workspace_id, role, task state, or memo_id without joining server records.

## Atomic writes
For article save, begin a transaction, verify assignment/state and holder epoch, conditionally UPDATE memo_contents with WHERE memo_id=? AND revision=? AND content_hash=?, require changes()==1, then update memo metadata and task version/event, and commit. Any zero-row update, authorization change, or failed write rolls back all statements and returns 409 or 403. D1 batch atomicity and affected-row reporting must be verified against the actual adapter; do not infer success from a pre-read. Revision restore follows the same conditional write and task authorization, snapshots the overwritten state, and records an event. Do not expose the current unrestricted restore endpoint to contractors.

## Upstream updates
The existing scheduled updater can push main and trigger production deployment; the default mirror mode may overwrite custom code. Before merging M0, replace that path on this fork with a workflow that fetches upstream into a candidate branch, opens a review PR, runs CI and migration tests against disposable data, and requires a human-approved merge. Disable scheduled direct push/deploy on this fork. Preserve custom changes during merge; never reset product files to an upstream snapshot. An approved main merge remains a separate production deployment decision because the current deploy script performs remote migration.

## Acceptance
See mediaops-m0-tests.md. Keep staging credentials, D1 UUIDs and production resource IDs out of Git. No schema file under migrations/ is committed during M0; the SQL draft is intentionally non-executable until approved.
