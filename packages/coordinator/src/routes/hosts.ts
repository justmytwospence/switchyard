import { HostEnrollRequest, SwitchyardError, UpdateHostRequest } from "@switchyard/protocol";
import type { FastifyInstance } from "fastify";
import type { CoordinatorContext } from "../context.js";
import { deviceOf, parse } from "../http.js";
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

  /** Change the clone destination without scanning or moving existing checkouts. */
  app.patch("/api/hosts/:id", async (req) => {
    const { id } = req.params as { id: string };
    if (req.body && typeof req.body === "object" && "projectFolders" in req.body) {
      throw new SwitchyardError(
        "unsupported_capability",
        "Projects come from your Git provider. Set this host's Checkout location instead.",
      );
    }
    const { checkoutRoot } = parse(UpdateHostRequest, req.body);
    return ctx.store.tx(() => {
      const host = ctx.store.hosts.require(id);
      if (host.revokedAt) throw new SwitchyardError("forbidden", "This host was revoked");
      if (checkoutRoot === undefined || checkoutRoot === host.checkoutRoot) return host;
      return ctx.store.putHost({ ...host, checkoutRoot });
    });
  });

  app.post("/api/hosts/:id/scan-projects", async () => {
    throw new SwitchyardError(
      "unsupported_capability",
      "Folder scanning is no longer available. Select repositories on your Git provider instead.",
    );
  });

  app.get("/api/hosts/:id/project-suggestions", async () => ({ suggestions: [] }));

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
