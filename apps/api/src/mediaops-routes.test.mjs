import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdir, readFile } from "node:fs/promises";
import { Hono } from "hono";
import { createSelfHostedStorageAdapter } from "./self-hosted-storage-adapter.ts";
import { registerMediaopsRoutes } from "./mediaops-routes.ts";
import { getMemoDetail } from "./memo-service.ts";

const open = [];
afterEach(() => { for (const db of open.splice(0)) db.close(); });
const auth = (id, role = "member") => ({ kind: "user", actorType: "user", actorId: id,
  username: id, displayName: id, scopes: [], workspaceId: `ws_${id}`, role });

const fixture = async () => {
  const sqlite = new Database(":memory:"); open.push(sqlite);
  sqlite.exec("PRAGMA foreign_keys = ON");
  const directory = new URL("../../../migrations/", import.meta.url);
  for (const name of (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort()) {
    sqlite.exec(await readFile(new URL(name, directory), "utf8"));
  }
  for (const id of ["owner", "a", "b", "reviewer", "stranger"]) {
    sqlite.query("INSERT INTO users (id, username, password_hash) VALUES (?, ?, 'test')").run(id, id);
    sqlite.query("INSERT INTO workspaces (id, name, is_personal) VALUES (?, ?, 1)").run(`ws_${id}`, id);
    sqlite.query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)")
      .run(`ws_${id}`, id, id === "owner" ? "owner" : "member");
  }
  const db = createSelfHostedStorageAdapter(sqlite, "/tmp").db;
  const app = new Hono();
  app.use("/api/v1/*", async (c, next) => { c.set("auth", auth(c.req.header("x-user") ?? "stranger", c.req.header("x-user") === "owner" ? "owner" : "member")); await next(); });
  registerMediaopsRoutes(app);
  const request = async (user, path, payload, method = "POST") => {
    const response = await app.request(`/api/v1/mediaops${path}`, {
      method, headers: { "x-user": user, "content-type": "application/json" },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    }, { storage: { db } });
    return { status: response.status, body: await response.json() };
  };
  return { sqlite, db, request };
};

