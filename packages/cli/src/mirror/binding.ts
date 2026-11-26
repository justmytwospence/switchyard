import type { View } from "@switchyard/protocol";
import { findView } from "@switchyard/protocol";
import type { ApiClient } from "@switchyard/terminal";
import type { Env } from "../paths.js";
import { type SurfaceInfo, startPresence } from "./presence.js";
import type { MirrorState } from "./state.js";

/** The view a multiplexer session mirrors: `SWITCHYARD_VIEW` if set, else the session's name. */
export function bindingRef(env: Env, sessionName: string): string {
  return env.SWITCHYARD_VIEW?.trim() || sessionName;
}

/** The view a client is bound to, or "missing": the daemon is then inert (nothing is touched). */
export function viewOrMissing(st: Pick<MirrorState, "views">, ref: string): View | "missing" {
  return findView(st.views, ref) ?? "missing";
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

export function noViewMessage(kind: "herdr" | "tmux", name: string): string {
  return `This ${kind} session has no Switchyard view. Create a view named "${name}" in Switchyard to mirror it.`;
}

/**
 * Reports this client as open in whichever view it is bound to, following the binding as views
 * are created, renamed and deleted. Leaving a view withdraws the client and nothing else.
 */
export function trackPresence(opts: {
  api: ApiClient;
  getView: () => View | null;
  subscribe: (fn: () => void) => () => void;
  surface: SurfaceInfo;
  log: (line: string) => void;
}): { stop(): Promise<void> } {
  let current: { id: string; stop(): Promise<void> } | null = null;
  const check = () => {
    const v = opts.getView();
    if (v?.id === current?.id) return;
    const old = current;
    current = null;
    if (old) void old.stop();
    if (v) {
      const p = startPresence(opts.api, opts.surface, v.id, opts.log);
      current = { id: v.id, stop: p.stop };
    }
  };
  const off = opts.subscribe(check);
  check();
  return {
    async stop() {
      off();
      await current?.stop();
      current = null;
    },
  };
}
