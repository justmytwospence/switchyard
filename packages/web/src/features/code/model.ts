import type {
  AttentionItem,
  Checkout,
  Connectivity,
  Host,
  Interaction,
  Profile,
  Project,
  Run,
  RuntimeCapabilities,
  Session,
  SessionModel,
  SlashCommand,
  TranscriptItem,
  View,
  Workspace,
} from "@switchyard/protocol";
import { DEFAULT_WORKTREE_DIR, sessionInView, ThinkingLevel } from "@switchyard/protocol";
import { formatDuration } from "../../lib/time";
import { PANE_LIMITS } from "../../prefs";
import { isBusyRuntime, isLiveRuntime, sessionsNeedingAttention } from "../../sync/selectors";
import type { StreamBuffer } from "../../sync/store";

/**
 * Pure helpers for the Code feature (navigator tree, composer state,
 * transcript timeline, new-session preview). Tested without a DOM.
 */

export function isLive(s: Pick<Session, "runtime">): boolean {
  return isLiveRuntime(s.runtime);
}

export function isBusy(s: Pick<Session, "runtime">): boolean {
  return isBusyRuntime(s.runtime);
}

/* ------------------------------------------------------------------ */
/* Worktree preview                                                    */
/* ------------------------------------------------------------------ */

/** Same rule as the coordinator: slashes in the branch become dashes. */
export function branchSlug(branch: string): string {
  return branch.replaceAll("/", "-");
}

/** `<checkout>/<worktreeDir>/<branch with / replaced by ->`. */
export function worktreePath(
  checkoutPath: string,
  branch: string,
  worktreeDir: string = DEFAULT_WORKTREE_DIR,
): string {
  return `${checkoutPath.replace(/\/+$/, "")}/${worktreeDir}/${branchSlug(branch.trim())}`;
}

/** Client-side branch name check (the host validates again). Returns a reason or null. */
export function branchProblem(branch: string): string | null {
  const b = branch.trim();
  if (!b) return "Enter a branch name.";
  if (/\s/.test(b)) return "Branch names cannot contain spaces.";
  if (b.startsWith("-")) return "Branch names cannot start with '-'.";
  if (b.startsWith("/") || b.endsWith("/")) return "Branch names cannot start or end with '/'.";
  if (b.includes("..")) return "Branch names cannot contain '..'.";
  if (b.includes("//")) return "Branch names cannot contain '//'.";
  if (b.endsWith(".lock") || b.endsWith(".")) return "Branch names cannot end with '.lock' or '.'.";
  const control = [...b].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127);
  if (control || /[~^:?*[\\]/.test(b) || b.includes("@{")) {
    return "Branch names cannot contain ~ ^ : ? * [ \\ or '@{'.";
  }
  return null;
}

export function hostOnline(h: Host | undefined): boolean {
  return !!h && !h.revokedAt && h.connectivity === "connected";
}

/** Main checkout first, then by branch. */
export function compareWorkspaces(a: Workspace, b: Workspace): number {
  return (
    (a.provenance === "main" ? 0 : 1) - (b.provenance === "main" ? 0 : 1) ||
    (a.branch ?? "").localeCompare(b.branch ?? "")
  );
}

