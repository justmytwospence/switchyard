import type { View, ViewClient } from "@switchyard/protocol";
import { findView } from "@switchyard/protocol";
import type { ApiClient } from "@switchyard/terminal";
import type { Env } from "../paths.js";
import { startPresence } from "./presence.js";
import type { MirrorState } from "./state.js";

/** The view a multiplexer session mirrors: `SWITCHYARD_VIEW` if set, else the session's name. */
export function bindingRef(env: Env, sessionName: string): string {
  return env.SWITCHYARD_VIEW?.trim() || sessionName;
}

/** The view a client is bound to, or "missing": the daemon is then inert (nothing is touched). */
export function viewOrMissing(st: Pick<MirrorState, "views">, ref: string): View | "missing" {
  return findView(st.views, ref) ?? "missing";
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
  client: Omit<ViewClient, "lastSeenAt">;
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
      const p = startPresence(opts.api, v, opts.client, opts.log);
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
