import { HostEnrollRequest } from "@switchyard/protocol";
import type { FastifyInstance } from "fastify";
import type { CoordinatorContext } from "../context.js";
import { deviceOf, parse } from "../http.js";
import { enrollmentResponse } from "./devices.js";

export function registerHostRoutes(app: FastifyInstance, ctx: CoordinatorContext): void {
  /** Host side of enrollment: unauthenticated, authorized by the single-use token. */
  app.post("/api/hosts/enroll", async (req, reply) => {
    const body = parse(HostEnrollRequest, req.body);
    const { host, credential } = ctx.auth.redeemHost(body.token, body.name, body.platform);
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
