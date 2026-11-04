# XD MediaOps M0 test contract

Run only on disposable local DB or the dedicated staging D1/R2/Worker. Seed personal, SmartGym, MediaOps, two editors and one reviewer with synthetic data.

1. Isolation: every account's normal list/detail/search/sync/resource/revision/export/MCP endpoint cannot reveal MediaOps data or another personal workspace. Guessing valid IDs returns 404.
2. Task grant: editor A reads/writes assigned T1 only; T2 and private/SmartGym IDs fail. Reviewer reads T1 but cannot edit. Disabled account fails. Revocation takes effect on the next request, including an existing edit session and resource URL.
3. State: only allowed transitions succeed; stale task version returns 409. Submit requires the exact committed server memo revision/hash. The server never claims to inspect IndexedDB.
4. Sequential handoff: A saves n+1, submits, reviewer returns changes, B receives assignment and saves n+2. Events and history identify actors and preserve versions.
5. Simultaneous saves: two requests with the same base revision/hash yield exactly one success. The loser gets 409; the final body equals the winner. Assert affected rows = 1 for success and zero-row write causes full rollback: no task version, event, revision, or metadata change.
6. Restore: only manager can restore; stale expected revision fails without side effects; successful restore creates a new revision and preserves the previous body.
7. Offline: queue a draft in Web IndexedDB, let another user save, reconnect; conflict is durable and visible, no silent overwrite. Client must block submit until its own queue acknowledgement; server rejects stale submitted revision independently.
8. Storage: unauthorized direct and ranged R2 downloads, upload completion, deletion and object-key guessing fail; no cross-task resource references.
9. Upgrade: apply draft migration to a copy of the prior schema populated with legacy personal/SmartGym records; verify row counts, workspace IDs and queries before/after. Test rollback via backup restore, not reverse SQL.
10. Staging gate: run scripts/verify-mediaops-staging.mjs against actual generated config and production binding inventory; require distinct Worker, D1 UUID, R2 and preview bucket. Capture staging health/version and synthetic-data results. Production bindings and deployment version must remain unchanged.

Required CI gate before any release: relevant API tests, Web conflict tests, typecheck, build:web, and the project's existing test workflow. Cross-runtime behavior and old-to-new upgrade remain unverified until explicitly exercised.
