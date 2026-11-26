import type {
  Terminal,
  TerminalBindingInput,
  TerminalKind,
  TerminalReport,
  View,
} from "@switchyard/protocol";
import { findView, terminalMirror } from "@switchyard/protocol";
import { type ApiClient, ApiRequestError } from "@switchyard/terminal";
import type { Env } from "../paths.js";
import { startPresence } from "./presence.js";
import type { MirrorState } from "./state.js";

/**
 * What a daemon mirrors: a view, `null` for every session, or "off" (nothing: the daemon touches
 * nothing in its terminal).
 */
export type Bound = View | null | "off";

/** A herdr or tmux session as a Switchyard terminal. */
export interface TerminalInfo {
  /** `${kind}:${name}@${machine}` */
  id: string;
  kind: TerminalKind;
  name: string;
  machine: string;
  /** The host agent on this machine, when it is enrolled with the same coordinator. */
  hostId: string | null;
}

export function terminalId(kind: TerminalKind, name: string, machine: string): string {
  return `${kind}:${name}@${machine}`;
}

/** The recorded binding of a terminal in synced state; "off" when it has none or its view is gone. */
export function recordedBinding(st: Pick<MirrorState, "views" | "terminals">, id: string): Bound {
  const t = st.terminals?.find((x) => x.id === id);
  if (!t) return "off";
  const mirror = terminalMirror(t);
  if (mirror === "all") return null;
  if (mirror === "view") return st.views.find((v) => v.id === t.viewId) ?? "off";
  return "off";
}

/**
 * The binding to record for a terminal that never had one, from how 0.19 bound it: its env
 * file's `SWITCHYARD_VIEW`, else the view named after it, but only when it was mirroring (it owns
 * spaces or windows). Undefined while `SWITCHYARD_VIEW` names a view that does not exist yet.
 */
export function seedBinding(
  env: Env,
  name: string,
  st: Pick<MirrorState, "views">,
  wasMirroring: boolean,
): TerminalBindingInput | undefined {
  const ref = env.SWITCHYARD_VIEW?.trim();
  if (ref) {
    const v = findView(st.views, ref);
    return v ? { mirror: "view", viewId: v.id } : undefined;
  }
  const named = wasMirroring ? findView(st.views, name) : null;
  return named ? { mirror: "view", viewId: named.id } : { mirror: "none" };
}

/** 0.19's binding, for a coordinator without terminals: `SWITCHYARD_VIEW`, else the view named after the session. */
export function legacyBinding(st: Pick<MirrorState, "views">, env: Env, name: string): Bound {
  return findView(st.views, env.SWITCHYARD_VIEW?.trim() || name) ?? "off";
}

/** For a one-shot command (the new-session picker): the recorded binding, else `SWITCHYARD_VIEW`. */
export function pickerBinding(
  st: Pick<MirrorState, "views" | "terminals">,
  env: Env,
  id: string,
): Bound {
  if (st.terminals?.some((t) => t.id === id)) return recordedBinding(st, id);
  const ref = env.SWITCHYARD_VIEW?.trim();
  return (ref && findView(st.views, ref)) || "off";
}

/**
 * After starting a session from a bound terminal: the coordinator pins it to the view only when
 * the view would not show it otherwise. Say so, or return null when it was not pinned.
 */
export async function pinNote(
  api: Pick<ApiClient, "get">,
  view: Pick<View, "id">,
  sessionId: string,
): Promise<string | null> {
  const views = await api.get<View[]>("/api/views").catch(() => null);
  const v = views?.find((x) => x.id === view.id);
  if (!v?.sessionIds.includes(sessionId)) return null;
  return `Pinned to view "${v.name}": it would not show there otherwise. Unpin it from the session menu.`;
}

export function offMessage(kind: TerminalKind, id: string): string {
  return `This ${kind} session mirrors nothing. Choose what it shows with: switchyard terminals bind ${id} --all (or --view <name>)`;
}

const EVERY_MS = 60_000;

/** A 404 for a route the coordinator does not have (not a missing entity). */
function unknownRoute(err: unknown): boolean {
  return err instanceof ApiRequestError && err.status === 404 && /^No route /.test(err.message);
}

export interface TerminalSync {
  /** What to mirror now. */
  binding(): Bound;
  /** Report now (after `shows` changed). */
  report(): void;
  stop(): Promise<void>;
}

