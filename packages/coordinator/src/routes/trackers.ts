import {
  newId,
  OpenIssueRequest,
  SwitchyardError,
  type Tracker,
  TrackerInput,
  TrackerPatch,
  TrackerStatusRequest,
} from "@switchyard/protocol";
import type { FastifyInstance } from "fastify";
import type { CoordinatorContext } from "../context.js";
import { parse } from "../http.js";
import { requireService } from "../services.js";

/** Trackers: GitHub issue sync (see docs/trackers.md). */
export function registerTrackerRoutes(app: FastifyInstance, ctx: CoordinatorContext): void {
  const { store } = ctx;
  const service = () => requireService(ctx, "trackers");
  const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;
  const checkName = (name: string, exceptId?: string) => {
    const taken = store.trackers
      .list()
      .some((t) => t.id !== exceptId && t.name.toLowerCase() === name.toLowerCase());
    if (taken) throw new SwitchyardError("conflict", `A tracker named ${name} exists`);
  };

  app.get("/api/trackers", async () => store.trackers.list(undefined, [], "created_at, rowid"));

  app.post("/api/trackers", async (req, reply) => {
    const body = parse(TrackerInput, req.body);
    const created = store.tx(() => {
      checkName(body.name);
      store.hosts.require(body.hostId);
      const now = store.nowIso();
      const tracker: Tracker = {
        id: newId("trk"),
        provider: "github",
        ...body,
        login: null,
        lastSyncedAt: null,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      };
      return store.trackers.upsert(tracker);
    });
    void service()
      .sync(created.id)
      .catch((err: unknown) => ctx.log.warn({ err, trackerId: created.id }, "tracker sync failed"));
    return reply.code(201).send(created);
  });

  app.patch("/api/trackers/:id", async (req) => {
    const body = parse(TrackerPatch, req.body);
    return store.tx(() => {
      const cur = store.trackers.require(idOf(req));
      if (body.name !== undefined) checkName(body.name, cur.id);
      if (body.hostId !== undefined) store.hosts.require(body.hostId);
      const defined = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
      const next: Tracker = { ...cur, ...defined, updatedAt: store.nowIso() };
      store.trackers.upsert(next);
      if (body.name !== undefined && body.name !== cur.name) {
        const view = store.views.list().find((v) => v.trackerId === cur.id);
        const clash = store.views
          .list()
          .some((v) => v.id !== view?.id && v.name.toLowerCase() === body.name!.toLowerCase());
        if (view && !clash) store.putView({ ...view, name: body.name, updatedAt: next.updatedAt });
      }
      return next;
    });
  });

  app.delete("/api/trackers/:id", async (req) => {
    const id = idOf(req);
    store.tx(() => {
      store.trackers.require(id);
      const now = store.nowIso();
      for (const i of store.issues.list("tracker_id = ?", [id])) store.deleteIssue(i);
      for (const v of store.views.list()) {
        if (v.trackerId === id) store.putView({ ...v, trackerId: null, updatedAt: now });
      }
      store.trackers.delete(id);
    });
    return { ok: true, id };
  });

  app.post("/api/trackers/:id/sync", async (req) => {
    store.trackers.require(idOf(req));
    return service().sync(idOf(req));
  });

  app.get("/api/issues", async () => store.issues.list(undefined, [], "created_at, rowid"));

  app.post("/api/issues/:id/open", async (req, reply) => {
    const body = parse(OpenIssueRequest, req.body ?? {});
    const result = await service().openIssue(idOf(req), body);
    return reply.code(result.created ? 202 : 200).send(result);
  });

  app.post("/api/issues/:id/status", async (req) => {
    const body = parse(TrackerStatusRequest, req.body);
    return service().setStatus(idOf(req), body.status);
  });
}
