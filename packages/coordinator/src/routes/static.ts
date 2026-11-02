import { existsSync } from "node:fs";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import { SwitchyardError } from "@switchyard/protocol";
import type { FastifyInstance } from "fastify";
import type { CoordinatorContext } from "../context.js";
import { sendError } from "../http.js";

/** CSP for adapter web renderers: an opaque-origin sandbox that may only run inline code. */
export const ADAPTER_FRAME_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

export async function registerStaticRoutes(
  app: FastifyInstance,
  ctx: CoordinatorContext,
): Promise<void> {
  const frame = async (
    req: { params: unknown },
    reply: import("fastify").FastifyReply,
  ): Promise<unknown> => {
    const { hostId, adapterId } = req.params as { hostId?: string; adapterId: string };
    const html = ctx.store.getRenderer(hostId ?? null, adapterId);
    if (html === undefined) {
      return sendError(reply, new SwitchyardError("not_found", "No web renderer for this adapter"));
    }
    return reply
      .header("Content-Type", "text/html; charset=utf-8")
      .header("Content-Security-Policy", ADAPTER_FRAME_CSP)
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header("Cache-Control", "no-store")
      .send(html);
  };
  app.get("/adapter-frames/:hostId/:adapterId", frame);
  app.get("/adapter-frames/:adapterId", frame);

  const webDist = ctx.config.webDist;
  const hasWeb = !!webDist && existsSync(join(webDist, "index.html"));
  if (hasWeb) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: "/",
      wildcard: false,
      index: false,
    });
  }

  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split("?")[0] ?? "/";
    const apiLike =
      path.startsWith("/api/") || path.startsWith("/ws/") || path.startsWith("/adapter-frames/");
    if (hasWeb && !apiLike && (req.method === "GET" || req.method === "HEAD")) {
      return reply.header("Cache-Control", "no-cache").sendFile("index.html");
    }
    return sendError(reply, new SwitchyardError("not_found", `No route ${req.method} ${path}`));
  });
}