/** Branch suggested from a prompt: first 5 words, kebab-case, at most 40 chars; else session-MMDD-HHMM. */
export function branchFromPrompt(prompt: string, now: Date = new Date()): string {
  const words = prompt
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .slice(0, 5);
  const slug = words.join("-").slice(0, 40).replace(/-+$/, "");
  if (slug) return slug;
  const p = (n: number) => String(n).padStart(2, "0");
  return `session-${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
}

/** `base`, or `base-2`, `base-3`… when a workspace already uses that branch. */
export function uniqueBranch(base: string, taken: Iterable<string | null>): string {
  const set = new Set([...taken].filter((b): b is string => !!b));
  if (!set.has(base)) return base;
  for (let i = 2; ; i++) if (!set.has(`${base}-${i}`)) return `${base}-${i}`;
}

/** Project id of a navigator project group ("p:<id>", "h:<host>/p:<id>"); null for other groups. */
export function projectIdOfGroup(key: string): string | null {
  const m = /(?:^|\/)p:([^/]+)$/.exec(key);
  return m && m[1] !== "__none" ? m[1]! : null;
}

export interface NewSessionDefaults {
  hostId: string;
  /** The main checkout's workspace on that host; null means "New worktree…". */
  workspaceId: string | null;
  checkoutId: string | null;
}

/** Host: the requested one, else the project default if online, else the first online host with a checkout. */
export function newSessionDefaults(
  project: Project,
  checkouts: Checkout[],
  workspaces: Workspace[],
  hosts: Record<string, Host>,
  hostId?: string,
): NewSessionDefaults {
  const hostIds = [...new Set(checkouts.map((c) => c.hostId))];
  const def = project.defaultHostId;
  const pick =
    (hostId && hostIds.includes(hostId) ? hostId : undefined) ??
    (def && hostIds.includes(def) && hostOnline(hosts[def]) ? def : undefined) ??
    hostIds.find((id) => hostOnline(hosts[id])) ??
    hostIds[0] ??
    "";
  const main =
    workspaces.find((w) => w.hostId === pick && !w.archivedAt && w.provenance === "main") ?? null;
  const onHost = checkouts.filter((c) => c.hostId === pick);
  const checkout = onHost.find((c) => c.id === main?.checkoutId) ?? onHost[0] ?? null;
  return { hostId: pick, workspaceId: main?.id ?? null, checkoutId: checkout?.id ?? null };
}

/* ------------------------------------------------------------------ */
/* Navigator tree                                                      */
/* ------------------------------------------------------------------ */

export type NavFilter = "active" | "attention" | "all";

export type NavLayout = "projects" | "worktrees" | "recent" | "hosts" | "status";

export const NAV_LAYOUTS: { value: NavLayout; label: string; hint: string }[] = [
  { value: "projects", label: "Projects", hint: "Sessions under each project" },
  { value: "worktrees", label: "Worktrees", hint: "Project, then branch or worktree" },
  { value: "recent", label: "Recent", hint: "One list of every session" },
  { value: "hosts", label: "Hosts", hint: "Host, then project" },
  { value: "status", label: "Status", hint: "Grouped by what needs you" },
];

export type NavSort = "activity" | "created" | "name" | "status";

export const NAV_SORTS: { value: NavSort; label: string; hint: string }[] = [
  { value: "activity", label: "Recent activity", hint: "Latest activity first" },
  { value: "created", label: "Newest", hint: "Most recently started first" },
  { value: "name", label: "Name", hint: "A to Z" },
  { value: "status", label: "Status", hint: "Waiting and running first" },
];

export const DEFAULT_SORT: Record<NavLayout, NavSort> = {
  projects: "name",
  worktrees: "activity",
  recent: "activity",
  hosts: "name",
  status: "activity",
};

export type StatusBucket = "needs_input" | "failed" | "running" | "review" | "idle";

export const STATUS_BUCKETS: { value: StatusBucket; label: string; short: string }[] = [
  { value: "needs_input", label: "Needs input", short: "needs you" },
  { value: "failed", label: "Failed", short: "failed" },
  { value: "running", label: "Working", short: "working" },
  { value: "review", label: "Ready to review", short: "to review" },
  { value: "idle", label: "Idle", short: "idle" },
];

const BUCKET_RANK: Record<StatusBucket, number> = {
  needs_input: 0,
  failed: 1,
  running: 2,
  review: 3,
  idle: 4,
};

/** Where a session sits in the "what needs me" order. */
export function statusBucket(s: Session, attention: boolean): StatusBucket {
  if (attention || s.runtime === "waiting_input") return "needs_input";
  if (s.runtime === "failed" && s.unreadSince) return "failed";
  if (s.runtime === "running" || s.runtime === "starting" || s.compacting) return "running";
  if (s.unreadSince) return "review";
  return "idle";
}

/** Non-empty buckets (not idle) with their counts and the most recently active session of each. */
export function statusSummary(
  rows: Pick<NavRow, "bucket" | "session">[],
): { bucket: StatusBucket; count: number; first: string }[] {
  const out: { bucket: StatusBucket; count: number; first: string; at: string }[] = [];
  for (const b of STATUS_BUCKETS) {
    if (b.value === "idle") continue;
    let count = 0;
    let first = "";
    let at = "";
    for (const r of rows) {
      if (r.bucket !== b.value) continue;
      count += 1;
      if (r.session.lastActivityAt >= at) {
        at = r.session.lastActivityAt;
        first = r.session.id;
      }
    }
    if (count > 0) out.push({ bucket: b.value, count, first, at });
  }
  return out.map(({ at: _at, ...r }) => r);
}

export interface NavRow {
  session: Session;
  attention: boolean;
  bucket: StatusBucket;
  /** Context shown on the row's second line; null = not shown in this layout. */
  project: string | null;
  host: string | null;
  branch: string | null;
}

export interface NavGroup {
  /**
   * Collapse key: "p:<projectId|__none>", "w:<workspaceId>" or "w:<projectKey>:cwd:<hostId>:<cwd>",
   * "h:<hostId>", or "h:<hostId>/p:<projectId|__none>".
   */
  key: string;
  kind: "project" | "workspace" | "host" | "status";
  label: string;
  /** Muted text beside the label: the shared host on project/workspace headers. */
  detail: string | null;
  /** Workspace path (tooltip), workspace groups only. */
  path: string | null;
  /** Host connection state, host groups only ("unreachable" when revoked). */
  hostState: Connectivity | null;
  groups: NavGroup[];
  rows: NavRow[];
  /** Sessions in this group and its child groups. */
  sessionCount: number;
}

export interface NavTree {
  groups: NavGroup[];
  /** Ungrouped rows (the Recent layout only). */
  rows: NavRow[];
}

export interface NavOptions {
  filter: NavFilter;
  query: string;
  /** Default "projects". */
  layout?: NavLayout;
  /** Default false. */
  showSubagents?: boolean;
  /** Default: the layout's default sort. */
  sort?: NavSort;
  /** Sessions needing input before the rest. Default true. */
  needsInputFirst?: boolean;
  /** Only sessions in this view. */
  view?: View | null;
}

export interface NavInput {
  projects: Record<string, Project>;
  workspaces: Record<string, Workspace>;
  sessions: Record<string, Session>;
  hosts: Record<string, Host>;
  attention: Record<string, AttentionItem>;
  interactions: Record<string, Interaction>;
}

export { sessionsNeedingAttention } from "../../sync/selectors";

function lastSegment(p: string): string {
  return p.replace(/\/+$/, "").split("/").pop() || p;
}

export function workspaceLabel(ws: Workspace | null | undefined, cwd?: string): string {
  if (!ws) return cwd ? lastSegment(cwd) : "No workspace";
  if (ws.branch) return ws.branch;
  return `${lastSegment(ws.path)} (detached)`;
}

interface NavEntry {
  session: Session;
  attention: boolean;
  bucket: StatusBucket;
  ws: Workspace | null;
  projectId: string | null;
  project: Project | null;
  hostId: string;
  hostName: string;
}

function emptyGroup(
  key: string,
  kind: NavGroup["kind"],
  label: string,
  patch: Partial<NavGroup> = {},
): NavGroup {
  return {
    key,
    kind,
    label,
    detail: null,
    path: null,
    hostState: null,
    groups: [],
    rows: [],
    sessionCount: 0,
    ...patch,
  };
}

function projectLabel(projectId: string | null, project: Project | null): string {
  return project?.name ?? (projectId ? "Unknown project" : "Other sessions");
}

/** Branch context for a row: hidden for the main checkout; the cwd folder for project-less sessions. */
function branchFor(e: NavEntry): string | null {
  if (e.ws) return e.ws.provenance === "main" ? null : workspaceLabel(e.ws);
  return e.projectId === null ? lastSegment(e.session.cwd) : null;
}

function latest(g: NavGroup): string {
  let best = "";
  for (const r of g.rows) if (r.session.lastActivityAt > best) best = r.session.lastActivityAt;
  for (const c of g.groups) {
    const l = latest(c);
    if (l > best) best = l;
  }
  return best;
}

function newest(g: NavGroup): string {
  let best = "";
  for (const r of g.rows) if (r.session.createdAt > best) best = r.session.createdAt;
  for (const c of g.groups) {
    const l = newest(c);
    if (l > best) best = l;
  }
  return best;
}

function sortGroups(groups: NavGroup[], sort: NavSort): NavGroup[] {
  const last = (g: NavGroup) =>
    g.key.endsWith("__none") || (g.kind === "host" && g.label === "Unknown host") ? 1 : 0;
  const key = (g: NavGroup) =>
    sort === "activity" ? latest(g) : sort === "created" ? newest(g) : "";
  return groups.sort(
    (a, b) => last(a) - last(b) || key(b).localeCompare(key(a)) || a.label.localeCompare(b.label),
  );
}

function countSessions(g: NavGroup): number {
  g.sessionCount = g.rows.length + g.groups.reduce((n, c) => n + countSessions(c), 0);
  return g.sessionCount;
}

/**
 * The navigator tree for a layout. `active` keeps live sessions and those
 * needing attention; `attention` only the latter; `all` includes stopped
 * sessions; projects without sessions are hidden (Worktrees still lists empty
 * workspaces of projects that have sessions). Archived sessions are never listed; subagents only on request.
 * Rows needing attention come first, then by last activity.
 */
export function buildNavTree(input: NavInput, opts: NavOptions): NavTree {
  const layout = opts.layout ?? "projects";
  const sort = opts.sort ?? DEFAULT_SORT[layout];
  const needsFirst = opts.needsInputFirst ?? true;
  const q = opts.query.trim().toLowerCase();
  const attn = sessionsNeedingAttention(input.attention, input.interactions);

  const entries: NavEntry[] = [];
  for (const s of Object.values(input.sessions)) {
    if (s.archivedAt !== null) continue;
    if (s.provenance === "subagent" && !opts.showSubagents) continue;
    if (opts.view && !sessionInView(opts.view, s, input.workspaces)) continue;
    const needs = attn.has(s.id);
    if (opts.filter === "active" && !isLive(s) && !needs) continue;
    if (opts.filter === "attention" && !needs) continue;
    const ws = s.workspaceId ? (input.workspaces[s.workspaceId] ?? null) : null;
    const projectId = s.projectId ?? ws?.projectId ?? null;
    const project = projectId ? (input.projects[projectId] ?? null) : null;
    const hostId = ws?.hostId ?? s.hostId;
    const hostName = input.hosts[hostId]?.name ?? "Unknown host";
    if (
      q &&
      ![s.title, s.subtitle ?? "", ws?.branch ?? "", project?.name ?? "", hostName, s.cwd]
        .join("\n")
        .toLowerCase()
        .includes(q)
    )
      continue;
    entries.push({
      session: s,
      attention: needs,
      bucket: statusBucket(s, needs),
      ws,
      projectId,
      project,
      hostId,
      hostName,
    });
  }
  const byActivity = (a: NavEntry, b: NavEntry) =>
    b.session.lastActivityAt.localeCompare(a.session.lastActivityAt);
  entries.sort((a, b) => {
    if (needsFirst && a.attention !== b.attention) return Number(b.attention) - Number(a.attention);
    switch (sort) {
      case "created":
        return b.session.createdAt.localeCompare(a.session.createdAt) || byActivity(a, b);
      case "name":
        return (
          a.session.title.localeCompare(b.session.title, undefined, {
            numeric: true,
            sensitivity: "base",
          }) || byActivity(a, b)
        );
      case "status":
        return BUCKET_RANK[a.bucket] - BUCKET_RANK[b.bucket] || byActivity(a, b);
      default:
        return byActivity(a, b);
    }
  });

  const row = (e: NavEntry, ctx: Omit<NavRow, "session" | "attention" | "bucket">): NavRow => ({
    session: e.session,
    attention: e.attention,
    bucket: e.bucket,
    ...ctx,
  });

  if (layout === "status") {
    const groups: NavGroup[] = [];
    for (const b of STATUS_BUCKETS) {
      const g = emptyGroup(`s:${b.value}`, "status", b.label);
      for (const e of entries) {
        if (e.bucket !== b.value) continue;
        g.rows.push(
          row(e, {
            project: projectLabel(e.projectId, e.project),
            host: e.hostName,
            branch: branchFor(e),
          }),
        );
      }
      if (g.rows.length > 0) {
        countSessions(g);
        groups.push(g);
      }
    }
    return { groups, rows: [] };
  }

  if (layout === "recent") {
    return {
      groups: [],
      rows: entries.map((e) =>
        row(e, {
          project: projectLabel(e.projectId, e.project),
          host: e.hostName,
          branch: branchFor(e),
        }),
      ),
    };
  }

  if (layout === "hosts") {
    const hosts = new Map<string, NavGroup>();
    for (const e of entries) {
      let hg = hosts.get(e.hostId);
      if (!hg) {
        const host = input.hosts[e.hostId];
        hg = emptyGroup(`h:${e.hostId}`, "host", e.hostName, {
          hostState: host ? (host.revokedAt ? "unreachable" : host.connectivity) : "unreachable",
        });
        hosts.set(e.hostId, hg);
      }
      const key = `${hg.key}/p:${e.projectId ?? "__none"}`;
      let pg = hg.groups.find((g) => g.key === key);
      if (!pg) {
        pg = emptyGroup(key, "project", projectLabel(e.projectId, e.project));
        hg.groups.push(pg);
      }
      pg.rows.push(row(e, { project: null, host: null, branch: branchFor(e) }));
    }
    const groups = sortGroups([...hosts.values()], sort);
    for (const g of groups) {
      sortGroups(g.groups, sort);
      countSessions(g);
    }
    return { groups, rows: [] };
  }

  const projects = new Map<string, NavGroup>();
  const projectGroup = (projectId: string | null): NavGroup => {
    const key = `p:${projectId ?? "__none"}`;
    let g = projects.get(key);
    if (!g) {
      const project = projectId ? (input.projects[projectId] ?? null) : null;
      g = emptyGroup(key, "project", projectLabel(projectId, project));
      projects.set(key, g);
    }
    return g;
  };

  if (layout === "projects") {
    const hostIds = new Map<NavGroup, Set<string>>();
    for (const e of entries) {
      const pg = projectGroup(e.projectId);
      pg.rows.push(row(e, { project: null, host: e.hostName, branch: branchFor(e) }));
      const ids = hostIds.get(pg) ?? new Set<string>();
      ids.add(e.hostId);
      hostIds.set(pg, ids);
    }
    for (const [pg, ids] of hostIds) {
      if (ids.size !== 1) continue;
      pg.detail = pg.rows[0]!.host;
      for (const r of pg.rows) r.host = null;
    }
    const groups = sortGroups([...projects.values()], sort);
    for (const g of groups) countSessions(g);
    return { groups, rows: [] };
  }

  // Worktrees: project -> workspace -> sessions.
  const wsGroups = new Map<string, NavGroup>();
  const wsOf = new Map<NavGroup, Workspace | null>();
  const wsGroup = (pg: NavGroup, ws: Workspace | null, hostId: string, cwd: string): NavGroup => {
    const key = ws ? `w:${ws.id}` : `w:${pg.key}:cwd:${hostId}:${cwd}`;
    let g = wsGroups.get(key);
    if (!g) {
      g = emptyGroup(key, "workspace", workspaceLabel(ws, cwd), {
        detail: input.hosts[hostId]?.name ?? "Unknown host",
        path: ws?.path ?? null,
      });
      wsGroups.set(key, g);
      wsOf.set(g, ws);
      pg.groups.push(g);
    }
    return g;
  };

  for (const e of entries) {
    const wg = wsGroup(projectGroup(e.projectId), e.ws, e.hostId, e.session.cwd);
    wg.rows.push(row(e, { project: null, host: null, branch: null }));
  }

  if (opts.filter === "all") {
    // Empty workspaces still appear under projects that have sessions, so a new session can start there.
    const withSessions = new Set(entries.map((e) => e.projectId));
    for (const ws of Object.values(input.workspaces)) {
      if (ws.archivedAt || !withSessions.has(ws.projectId)) continue;
      const project = input.projects[ws.projectId] ?? null;
      if (
        q &&
        ![ws.branch ?? "", project?.name ?? "", ws.path].join("\n").toLowerCase().includes(q)
      )
        continue;
      wsGroup(projectGroup(ws.projectId), ws, ws.hostId, ws.path);
    }
  }

  const groups = sortGroups([...projects.values()], sort);
  for (const g of groups) {
    g.groups.sort((a, b) => {
      if (sort === "activity" || sort === "created") {
        const la = sort === "activity" ? latest(a) : newest(a);
        const lb = sort === "activity" ? latest(b) : newest(b);
        if (la !== lb) return lb.localeCompare(la);
      }
      // The main checkout first, then by branch.
      const ma = wsOf.get(a)?.provenance === "main" ? 0 : 1;
      const mb = wsOf.get(b)?.provenance === "main" ? 0 : 1;
      return ma - mb || a.label.localeCompare(b.label);
    });
    // A project with only its main checkout (or one plain folder) needs no workspace level.
    const only = g.groups.length === 1 ? g.groups[0]! : null;
    if (only && (only.path === null || wsOf.get(only)?.provenance === "main")) {
      g.rows = only.rows;
      g.detail = only.detail;
      g.groups = [];
    }
    countSessions(g);
  }
  return { groups, rows: [] };
}

/** True when the tree has no sessions and nothing to expand. */
export function navTreeIsEmpty(tree: NavTree): boolean {
  return (
    tree.rows.length === 0 &&
    tree.groups.every((g) => g.sessionCount === 0 && g.groups.length === 0)
  );
}

/** Every group key, depth-first (for Collapse all). */
export function navGroupKeys(tree: NavTree): string[] {
  const out: string[] = [];
  const walk = (gs: NavGroup[]) => {
    for (const g of gs) {
      out.push(g.key);
      walk(g.groups);
    }
  };
  walk(tree.groups);
  return out;
}

/* ------------------------------------------------------------------ */
/* Session context                                                     */
/* ------------------------------------------------------------------ */

const ACTIVE_RUN_STATES: Run["state"][] = [
  "queued",
  "dispatching",
  "uncertain",
  "running",
  "waiting_input",
  "checking",
];

/** The run controlling a session: `session.runId`, else the newest active run on it. */
export function runForSession(runs: Record<string, Run>, session: Session): Run | null {
  if (session.runId && runs[session.runId]) return runs[session.runId]!;
  let best: Run | null = null;
  for (const r of Object.values(runs)) {
    if (r.sessionId !== session.id || !ACTIVE_RUN_STATES.includes(r.state)) continue;
    if (!best || r.createdAt > best.createdAt) best = r;
  }
  return best;
}

export type AutomationControl = "automation" | "human" | "none";

export function automationControl(run: Run | null): AutomationControl {
  if (!run) return "none";
  return run.controlMode;
}

export const AUTOMATION_LABEL: Record<AutomationControl, string> = {
  automation: "Automation",
  human: "You have control",
  none: "Manual session",
};

export type HostLink = "connected" | "reconnecting" | "unreachable";

export function hostLink(host: Host | undefined, session: Session): HostLink {
  if (host?.revokedAt) return "unreachable";
  return host?.connectivity ?? session.connectivity;
}

/** Shown wherever a read-only subagent session would otherwise accept input. */
export const SUBAGENT_READ_ONLY = "Subagent: view only. Live control is not supported.";

/** A read-only subagent session (its transcript comes from the native file on open). */
export function isSubagentView(session: Pick<Session, "provenance" | "readOnly">): boolean {
  return session.provenance === "subagent" && session.readOnly;
}

/** Why the composer cannot send, or null when it can. Ordered by what the user must fix first. */
export function composerBlockReason(input: {
  session: Session;
  hostLink: HostLink;
  hostName: string;
}): { reason: string; action?: "resume"; pending?: boolean } | null {
  const { session, hostLink: link } = input;
  if (session.readOnly) return { reason: SUBAGENT_READ_ONLY };
  if (session.archivedAt) return { reason: "Session archived: unarchive it to send" };
  if (link !== "connected") {
    return {
      reason:
        link === "reconnecting"
          ? `Host offline: ${input.hostName} is reconnecting`
          : `Host offline: ${input.hostName} is unreachable`,
    };
  }
  if (session.runtime === "starting")
    return { reason: "Starting… you can send once Pi is ready", pending: true };
  // A stopped session with a Pi file resumes when you send to it.
  if (!isLive(session) && !session.nativeHandle) {
    return { reason: "Session stopped: no native Pi session to resume" };
  }
  if (session.compacting) return { reason: "Compacting context: you can send when it finishes" };
  return null;
}

export type SessionStatusKind =
  | "subagent"
  | "archived"
  | "host"
  | "answer"
  | "failed"
  | "interrupted"
  | "stopped"
  | "starting"
  | "compacting"
  | "automation"
  | "human";
export type SessionStatusAction = "unarchive" | "answer" | "resume" | "takeover" | "return";

export interface SessionStatus {
  kind: SessionStatusKind;
  tone: "neutral" | "info" | "warning" | "danger";
  text: string;
  action: { kind: SessionStatusAction; label: string } | null;
  /** Transitional: show a spinner instead of the icon. */
  pending?: boolean;
  /** Secondary link (failed: diagnostics). */
  link?: { label: string; to: string };
}

/** An unreachable host turns the status from warning to danger after this long. */
export const HOST_OFFLINE_DANGER_MS = 5 * 60_000;

/**
 * The one status line above the composer: what most needs the user, in priority order
 * (subagent, archived, host, question, failed, interrupted, stopped, starting, compacting,
 * automation, human control). Null when nothing needs saying.
 */
export function sessionStatus(input: {
  session: Session;
  hostLink: HostLink;
  hostName: string;
  hostLastSeenAt: string | null | undefined;
  control: AutomationControl;
  pending: Pick<Interaction, "title">[];
  canResume: boolean;
  now: number;
}): SessionStatus | null {
  const { session: s, hostLink: link, hostName, pending } = input;
  const resume = input.canResume ? { kind: "resume" as const, label: "Resume" } : null;
  if (s.readOnly)
    return { kind: "subagent", tone: "neutral", text: SUBAGENT_READ_ONLY, action: null };
  if (s.archivedAt) {
    return {
      kind: "archived",
      tone: "neutral",
      text: "This session is archived. Unarchive it to send messages.",
      action: { kind: "unarchive", label: "Unarchive" },
    };
  }
  if (link !== "connected") {
    const seen = input.hostLastSeenAt ? Date.parse(input.hostLastSeenAt) : Number.NaN;
    const long =
      link === "unreachable" &&
      (!Number.isFinite(seen) || input.now - seen > HOST_OFFLINE_DANGER_MS);
    return link === "reconnecting"
      ? {
          kind: "host",
          tone: "warning",
          pending: true,
          text: `Host ${hostName} is reconnecting… Sending and answers resume when it is back.`,
          action: null,
        }
      : {
          kind: "host",
          tone: long ? "danger" : "warning",
          text: `Host ${hostName} is offline. Showing the last known transcript; sending resumes when it reconnects.`,
          action: null,
        };
  }
  if (pending.length > 0) {
    return {
      kind: "answer",
      tone: "warning",
      text:
        pending.length === 1
          ? `Needs input: ${pending[0]!.title}`
          : `${pending.length} questions need input`,
      action: { kind: "answer", label: "Answer" },
    };
  }
  if (s.runtime === "failed") {
    return {
      kind: "failed",
      tone: "danger",
      text: `This session failed: ${s.runtimeDetail ?? "Pi exited with an error."}`,
      action: resume,
      link: { label: "Diagnostics", to: "/settings/diagnostics" },
    };
  }
  if (s.runtime === "interrupted") {
    return {
      kind: "interrupted",
      tone: "neutral",
      text: s.runtimeDetail
        ? `Interrupted: ${s.runtimeDetail}`
        : "Interrupted. Resume to continue.",
      action: resume,
    };
  }
  if (s.runtime === "stopped") {
    return s.nativeHandle
      ? {
          kind: "stopped",
          tone: "neutral",
          text: "Stopped. Sending a message resumes it.",
          action: resume,
        }
      : {
          kind: "stopped",
          tone: "neutral",
          text: "Stopped: no native Pi session to resume.",
          action: null,
        };
  }
  if (s.runtime === "starting") {
    return {
      kind: "starting",
      tone: "info",
      pending: true,
      text: "Starting Pi… you can send once it is ready.",
      action: null,
    };
  }
  if (s.compacting) {
    return {
      kind: "compacting",
      tone: "info",
      pending: true,
      text: "Compacting context… you can send when it finishes.",
      action: null,
    };
  }
  if (input.control === "automation") {
    return {
      kind: "automation",
      tone: "info",
      text: "Automation is running this session. Take over to pause automatic continuations.",
      action: { kind: "takeover", label: "Take over" },
    };
  }
  if (input.control === "human") {
    return {
      kind: "human",
      tone: "neutral",
      text: "You have control. Automatic continuations are paused.",
      action: { kind: "return", label: "Return to automation" },
    };
  }
  return null;
}

export interface SendModes {
  /** Send as a normal prompt (session idle). */
  prompt: boolean;
  /** Immediate steering while running (only when the runtime supports it). */
  steer: boolean;
  /** Queue a follow-up while running. */
  followUp: boolean;
}

export function sendModes(
  session: Pick<Session, "runtime">,
  caps: RuntimeCapabilities | null | undefined,
): SendModes {
  if (!isBusy(session)) return { prompt: true, steer: false, followUp: false };
  return {
    prompt: false,
    steer: caps?.steer === true,
    followUp: caps ? caps.followUp : true,
  };
}

/* ------------------------------------------------------------------ */
/* Transcript timeline                                                 */
/* ------------------------------------------------------------------ */

export type TimelineEntry =
  | {
      type: "item";
      key: string;
      item: TranscriptItem;
      stream: StreamBuffer | null;
      repeat?: number;
    }
  | { type: "stream"; key: string; stream: StreamBuffer }
  | { type: "interaction"; key: string; interaction: Interaction };

/**
 * Durable transcript items in order, with stream deltas merged into their
 * item (or appended as live entries when the item has not arrived yet), plus
 * pending interactions that have no transcript item yet.
 */
export function buildTimeline(
  items: TranscriptItem[],
  streams: StreamBuffer[],
  pending: Interaction[],
): TimelineEntry[] {
  const byItem = new Map(streams.map((s) => [s.itemId, s]));
  const out: TimelineEntry[] = [];
  const seenInteractions = new Set<string>();
  for (const item of items) {
    const stream = byItem.get(item.id) ?? null;
    if (stream) byItem.delete(item.id);
    if (item.kind === "interaction") seenInteractions.add(item.data.interactionId);
    // Consecutive identical notices (e.g. repeated "Host agent restarted") become one row with a count.
    const prev = out[out.length - 1];
    if (
      item.kind === "notice" &&
      !stream &&
      prev?.type === "item" &&
      prev.item.kind === "notice" &&
      prev.item.data.level === item.data.level &&
      prev.item.data.text === item.data.text
    ) {
      out[out.length - 1] = { ...prev, repeat: (prev.repeat ?? 1) + 1 };
      continue;
    }
    out.push({ type: "item", key: item.id, item, stream });
  }
  const orphans = [...byItem.values()].sort(
    (a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER),
  );
  for (const s of orphans) {
    if (!s.text && !s.thinking && !s.toolArgs && !s.toolOutput) continue;
    out.push({ type: "stream", key: `stream:${s.itemId}`, stream: s });
  }
  for (const i of pending) {
    if (seenInteractions.has(i.id)) continue;
    out.push({ type: "interaction", key: `interaction:${i.id}`, interaction: i });
  }
  return out;
}

export interface WorkSummary {
  durationMs: number | null;
  edits: number;
  reads: number;
  commands: number;
  searches: number;
  other: number;
  thinking: number;
  failed: number;
}

export type FoldedEntry =
  | TimelineEntry
  | { type: "work"; key: string; entries: TimelineEntry[]; summary: WorkSummary };

function isToolEntry(e: TimelineEntry): e is Extract<TimelineEntry, { type: "item" }> {
  return e.type === "item" && e.item.kind === "tool";
}

/** Counts and elapsed time of the folded tool calls and thinking of one turn. */
export function summarizeWork(entries: TimelineEntry[], turnStartAt: string | null): WorkSummary {
  const s: WorkSummary = {
    durationMs: null,
    edits: 0,
    reads: 0,
    commands: 0,
    searches: 0,
    other: 0,
    thinking: 0,
    failed: 0,
  };
  let toolSum: number | null = null;
  let maxEnd: number | null = null;
  for (const e of entries) {
    if (e.type !== "item") continue;
    const item = e.item;
    if (item.kind === "thinking") s.thinking += 1;
    if (item.kind === "tool") {
      const d = item.data;
      if (d.status === "error") s.failed += 1;
      switch (d.name) {
        case "edit":
        case "write":
          s.edits += 1;
          break;
        case "read":
          s.reads += 1;
          break;
        case "bash":
        case "powershell":
          s.commands += 1;
          break;
        case "grep":
        case "find":
        case "ls":
          s.searches += 1;
          break;
        default:
          s.other += 1;
      }
      if (d.durationMs !== null && d.durationMs !== undefined)
        toolSum = (toolSum ?? 0) + d.durationMs;
      const start = Date.parse(d.startedAt);
      const end = Number.isNaN(start) ? Date.parse(item.at) : start + (d.durationMs ?? 0);
      if (!Number.isNaN(end)) maxEnd = Math.max(maxEnd ?? end, end);
    } else {
      const at = Date.parse(item.at);
      if (!Number.isNaN(at)) maxEnd = Math.max(maxEnd ?? at, at);
    }
  }
  const startMs = turnStartAt ? Date.parse(turnStartAt) : Number.NaN;
  if (!Number.isNaN(startMs) && maxEnd !== null) s.durationMs = Math.max(0, maxEnd - startMs);
  else s.durationMs = toolSum;
  return s;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "Worked 7s · 2 edits · 3 reads · 1 command". */
export function formatWorkSummary(s: WorkSummary): string {
  const dur = formatDuration(s.durationMs);
  const parts = [dur ? `Worked ${dur}` : "Worked"];
  if (s.edits) parts.push(plural(s.edits, "edit", "edits"));
  if (s.reads) parts.push(plural(s.reads, "read", "reads"));
  if (s.commands) parts.push(plural(s.commands, "command", "commands"));
  if (s.searches) parts.push(plural(s.searches, "search", "searches"));
  if (s.other) parts.push(`${s.other} other`);
  if (s.failed) parts.push(`${s.failed} failed`);
  return parts.join(" · ");
}

function turnIsOpen(turn: TimelineEntry[], busy: boolean): boolean {
  if (busy) return true;
  return turn.some(
    (e) =>
      e.type === "stream" ||
      (e.type === "item" &&
        (e.stream !== null ||
          (e.item.kind === "tool" && e.item.data.status === "running") ||
          (e.item.kind === "assistant" && e.item.data.streaming === true))),
  );
}

/**
 * Collapse the tool calls and thinking of each finished turn into one "work" entry. The last
 * turn stays open while the session is busy or anything in it is still streaming. Interactions,
 * subagents, notices, system and user items and the turn's final reply never fold.
 */
export function foldTimeline(entries: TimelineEntry[], busy: boolean): FoldedEntry[] {
  const turns: TimelineEntry[][] = [];
  for (const e of entries) {
    if (turns.length === 0 || (e.type === "item" && e.item.kind === "user")) turns.push([e]);
    else turns[turns.length - 1]?.push(e);
  }
  const out: FoldedEntry[] = [];
  turns.forEach((turn, idx) => {
    const first = turn[0];
    const startsWithUser = first?.type === "item" && first.item.kind === "user";
    if (idx === turns.length - 1 && turnIsOpen(turn, busy)) {
      out.push(...turn);
      return;
    }
    let lastAssistant = -1;
    turn.forEach((e, i) => {
      if (e.type === "item" && e.item.kind === "assistant") lastAssistant = i;
    });
    const foldable = new Set<number>();
    turn.forEach((e, i) => {
      if (e.type !== "item") return;
      const k = e.item.kind;
      if (k === "tool" || k === "thinking" || (k === "assistant" && i !== lastAssistant))
        foldable.add(i);
    });
    const folded = turn.filter((_, i) => foldable.has(i));
    if (!folded.some(isToolEntry)) {
      out.push(...turn);
      return;
    }
    const startAt = startsWithUser && first?.type === "item" ? first.item.at : null;
    let placed = false;
    turn.forEach((e, i) => {
      if (!foldable.has(i)) {
        out.push(e);
        return;
      }
      if (placed) return;
      placed = true;
      out.push({
        type: "work",
        key: `work:${e.key}`,
        entries: folded,
        summary: summarizeWork(folded, startAt),
      });
    });
  });
  return out;
}

/** Number of entries after the one with `baselineKey` (unseen while scrolled up). */
export function countAfter(entries: { key: string }[], baselineKey: string | null): number {
  if (baselineKey === null) return entries.length;
  const idx = entries.findIndex((e) => e.key === baselineKey);
  if (idx < 0) return 0;
  return entries.length - idx - 1;
}

/** DOM id of an interaction in the transcript (strip and deep links scroll to it). */
export function interactionDomId(interactionId: string): string {
  return `interaction-${interactionId}`;
}

/* ------------------------------------------------------------------ */
/* Attachments                                                         */
/* ------------------------------------------------------------------ */

export interface ImageAttachment {
  id: string;
  name: string;
  mimeType: string;
  /** Base64 without the data: prefix. */
  data: string;
  size: number;
}

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Split a data URL into `{mimeType, data}`. */
export function parseDataUrl(url: string): { mimeType: string; data: string } | null {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
  if (!m?.[2]) return null;
  return { mimeType: m[1] ?? "application/octet-stream", data: m[3] ?? "" };
}

export function readImageFile(file: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) {
      reject(new Error(`${file.name} is not an image`));
      return;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      reject(new Error(`${file.name} is larger than 10 MB`));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`));
    reader.onload = () => {
      const parsed = parseDataUrl(String(reader.result ?? ""));
      if (!parsed) {
        reject(new Error(`Could not read ${file.name}`));
        return;
      }
      resolve({
        id: `att_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        name: file.name,
        mimeType: parsed.mimeType || file.type,
        data: parsed.data,
        size: file.size,
      });
    };
    reader.readAsDataURL(file);
  });
}

/* ------------------------------------------------------------------ */
/* Misc                                                                */
/* ------------------------------------------------------------------ */

export function checkoutLabel(c: Checkout, hosts: Record<string, Host>): string {
  return `${hosts[c.hostId]?.name ?? "Unknown host"}: ${c.path}`;
}

/** First line of a tool's args for a compact summary. */
export function stringifyArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

/** Tail of verbose output for the collapsed mobile preview. */
export function outputPreview(output: string, maxLines = 6): { text: string; truncated: boolean } {
  const lines = output.replace(/\n+$/, "").split("\n");
  if (lines.length <= maxLines && output.length <= 600) return { text: output, truncated: false };
  const tail = lines.slice(-maxLines).join("\n");
  return { text: tail.length > 600 ? tail.slice(-600) : tail, truncated: true };
}

/* ------------------------------------------------------------------ */
/* Pane layout                                                         */
/* ------------------------------------------------------------------ */

export const CONVERSATION_MIN = 420;
/** At the compact breakpoint the navigator is at most this wide (the inspector is a drawer). */
export const COMPACT_NAVIGATOR_MAX = 300;
const SPLITTER = 6;

/**
 * Pane widths that always leave the conversation its 420 px minimum: the
 * inspector gives way first (down to 320), then the navigator (down to 220).
 * Stored preferences are not changed.
 */
export function fitPanes(
  available: number,
  nav: number,
  insp: number | null,
): { nav: number; insp: number | null } {
  if (available <= 0) return { nav, insp };
  const splitters = insp === null ? SPLITTER : SPLITTER * 2;
  let over = nav + (insp ?? 0) + splitters + CONVERSATION_MIN - available;
  let i = insp;
  let n = nav;
  if (over > 0 && i !== null) {
    const give = Math.min(over, i - PANE_LIMITS.inspector.min);
    i -= give;
    over -= give;
  }
  if (over > 0) {
    const give = Math.min(over, n - PANE_LIMITS.navigator.min);
    n -= give;
  }
  return { nav: n, insp: i };
}

// ---- session controls: slash commands, model, effort, context ----

export type CommandSource = "switchyard" | SlashCommand["source"] | "terminal";

export interface CommandEntry {
  name: string;
  description: string | null;
  source: CommandSource;
  argumentHint: string | null;
}

export const CLIENT_COMMANDS: CommandEntry[] = [
  {
    name: "model",
    description: "Switch this session's model",
    source: "switchyard",
    argumentHint: "<provider>/<model>",
  },
  {
    name: "thinking",
    description: "Set the effort (thinking level)",
    source: "switchyard",
    argumentHint: "<level>",
  },
  {
    name: "compact",
    description: "Compact the session context",
    source: "switchyard",
    argumentHint: "[instructions]",
  },
  {
    name: "name",
    description: "Rename this session",
    source: "switchyard",
    argumentHint: "<name>",
  },
  {
    name: "new",
    description: "Start a new session in this workspace",
    source: "switchyard",
    argumentHint: "[prompt]",
  },
  {
    name: "fork",
    description: "Start a new session from one of your messages",
    source: "switchyard",
    argumentHint: null,
  },
  {
    name: "clone",
    description: "Copy this conversation into a new session",
    source: "switchyard",
    argumentHint: null,
  },
  {
    name: "tree",
    description: "Start a new session from any point in the conversation tree",
    source: "switchyard",
    argumentHint: null,
  },
  {
    name: "resume",
    description: "Open another Pi session from this folder",
    source: "switchyard",
    argumentHint: null,
  },
  {
    name: "reload",
    description: "Reload extensions, skills, prompts and context files",
    source: "switchyard",
    argumentHint: null,
  },
  {
    name: "export",
    description: "Download this session's .jsonl file",
    source: "switchyard",
    argumentHint: null,
  },
  {
    name: "session",
    description: "Show session info and stats",
    source: "switchyard",
    argumentHint: null,
  },
  {
    name: "copy",
    description: "Copy the last reply to the clipboard",
    source: "switchyard",
    argumentHint: null,
  },
];

export const TERMINAL_COMMANDS: CommandEntry[] = [
  {
    name: "settings",
    description: "Open settings menu",
    source: "terminal",
    argumentHint: null,
  },
  {
    name: "scoped-models",
    description: "Enable/disable models for Ctrl+P cycling",
    source: "terminal",
    argumentHint: null,
  },
  {
    name: "import",
    description: "Import and resume a session from a JSONL file",
    source: "terminal",
    argumentHint: null,
  },
  {
    name: "share",
    description: "Share session via a Radius artifact or a GitHub gist",
    source: "terminal",
    argumentHint: null,
  },
  {
    name: "bug",
    description: "Report a bug to the Pi developers",
    source: "terminal",
    argumentHint: "<description>",
  },
  {
    name: "changelog",
    description: "Show changelog entries",
    source: "terminal",
    argumentHint: null,
  },
  {
    name: "hotkeys",
    description: "Show all keyboard shortcuts",
    source: "terminal",
    argumentHint: null,
  },
  {
    name: "trust",
    description: "Save project trust decision for future sessions",
    source: "terminal",
    argumentHint: null,
  },
  {
    name: "login",
    description: "Configure provider authentication",
    source: "terminal",
    argumentHint: "<provider>",
  },
  {
    name: "logout",
    description: "Remove provider authentication",
    source: "terminal",
    argumentHint: null,
  },
  {
    name: "quit",
    description: "Quit Pi",
    source: "terminal",
    argumentHint: null,
  },
];

export const TERMINAL_ONLY_COMMANDS = TERMINAL_COMMANDS.map((c) => c.name);

const SOURCE_ORDER: Record<string, number> = { extension: 0, prompt: 1, skill: 2 };

export function mergeCommands(client: CommandEntry[], remote: SlashCommand[]): CommandEntry[] {
  const names = new Set([...client.map((c) => c.name), ...remote.map((c) => c.name)]);
  const terminal = TERMINAL_COMMANDS.filter((c) => !names.has(c.name)).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const taken = new Set(client.map((c) => c.name));
  const rest: CommandEntry[] = remote
    .filter((c) => !taken.has(c.name))
    .map((c) => ({
      name: c.name,
      description: c.description,
      source: c.source,
      argumentHint: c.argumentHint ?? null,
    }))
    .sort(
      (a, b) =>
        (SOURCE_ORDER[a.source] ?? 9) - (SOURCE_ORDER[b.source] ?? 9) ||
        a.name.localeCompare(b.name),
    );
  return [...client, ...rest, ...terminal];
}

export function completionEligible(draft: string): boolean {
  return !draft.includes("\n") && draft.length <= 500 && /^\/\S+ /.test(draft);
}

export function applyCompletion(draft: string, prefix: string, value: string): string {
  if (!draft.endsWith(prefix)) return draft;
  return draft.slice(0, draft.length - prefix.length) + value + (value.endsWith(" ") ? "" : " ");
}

/** The hint of the command being typed (`/name ` followed by arguments), if it has one. */
export function activeArgumentHint(
  draft: string,
  entries: CommandEntry[],
): { name: string; hint: string } | null {
  if (draft.includes("\n")) return null;
  const m = /^\/(\S+)[ \t]/.exec(draft);
  if (!m) return null;
  const entry = entries.find((e) => e.name === m[1]);
  return entry?.argumentHint ? { name: entry.name, hint: entry.argumentHint } : null;
}

export function filterCommands(entries: CommandEntry[], query: string, limit = 50): CommandEntry[] {
  const q = query.toLowerCase();
  if (!q) return entries.slice(0, limit);
  const scored: { e: CommandEntry; score: number; i: number }[] = [];
  entries.forEach((e, i) => {
    const name = e.name.toLowerCase();
    const score = name.startsWith(q)
      ? 0
      : name.includes(q)
        ? 1
        : (e.description ?? "").toLowerCase().includes(q)
          ? 2
          : -1;
    if (score >= 0) scored.push({ e, score, i });
  });
  scored.sort((a, b) => a.score - b.score || a.i - b.i);
  return scored.slice(0, limit).map((s) => s.e);
}

export type ClientCommand =
  | { kind: "model-picker" }
  | { kind: "model"; provider: string; modelId: string }
  | { kind: "thinking"; level: ThinkingLevel }
  | { kind: "compact"; instructions: string | null }
  | { kind: "name"; title: string }
  | { kind: "new"; prompt: string }
  | { kind: "fork" | "clone" | "tree" | "resume" | "reload" | "export" | "session" | "copy" }
  | { kind: "invalid"; reason: string }
  | { kind: "terminal-only"; name: string };

export function parseClientCommand(text: string): ClientCommand | null {
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  const name = m[1]!;
  const arg = (m[2] ?? "").trim();
  switch (name) {
    case "model": {
      if (!arg) return { kind: "model-picker" };
      const slash = arg.indexOf("/");
      if (slash <= 0 || slash === arg.length - 1 || /\s/.test(arg)) {
        return {
          kind: "invalid",
          reason: "Use /model <provider>/<model>, or /model alone to pick one",
        };
      }
      return { kind: "model", provider: arg.slice(0, slash), modelId: arg.slice(slash + 1) };
    }
    case "thinking": {
      const r = ThinkingLevel.safeParse(arg.toLowerCase());
      if (!r.success) {
        return {
          kind: "invalid",
          reason: `Use /thinking <level>: ${ThinkingLevel.options.join(", ")}`,
        };
      }
      return { kind: "thinking", level: r.data };
    }
    case "compact":
      return { kind: "compact", instructions: arg || null };
    case "name":
      if (!arg) return { kind: "invalid", reason: "Use /name <new name>" };
      if (arg.length > 200) {
        return { kind: "invalid", reason: "Session names are at most 200 characters" };
      }
      return { kind: "name", title: arg };
    case "new":
      return { kind: "new", prompt: arg };
    case "fork":
    case "clone":
    case "tree":
    case "resume":
    case "reload":
    case "export":
    case "session":
    case "copy":
      return { kind: name };
    default:
      return TERMINAL_ONLY_COMMANDS.includes(name) ? { kind: "terminal-only", name } : null;
  }
}

export function clientCommandProblem(
  cmd: ClientCommand,
  running: boolean,
  hasNative = true,
): string | null {
  if (cmd.kind === "invalid") return cmd.reason;
  if (cmd.kind === "terminal-only") {
    return `/${cmd.name} is a Pi terminal command: open the session's terminal to use it`;
  }
  if (cmd.kind === "compact" && running) return "Wait for the run to finish before compacting";
  if (
    !hasNative &&
    (cmd.kind === "fork" ||
      cmd.kind === "clone" ||
      cmd.kind === "tree" ||
      cmd.kind === "export" ||
      cmd.kind === "reload")
  ) {
    return "This session has no Pi session file yet";
  }
  if (cmd.kind === "reload" && running) return "Wait for the run to finish before reloading";
  return null;
}

/** Model name for a pill: no provider or vendor prefix (the name is specific enough). */
export function pillModelLabel(m: SessionModel): string {
  let label = m.name ?? "";
  const vendor = /^[^:/]{1,40}:\s+(.+)$/.exec(label);
  if (vendor) label = vendor[1]!;
  if (!label) label = m.id.slice(m.id.lastIndexOf("/") + 1);
  const prefix = `${m.provider}/`;
  if (label.toLowerCase().startsWith(prefix.toLowerCase())) label = label.slice(prefix.length);
  const brand = /^Claude\s+(.+)$/.exec(label);
  if (brand) label = brand[1]!;
  return label || modelLabel(m);
}

/** Pi's scoped (favorite) models, plus the current one, in the original order. */
export function favoriteModels(
  models: SessionModel[],
  current: SessionModel | null,
): SessionModel[] {
  return models.filter(
    (m) => m.scoped === true || (current && m.provider === current.provider && m.id === current.id),
  );
}

export function effortIndex(
  levels: readonly string[],
  thinking: string | null | undefined,
): number {
  const i = thinking ? levels.indexOf(thinking) : -1;
  return Math.max(i, 0);
}

export function modelLabel(m: SessionModel): string {
  return m.name ?? m.id;
}

export function profileSummary(p: Profile): string {
  return [
    p.name,
    p.provider && p.model ? `${p.provider}/${p.model}` : (p.model ?? null),
    p.thinking ? `effort ${p.thinking}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function modelSummary(session: Session): string {
  const model = session.model;
  if (!model) return profileSummary(session.profileSnapshot);
  const effort =
    session.thinking && model.thinkingLevels.length > 1 ? ` · effort ${session.thinking}` : "";
  return `${modelLabel(model)}${effort}`;
}

export function groupModels(
  models: SessionModel[],
  query: string,
): { provider: string; models: SessionModel[] }[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const groups: { provider: string; models: SessionModel[] }[] = [];
  for (const m of models) {
    const hay = `${m.provider}/${m.id} ${m.name ?? ""}`.toLowerCase();
    if (!tokens.every((t) => hay.includes(t))) continue;
    let g = groups.find((x) => x.provider === m.provider);
    if (!g) {
      g = { provider: m.provider, models: [] };
      groups.push(g);
    }
    g.models.push(m);
  }
  return groups;
}

export function contextMeter(s: Pick<Session, "stats" | "compacting">): {
  label: string;
  detail: string;
  percent: number | null;
  tone: "muted" | "warning" | "danger";
} | null {
  const c = s.stats?.context;
  if (!c) return null;
  const fmt = (n: number) => n.toLocaleString("en-US");
  const label = s.compacting
    ? "Compacting…"
    : c.percent === null
      ? "—"
      : `${Math.round(c.percent)}%`;
  const detail =
    c.tokens === null
      ? `Known after the next reply (window ${fmt(c.window)} tokens)`
      : `${fmt(c.tokens)} of ${fmt(c.window)} tokens`;
  const p = c.percent ?? 0;
  return {
    label,
    detail,
    percent: c.percent,
    tone: p >= 90 ? "danger" : p >= 75 ? "warning" : "muted",
  };
}

export function piControlsAvailable(host: Host | undefined, block: unknown): boolean {
  return !block && host?.capabilities?.sessionControls === true;
}
