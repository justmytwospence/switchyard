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
import { deviceOf, parse } from "../http.js";
import { reportTerminal } from "./terminals.js";

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
      if (cur.trackerId && body.projectIds !== undefined) {
        throw new SwitchyardError("conflict", "This view's projects are managed by its tracker");
      }
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
      // Its terminals mirror nothing (never everything) until they are bound again.
      for (const x of store.terminals.list("view_id = ?", [v.id])) {
        store.putTerminal({ ...x, mirror: "none", viewId: null });
      }
      store.deleteView(v.id);
      return { ok: true, id: v.id };
    }),
  );

  app.post("/api/views/:id/sessions/:sessionId", async (req) =>
    store.tx(() => {
      const { sessionId } = req.params as { sessionId: string };
      const v = store.views.require(idOf(req));
      const session = store.sessions.require(sessionId);
      if (v.sessionIds.includes(sessionId)) return v;
      if (session.archivedAt)
        throw new SwitchyardError("conflict", "Unarchive this session before pinning it");
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

  // Legacy (CLI 0.17 mirrors): a client report is a terminal report seeding this view.
  app.post("/api/views/:id/clients", async (req) => {
    const body = parse(ViewClientReport, req.body);
    return store.tx((): View => {
      const v = store.views.require(idOf(req));
      reportTerminal(
        ctx,
        body.id,
        {
          kind: body.kind,
          name: body.name,
          machine: body.machine,
          seed: { mirror: "view", viewId: v.id },
        },
        deviceOf(req).id,
      );
      return v;
    });
  });

  // Withdrawing no longer forgets the terminal or its binding.
  app.delete("/api/views/:id/clients/:clientId", async (req) => store.views.require(idOf(req)));
}
