import type { Hono } from "hono";
import type { AppContext, AppEnv } from "./api-context";
import { AppError } from "./app-error";
import { apiError } from "./http-errors";
import {
  approveMediaopsTask, assignMediaopsUser, createMediaopsTask, listMediaopsTasks,
  readMediaopsTask, reviewMediaopsTask, revokeMediaopsUser, saveMediaopsArticle,
  restoreMediaopsRevision, submitMediaopsTask, transferMediaopsHolder,
} from "./mediaops-service";

const safe = async (c: AppContext, run: () => Promise<unknown>) => {
  try { return c.json({ result: await run() }); }
  catch (error) {
    if (error instanceof AppError) return apiError(c, error.code, error.message, error.status);
    throw error;
  }
};
const body = async (c: AppContext) => {
  const value: unknown = await c.req.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError("bad_request", "Object body required", 400);
  return value as Record<string, unknown>;
};
const string = (value: unknown, name: string) => {
  if (typeof value !== "string" || !value.trim()) throw new AppError("bad_request", `${name} required`, 400);
  return value;
};
const integer = (value: unknown, name: string) => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new AppError("bad_request", `${name} must be a nonnegative integer`, 400);
  return value as number;
};

export const registerMediaopsRoutes = (app: Hono<AppEnv>) => {
  app.get("/api/v1/mediaops/tasks", (c) => safe(c, () => listMediaopsTasks(c.env.storage.db, c.get("auth"))));
  app.post("/api/v1/mediaops/tasks", (c) => safe(c, async () => {
    const input = await body(c);
    return createMediaopsTask(c.env.storage.db, c.get("auth"), string(input.title, "title"));
  }));
  app.get("/api/v1/mediaops/tasks/:id", (c) => safe(c, () => readMediaopsTask(c.env.storage.db, c.get("auth"), c.req.param("id"))));
  app.post("/api/v1/mediaops/tasks/:id/assignments", (c) => safe(c, async () => {
    const input = await body(c), role = string(input.role, "role");
    if (role !== "editor" && role !== "reviewer") throw new AppError("bad_request", "Invalid role", 400);
    await assignMediaopsUser(c.env.storage.db, c.get("auth"), c.req.param("id"), string(input.userId, "userId"), role);
    return { ok: true };
  }));
  app.post("/api/v1/mediaops/tasks/:id/revoke", (c) => safe(c, async () => {
    const input = await body(c), role = string(input.role, "role");
    if (role !== "editor" && role !== "reviewer") throw new AppError("bad_request", "Invalid role", 400);
    await revokeMediaopsUser(c.env.storage.db, c.get("auth"), c.req.param("id"), string(input.userId, "userId"), role);
    return { ok: true };
  }));
  app.post("/api/v1/mediaops/tasks/:id/transfer", (c) => safe(c, async () => {
    const input = await body(c);
    return transferMediaopsHolder(c.env.storage.db, c.get("auth"), c.req.param("id"),
      string(input.userId, "userId"), integer(input.expectedVersion, "expectedVersion"));
  }));
  app.post("/api/v1/mediaops/tasks/:id/save", (c) => safe(c, async () => {
    const input = await body(c);
    return saveMediaopsArticle(c.env.storage.db, c.get("auth"), c.req.param("id"), {
      expectedRevision: integer(input.expectedRevision, "expectedRevision"),
      expectedHash: string(input.expectedHash, "expectedHash"),
      holderEpoch: integer(input.holderEpoch, "holderEpoch"),
      markdown: typeof input.markdown === "string" ? input.markdown : string(input.markdown, "markdown"),
    });
  }));
  app.post("/api/v1/mediaops/tasks/:id/submit", (c) => safe(c, async () => {
    const input = await body(c);
    return submitMediaopsTask(c.env.storage.db, c.get("auth"), c.req.param("id"), {
      expectedVersion: integer(input.expectedVersion, "expectedVersion"),
      revision: integer(input.revision, "revision"), hash: string(input.hash, "hash"),
      holderEpoch: integer(input.holderEpoch, "holderEpoch"),
    });
  }));
  app.post("/api/v1/mediaops/tasks/:id/review", (c) => safe(c, async () => {
    const input = await body(c), decision = string(input.decision, "decision");
    if (decision !== "reviewed" && decision !== "changes_requested") throw new AppError("bad_request", "Invalid decision", 400);
    return reviewMediaopsTask(c.env.storage.db, c.get("auth"), c.req.param("id"), decision,
      integer(input.expectedVersion, "expectedVersion"));
  }));
  app.post("/api/v1/mediaops/tasks/:id/approve", (c) => safe(c, async () => {
    const input = await body(c);
    return approveMediaopsTask(c.env.storage.db, c.get("auth"), c.req.param("id"),
      integer(input.expectedVersion, "expectedVersion"));
  }));
  app.post("/api/v1/mediaops/tasks/:id/restore", (c) => safe(c, async () => {
    const input = await body(c);
    return restoreMediaopsRevision(c.env.storage.db, c.get("auth"), c.req.param("id"), {
      revisionId: string(input.revisionId, "revisionId"),
      expectedRevision: integer(input.expectedRevision, "expectedRevision"),
      expectedHash: string(input.expectedHash, "expectedHash"),
      expectedVersion: integer(input.expectedVersion, "expectedVersion"),
    });
  }));
};
