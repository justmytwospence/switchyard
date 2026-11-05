import {
  CreateEnrollmentRequest,
  type CreateEnrollmentResponse,
  type Device,
} from "@switchyard/protocol";
import type { FastifyInstance } from "fastify";
import QRCode from "qrcode";
import { z } from "zod";
import type { CoordinatorContext } from "../context.js";
import { deviceOf, parse } from "../http.js";

const UpdateDeviceRequest = z.object({
  name: z.string().min(1).max(80).optional(),
  preferredMobile: z.boolean().optional(),
});

export async function enrollmentResponse(
  ctx: CoordinatorContext,
  kind: "device" | "host",
  createdBy: string | null,
): Promise<CreateEnrollmentResponse> {
  const e = ctx.auth.createEnrollment(kind, createdBy);
  const qrSvg = await QRCode.toString(e.url, { type: "svg", margin: 1 });
  return { token: e.token, url: e.url, expiresAt: e.expiresAt, qrSvg, command: e.command };
}

function publicDevice(ctx: CoordinatorContext, id: string): Device {
  return ctx.store.devices.require(id);
}

export function registerDeviceRoutes(app: FastifyInstance, ctx: CoordinatorContext): void {
  app.post("/api/enrollments", async (req, reply) => {
    const body = parse(CreateEnrollmentRequest, req.body);
    return reply.code(201).send(await enrollmentResponse(ctx, body.kind, deviceOf(req).id));
  });
  app.post("/api/devices/enrollments", async (req, reply) =>
    reply.code(201).send(await enrollmentResponse(ctx, "device", deviceOf(req).id)),
  );

  app.get("/api/devices", async () => ctx.store.devices.list("is_admin = 0", [], "created_at"));

  app.get("/api/devices/:id", async (req) => publicDevice(ctx, (req.params as { id: string }).id));

  app.patch("/api/devices/:id", async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(UpdateDeviceRequest, req.body);
    return ctx.store.tx(() => {
      const d = ctx.store.devices.require(id);
      if (body.preferredMobile) {
        for (const other of ctx.store.devices.list("is_admin = 0")) {
          if (other.id !== id && other.preferredMobile) {
            ctx.store.putDevice({ ...other, preferredMobile: false });
          }
        }
      }
      return ctx.store.putDevice({
        ...d,
        name: body.name ?? d.name,
        preferredMobile: body.preferredMobile ?? d.preferredMobile,
      });
    });
  });

  const revoke = async (req: { params: unknown }) =>
    ctx.auth.revokeDevice((req.params as { id: string }).id);
  app.post("/api/devices/:id/revoke", revoke);
  app.delete("/api/devices/:id", revoke);
}
