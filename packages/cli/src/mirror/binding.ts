import type {
  Client,
  ClientBindingInput,
  ClientKind,
  ClientReport,
  Scope,
} from "@switchyard/protocol";
import { findScope } from "@switchyard/protocol";
import { type ApiClient, ApiRequestError } from "@switchyard/terminal";
import type { Env } from "../paths.js";
import type { MirrorState } from "./state.js";

/**
 * What a daemon mirrors: a scope, `null` for every session, or "off" (nothing: the daemon touches
 * nothing in its client).
 */
export type Bound = Scope | null | "off";

/** A herdr or tmux session as a Switchyard client. */
export interface ClientInfo {
  /** `${kind}:${name}@${machine}` */
  id: string;
  kind: ClientKind;
  name: string;
  machine: string;
  /** The host agent on this machine, when it is enrolled with the same coordinator. */
  hostId: string | null;
}

export function clientId(kind: ClientKind, name: string, machine: string): string {
  return `${kind}:${name}@${machine}`;
}

/** The recorded binding of a client in synced state; "off" when it has none or its scope is gone. */
export function recordedBinding(st: Pick<MirrorState, "scopes" | "clients">, id: string): Bound {
  const t = st.clients?.find((x) => x.id === id);
  if (!t) return "off";
  if (t.mirror === "all") return null;
  if (t.mirror === "scope") return st.scopes.find((v) => v.id === t.scopeId) ?? "off";
  return "off";
}

/**
 * The binding to record for a client that never had one, from how 0.19 bound it: its env
 * file's `SWITCHYARD_VIEW`, else the scope named after it, but only when it was mirroring (it owns
 * spaces or windows). Undefined while `SWITCHYARD_VIEW` names a scope that does not exist yet.
 */
export function seedBinding(
  env: Env,
  name: string,
  st: Pick<MirrorState, "scopes">,
  wasMirroring: boolean,
): ClientBindingInput | undefined {
  const ref = env.SWITCHYARD_VIEW?.trim();
  if (ref) {
    const v = findScope(st.scopes, ref);
    return v ? { mirror: "scope", scopeId: v.id } : undefined;
  }
  const named = wasMirroring ? findScope(st.scopes, name) : null;
  return named ? { mirror: "scope", scopeId: named.id } : { mirror: "none" };
}

/** For a one-shot command (the new-session picker): the recorded binding, else `SWITCHYARD_VIEW`. */
export function pickerBinding(
  st: Pick<MirrorState, "scopes" | "clients">,
  env: Env,
  id: string,
): Bound {
  if (st.clients?.some((t) => t.id === id)) return recordedBinding(st, id);
  const ref = env.SWITCHYARD_VIEW?.trim();
  return (ref && findScope(st.scopes, ref)) || "off";
}

/**
 * After starting a session from a bound client: the coordinator pins it to the scope only when
 * the scope would not show it otherwise. Say so, or return null when it was not pinned.
 */
export async function pinNote(
  api: Pick<ApiClient, "get">,
  scope: Pick<Scope, "id">,
  sessionId: string,
): Promise<string | null> {
  const scopes = await api.get<Scope[]>("/api/scopes").catch(() => null);
  const v = scopes?.find((x) => x.id === scope.id);
  if (!v?.sessionIds.includes(sessionId)) return null;
  return `Pinned to scope "${v.name}": it would not show there otherwise. Unpin it from the session menu.`;
}

export function offMessage(kind: ClientKind, id: string): string {
  return `This ${kind} session mirrors nothing. Choose what it shows with: switchyard clients bind ${id} --all (or --scope <name>)`;
}

const EVERY_MS = 60_000;

/** A 404 for a route the coordinator does not have (not a missing entity). */
export function isUnknownRoute(err: unknown): boolean {
  return err instanceof ApiRequestError && err.status === 404 && /^No route /.test(err.message);
}

export interface ClientSync {
  /** What to mirror now. */
  binding(): Bound;
  /** Report now (after `shows` changed). */
  report(): void;
  stop(): Promise<void>;
}

/**
 * Register this client with the coordinator and report it every minute (and on `report()`),
 * seeding its binding once from how it was bound before. The binding is read from synced state.
 * A coordinator older than this CLI has no clients: it is said once, and nothing is mirrored.
 */
