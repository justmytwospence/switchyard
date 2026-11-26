import {
  type Client,
  type Host,
  openClients,
  type Project,
  type Scope,
  sourceBacklog,
  sourceFollow,
} from "@switchyard/protocol";

/** What decides a scope's members: a GitHub source, or the scope's own filters and pins. */
export type ScopeSourceKind = "github" | "manual";

export function scopeSourceKind(v: Scope): ScopeSourceKind {
  return v.source ? "github" : "manual";
}

/** The option text in scope selectors: the name, marked when GitHub feeds it. */
export function scopeOptionLabel(v: Scope): string {
  return v.source ? `${v.name} · GitHub` : v.name;
}

function names(ids: string[], byId: Record<string, { name: string }>): string {
  const known = ids.map((id) => byId[id]?.name).filter((n): n is string => !!n);
  if (known.length <= 3) return known.join(", ");
  return `${known.slice(0, 3).join(", ")} and ${known.length - 3} more`;
}

export interface DescribeContext {
  projects: Record<string, Pick<Project, "name">>;
  hosts: Record<string, Pick<Host, "name">>;
}

/** One line saying where a scope's sessions (or, on the Tasks page, tasks) come from. */
export function describeScope(
  v: Scope,
  ctx: DescribeContext,
  subject: "sessions" | "tasks" = "sessions",
): string {
  const t = v.source;
  const x = t?.extraRepositories ?? [];
  const also =
    x.length === 1 ? ` and ${x[0]}` : x.length > 1 ? ` and ${x.length} other repositories` : "";
  if (subject === "tasks") {
    if (t) return `Tasks in the repositories of ${t.owner}${also}`;
    if (v.mode === "pinned") return "Tasks of sessions you pin";
    const projectNames = v.projectIds ? names(v.projectIds, ctx.projects) : "";
    return projectNames ? `Tasks in ${projectNames}` : "Every task";
  }
  if (t) {
    // A paused source has stopped following issues: say so where its scope looks empty.
    const paused = t.enabled === false ? " (sync paused: issues are not updated)" : "";
    if (t.board && sourceFollow(t) === "board") {
      const backlog = sourceBacklog(t);
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

/** Clients mirroring this scope now, as "herdr vo on mac-pro, tmux main on nuc"; null when none. */
export function shownIn(
  v: Scope,
  clients: Client[],
  hosts: Record<string, Pick<Host, "name">> = {},
  now = Date.now(),
): string | null {
  const open = openClients(clients, v.id, now);
  if (open.length === 0) return null;
  return open
    .map((c) => `${c.kind} ${c.name} on ${(c.hostId && hosts[c.hostId]?.name) || c.machine}`)
    .join(", ");
}

/** What a client mirrors, for a list: "everything", "scope work" or "nothing". */
export function mirrorLabel(
  t: Pick<Client, "mirror" | "scopeId">,
  scopes: Record<string, Pick<Scope, "name">>,
): string {
  if (t.mirror === "all") return "everything";
  if (t.mirror === "scope") return `scope ${(t.scopeId && scopes[t.scopeId]?.name) || "(deleted)"}`;
  return "nothing";
}

export type ScopeEmptyFilter = "active" | "attention" | "all";

/**
 * Title and explanation for a selected scope with nothing to list. `source` is describeScope's
 * text (what the scope contains); `origin` is this deployment's host name.
 */
export function emptyScopeState(
  v: Scope,
  opts: { filter: ScopeEmptyFilter; source: string; origin: string },
): { title: string; description: string } {
  const title =
    opts.filter === "attention"
      ? `Nothing needs your input in ${v.name}`
      : opts.filter === "active"
        ? `No active sessions in ${v.name}`
        : `No sessions in ${v.name}`;
  const source = scopeSourceKind(v);
  let description: string;
  if (source === "github") {
    description = `This scope shows sessions on ${v.name}'s issues and live sessions in its repositories. Issues that are not started are on the Board.`;
  } else if (source === "manual" && v.mode === "pinned") {
    description = `This scope holds only sessions you pin. Pin one from its menu: Pin to ${v.name}.`;
  } else {
    description = `This scope contains: ${opts.source}.`;
  }
  return { title, description };
}
