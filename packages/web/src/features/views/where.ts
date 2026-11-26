import type { Host, Session } from "@switchyard/protocol";
import { useFilter } from "../../prefs";

/** Where a session runs, as a filter: a terminal Pi is running in now, or a host. */
export type Where = { kind: "terminal"; id: string } | { kind: "host"; id: string };

/** The selected place (null: anywhere); persisted per browser, for the Sessions navigator. */
export function useSelectedWhere(): [Where | null, (w: Where | null) => void] {
  return useFilter<Where | null>("codeWhere", null);
}

/** `herdr:default@mac-pro` -> `herdr default on mac-pro`; anything else unchanged. */
export function terminalLabel(id: string): string {
  const m = /^([a-z]+):([^@]+)@(.+)$/.exec(id);
  return m ? `${m[1]} ${m[2]} on ${m[3]}` : id;
}

export function whereLabel(w: Where, hosts: Record<string, Pick<Host, "name">>): string {
  return w.kind === "terminal" ? terminalLabel(w.id) : (hosts[w.id]?.name ?? "Unknown host");
}

type WhereSession = Pick<Session, "hostId" | "external">;

/** Does the session run there? A terminal holds only Pi running in it now. */
export function sessionIsWhere(w: Where | null | undefined, s: WhereSession): boolean {
  if (!w) return true;
  return w.kind === "terminal" ? s.external?.client === w.id : s.hostId === w.id;
}

/** `terminal:<id>` / `host:<id>` for a select value; "" is anywhere. */
export function whereKey(w: Where | null): string {
  return w ? `${w.kind}:${w.id}` : "";
}

export function parseWhere(key: string): Where | null {
  const i = key.indexOf(":");
  const kind = key.slice(0, i);
  const id = key.slice(i + 1);
  return (kind === "terminal" || kind === "host") && id ? { kind, id } : null;
}

/**
 * The places to offer: terminals with an unarchived session in them (sorted by label), and the
 * hosts (sorted by name) when there are at least two. The selected place is always offered.
 */
export function whereOptions(
  sessions: Iterable<Pick<Session, "archivedAt" | "external">>,
  hosts: Record<string, Pick<Host, "name">>,
  selected: Where | null,
): { terminals: Where[]; hosts: Where[] } {
  const t = new Set<string>();
  for (const s of sessions) {
    if (s.archivedAt === null && s.external?.client) t.add(s.external.client);
  }
  if (selected?.kind === "terminal") t.add(selected.id);
  const h = new Set(Object.keys(hosts).length >= 2 ? Object.keys(hosts) : []);
  if (selected?.kind === "host") h.add(selected.id);
  const by = (a: Where, b: Where) => whereLabel(a, hosts).localeCompare(whereLabel(b, hosts));
  return {
    terminals: [...t].map((id): Where => ({ kind: "terminal", id })).sort(by),
    hosts: [...h].map((id): Where => ({ kind: "host", id })).sort(by),
  };
}
