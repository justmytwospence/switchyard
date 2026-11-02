import {
  NotificationSettings,
  PushSubscriptionRequest,
  SwitchyardError,
} from "@switchyard/protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CoordinatorContext } from "../context.js";
import { deviceOf, parse } from "../http.js";
import { requireService } from "../services.js";

const DeleteSubscription = z.object({ endpoint: z.string().optional() });

export function registerPushRoutes(app: FastifyInstance, ctx: CoordinatorContext): void {
  const push = () => requireService(ctx, "push");

  app.get("/api/push/vapid-public-key", async () => ({ publicKey: push().vapid().publicKey }));

  app.post("/api/push/subscriptions", async (req, reply) => {
    const body = parse(PushSubscriptionRequest, req.body);
    const device = deviceOf(req);
    const updated = push().subscribe(
      device.id,
      { endpoint: body.endpoint, keys: body.keys },
      body.permission,
    );
    return reply.code(201).send(updated);
  });

  app.delete("/api/push/subscriptions", async (req) => {
    const body = parse(DeleteSubscription, req.body ?? {});
    return push().unsubscribe(deviceOf(req).id, body.endpoint ?? null);
  });

  /** Send a test notification to the calling device's subscriptions. */
  app.post("/api/push/test", async (req) => {
    const device = deviceOf(req);
    if (push().subscriptions(device.id).length === 0) {
      throw new SwitchyardError("conflict", "This device has no push subscription");
    }
    const r = await push().sendToDevice(device.id, {
      type: "show",
      title: "Switchyard",
      body: "Test notification from Switchyard",
      tag: "switchyard-test",
      url: "/settings",
      renotify: true,
    });
    return { ok: r.sent > 0, ...r };
  });

  app.get("/api/me/notification-settings", async () => push().settings());

  app.patch("/api/me/notification-settings", async (req) => {
    const body = parse(NotificationSettings.partial(), req.body);
    return push().updateSettings(body);
  });
}