/**
 * Register this terminal with the coordinator and report it every minute (and on `report()`),
 * seeding its binding once from how it was bound before. The binding is read from synced state.
 * Against a coordinator without terminals it falls back to 0.19's surface presence and binding.
 */
export function syncTerminal(opts: {
  api: ApiClient;
  info: TerminalInfo;
  state: () => Pick<MirrorState, "views" | "terminals"> | null;
  subscribe: (fn: () => void) => () => void;
  env: Env;
  /** Whether it was mirroring under 0.19 (owns spaces or windows). */
  wasMirroring: boolean;
  /** Sessions in its mirror tabs or windows. */
  shows?: () => string[];
  /** The name 0.19 would look a view up by (tmux: the current session name). */
  legacyName?: () => string;
  log: (line: string) => void;
}): TerminalSync {
  const { api, info, log } = opts;
  const path = `/api/terminals/${encodeURIComponent(info.id)}`;
  let mode: "unknown" | "terminals" | "legacy" = "unknown";
  let lastError = "";
  let lastShows = "";
  let warned = "";
  let stopped = false;
  let legacy: { viewId: string; stop(): Promise<void> } | null = null;

  const legacyBound = (): Bound => {
    const st = opts.state();
    return st ? legacyBinding(st, opts.env, opts.legacyName?.() ?? info.name) : "off";
  };
  const followLegacy = () => {
    const v = legacyBound();
    const id = v && v !== "off" ? v.id : null;
    if (id === (legacy?.viewId ?? null)) return;
    const old = legacy;
    legacy = null;
    if (old) void old.stop();
    if (id) {
      const p = startPresence(api, info, id, log);
      legacy = { viewId: id, stop: p.stop };
    }
  };

  const warnIgnoredEnv = (st: Pick<MirrorState, "views" | "terminals">) => {
    const ref = opts.env.SWITCHYARD_VIEW?.trim();
    const t = st.terminals?.find((x) => x.id === info.id);
    if (!ref || !t?.bindingSetAt) return;
    const want = findView(st.views, ref);
    const same = terminalMirror(t) === "view" && want?.id === t.viewId;
    const key = `${ref}|${t.mirror}|${t.viewId}`;
    if (same || warned === key) return;
    warned = key;
    log(
      `SWITCHYARD_VIEW=${ref} is ignored: this terminal's recorded binding wins (switchyard terminals bind ${info.id} ...)`,
    );
  };

  let inflight = false;
  let again = false;
  const send = async (): Promise<void> => {
    if (stopped || mode === "legacy") return;
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
    const recorded = st.terminals?.find((x) => x.id === info.id);
    const shows = opts.shows?.();
    const body: TerminalReport = {
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
      const t = await api.request<Terminal>("PUT", path, body);
      if (mode !== "terminals") {
        mode = "terminals";
        log(`terminal ${info.id} mirrors ${describe(t)}`);
      }
      lastShows = JSON.stringify(shows ?? null);
      lastError = "";
      warnIgnoredEnv(st);
    } catch (err) {
      if (mode === "unknown" && unknownRoute(err)) {
        mode = "legacy";
        log("this coordinator has no terminals; binding by SWITCHYARD_VIEW or the session's name");
        followLegacy();
        return;
      }
      const m = (err as Error).message;
      if (m !== lastError) log(`terminal report failed: ${m}`);
      lastError = m;
    }
  };

  let lastBinding = "";
  const off = opts.subscribe(() => {
    if (mode === "legacy") return followLegacy();
    const st = opts.state();
    if (!st) return;
    if (mode === "unknown") void send();
    const t = st.terminals?.find((x) => x.id === info.id);
    const now = t ? describe(t) : "";
    if (t && lastBinding && now !== lastBinding) log(`terminal ${info.id} now mirrors ${now}`);
    if (t) lastBinding = now;
  });
  void send();
  const timer = setInterval(() => void send(), EVERY_MS);
  timer.unref?.();
  return {
    binding() {
      if (mode === "legacy") return legacyBound();
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
      await legacy?.stop();
      legacy = null;
    },
  };
}

function describe(t: Terminal): string {
  const m = terminalMirror(t);
  return m === "view" ? `view ${t.viewId}` : m === "all" ? "everything" : "nothing";
}
