import {
  type GitHubSource,
  GitHubSourceInput,
  newId,
  type Scope,
  ScopeInput,
  ScopePatch,
  Scope as ScopeSchema,
  SwitchyardError,
} from "@switchyard/protocol";
import type { FastifyInstance } from "fastify";
import type { CoordinatorContext } from "../context.js";
import { parse } from "../http.js";
import { projectIdsFor } from "../scope-sources.js";
import { requireService } from "../services.js";

function defined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Pin a session to a scope (membership only). An archived session cannot be pinned. */
export function pinSession(ctx: CoordinatorContext, scopeId: string, sessionId: string): Scope {
  const { store } = ctx;
  return store.tx(() => {
    const v = store.scopes.require(scopeId);
    const session = store.sessions.require(sessionId);
    if (v.sessionIds.includes(sessionId)) return v;
    if (session.archivedAt)
      throw new SwitchyardError("conflict", "Unarchive this session before pinning it");
    return store.putScope({
      ...v,
      sessionIds: [...v.sessionIds, sessionId],
      updatedAt: store.nowIso(),
    });
  });
}

export function unpinSession(ctx: CoordinatorContext, scopeId: string, sessionId: string): Scope {
  const { store } = ctx;
  return store.tx(() => {
    const v = store.scopes.require(scopeId);
    if (!v.sessionIds.includes(sessionId)) return v;
    return store.putScope({
      ...v,
      sessionIds: v.sessionIds.filter((s) => s !== sessionId),
      updatedAt: store.nowIso(),
    });
  });
}

/** A new source as stored: the input's fields, not synced yet. */
function newSource(input: GitHubSourceInput): GitHubSource {
  const parsed = GitHubSourceInput.parse(input);
  return { kind: "github", ...parsed, login: null, lastSyncedAt: null, lastError: null };
}

/** Scopes: named parts of your work, optionally fed by a GitHub source (see docs/scopes.md). */
export function registerScopeRoutes(app: FastifyInstance, ctx: CoordinatorContext): void {
  const { store } = ctx;
  const service = () => requireService(ctx, "scopeSources");
  const checkName = (name: string, exceptId?: string) => {
    const taken = store.scopes
      .list()
      .some((v) => v.id !== exceptId && v.name.toLowerCase() === name.toLowerCase());
    if (taken) throw new SwitchyardError("conflict", `A scope named ${name} exists`);
  };
  const checkSource = (source: GitHubSource) => {
    store.hosts.require(source.hostId);
    if (source.follow === "board" && !source.board)
      throw new SwitchyardError("invalid_request", "Following a board needs a board number");
  };
  const syncSoon = (scopeId: string) => {
    void service()
      .sync(scopeId)
      .catch((err: unknown) => ctx.log.warn({ err, scopeId }, "scope sync failed"));
  };
  const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;
  const keptByGitHub = () =>
    new SwitchyardError("conflict", "This scope's projects are kept by GitHub");

  app.get("/api/scopes", async () => store.scopes.list(undefined, [], "created_at, rowid"));

  app.post("/api/scopes", async (req, reply) => {
    const body = parse(ScopeInput, req.body);
    const created = store.tx(() => {
      checkName(body.name);
      const now = store.nowIso();
      const source = body.source ? newSource(body.source) : null;
      if (source) checkSource(source);
      return store.putScope(
        ScopeSchema.parse({
          id: newId("scp"),
          name: body.name,
          mode: body.mode ?? "all",
          projectIds: source
            ? projectIdsFor(source, store.projects.list())
            : (body.projectIds ?? null),
          hostIds: body.hostIds ?? null,
          sessionIds: [],
          source,
          createdAt: now,
          updatedAt: now,
        }),
      );
    });
    if (created.source) syncSoon(created.id);
    return reply.code(201).send(created);
  });

  app.patch("/api/scopes/:id", async (req) => {
    const body = parse(ScopePatch, req.body);
    let added = false;
    const next = store.tx(() => {
      const cur = store.scopes.require(idOf(req));
      if (body.name !== undefined) checkName(body.name, cur.id);
      let source = cur.source;
      if (body.source === null) {
        if (cur.source) {
          for (const i of store.issues.list("scope_id = ?", [cur.id])) store.deleteIssue(i);
        }
        source = null;
      } else if (body.source !== undefined) {
        if (cur.source) {
          source = { ...cur.source, ...defined(body.source) };
        } else {
          const input = GitHubSourceInput.safeParse(body.source);
          if (!input.success)
            throw new SwitchyardError(
              "invalid_request",
              "A GitHub source needs a host and an owner",
            );
          source = newSource(input.data);
          added = true;
        }
        checkSource(source);
      }
      if (source && body.projectIds !== undefined) throw keptByGitHub();
      const { source: _source, ...fields } = body;
      return store.putScope(
        ScopeSchema.parse({
          ...cur,
          ...defined(fields),
          ...(source && body.source !== undefined
            ? { projectIds: projectIdsFor(source, store.projects.list()) }
            : {}),
          source,
          id: cur.id,
          updatedAt: store.nowIso(),
        }),
      );
    });
    if (added) syncSoon(next.id);
    return next;
  });

  app.delete("/api/scopes/:id", async (req) =>
    store.tx(() => {
      const v = store.scopes.require(idOf(req));
      // Its clients mirror nothing (never everything) until they are bound again.
      for (const x of store.clients.list("scope_id = ?", [v.id])) {
        store.putClient({ ...x, mirror: "none", scopeId: null });
      }
      for (const i of store.issues.list("scope_id = ?", [v.id])) store.deleteIssue(i);
      store.deleteScope(v.id);
      return { ok: true, id: v.id };
    }),
  );

  app.post("/api/scopes/:id/sessions/:sessionId", async (req) =>
    pinSession(ctx, idOf(req), (req.params as { sessionId: string }).sessionId),
  );

  app.delete("/api/scopes/:id/sessions/:sessionId", async (req) =>
    unpinSession(ctx, idOf(req), (req.params as { sessionId: string }).sessionId),
  );

  app.post("/api/scopes/:id/sync", async (req) => {
    store.scopes.require(idOf(req));
    return service().sync(idOf(req));
  });
}
