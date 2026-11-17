import type { Host, Project, Tracker, View } from "@switchyard/protocol";

/** What decides a view's members: a GitHub tracker, a terminal client, or the view's own filter. */
export type ViewSource = "tracker" | "client" | "manual";

export function viewSource(v: View): ViewSource {
  if (v.trackerId) return "tracker";
  if (v.clientId) return "client";
  return "manual";
}

/** `herdr:default@mac-pro` -> `herdr default on mac-pro`; anything else unchanged. */
export function clientLabel(id: string): string {
  const m = /^([a-z]+):([^@]+)@(.+)$/.exec(id);
  return m ? `${m[1]} ${m[2]} on ${m[3]}` : id;
}

/** The option text in view selectors: the name plus where its sessions come from. */
export function viewOptionLabel(v: View): string {
  const source = viewSource(v);
  if (source === "tracker") return `${v.name} · GitHub`;
  if (source === "client") {
    const m = /^([a-z]+):([^@]+)/.exec(v.clientId ?? "");
    return m ? `${v.name} · ${m[1]} ${m[2]}` : `${v.name} · terminal`;
  }
  return v.name;
}

function names(ids: string[], byId: Record<string, { name: string }>): string {
  const known = ids.map((id) => byId[id]?.name).filter((n): n is string => !!n);
  if (known.length <= 3) return known.join(", ");
  return `${known.slice(0, 3).join(", ")} and ${known.length - 3} more`;
}

export interface DescribeContext {
  trackers: Tracker[] | null;
  projects: Record<string, Pick<Project, "name">>;
  hosts: Record<string, Pick<Host, "name">>;
}

/** One line saying where a view's sessions come from. */
export function describeView(v: View, ctx: DescribeContext): string {
  const source = viewSource(v);
  if (source === "tracker") {
    const t = ctx.trackers?.find((x) => x.id === v.trackerId);
    if (!t) return "Kept by a GitHub tracker";
    const board = t.board ? ` (board #${t.board.projectNumber})` : "";
    return `GitHub issues assigned to ${t.login ?? "you"} in ${t.owner}${board}`;
  }
  if (source === "client") return `Pi you start in ${clientLabel(v.clientId ?? "")}`;
  if (v.mode === "pinned") {
    const n = v.sessionIds.length;
    return `${n} pinned ${n === 1 ? "session" : "sessions"}`;
  }
  const projectNames = v.projectIds ? names(v.projectIds, ctx.projects) : "";
  const hostNames = v.hostIds ? names(v.hostIds, ctx.hosts) : "";
  if (!projectNames && !hostNames) return "Every session";
  if (!projectNames) return `Sessions on ${hostNames}`;
  return `Sessions in ${projectNames}${hostNames ? ` on ${hostNames}` : ""}`;
}
