import {
  SurfaceReport,
  SwitchyardError,
  type Terminal,
  TerminalBindingInput,
  type TerminalKind,
  type TerminalMirror,
  TerminalReport,
  terminalMirror,
} from "@switchyard/protocol";
import type { FastifyInstance } from "fastify";
import type { CoordinatorContext } from "../context.js";
import { deviceOf, parse } from "../http.js";

/** A terminal that reported less than this ago is not rewritten (keeps the event log quiet). */
const TERMINAL_REWRITE_MS = 5 * 60_000;

/** `<kind>:<name>@<machine>` split into its parts, or null. */
export function parseTerminalId(
  id: string,
): { kind: TerminalKind; name: string; machine: string } | null {
  const m = /^(herdr|tmux):(.+)@([^@]+)$/.exec(id);
  return m ? { kind: m[1] as TerminalKind, name: m[2]!, machine: m[3]! } : null;
}

function sameIds(a: string[] | undefined, b: string[] | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** A binding with a view that exists (an unknown view is an error). */
function checkedBinding(
  ctx: CoordinatorContext,
  b: { mirror: TerminalMirror; viewId?: string | null },
): { mirror: TerminalMirror; viewId: string | null } {
  if (b.mirror !== "view") return { mirror: b.mirror, viewId: null };
  ctx.store.views.require(b.viewId!);
  return { mirror: "view", viewId: b.viewId! };
}

/**
 * Record a daemon's report (inside a transaction). The binding is never changed by a report,
 * except `seed`, which applies only to a terminal whose binding was never recorded. Unchanged
 * and recent reports write nothing.
 */
export function reportTerminal(
  ctx: CoordinatorContext,
  id: string,
  body: TerminalReport,
  deviceId: string,
): Terminal {
  const { store } = ctx;
  if (id !== `${body.kind}:${body.name}@${body.machine}`) {
    throw new SwitchyardError(
      "invalid_request",
      "Terminal id does not match its kind, name and machine",
    );
  }
  return store.tx(() => {
    const existing = store.terminals.get(id);
    const asked = body.hostId === undefined ? (existing?.hostId ?? null) : body.hostId;
    const hostId = asked && store.hosts.get(asked) ? asked : null;
    const now = store.now();
    let mirror: TerminalMirror = existing ? terminalMirror(existing) : "none";
    let viewId = existing?.viewId ?? null;
    let bindingSetAt = existing?.bindingSetAt ?? null;
    if (!bindingSetAt && body.seed) {
      const b = checkedBinding(ctx, body.seed);
      mirror = b.mirror;
      viewId = b.viewId;
      bindingSetAt = now.toISOString();
    }
    const shows = body.shows ?? existing?.shows ?? [];
    if (
      existing &&
      now.getTime() - Date.parse(existing.lastSeenAt) < TERMINAL_REWRITE_MS &&
      existing.kind === body.kind &&
      existing.name === body.name &&
      existing.machine === body.machine &&
      existing.mirror === mirror &&
      existing.viewId === viewId &&
      (existing.bindingSetAt ?? null) === bindingSetAt &&
      sameIds(existing.shows, shows) &&
      existing.hostId === hostId &&
      existing.deviceId === deviceId
    ) {
      return existing;
    }
    return store.putTerminal({
      id,
      kind: body.kind,
      name: body.name,
      machine: body.machine,
      deviceId,
      hostId,
      mirror,
      viewId,
      bindingSetAt,
      shows,
      lastSeenAt: now.toISOString(),
      createdAt: existing?.createdAt ?? now.toISOString(),
    });
  });
}

/** Record what a terminal mirrors (the CLI or the web app). A terminal not seen yet is created. */
export function bindTerminal(
  ctx: CoordinatorContext,
  id: string,
  input: TerminalBindingInput,
  deviceId: string,
): Terminal {
  const { store } = ctx;
  const parts = parseTerminalId(id);
  if (!parts) {
    throw new SwitchyardError("invalid_request", "A terminal id is <herdr|tmux>:<name>@<machine>");
  }
  return store.tx(() => {
    const b = checkedBinding(ctx, input);
    const existing = store.terminals.get(id);
    const now = store.nowIso();
    return store.putTerminal({
      id,
      ...parts,
      deviceId: existing?.deviceId ?? deviceId,
      hostId: existing?.hostId ?? null,
      mirror: b.mirror,
      viewId: b.viewId,
      bindingSetAt: now,
      shows: existing?.shows ?? [],
      // A terminal recorded before its daemon ever reported is not open yet.
      lastSeenAt: existing?.lastSeenAt ?? new Date(0).toISOString(),
      createdAt: existing?.createdAt ?? now,
    });
  });
}

/** A terminal as a 0.19 CLI reads a surface: `viewId` only when it mirrors a view. */
function asSurface(t: Terminal): Terminal {
  return { ...t, viewId: terminalMirror(t) === "view" ? t.viewId : null };
}

/** Terminals: herdr and tmux sessions Switchyard knows about (see docs/terminal-sessions.md). */
export function registerTerminalRoutes(app: FastifyInstance, ctx: CoordinatorContext): void {
  const { store } = ctx;
  const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;
  const list = () => store.terminals.list(undefined, [], "created_at, rowid");

  app.get("/api/terminals", async () => list());

  app.put("/api/terminals/:id", async (req) => {
    const body = parse(TerminalReport, req.body);
    return reportTerminal(ctx, idOf(req), body, deviceOf(req).id);
  });

  app.put("/api/terminals/:id/binding", async (req) => {
    const body = parse(TerminalBindingInput, req.body);
    return bindTerminal(ctx, idOf(req), body, deviceOf(req).id);
  });

  app.delete("/api/terminals/:id", async (req) => {
    store.deleteTerminal(idOf(req));
    return { ok: true, id: idOf(req) };
  });

  // Legacy (CLI 0.19 mirrors). A report seeds the binding of a terminal that has none recorded;
  // withdrawing a surface no longer forgets the terminal.
  app.get("/api/surfaces", async () => list().map(asSurface));

  app.put("/api/surfaces/:id", async (req) => {
    const body = parse(SurfaceReport, req.body);
    const t = reportTerminal(
      ctx,
      idOf(req),
      {
        kind: body.kind,
        name: body.name,
        machine: body.machine,
        ...(body.hostId !== undefined ? { hostId: body.hostId } : {}),
        ...(body.viewId ? { seed: { mirror: "view" as const, viewId: body.viewId } } : {}),
      },
      deviceOf(req).id,
    );
    return asSurface(t);
  });

  app.delete("/api/surfaces/:id", async (req) => ({ ok: true, id: idOf(req) }));
}