describe("MediaOps task authorization and CAS", () => {
  test("two editors hand off; old holder and offline upload cannot overwrite", async () => {
    const f = await fixture();
    const created = await f.request("owner", "/tasks", { title: "Article" });
    expect(created.status).toBe(200);
    const taskId = created.body.result.id;
    for (const userId of ["a", "b"]) expect((await f.request("owner", `/tasks/${taskId}/assignments`, { userId, role: "editor" })).status).toBe(200);
    expect((await f.request("stranger", `/tasks/${taskId}`, null, "GET")).status).toBe(404);
    let task = (await f.request("owner", `/tasks/${taskId}/transfer`, { userId: "a", expectedVersion: 1 })).body.result;
    const oldEpoch = task.holder_epoch;
    const stale = { expectedRevision: task.revision, expectedHash: task.content_hash, holderEpoch: oldEpoch, markdown: "A's draft" };
    task = (await f.request("a", `/tasks/${taskId}/save`, stale)).body.result;
    expect(task.revision).toBe(1);
    task = (await f.request("a", `/tasks/${taskId}/transfer`, { userId: "b", expectedVersion: task.version })).body.result;
    expect((await f.request("a", `/tasks/${taskId}/save`, { ...stale, expectedRevision: 1, expectedHash: task.content_hash })).status).toBe(403);
    const b = await f.request("b", `/tasks/${taskId}/save`, { expectedRevision: 1, expectedHash: task.content_hash, holderEpoch: task.holder_epoch, markdown: "B's draft" });
    expect(b.status).toBe(200);
    expect((await f.request("b", `/tasks/${taskId}/save`, { ...stale, holderEpoch: b.body.result.holder_epoch })).status).toBe(409);
    expect(f.sqlite.query("SELECT content_markdown FROM memo_contents WHERE memo_id = ?").get(task.memo_id).content_markdown).toBe("B's draft");
  });

  test("zero-row CAS rolls back revision, metadata and event", async () => {
    const f = await fixture();
    const id = (await f.request("owner", "/tasks", { title: "Rollback" })).body.result.id;
    await f.request("owner", `/tasks/${id}/assignments`, { userId: "a", role: "editor" });
    const task = (await f.request("owner", `/tasks/${id}/transfer`, { userId: "a", expectedVersion: 1 })).body.result;
    const before = {
      task: f.sqlite.query("SELECT * FROM mediaops_tasks WHERE id = ?").get(id),
      memo: f.sqlite.query("SELECT * FROM memos WHERE id = ?").get(task.memo_id),
      revisionCount: f.sqlite.query("SELECT count(*) AS n FROM memo_revisions WHERE memo_id = ?").get(task.memo_id).n,
      eventCount: f.sqlite.query("SELECT count(*) AS n FROM mediaops_events WHERE task_id = ?").get(id).n,
    };
    expect((await f.request("a", `/tasks/${id}/save`, { expectedRevision: 0, expectedHash: "wrong", holderEpoch: task.holder_epoch, markdown: "bad" })).status).toBe(409);
    expect(f.sqlite.query("SELECT * FROM mediaops_tasks WHERE id = ?").get(id)).toEqual(before.task);
    expect(f.sqlite.query("SELECT * FROM memos WHERE id = ?").get(task.memo_id)).toEqual(before.memo);
    expect(f.sqlite.query("SELECT count(*) AS n FROM memo_revisions WHERE memo_id = ?").get(task.memo_id).n).toBe(before.revisionCount);
    expect(f.sqlite.query("SELECT count(*) AS n FROM mediaops_events WHERE task_id = ?").get(id).n).toBe(before.eventCount);
    expect(f.sqlite.query("SELECT count(*) AS n FROM mediaops_cas_assertions").get().n).toBe(0);
  });

  test("reviewer cannot approve; manager approval snapshots exact submitted revision", async () => {
    const f = await fixture();
    const id = (await f.request("owner", "/tasks", { title: "Approval" })).body.result.id;
    await f.request("owner", `/tasks/${id}/assignments`, { userId: "a", role: "editor" });
    await f.request("owner", `/tasks/${id}/assignments`, { userId: "reviewer", role: "reviewer" });
    let task = (await f.request("owner", `/tasks/${id}/transfer`, { userId: "a", expectedVersion: 1 })).body.result;
    task = (await f.request("a", `/tasks/${id}/save`, { expectedRevision: 0, expectedHash: task.content_hash, holderEpoch: task.holder_epoch, markdown: "Approved text" })).body.result;
    task = (await f.request("a", `/tasks/${id}/submit`, { expectedVersion: task.version, revision: task.revision, hash: task.content_hash, holderEpoch: task.holder_epoch })).body.result;
    expect((await f.request("reviewer", `/tasks/${id}/approve`, { expectedVersion: task.version })).status).toBe(403);
    task = (await f.request("reviewer", `/tasks/${id}/review`, { decision: "reviewed", expectedVersion: task.version })).body.result;
    task = (await f.request("owner", `/tasks/${id}/approve`, { expectedVersion: task.version })).body.result;
    expect(task.state).toBe("approved");
    const snapshot = f.sqlite.query("SELECT * FROM mediaops_approvals WHERE task_id = ?").get(id);
    expect(snapshot.revision).toBe(task.revision);
    expect(snapshot.content_hash).toBe(task.content_hash);
    expect(snapshot.content_markdown).toBe("Approved text");
    expect(() => f.sqlite.query("UPDATE mediaops_approvals SET content_markdown = 'changed' WHERE id = ?").run(snapshot.id)).toThrow();
    const revisionId = f.sqlite.query("SELECT id FROM memo_revisions WHERE memo_id = ? ORDER BY revision ASC LIMIT 1").get(task.memo_id).id;
    expect((await f.request("reviewer", `/tasks/${id}/restore`, { revisionId, expectedRevision: task.revision,
      expectedHash: task.content_hash, expectedVersion: task.version })).status).toBe(403);
    expect((await f.request("owner", `/tasks/${id}/restore`, { revisionId, expectedRevision: 0,
      expectedHash: task.content_hash, expectedVersion: task.version })).status).toBe(409);
    const restored = await f.request("owner", `/tasks/${id}/restore`, { revisionId,
      expectedRevision: task.revision, expectedHash: task.content_hash, expectedVersion: task.version });
    expect(restored.status).toBe(200);
    expect(restored.body.result.state).toBe("changes_requested");
    expect(restored.body.result.revision).toBe(task.revision + 1);
    expect(f.sqlite.query("SELECT content_markdown FROM mediaops_approvals WHERE id = ?").get(snapshot.id).content_markdown).toBe("Approved text");
  });

  test("revocation blocks the holder's next save", async () => {
    const f = await fixture();
    const id = (await f.request("owner", "/tasks", { title: "Revocation" })).body.result.id;
    await f.request("owner", `/tasks/${id}/assignments`, { userId: "a", role: "editor" });
    const task = (await f.request("owner", `/tasks/${id}/transfer`, { userId: "a", expectedVersion: 1 })).body.result;
    expect((await f.request("owner", `/tasks/${id}/revoke`, { userId: "a", role: "editor" })).status).toBe(200);
    expect((await f.request("a", `/tasks/${id}/save`, { expectedRevision: 0, expectedHash: task.content_hash, holderEpoch: task.holder_epoch, markdown: "late" })).status).toBe(404);
  });

  test("simultaneous saves accept one revision and reject the other", async () => {
    const f = await fixture();
    const id = (await f.request("owner", "/tasks", { title: "Concurrent" })).body.result.id;
    await f.request("owner", `/tasks/${id}/assignments`, { userId: "a", role: "editor" });
    const task = (await f.request("owner", `/tasks/${id}/transfer`, { userId: "a", expectedVersion: 1 })).body.result;
    const base = { expectedRevision: task.revision, expectedHash: task.content_hash, holderEpoch: task.holder_epoch };
    const results = await Promise.all([
      f.request("a", `/tasks/${id}/save`, { ...base, markdown: "First" }),
      f.request("a", `/tasks/${id}/save`, { ...base, markdown: "Second" }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const body = f.sqlite.query("SELECT revision, content_markdown FROM memo_contents WHERE memo_id = ?").get(task.memo_id);
    expect(body.revision).toBe(1);
    expect(["First", "Second"]).toContain(body.content_markdown);
    expect(f.sqlite.query("SELECT count(*) AS n FROM memo_revisions WHERE memo_id = ?").get(task.memo_id).n).toBe(1);
    expect(f.sqlite.query("SELECT count(*) AS n FROM mediaops_events WHERE task_id = ? AND action = 'article.save'").get(id).n).toBe(1);
  });

  test("normal personal workspace lookup cannot reach MediaOps, and agents are denied", async () => {
    const f = await fixture();
    const task = (await f.request("owner", "/tasks", { title: "Isolated" })).body.result;
    expect(await getMemoDetail(f.db, "ws_a", task.memo_id)).toBeNull();
    expect(await getMemoDetail(f.db, "ws_owner", task.memo_id)).toBeNull();
    expect((await f.request("stranger", "/tasks", null, "GET")).body.result).toEqual([]);
    const agentApp = new Hono();
    agentApp.use("/api/v1/*", async (c, next) => { c.set("auth", { ...auth("a"), kind: "agent", actorType: "agent" }); await next(); });
    registerMediaopsRoutes(agentApp);
    const response = await agentApp.request(`/api/v1/mediaops/tasks/${task.id}`, {}, { storage: { db: f.db } });
    expect(response.status).toBe(403);
  });

  test("a conflicting personal workspace ID cannot become the MediaOps space", async () => {
    const f = await fixture();
    f.sqlite.query("INSERT INTO workspaces (id, name, is_personal) VALUES ('ws_mediaops', 'Private collision', 1)").run();
    const response = await f.request("owner", "/tasks", { title: "Must not escape" });
    expect(response.status).toBe(409);
    expect(f.sqlite.query("SELECT count(*) AS n FROM memos WHERE workspace_id = 'ws_mediaops'").get().n).toBe(0);
  });

  test("an assigned editor may claim an unheld turn but cannot seize another holder", async () => {
    const f = await fixture();
    const task = (await f.request("owner", "/tasks", { title: "Claim" })).body.result;
    for (const userId of ["a", "b"]) await f.request("owner", `/tasks/${task.id}/assignments`, { userId, role: "editor" });
    const claimed = await f.request("a", `/tasks/${task.id}/transfer`, { userId: "a", expectedVersion: task.version });
    expect(claimed.status).toBe(200);
    expect(claimed.body.result.holder_user_id).toBe("a");
    expect((await f.request("b", `/tasks/${task.id}/transfer`, { userId: "b", expectedVersion: claimed.body.result.version })).status).toBe(403);
  });
});
