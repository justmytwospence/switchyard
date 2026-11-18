import { type Surface, SurfaceReport, SwitchyardError } from "@switchyard/protocol";
import type { FastifyInstance } from "fastify";
import type { CoordinatorContext } from "../context.js";
import { deviceOf, parse } from "../http.js";

/** A surface that reported less than this ago is not rewritten (keeps the event log quiet). */
const SURFACE_REWRITE_MS = 5 * 60_000;

/** Record a surface's report (inside a transaction): unchanged and recent reports write nothing. */
export function reportSurface(
  ctx: CoordinatorContext,
  id: string,
  body: SurfaceReport,
  deviceId: string,
): Surface {
  const { store } = ctx;
  if (id !== `${body.kind}:${body.name}@${body.machine}`) {
    throw new SwitchyardError(
      "invalid_request",
      "Surface id does not match its kind, name and machine",
    );
  }
  return store.tx(() => {
    if (body.viewId !== null) store.views.require(body.viewId);
    const existing = store.surfaces.get(id);
    const asked = body.hostId === undefined ? (existing?.hostId ?? null) : body.hostId;
    const hostId = asked && store.hosts.get(asked) ? asked : null;
    const now = store.now();
    if (
      existing &&
      now.getTime() - Date.parse(existing.lastSeenAt) < SURFACE_REWRITE_MS &&
      existing.kind === body.kind &&
      existing.name === body.name &&
      existing.machine === body.machine &&
      existing.viewId === body.viewId &&
      existing.hostId === hostId &&
      existing.deviceId === deviceId
    ) {
      return existing;
    }
    return store.putSurface({
      id,
      kind: body.kind,
      name: body.name,
      machine: body.machine,
      deviceId,
      hostId,
      viewId: body.viewId,
      lastSeenAt: now.toISOString(),
      createdAt: existing?.createdAt ?? now.toISOString(),
    });
  });
}

/** Surfaces: herdr and tmux sessions that show a view (see docs/terminal-sessions.md). */
export function registerSurfaceRoutes(app: FastifyInstance, ctx: CoordinatorContext): void {
  const { store } = ctx;
  const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;

  app.get("/api/surfaces", async () => store.surfaces.list(undefined, [], "created_at, rowid"));

  app.put("/api/surfaces/:id", async (req) => {
    const body = parse(SurfaceReport, req.body);
    return reportSurface(ctx, idOf(req), body, deviceOf(req).id);
  });

  app.delete("/api/surfaces/:id", async (req) => {
    store.deleteSurface(idOf(req));
    return { ok: true, id: idOf(req) };
  });
}
