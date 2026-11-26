import {
  type Client,
  ClientBindingInput,
  type ClientMirror,
  ClientReport,
  parseClientId,
  SwitchyardError,
} from "@switchyard/protocol";
import type { FastifyInstance } from "fastify";
import type { CoordinatorContext } from "../context.js";
import { deviceOf, parse } from "../http.js";

/** A client that reported less than this ago is not rewritten (keeps the event log quiet). */
const CLIENT_REWRITE_MS = 5 * 60_000;

function sameIds(a: string[] | undefined, b: string[] | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** A binding with a scope that exists (an unknown scope is an error). */
function checkedBinding(
  ctx: CoordinatorContext,
  b: { mirror: ClientMirror; scopeId?: string | null },
): { mirror: ClientMirror; scopeId: string | null } {
  if (b.mirror !== "scope") return { mirror: b.mirror, scopeId: null };
  ctx.store.scopes.require(b.scopeId!);
  return { mirror: "scope", scopeId: b.scopeId! };
}

/**
 * Record a daemon's report (inside a transaction). The binding is never changed by a report,
 * except `seed`, which applies only to a client whose binding was never recorded. Unchanged
 * and recent reports write nothing.
 */
export function reportClient(
  ctx: CoordinatorContext,
  id: string,
  body: ClientReport,
  deviceId: string,
): Client {
  const { store } = ctx;
  if (id !== `${body.kind}:${body.name}@${body.machine}`) {
    throw new SwitchyardError(
      "invalid_request",
      "Client id does not match its kind, name and machine",
    );
  }
  return store.tx(() => {
    const existing = store.clients.get(id);
    const asked = body.hostId === undefined ? (existing?.hostId ?? null) : body.hostId;
    const hostId = asked && store.hosts.get(asked) ? asked : null;
    const now = store.now();
    let mirror: ClientMirror = existing?.mirror ?? "none";
    let scopeId = existing?.scopeId ?? null;
    let bindingSetAt = existing?.bindingSetAt ?? null;
    if (!bindingSetAt && body.seed) {
      const b = checkedBinding(ctx, body.seed);
      mirror = b.mirror;
      scopeId = b.scopeId;
      bindingSetAt = now.toISOString();
    }
    const shows = body.shows ?? existing?.shows ?? [];
    if (
      existing &&
      now.getTime() - Date.parse(existing.lastSeenAt) < CLIENT_REWRITE_MS &&
      existing.kind === body.kind &&
      existing.name === body.name &&
      existing.machine === body.machine &&
      existing.mirror === mirror &&
      existing.scopeId === scopeId &&
      (existing.bindingSetAt ?? null) === bindingSetAt &&
      sameIds(existing.shows, shows) &&
      existing.hostId === hostId &&
      existing.deviceId === deviceId
    ) {
      return existing;
    }
    return store.putClient({
      id,
      kind: body.kind,
      name: body.name,
      machine: body.machine,
      deviceId,
      hostId,
      mirror,
      scopeId,
      bindingSetAt,
      shows,
      lastSeenAt: now.toISOString(),
      createdAt: existing?.createdAt ?? now.toISOString(),
    });
  });
}

/** Record what a client mirrors (the CLI or the web app). A client not seen yet is created. */
export function bindClient(
  ctx: CoordinatorContext,
  id: string,
  input: ClientBindingInput,
  deviceId: string,
): Client {
  const { store } = ctx;
  const parts = parseClientId(id);
  if (!parts) {
    throw new SwitchyardError("invalid_request", "A client id is <kind>:<name>@<machine>");
  }
  return store.tx(() => {
    const b = checkedBinding(ctx, input);
    const existing = store.clients.get(id);
    const now = store.nowIso();
    return store.putClient({
      id,
      ...parts,
      deviceId: existing?.deviceId ?? deviceId,
      hostId: existing?.hostId ?? null,
      mirror: b.mirror,
      scopeId: b.scopeId,
      bindingSetAt: now,
      shows: existing?.shows ?? [],
      // A client recorded before its daemon ever reported is not open yet.
      lastSeenAt: existing?.lastSeenAt ?? new Date(0).toISOString(),
      createdAt: existing?.createdAt ?? now,
    });
  });
}

/** Clients: herdr and tmux sessions Switchyard knows about (see docs/clients.md). */
export function registerClientRoutes(app: FastifyInstance, ctx: CoordinatorContext): void {
  const { store } = ctx;
  const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;
  const list = () => store.clients.list(undefined, [], "created_at, rowid");

  app.get("/api/clients", async () => list());

  app.put("/api/clients/:id", async (req) => {
    const body = parse(ClientReport, req.body);
    return reportClient(ctx, idOf(req), body, deviceOf(req).id);
  });

  app.put("/api/clients/:id/binding", async (req) => {
    const body = parse(ClientBindingInput, req.body);
    return bindClient(ctx, idOf(req), body, deviceOf(req).id);
  });

  app.delete("/api/clients/:id", async (req) => {
    store.deleteClient(idOf(req));
    return { ok: true, id: idOf(req) };
  });
}
