import {
  AdapterActionRequest,
  CreateSessionRequest,
  ImportableSession,
  ImportSessionRequest,
  newId,
  PromptRequest,
  RenameRequest,
  type Session,
  SwitchyardError,
  TranscriptItem,
} from "@switchyard/protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CoordinatorContext } from "../context.js";
import { parse } from "../http.js";
import { returnToAutomation, stopSession, takeover } from "../sessions/control.js";
import {
  createSession,
  LIVE_RUNTIMES,
  requireConnected,
  requireUsableHost,
  resolveProfile,
  startOnHost,
} from "../sessions/service.js";

const ListQuery = z.object({
  projectId: z.string().optional(),
  hostId: z.string().optional(),
  includeArchived: z.enum(["true", "false"]).optional(),
});
const TranscriptQuery = z.object({
  before: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});
const AbortRequest = z.object({ clearQueue: z.boolean().default(false) });
const ImportableQuery = z.object({ hostId: z.string() });

function normalizeImportable(raw: unknown): ImportableSession[] {
  const list = Array.isArray(raw) ? raw : ((raw as { sessions?: unknown })?.sessions ?? []);
  return ImportableSession.array().parse(list);
}

export function registerSessionRoutes(app: FastifyInstance, ctx: CoordinatorContext): void {
  const get = (id: string) => ctx.store.sessions.require(id);
  const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;

  app.get("/api/sessions", async (req) => {
    const q = parse(ListQuery, req.query, "query");
    const where: string[] = [];
    const params: string[] = [];
    if (q.projectId) {
      where.push("project_id = ?");
      params.push(q.projectId);
    }
    if (q.hostId) {
      where.push("host_id = ?");
      params.push(q.hostId);
    }
    if (q.includeArchived !== "true") where.push("archived_at IS NULL");
    return ctx.store.sessions.list(
      where.join(" AND ") || undefined,
      params,
      "last_activity_at DESC",
    );
  });

  /** Inactive native Pi sessions on a host, marked when already imported. */
  app.get("/api/sessions/importable", async (req) => {
    const q = parse(ImportableQuery, req.query, "query");
    requireConnected(ctx, q.hostId);
    const list = normalizeImportable(
      await ctx.hostHub.request(q.hostId, { type: "session.importable" }),
    );
    return list.map((s) => ({
      ...s,
      importedSessionId: ctx.store.sessionByNativeFile(q.hostId, s.sessionFile)?.id ?? null,
    }));
  });

  /** Import an inactive native session: stopped, provenance imported, transcript from Pi. */
  app.post("/api/sessions/import", async (req, reply) => {
    const body = parse(ImportSessionRequest, req.body);
    requireConnected(ctx, body.hostId);
    const already = ctx.store.sessionByNativeFile(body.hostId, body.sessionFile);
    if (already) {
      throw new SwitchyardError("conflict", "This Pi session was already imported", {
        sessionId: already.id,
      });
    }
    const list = normalizeImportable(
      await ctx.hostHub.request(body.hostId, { type: "session.importable" }),
    );
    const native = list.find((s) => s.sessionFile === body.sessionFile);
    if (!native) throw new SwitchyardError("not_found", "Pi session file not found on host");
    if (!native.inactive) {
      throw new SwitchyardError(
        "conflict",
        "This Pi session is still active; close it in Pi before importing",
      );
    }
    const rawItems = await ctx.hostHub.request<unknown>(body.hostId, {
      type: "session.readNative",
      sessionFile: body.sessionFile,
    });
    const ws = ctx.store.workspaceByPath(body.hostId, native.cwd);
    const projectId = body.projectId ?? ws?.projectId ?? null;
    if (projectId) ctx.store.projects.require(projectId);
    const project = projectId ? ctx.store.projects.get(projectId) : null;
    const host = ctx.store.hosts.require(body.hostId);
    const now = ctx.store.nowIso();
    const id = newId("ses");
    const items = (
      Array.isArray(rawItems) ? rawItems : ((rawItems as { items?: unknown })?.items ?? [])
    ) as Record<string, unknown>[];
    const session: Session = {
      id,
      title: native.name ?? native.cwd.split("/").pop() ?? "Imported session",
      subtitle: null,
      hostId: body.hostId,
      workspaceId: ws && ws.projectId === projectId ? ws.id : null,
      projectId,
      cwd: native.cwd,
      nativeHandle: { sessionId: native.sessionId, sessionFile: native.sessionFile },
      profileSnapshot: resolveProfile(ctx, null, project),
      runtime: "stopped",
      runtimeDetail: null,
      connectivity: host.connectivity,
      runId: null,
      taskId: null,
      provenance: "imported",
      readOnly: false,
      lastActivityAt: native.mtime,
      archivedAt: null,
      queue: { steering: [], followUp: [] },
      stats: null,
      lastAssistantText: null,
      createdAt: now,
    };
    ctx.store.tx(() => {
      ctx.store.putSession(session);
      items.forEach((raw, i) => {
        const item = TranscriptItem.safeParse({
          ...raw,
          id: raw.id ?? newId("itm"),
          order: typeof raw.order === "number" ? raw.order : i,
          at: raw.at ?? native.mtime,
          sessionId: id,
        });
        if (item.success) ctx.store.upsertItem(item.data);
      });
    });
    return reply.code(201).send(session);
  });

  app.get("/api/sessions/:id", async (req) => get(idOf(req)));

  app.post("/api/sessions", async (req, reply) => {
    const body = parse(CreateSessionRequest, req.body);
    const { session } = createSession(ctx, body);
    return reply.code(202).send(session);
  });

  app.get("/api/sessions/:id/transcript", async (req) => {
    const s = get(idOf(req));
    const q = parse(TranscriptQuery, req.query, "query");
    return ctx.store.listItems(s.id, { before: q.before, limit: q.limit });
  });

  /** Current partial stream and pending interactions, from the host. */
  app.get("/api/sessions/:id/snapshot", async (req) => {
    const s = get(idOf(req));
    requireConnected(ctx, s.hostId);
    return ctx.hostHub.request(s.hostId, { type: "session.snapshot", sessionId: s.id });
  });

  app.post("/api/sessions/:id/prompt", async (req) => {
    const s = get(idOf(req));
    const body = parse(PromptRequest, req.body);
    if (s.readOnly) throw new SwitchyardError("forbidden", "Read-only subagent view");
    if (!LIVE_RUNTIMES.includes(s.runtime) || s.runtime === "starting") {
      throw new SwitchyardError(
        "conflict",
        s.runtime === "starting"
          ? "Session is still starting"
          : `Session ${s.runtime}: Resume to send`,
      );
    }
    requireConnected(ctx, s.hostId);
    const run = ctx.store.runForSession(s);
    const result = await ctx.hostHub.request(s.hostId, {
      type: "session.prompt",
      sessionId: s.id,
      text: body.text,
      images: body.images,
      mode: body.mode,
      origin: "human",
      controlRevision: run?.controlRevision ?? 1,
    });
    return {
      ok: true,
      clientMessageId: body.clientMessageId ?? null,
      result: result ?? null,
      automationActive: run?.controlMode === "automation",
    };
  });

  app.post("/api/sessions/:id/abort", async (req) => {
    const s = get(idOf(req));
    const body = parse(AbortRequest, req.body);
    requireConnected(ctx, s.hostId);
    await ctx.hostHub.request(s.hostId, {
      type: "session.abort",
      sessionId: s.id,
      clearQueue: body.clearQueue,
    });
    return { ok: true };
  });

  app.post("/api/sessions/:id/stop", async (req) => {
    const s = get(idOf(req));
    requireConnected(ctx, s.hostId);
    return stopSession(ctx, s.id);
  });

  app.post("/api/sessions/:id/takeover", async (req) => takeover(ctx, idOf(req)));
  app.post("/api/sessions/:id/return-to-automation", async (req) =>
    returnToAutomation(ctx, idOf(req)),
  );

  /** Resume with `--session <file>`; refuses without a native handle. */
  app.post("/api/sessions/:id/resume", async (req) => {
    const s = get(idOf(req));
    if (!s.nativeHandle) {
      throw new SwitchyardError(
        "native_session_missing",
        "This session has no native Pi session to resume",
      );
    }
    if (LIVE_RUNTIMES.includes(s.runtime)) {
      throw new SwitchyardError("conflict", `Session is already ${s.runtime}`);
    }
    if (s.readOnly) throw new SwitchyardError("forbidden", "Read-only subagent view");
    requireUsableHost(ctx, s.hostId);
    const prev = s.runtime;
    const starting = ctx.store.putSession({ ...s, runtime: "starting", runtimeDetail: null });
    const run = ctx.store.runForSession(s);
    try {
      await startOnHost(ctx, starting, {
        initialPrompt: null,
        nativeHandle: s.nativeHandle,
        controlRevision: run?.controlRevision ?? 1,
        controlMode: run?.controlMode ?? "human",
      });
    } catch (err) {
      ctx.store.tx(() => {
        const cur = ctx.store.sessions.require(s.id);
        if (cur.runtime === "starting") {
          ctx.store.putSession({
            ...cur,
            runtime: prev,
            runtimeDetail: err instanceof Error ? err.message : String(err),
          });
        }
      });
      throw err;
    }
    return get(s.id);
  });

  app.post("/api/sessions/:id/rename", async (req) => {
    const s = get(idOf(req));
    const body = parse(RenameRequest, req.body);
    if (LIVE_RUNTIMES.includes(s.runtime) && s.runtime !== "starting") {
      requireConnected(ctx, s.hostId);
      await ctx.hostHub.request(s.hostId, {
        type: "session.rename",
        sessionId: s.id,
        title: body.title,
      });
    }
    return ctx.store.tx(() => {
      const cur = ctx.store.sessions.require(s.id);
      return ctx.store.putSession({ ...cur, title: body.title });
    });
  });

  /** Archive. Stops an idle Pi process first; refuses while running. */
  app.post("/api/sessions/:id/archive", async (req) => {
    const s = get(idOf(req));
    if (s.runtime === "running" || s.runtime === "waiting_input") {
      throw new SwitchyardError("conflict", "Stop the session before archiving it");
    }
    if ((s.runtime === "idle" || s.runtime === "starting") && ctx.hostHub.isConnected(s.hostId)) {
      await ctx.hostHub.request(s.hostId, { type: "session.stop", sessionId: s.id });
    }
    return ctx.store.tx(() => {
      const cur = ctx.store.sessions.require(s.id);
      return ctx.store.putSession({ ...cur, archivedAt: cur.archivedAt ?? ctx.store.nowIso() });
    });
  });

  app.post("/api/sessions/:id/unarchive", async (req) =>
    ctx.store.tx(() => {
      const cur = get(idOf(req));
      return ctx.store.putSession({ ...cur, archivedAt: null });
    }),
  );

  /** Adapter action passthrough (panel/card buttons). */
  app.post("/api/sessions/:id/adapter-action", async (req) => {
    const s = get(idOf(req));
    const body = parse(AdapterActionRequest, req.body);
    requireConnected(ctx, s.hostId);
    const result = await ctx.hostHub.request(s.hostId, {
      type: "session.adapterAction",
      sessionId: s.id,
      adapterId: body.adapterId,
      actionId: body.actionId,
      payload: body.payload ?? null,
    });
    return { ok: true, result: result ?? null };
  });
}
