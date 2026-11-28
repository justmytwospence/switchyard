import {
  AddCheckoutRequest,
  CheckoutPreviewRequest,
  CheckoutProvisionRequest,
  CreateProjectRequest,
  isListedProject,
  type Project,
  SwitchyardError,
  UpdateProjectRequest,
} from "@switchyard/protocol";
import type { FastifyInstance } from "fastify";
import type { CoordinatorContext } from "../context.js";
import { deviceOf, parse } from "../http.js";
import { requireService } from "../services.js";
import { refreshCheckoutWorkspaces, worktreeDirOf } from "../workspaces.js";

/** Projects stored before 0.2 have no worktree folder: report the default. */
function withDefaults(p: Project): Project {
  return {
    ...p,
    worktreeDir: worktreeDirOf(p),
    ensureSessions: p.ensureSessions ?? false,
    removeLanded: p.removeLanded ?? false,
  };
}

function projectView(ctx: CoordinatorContext, p: Project) {
  return {
    ...withDefaults(p),
    checkouts: ctx.store.checkouts.list("project_id = ?", [p.id]),
    workspaces: ctx.store.workspaces.list("project_id = ? AND archived_at IS NULL", [p.id]),
  };
}

export function registerProjectRoutes(app: FastifyInstance, ctx: CoordinatorContext): void {
  app.get("/api/projects", async (req) => {
    const includeHistory = (req.query as { includeHistory?: string }).includeHistory === "true";
    const projects = ctx.store.projects.list(undefined, [], "created_at");
    return (includeHistory ? projects : projects.filter(isListedProject)).map(withDefaults);
  });

  app.get("/api/projects/:id", async (req) =>
    projectView(ctx, ctx.store.projects.require((req.params as { id: string }).id)),
  );

  /** Compatibility: old clients may attach to a listed project, but cannot create a project. */
  app.post("/api/projects", async (req, reply) => {
    const { hostId, path } = parse(CreateProjectRequest, req.body);
    const project = await requireService(ctx, "checkoutProvision").attachFromLegacyCreate(
      hostId,
      path,
    );
    return reply.code(201).send(projectView(ctx, project));
  });

  app.patch("/api/projects/:id", async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(UpdateProjectRequest, req.body);
    return ctx.store.tx(() => {
      const p = ctx.store.projects.require(id);
      if (body.defaultProfileId) ctx.store.profiles.require(body.defaultProfileId);
      if (body.defaultHostId) ctx.store.hosts.require(body.defaultHostId);
      const next: Project = { ...withDefaults(p), updatedAt: ctx.store.nowIso() };
      for (const [k, v] of Object.entries(body)) {
        if (v !== undefined) (next as Record<string, unknown>)[k] = v;
      }
      return ctx.store.putProject(next);
    });
  });

  /** Add another clone of the same repository (possibly on another host). */
  app.post("/api/projects/:id/checkouts", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parse(AddCheckoutRequest, req.body);
    const result = await requireService(ctx, "checkoutProvision").attach(
      id,
      body.hostId,
      body.path,
    );
    return reply.code(201).send(result);
  });

  app.post("/api/projects/:id/checkouts/preview", async (req) => {
    const { id } = req.params as { id: string };
    const { hostId, folderName } = parse(CheckoutPreviewRequest, req.body);
    return requireService(ctx, "checkoutProvision").preview(
      deviceOf(req).id,
      id,
      hostId,
      folderName,
    );
  });

  app.post("/api/projects/:id/checkouts/provision", async (req) => {
    const { id } = req.params as { id: string };
    const { previewId } = parse(CheckoutProvisionRequest, req.body);
    return requireService(ctx, "checkoutProvision").provision(deviceOf(req).id, id, previewId);
  });

  /** Re-run `workspace.discover` for every checkout of the project on connected hosts. */
  app.post("/api/projects/:id/refresh", async (req) => {
    const { id } = req.params as { id: string };
    const project = ctx.store.projects.require(id);
    const errors: { checkoutId: string; code: string; message: string }[] = [];
    for (const c of ctx.store.checkouts.list("project_id = ?", [id])) {
      try {
        await refreshCheckoutWorkspaces(ctx, c);
      } catch (err) {
        const e =
          err instanceof SwitchyardError ? err : new SwitchyardError("internal", String(err));
        errors.push({ checkoutId: c.id, code: e.code, message: e.message });
      }
    }
    return { ...projectView(ctx, project), errors };
  });

  app.post("/api/checkouts/:id/refresh", async (req) => {
    const checkout = ctx.store.checkouts.require((req.params as { id: string }).id);
    return refreshCheckoutWorkspaces(ctx, checkout);
  });
}