export function syncClient(opts: {
  api: ApiClient;
  info: ClientInfo;
  state: () => Pick<MirrorState, "scopes" | "clients"> | null;
  subscribe: (fn: () => void) => () => void;
  env: Env;
  /** Whether it was mirroring under 0.19 (owns spaces or windows). */
  wasMirroring: boolean;
  /** Sessions in its mirror tabs or windows. */
  shows?: () => string[] | undefined;
  log: (line: string) => void;
}): ClientSync {
  const { api, info, log } = opts;
  const path = `/api/clients/${encodeURIComponent(info.id)}`;
  let mode: "unknown" | "clients" | "unsupported" = "unknown";
  let lastError = "";
  let lastShows = "";
  let warned = "";
  let stopped = false;

  const warnIgnoredEnv = (st: Pick<MirrorState, "scopes" | "clients">) => {
    const ref = opts.env.SWITCHYARD_VIEW?.trim();
    const t = st.clients?.find((x) => x.id === info.id);
    if (!ref || !t?.bindingSetAt) return;
    const want = findScope(st.scopes, ref);
    const same = t.mirror === "scope" && want?.id === t.scopeId;
    const key = `${ref}|${t.mirror}|${t.scopeId}`;
    if (same || warned === key) return;
    warned = key;
    log(
      `SWITCHYARD_VIEW=${ref} is ignored: this client's recorded binding wins (switchyard clients bind ${info.id} ...)`,
    );
  };

  let inflight = false;
  let again = false;
  const send = async (): Promise<void> => {
    if (stopped || mode === "unsupported") return;
    if (inflight) {
      again = true;
      return;
    }
    inflight = true;
    try {
      await sendOnce();
    } finally {
      inflight = false;
    }
    if (again) {
      again = false;
      await send();
    }
  };

  const sendOnce = async () => {
    const st = opts.state();
    if (!st) return;
    const recorded = st.clients?.find((x) => x.id === info.id);
    const shows = opts.shows?.();
    const body: ClientReport = {
      kind: info.kind,
      name: info.name,
      machine: info.machine,
      hostId: info.hostId,
      ...(shows ? { shows } : {}),
    };
    if (!recorded?.bindingSetAt) {
      const seed = seedBinding(opts.env, info.name, st, opts.wasMirroring);
      if (seed) body.seed = seed;
    }
    try {
      const t = await api.request<Client>("PUT", path, body);
      if (mode !== "clients") {
        mode = "clients";
        log(`client ${info.id} mirrors ${describe(t)}`);
      }
      lastShows = JSON.stringify(shows ?? null);
      lastError = "";
      warnIgnoredEnv(st);
    } catch (err) {
      if (mode === "unknown" && isUnknownRoute(err)) {
        mode = "unsupported";
        log("this coordinator is older than this CLI (it has no clients): upgrade the coordinator");
        return;
      }
      const m = (err as Error).message;
      if (m !== lastError) log(`client report failed: ${m}`);
      lastError = m;
    }
  };

  let lastBinding = "";
  const off = opts.subscribe(() => {
    if (mode === "unsupported") return;
    const st = opts.state();
    if (!st) return;
    if (mode === "unknown") void send();
    const t = st.clients?.find((x) => x.id === info.id);
    const now = t ? describe(t) : "";
    if (t && lastBinding && now !== lastBinding) log(`client ${info.id} now mirrors ${now}`);
    if (t) lastBinding = now;
  });
  void send();
  const timer = setInterval(() => void send(), EVERY_MS);
  timer.unref?.();
  return {
    binding() {
      if (mode === "unsupported") return "off";
      const st = opts.state();
      return st ? recordedBinding(st, info.id) : "off";
    },
    report() {
      if (JSON.stringify(opts.shows?.() ?? null) !== lastShows) void send();
    },
    async stop() {
      stopped = true;
      off();
      clearInterval(timer);
    },
  };
}

function describe(t: Client): string {
  return t.mirror === "scope"
    ? `scope ${t.scopeId}`
    : t.mirror === "all"
      ? "everything"
      : "nothing";
}
