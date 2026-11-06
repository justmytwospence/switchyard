import { basename } from "node:path";
import {
  HostEnrollRequest,
  ProjectSuggestions,
  type ProjectSuggestionsResponse,
  SwitchyardError,
  UpdateHostRequest,
} from "@switchyard/protocol";
import type { FastifyInstance } from "fastify";
import type { CoordinatorContext } from "../context.js";
import { deviceOf, parse } from "../http.js";
import { isTooOld, normalizeProjectFolders } from "../project-folders.js";
import { requireService } from "../services.js";
import { requireConnected } from "../sessions/service.js";
import { enrollmentResponse } from "./devices.js";

export function registerHostRoutes(app: FastifyInstance, ctx: CoordinatorContext): void {
  /**
   * Host side of enrollment: unauthenticated, authorized by a single-use token or by the shared
   * `SWITCHYARD_HOST_ENROLL_SECRET` when the server enables it.
   */
  app.post("/api/hosts/enroll", async (req, reply) => {
    ctx.limiters.hosts.check(req);
    const body = parse(HostEnrollRequest, req.body);
    const { host, credential } =
      "token" in body
        ? ctx.auth.redeemHost(body.token, body.name, body.platform)
        : ctx.auth.redeemHostSecret(body.secret, body.name, body.platform);
    return reply.code(201).send({ hostId: host.id, credential });
  });

  app.post("/api/hosts/enrollments", async (req, reply) =>
    reply.code(201).send(await enrollmentResponse(ctx, "host", deviceOf(req).id)),
  );

  app.get("/api/hosts", async () => ctx.store.hosts.list(undefined, [], "created_at"));

  app.get("/api/hosts/:id", async (req) => {
    const { id } = req.params as { id: string };
    const host = ctx.store.hosts.require(id);
    return { ...host, adapters: ctx.store.adaptersByHost()[id] ?? [] };
  });

  /** Change a host's settings (its project folders); new folders are scanned in the background. */
  app.patch("/api/hosts/:id", async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(UpdateHostRequest, req.body);
    let scan = false;
    const host = ctx.store.tx(() => {
      const h = ctx.store.hosts.require(id);
      if (h.revokedAt) throw new SwitchyardError("forbidden", "This host was revoked");
      const next = { ...h };
      if (body.projectFolders !== undefined) {
        const folders = normalizeProjectFolders(body.projectFolders);
        scan =
          folders.length > 0 && JSON.stringify(folders) !== JSON.stringify(h.projectFolders ?? []);
        next.projectFolders = folders;
      }
      return ctx.store.putHost(next);
    });
    if (scan && ctx.hostHub.isConnected(id)) {
      requireService(ctx, "projectFolders").background(id);
    }
    return host;
  });

  /** Scan the host's project folders now and wait for the result. */
  app.post("/api/hosts/:id/scan-projects", async (req) => {
    const { id } = req.params as { id: string };
    return requireService(ctx, "projectFolders").scan(id);
  });

  /** Repositories used with Pi on this host recently that are not projects yet. */
  app.get(
    "/api/hosts/:id/project-suggestions",
    async (req): Promise<ProjectSuggestionsResponse> => {
      const { id } = req.params as { id: string };
      requireConnected(ctx, id);
      let raw: unknown;
      try {
        raw = await ctx.hostHub.request(
          id,
          { type: "projects.suggest", days: 30 },
          { timeoutMs: 30_000 },
        );
      } catch (err) {
        if (isTooOld(err)) {
          throw new SwitchyardError(
            "unsupported_capability",
            "Update the host agent to get project suggestions",
          );
        }
        throw err;
      }
      const known = new Set(ctx.store.checkouts.list("host_id = ?", [id]).map((c) => c.path));
      return {
        suggestions: ProjectSuggestions.parse(raw)
          .suggestions.filter((s) => !known.has(s.rootPath))
          .map((s) => ({ ...s, name: basename(s.rootPath), preselected: s.sessionCount >= 3 })),
      };
    },
  );

  const revoke = async (req: { params: unknown }) => {
    const { id } = req.params as { id: string };
    const host = ctx.store.tx(() => {
      const h = ctx.store.hosts.require(id);
      if (h.revokedAt) return h;
      return ctx.store.putHost({ ...h, revokedAt: ctx.store.nowIso() });
    });
    ctx.hostHub.disconnect(id, "This host was revoked");
    return host;
  };
  app.post("/api/hosts/:id/revoke", revoke);
  app.delete("/api/hosts/:id", revoke);
}
