import { EnrollRequest } from "@switchyard/protocol";
import type { FastifyInstance } from "fastify";
import type { CoordinatorContext } from "../context.js";
import { deviceOf, parse } from "../http.js";

export function registerAuthRoutes(app: FastifyInstance, ctx: CoordinatorContext): void {
  /** Redeem a device enrollment. Browsers get the HttpOnly cookie and no credential in the body. */
  app.post("/api/enroll", async (req, reply) => {
    const body = parse(EnrollRequest, req.body);
    const { device, credential } = ctx.auth.redeemDevice(body.token, body.name, body.kind);
    const browser = body.kind === "browser" || body.kind === "pwa";
    if (browser) ctx.auth.setDeviceCookie(reply, credential);
    return reply.code(201).send({ deviceId: device.id, credential: browser ? "" : credential });
  });

  app.get("/api/me", async (req) => {
    const { isAdmin, ...device } = deviceOf(req);
    return { device, admin: isAdmin, publicUrl: ctx.config.publicUrl };
  });

  /** Clear this browser's cookie (does not revoke the device). */
  app.post("/api/logout", async (_req, reply) => {
    ctx.auth.clearDeviceCookie(reply);
    return { ok: true };
  });
}
