import { ClientBindingInput, ClientReport, hasSource } from "@switchyard/protocol";
import type { FastifyInstance } from "fastify";
import type { CoordinatorContext } from "../context.js";
import { deviceOf, parse } from "../http.js";
import {
  fromLegacyBinding,
  LegacyBinding,
  LegacyReport,
  legacyTerminal,
  legacyTracker,
  legacyView,
} from "../legacy.js";
import { bindClient, reportClient } from "./clients.js";
import { pinSession, unpinSession } from "./scopes.js";

/**
 * COMPAT(scopes-rename): remove after 2027-03-01.
 *
 * What a running 0.20 daemon or an open 0.20 browser tab reads and reports: views, trackers and
 * terminals as lists, a terminal's report, binding and removal, and pins. Creating or editing
 * views and trackers needs a 0.21 client.
 */
export function registerLegacyRoutes(app: FastifyInstance, ctx: CoordinatorContext): void {
  const { store } = ctx;
  const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;
  const sessionOf = (req: { params: unknown }) => (req.params as { sessionId: string }).sessionId;
  const scopes = () => store.scopes.list(undefined, [], "created_at, rowid");

  app.get("/api/views", async () => scopes().map(legacyView));

  app.get("/api/trackers", async () => scopes().filter(hasSource).map(legacyTracker));

  app.get("/api/terminals", async () =>
    store.clients.list(undefined, [], "created_at, rowid").map(legacyTerminal),
  );

  app.put("/api/terminals/:id", async (req) => {
    const body = parse(LegacyReport, req.body);
    const { seed, ...rest } = body;
    const report = parse(ClientReport, {
      ...rest,
      ...(seed ? { seed: fromLegacyBinding(seed) } : {}),
    });
    return legacyTerminal(reportClient(ctx, idOf(req), report, deviceOf(req).id));
  });

  app.put("/api/terminals/:id/binding", async (req) => {
    const body = parse(LegacyBinding, req.body);
    const binding = parse(ClientBindingInput, fromLegacyBinding(body));
    return legacyTerminal(bindClient(ctx, idOf(req), binding, deviceOf(req).id));
  });

  app.delete("/api/terminals/:id", async (req) => {
    store.deleteClient(idOf(req));
    return { ok: true, id: idOf(req) };
  });

  app.post("/api/views/:id/sessions/:sessionId", async (req) =>
    legacyView(pinSession(ctx, idOf(req), sessionOf(req))),
  );

  app.delete("/api/views/:id/sessions/:sessionId", async (req) =>
    legacyView(unpinSession(ctx, idOf(req), sessionOf(req))),
  );
}
