import {
  newId,
  SwitchyardError,
  type View,
  ViewClientReport,
  ViewInput,
  ViewPatch,
  View as ViewSchema,
} from "@switchyard/protocol";
import type { FastifyInstance } from "fastify";
import type { CoordinatorContext } from "../context.js";
import { parse } from "../http.js";

/** A client that reported less than this ago is not rewritten (keeps the event log quiet). */
const CLIENT_REWRITE_MS = 5 * 60_000;

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function registerViewRoutes(app: FastifyInstance, ctx: CoordinatorContext): void {
  const { store } = ctx;
  const checkName = (name: string, exceptId?: string) => {
    const taken = store.views
      .list()
      .some((v) => v.id !== exceptId && v.name.toLowerCase() === name.toLowerCase());
    if (taken) throw new SwitchyardError("conflict", `A view named ${name} exists`);
  };
  const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;

  app.get("/api/views", async () => store.views.list(undefined, [], "created_at, rowid"));

  app.post("/api/views", async (req, reply) => {
    const body = parse(ViewInput, req.body);
    const created = store.tx(() => {
      checkName(body.name);
      const now = store.nowIso();
      const view = ViewSchema.parse({
        id: newId("viw"),
        mode: "all",
        projectIds: null,
        hostIds: null,
        sessionIds: [],
        clients: [],
        createdAt: now,
        updatedAt: now,
        ...stripUndefined(body),
      });
      return store.putView(view);
    });
    return reply.code(201).send(created);
  });

  app.patch("/api/views/:id", async (req) => {
    const body = parse(ViewPatch, req.body);
    return store.tx(() => {
      const cur = store.views.require(idOf(req));
      if (body.name !== undefined) checkName(body.name, cur.id);
      const next = ViewSchema.parse({
        ...cur,
        ...stripUndefined(body),
        id: cur.id,
        updatedAt: store.nowIso(),
      });
      return store.putView(next);
    });
  });

  app.delete("/api/views/:id", async (req) =>
    store.tx(() => {
      const v = store.views.require(idOf(req));
      store.deleteView(v.id);
      return { ok: true, id: v.id };
    }),
  );

  app.post("/api/views/:id/sessions/:sessionId", async (req) =>
    store.tx(() => {
      const { sessionId } = req.params as { sessionId: string };
      const v = store.views.require(idOf(req));
      store.sessions.require(sessionId);
      if (v.sessionIds.includes(sessionId)) return v;
      return store.putView({
        ...v,
        sessionIds: [...v.sessionIds, sessionId],
        updatedAt: store.nowIso(),
      });
    }),
  );

  app.delete("/api/views/:id/sessions/:sessionId", async (req) =>
    store.tx(() => {
      const { sessionId } = req.params as { sessionId: string };
      const v = store.views.require(idOf(req));
      if (!v.sessionIds.includes(sessionId)) return v;
      return store.putView({
        ...v,
        sessionIds: v.sessionIds.filter((s) => s !== sessionId),
        updatedAt: store.nowIso(),
      });
    }),
  );

  app.post("/api/views/:id/clients", async (req) => {
    const body = parse(ViewClientReport, req.body);
    return store.tx((): View => {
      const v = store.views.require(idOf(req));
      const now = store.now();
      const cur = v.clients.find((c) => c.id === body.id);
      if (
        cur &&
        now.getTime() - Date.parse(cur.lastSeenAt) < CLIENT_REWRITE_MS &&
        cur.kind === body.kind &&
        cur.name === body.name &&
        cur.machine === body.machine
      ) {
        return v;
      }
      const entry = { ...body, lastSeenAt: now.toISOString() };
      const clients = cur
        ? v.clients.map((c) => (c.id === body.id ? entry : c))
        : [...v.clients, entry];
      return store.putView({ ...v, clients, updatedAt: now.toISOString() });
    });
  });

  app.delete("/api/views/:id/clients/:clientId", async (req) =>
    store.tx(() => {
      const { clientId } = req.params as { clientId: string };
      const v = store.views.require(idOf(req));
      if (!v.clients.some((c) => c.id === clientId)) return v;
      return store.putView({
        ...v,
        clients: v.clients.filter((c) => c.id !== clientId),
        updatedAt: store.nowIso(),
      });
    }),
  );
}
