import type { Host, Session } from "@switchyard/protocol";
import { isLiveRuntime } from "@switchyard/protocol";
import { useFilter } from "../../prefs";

/**
 * Where a session runs, as a filter: a herdr or tmux client Pi is running in now (`hostId`: the host it runs
 * on, for its label), or a host.
 */
export type Where = { kind: "client"; id: string; hostId?: string } | { kind: "host"; id: string };

/** The selected place (null: anywhere); persisted per browser, for the Sessions navigator. */
export function useSelectedWhere(): [Where | null, (w: Where | null) => void] {
  return useFilter<Where | null>("codeWhere", null);
}

type HostNames = Record<string, Pick<Host, "name"> & Partial<Pick<Host, "revokedAt">>>;

/** `herdr:default@mac-pro` -> `herdr default`; anything else unchanged. */
export function clientName(id: string): string {
  const m = /^([a-z]+):([^@]+)@(.+)$/.exec(id);
  return m ? `${m[1]} ${m[2]}` : id;
}

/**
 * `herdr:default@mac-pro` -> `herdr default on Mac`: the client, on the Switchyard name of the
 * host it runs on (`hostName`), or else the machine name in the id.
 */
export function clientLabel(id: string, hostName?: string | null): string {
  const m = /^([a-z]+):([^@]+)@(.+)$/.exec(id);
  if (!m) return hostName ? `${id} on ${hostName}` : id;
  return `${m[1]} ${m[2]} on ${hostName || m[3]}`;
}

export function whereLabel(w: Where, hosts: HostNames): string {
  if (w.kind === "client") return clientLabel(w.id, w.hostId ? hosts[w.hostId]?.name : null);
  return hosts[w.id]?.name ?? "Unknown host";
}

/** Hosts that are not revoked: the only ones the navigator names or filters by. */
export function liveHostIds(hosts: HostNames): string[] {
  return Object.entries(hosts)
    .filter(([, h]) => !h.revokedAt)
    .map(([id]) => id);
}

/** A stored Where, or null when it names a revoked host (it never appears). */
export function effectiveWhere(stored: Where | null | undefined, hosts: HostNames): Where | null {
  if (!stored) return null;
  // Stored before clients had their name.
  const w: Where =
    (stored as { kind: string }).kind === "terminal"
      ? ({ ...stored, kind: "client" } as Where)
      : stored;
  const hostId = w.kind === "host" ? w.id : w.hostId;
  if (hostId && hosts[hostId]?.revokedAt) return null;
  return w;
}

export function sameWhere(a: Where | null | undefined, b: Where | null | undefined): boolean {
  return !!a && !!b && a.kind === b.kind && a.id === b.id;
}

type WhereSession = Pick<Session, "hostId" | "external">;

/** Does the session run there? A client holds only Pi running in it now. */
export function sessionIsWhere(w: Where | null | undefined, s: WhereSession): boolean {
  if (!w) return true;
  return w.kind === "client" ? s.external?.client === w.id : s.hostId === w.id;
}

/** What a row says about where its session runs. */
export interface RowWhere {
  kind: "terminal" | "host";
  label: string;
}

/**
 * Where a session runs, for its row: the terminal of a Pi started by hand, else the host when
 * there are several (`multiHost`); null when there is nothing to tell apart.
 */
export function sessionWhereToken(
  s: WhereSession,
  hostName: string,
  multiHost: boolean,
): RowWhere | null {
  if (s.external) {
    const client = s.external.client;
    if (client) return { kind: "terminal", label: clientLabel(client, hostName) };
    return { kind: "terminal", label: multiHost ? `Terminal on ${hostName}` : "Terminal" };
  }
  return multiHost ? { kind: "host", label: hostName } : null;
}

/**
 * Details' "Runs in" line for a Pi started by hand: the terminal it runs in now, or the one it
 * last ran in after it stopped (until Switchyard starts it). Null for a session Switchyard holds.
 */
export function runsIn(
  s: WhereSession & Partial<Pick<Session, "place" | "runtime">>,
  hostName: string,
): string | null {
  if (s.external) {
    return s.external.client
      ? `${clientLabel(s.external.client, hostName)} (your terminal)`
      : `Your terminal on ${hostName}`;
  }
  if (s.place && s.runtime !== undefined && !isLiveRuntime(s.runtime)) {
    return `Last run by hand in ${clientLabel(s.place.terminalId, hostName)}`;
  }
  return null;
}
