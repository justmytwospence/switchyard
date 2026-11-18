import { CreateWorkspaceRequest, DiffRev, RemoveWorkspaceRequest } from "@switchyard/protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CoordinatorContext } from "../context.js";
import { parse } from "../http.js";
import { createWorkspace, requireConnected } from "../sessions/service.js";
import { baseFor, refreshWorkspaceStatus, removeWorkspace } from "../workspaces.js";

const ListQuery = z.object({
  projectId: z.string().optional(),
  includeArchived: z.enum(["true", "false"]).optional(),
});
const DiffQuery = z.object({ file: z.string().optional(), rev: DiffRev.optional() });
const CommitsQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });
const FilesQuery = z.object({ dir: z.string().default("") });
const FileQuery = z.object({ path: z.string().min(1) });

export function registerWorkspaceRoutes(app: FastifyInstance, ctx: CoordinatorContext): void {
  app.get("/api/workspaces", async (req) => {
    const q = parse(ListQuery, req.query, "query");
    const where: string[] = [];
    const params: string[] = [];
    if (q.projectId) {
      where.push("project_id = ?");
      params.push(q.projectId);
    }
    if (q.includeArchived !== "true") where.push("archived_at IS NULL");
    return ctx.store.workspaces.list(where.join(" AND ") || undefined, params);
  });

  app.get("/api/workspaces/:id", async (req) =>
    ctx.store.workspaces.require((req.params as { id: string }).id),
  );

  app.post("/api/workspaces", async (req, reply) => {
    const body = parse(CreateWorkspaceRequest, req.body);
    const checkout = ctx.store.checkouts.require(body.checkoutId);
    const project = ctx.store.projects.require(checkout.projectId);
    const ws = await createWorkspace(ctx, project, checkout, body.branch, body.base);
    return reply.code(201).send(ws);
  });

  /** Remove a worktree. Dirty/unmerged need explicit force flags; never deletes the branch. */
  app.post("/api/workspaces/:id/remove", async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(RemoveWorkspaceRequest, req.body);
    await removeWorkspace(ctx, id, { force: body.force });
    return { ok: true, id };
  });

  app.post("/api/workspaces/:id/refresh", async (req) => {
    const ws = ctx.store.workspaces.require((req.params as { id: string }).id);
    requireConnected(ctx, ws.hostId);
    return refreshWorkspaceStatus(ctx, ws);
  });

  app.get("/api/workspaces/:id/diff", async (req) => {
    const ws = ctx.store.workspaces.require((req.params as { id: string }).id);
    const q = parse(DiffQuery, req.query, "query");
    requireConnected(ctx, ws.hostId);
    return ctx.hostHub.request(ws.hostId, {
      type: "workspace.diff",
      path: ws.path,
      base: baseFor(ctx, ws),
      file: q.file ?? null,
      ...(q.rev ? { rev: q.rev } : {}),
    });
  });

  app.get("/api/workspaces/:id/commits", async (req) => {
    const ws = ctx.store.workspaces.require((req.params as { id: string }).id);
    const q = parse(CommitsQuery, req.query, "query");
    requireConnected(ctx, ws.hostId);
    return ctx.hostHub.request(ws.hostId, {
      type: "workspace.log",
      path: ws.path,
      base: baseFor(ctx, ws),
      limit: q.limit,
    });
  });

  app.get("/api/workspaces/:id/files", async (req) => {
    const ws = ctx.store.workspaces.require((req.params as { id: string }).id);
    const q = parse(FilesQuery, req.query, "query");
    requireConnected(ctx, ws.hostId);
    return ctx.hostHub.request(ws.hostId, { type: "workspace.files", path: ws.path, dir: q.dir });
  });

  app.get("/api/workspaces/:id/file", async (req) => {
    const ws = ctx.store.workspaces.require((req.params as { id: string }).id);
    const q = parse(FileQuery, req.query, "query");
    requireConnected(ctx, ws.hostId);
    return ctx.hostHub.request(ws.hostId, {
      type: "workspace.readFile",
      path: ws.path,
      file: q.path,
    });
  });
}
