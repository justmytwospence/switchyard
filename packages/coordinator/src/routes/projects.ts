import {
  AddCheckoutRequest,
  type Checkout,
  CreateProjectRequest,
  newId,
  type Project,
  SwitchyardError,
  UpdateProjectRequest,
} from "@switchyard/protocol";
import type { FastifyInstance } from "fastify";
import type { CoordinatorContext } from "../context.js";
import { parse } from "../http.js";
import { requireConnected } from "../sessions/service.js";
import {
  DEFAULT_WORKTREE_DIR,
  inspectCheckout,
  refreshCheckoutWorkspaces,
  worktreeDirOf,
} from "../workspaces.js";

/** Projects stored before 0.2 have no worktree folder: report the default. */
function withDefaults(p: Project): Project {
  return { ...p, worktreeDir: worktreeDirOf(p) };
}

function projectView(ctx: CoordinatorContext, p: Project) {
  return {
    ...withDefaults(p),
    checkouts: ctx.store.checkouts.list("project_id = ?", [p.id]),
    workspaces: ctx.store.workspaces.list("project_id = ? AND archived_at IS NULL", [p.id]),
  };
}

export function registerProjectRoutes(app: FastifyInstance, ctx: CoordinatorContext): void {
  app.get("/api/projects", async () =>
    ctx.store.projects.list(undefined, [], "created_at").map(withDefaults),
  );

  app.get("/api/projects/:id", async (req) =>
    projectView(ctx, ctx.store.projects.require((req.params as { id: string }).id)),
  );

  /** Inspect the checkout on the host, create Project + Checkout, then discover workspaces. */
  app.post("/api/projects", async (req, reply) => {
    const body = parse(CreateProjectRequest, req.body);
    requireConnected(ctx, body.hostId);
    if (body.defaultProfileId) ctx.store.profiles.require(body.defaultProfileId);
    const info = await inspectCheckout(ctx, body.hostId, body.path);
    const now = ctx.store.nowIso();
    const { project, checkout } = ctx.store.tx(() => {
      const dupe = ctx.store.projects.list("repo_identity = ?", [info.repoIdentity])[0];
      if (dupe) {
        throw new SwitchyardError(
          "conflict",
          `Project ${dupe.name} already tracks ${info.repoIdentity}; add a checkout to it instead`,
          { projectId: dupe.id },
        );
      }
      const project: Project = {
        id: newId("prj"),
        name: body.name,
        repoIdentity: info.repoIdentity,
        defaultProfileId: body.defaultProfileId ?? null,
        defaultHostId: body.hostId,
        maxConcurrentRuns: body.maxConcurrentRuns ?? 1,
        automationEnabled: true,
        setupCommand: body.setupCommand ?? null,
        checks: body.checks ?? [],
        workspaceSharing: "single_writer",
        worktreeDir: body.worktreeDir ?? DEFAULT_WORKTREE_DIR,
        createdAt: now,
        updatedAt: now,
      };
      const checkout: Checkout = {
        id: newId("chk"),
        projectId: project.id,
        hostId: body.hostId,
        path: info.root,
        commonDir: info.commonDir,
        defaultBranch: info.defaultBranch,
        createdAt: now,
      };
      ctx.store.putProject(project);
      ctx.store.putCheckout(checkout);
      return { project, checkout };
    });
    try {
      await refreshCheckoutWorkspaces(ctx, checkout);
    } catch (err) {
      req.log.warn({ err, projectId: project.id }, "workspace discovery failed");
    }
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
    const project = ctx.store.projects.require(id);
    requireConnected(ctx, body.hostId);
    const info = await inspectCheckout(ctx, body.hostId, body.path);
    if (info.repoIdentity !== project.repoIdentity) {
      throw new SwitchyardError(
        "repo_mismatch",
        `${info.root} is ${info.repoIdentity}, not ${project.repoIdentity}`,
      );
    }
    const checkout = ctx.store.tx(() => {
      const existing = ctx.store.checkouts.list("host_id = ? AND path = ?", [
        body.hostId,
        info.root,
      ])[0];
      if (existing) {
        if (existing.projectId !== project.id) {
          throw new SwitchyardError("conflict", "This checkout belongs to another project");
        }
        return existing;
      }
      return ctx.store.putCheckout({
        id: newId("chk"),
        projectId: project.id,
        hostId: body.hostId,
        path: info.root,
        commonDir: info.commonDir,
        defaultBranch: info.defaultBranch,
        createdAt: ctx.store.nowIso(),
      });
    });
    const workspaces = await refreshCheckoutWorkspaces(ctx, checkout);
    return reply.code(201).send({ checkout, workspaces });
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
