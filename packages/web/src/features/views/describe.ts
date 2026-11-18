import {
  type Host,
  openSurfaces,
  type Project,
  type Surface,
  type Tracker,
  type View,
} from "@switchyard/protocol";

/** What decides a view's members: a GitHub tracker, a source surface, or the view's own filter. */
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
    const x = t.extraRepositories ?? [];
    const also =
      x.length === 1 ? ` and ${x[0]}` : x.length > 1 ? ` and ${x.length} other repositories` : "";
    return `Branches and issues assigned to ${t.login ?? "you"} in ${t.owner}${also}${board}`;
  }
  if (source === "client") return `Pi you start in ${clientLabel(v.clientId ?? "")}`;
  if (v.mode === "pinned") return "Only sessions you pin";
  const projectNames = v.projectIds ? names(v.projectIds, ctx.projects) : "";
  const hostNames = v.hostIds ? names(v.hostIds, ctx.hosts) : "";
  if (!projectNames && !hostNames) return "Every session";
  if (!projectNames) return `Sessions on ${hostNames}`;
  return `Sessions in ${projectNames}${hostNames ? ` on ${hostNames}` : ""}`;
}

/** Terminals showing this view now, as "herdr vo on mac-pro, tmux main on nuc"; null when none. */
export function shownIn(
  v: View,
  surfaces: Surface[],
  hosts: Record<string, Pick<Host, "name">> = {},
  now = Date.now(),
): string | null {
  const open = openSurfaces(surfaces, v.id, now);
  if (open.length === 0) return null;
  return open
    .map((c) => `${c.kind} ${c.name} on ${(c.hostId && hosts[c.hostId]?.name) || c.machine}`)
    .join(", ");
}

export type ViewEmptyFilter = "active" | "attention" | "all";

/**
 * Title and explanation for a selected view with nothing to list. `source` is describeView's
 * text; `origin` is this deployment's host name.
 */
export function emptyViewState(
  v: View,
  opts: { filter: ViewEmptyFilter; source: string; origin: string },
): { title: string; description: string } {
  const title =
    opts.filter === "attention"
      ? `Nothing needs your input in ${v.name}`
      : opts.filter === "active"
        ? `No active sessions in ${v.name}`
        : `No sessions in ${v.name}`;
  const source = viewSource(v);
  let description: string;
  if (source === "client" && v.sessionIds.length === 0) {
    description = `A Pi you start in ${clientLabel(v.clientId ?? "")} joins this view once it enrols with a host agent connected to ${opts.origin}.`;
  } else if (source === "manual" && v.mode === "pinned") {
    description = `This view holds only sessions you pin. Pin one from its menu: Pin to ${v.name}.`;
  } else {
    description = `This view's source: ${opts.source}.`;
  }
  return { title, description };
}
