import {
  type Host,
  openTerminals,
  type Project,
  type Terminal,
  type Tracker,
  terminalMirror,
  trackerBacklog,
  trackerFollow,
  type View,
} from "@switchyard/protocol";

/** What decides a view's members: a GitHub tracker, or the view's own filters and pins. */
export type ViewSource = "tracker" | "manual";

export function viewSource(v: View): ViewSource {
  return v.trackerId ? "tracker" : "manual";
}

/** The option text in view selectors: the name, marked when a tracker keeps it. */
export function viewOptionLabel(v: View): string {
  return viewSource(v) === "tracker" ? `${v.name} · GitHub` : v.name;
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

/** One line saying where a view's sessions (or, on the Tasks page, tasks) come from. */
export function describeView(
  v: View,
  ctx: DescribeContext,
  subject: "sessions" | "tasks" = "sessions",
): string {
  const source = viewSource(v);
  const tracker =
    source === "tracker" ? ctx.trackers?.find((x) => x.id === v.trackerId) : undefined;
  const x = tracker?.extraRepositories ?? [];
  const also =
    x.length === 1 ? ` and ${x[0]}` : x.length > 1 ? ` and ${x.length} other repositories` : "";
  if (subject === "tasks") {
    if (source === "tracker")
      return tracker
        ? `Tasks in the repositories of ${tracker.owner}${also}`
        : "Tasks in a GitHub tracker's repositories";
    if (v.mode === "pinned") return "Tasks of sessions you pin";
    const projectNames = v.projectIds ? names(v.projectIds, ctx.projects) : "";
    return projectNames ? `Tasks in ${projectNames}` : "Every task";
  }
  if (source === "tracker") {
    const t = tracker;
    if (!t) return "Kept by a GitHub tracker";
    // A paused tracker has stopped following issues: say so where its view looks empty.
    const paused = t.enabled === false ? " (tracker paused: issues are not updated)" : "";
    if (t.board && trackerFollow(t) === "board") {
      const backlog = trackerBacklog(t);
      return `Issues on ${t.owner}'s board #${t.board.projectNumber}${backlog.length ? `, except ${backlog.join(", ")}` : ""}, and live sessions there${paused}`;
    }
    const board = t.board ? ` (board #${t.board.projectNumber})` : "";
    return `Issues assigned to ${t.login ?? "you"} in ${t.owner}${also}${board}, and live sessions there${paused}`;
  }
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
  terminals: Terminal[],
  hosts: Record<string, Pick<Host, "name">> = {},
  now = Date.now(),
): string | null {
  const open = openTerminals(terminals, v.id, now);
  if (open.length === 0) return null;
  return open
    .map((c) => `${c.kind} ${c.name} on ${(c.hostId && hosts[c.hostId]?.name) || c.machine}`)
    .join(", ");
}

/** What a terminal mirrors, for a list: "everything", "view work" or "nothing". */
export function mirrorLabel(
  t: Pick<Terminal, "mirror" | "viewId">,
  views: Record<string, Pick<View, "name">>,
): string {
  const m = terminalMirror(t);
  if (m === "all") return "everything";
  if (m === "view") return `view ${(t.viewId && views[t.viewId]?.name) || "(deleted)"}`;
  return "nothing";
}

export type ViewEmptyFilter = "active" | "attention" | "all";

/**
 * Title and explanation for a selected view with nothing to list. `source` is describeView's
 * text (what the view contains); `origin` is this deployment's host name.
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
  if (source === "tracker") {
    description = `This view shows sessions on ${v.name}'s issues and live sessions in its repositories. Issues that are not started are on the Board.`;
  } else if (source === "manual" && v.mode === "pinned") {
    description = `This view holds only sessions you pin. Pin one from its menu: Pin to ${v.name}.`;
  } else {
    description = `This view contains: ${opts.source}.`;
  }
  return { title, description };
}
