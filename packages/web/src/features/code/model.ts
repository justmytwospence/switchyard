import type {
  AttentionItem,
  Checkout,
  Connectivity,
  Host,
  Interaction,
  Profile,
  Project,
  ProviderUsage,
  Run,
  RuntimeCapabilities,
  Scope,
  ScopeReason,
  Session,
  SessionModel,
  SlashCommand,
  TrackedIssue,
  TranscriptItem,
  Workspace,
} from "@switchyard/protocol";
import {
  DEFAULT_WORKTREE_DIR,
  issueBranchSet,
  issueLookup,
  sessionScopeReason,
  ThinkingLevel,
} from "@switchyard/protocol";
import { formatDuration } from "../../lib/time";
import { PANE_LIMITS } from "../../prefs";
import { isBusyRuntime, isLiveRuntime, sessionsNeedingAttention } from "../../sync/selectors";
import type { StreamBuffer } from "../../sync/store";
import {
  liveHostIds,
  type RowWhere,
  sessionIsWhere,
  sessionWhereToken,
  type Where,
} from "../scopes/where";
import { toolViewOf } from "./toolView";

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

export interface NewSessionDefaults {
  hostId: string;
  /** The main checkout's workspace on that host; null means "New worktree…". */
  workspaceId: string | null;
  checkoutId: string | null;
}

/** The scope's projects first (in their existing order), then the rest. */
export function orderProjectsForScope<T extends { id: string }>(
  projects: T[],
  scopeProjectIds: string[] | null,
): T[] {
  if (!scopeProjectIds) return projects;
  const inView = projects.filter((p) => scopeProjectIds.includes(p.id));
  return [...inView, ...projects.filter((p) => !scopeProjectIds.includes(p.id))];
}

/** The project New session starts on: the asked one, else the last used or selected one when the scope covers it, else the first listed. */
export function newSessionProject(input: {
  initial: string | null;
  last: string | null;
  selected: string | null;
  ordered: { id: string }[];
  scopeProjectIds: string[] | null;
}): string {
  const listed = (id: string | null): id is string =>
    !!id && input.ordered.some((p) => p.id === id);
  if (listed(input.initial)) return input.initial;
  const pick = [input.last, input.selected].find(
    (id) => listed(id) && (!input.scopeProjectIds || input.scopeProjectIds.includes(id)),
  );
  return pick ?? input.ordered[0]?.id ?? "";
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

export type NavGrouping = "none" | "project" | "host" | "status";
export const NAV_GROUPINGS: { value: NavGrouping; label: string; hint: string }[] = [
  { value: "none", label: "None", hint: "One list of sessions" },
  { value: "project", label: "Project", hint: "Sessions by project" },
  { value: "host", label: "Host", hint: "Sessions by host" },
  { value: "status", label: "Status", hint: "Sessions by status" },
];

export type NavSort = "activity" | "created" | "name" | "status";

export const NAV_SORTS: { value: NavSort; label: string; hint: string }[] = [
  { value: "activity", label: "Recent activity", hint: "Latest activity first" },
  { value: "created", label: "Newest", hint: "Most recently started first" },
  { value: "name", label: "Name", hint: "A to Z" },
  { value: "status", label: "Status", hint: "Waiting and running first" },
];

export function readNavPresentation(stored: unknown): { groupBy: NavGrouping; sort: NavSort } {
  const prefs = stored && typeof stored === "object" ? (stored as Record<string, unknown>) : {};
  const validGroup = NAV_GROUPINGS.some((g) => g.value === prefs.groupBy);
  const validSort = (v: unknown): v is NavSort => NAV_SORTS.some((s) => s.value === v);
  const layouts = new Map<string, NavGrouping>([
    ["recent", "none"],
    ["projects", "project"],
    ["where", "host"],
    ["hosts", "host"],
    ["status", "status"],
  ]);
  const oldLayout = typeof prefs.layout === "string" ? prefs.layout : "";
  const sorts =
    prefs.sorts && typeof prefs.sorts === "object" ? (prefs.sorts as Record<string, unknown>) : {};
  const oldSort = validSort(sorts[oldLayout])
    ? sorts[oldLayout]
    : oldLayout === "hosts"
      ? sorts.where
      : undefined;
  return {
    groupBy: validGroup ? (prefs.groupBy as NavGrouping) : (layouts.get(oldLayout) ?? "none"),
    sort: validSort(prefs.sort) ? prefs.sort : validSort(oldSort) ? oldSort : "activity",
  };
}

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

/**
 * One line for a session's row saying what it last did or is waiting for: the question it asks,
 * why it failed or stopped, else the first line of Pi's last reply. Null when there is nothing.
 */
export function rowPreview(
  s: Pick<Session, "runtime" | "runtimeDetail" | "lastAssistantText" | "compacting">,
  pendingTitle: string | null,
): string | null {
  const clip = (t: string) => (t.length > 140 ? `${t.slice(0, 139)}…` : t);
  if (pendingTitle?.trim()) return clip(`Asks: ${pendingTitle.trim()}`);
  const detail = s.runtimeDetail?.trim().split("\n")[0]?.trim();
  if (s.runtime === "failed") return clip(detail || "Pi exited with an error");
  if (s.runtime === "starting") return clip(detail || "Starting Pi…");
  if (s.runtime === "interrupted" && detail) return clip(detail);
  if (s.compacting) return "Compacting context…";
  for (const raw of (s.lastAssistantText ?? "").split("\n")) {
    // Markdown markers say nothing in one line of plain text.
    const line = raw
      .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s*|\d+[.)]\s+)/, "")
      .replace(/[*_`]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (line && !/^[-=|:\s]+$/.test(line)) return clip(line);
  }
  return null;
}

/** The title of each session's oldest pending question. */
export function pendingTitles(
  interactions: Record<string, Pick<Interaction, "sessionId" | "state" | "title" | "createdAt">>,
): Map<string, string> {
  const oldest = new Map<string, { title: string; at: string }>();
  for (const i of Object.values(interactions)) {
    if (i.state !== "pending") continue;
    const cur = oldest.get(i.sessionId);
    if (!cur || i.createdAt < cur.at) oldest.set(i.sessionId, { title: i.title, at: i.createdAt });
  }
  return new Map([...oldest].map(([id, v]) => [id, v.title]));
}

export interface NavRow {
  session: Session;
  attention: boolean;
  bucket: StatusBucket;
  project: string | null;
  branch: string | null;
  where: RowWhere | null;
  issue: { number: number; url: string; title: string } | null;
  leaves: boolean;
  outside: NavOutside | null;
}
export type NavOutside = "scope" | "where" | "status";
export interface NavSection {
  key: string;
  label: string;
  rows: NavRow[];
  projectId?: string;
  hostId?: string;
  hostState?: Connectivity;
}
export interface SessionList {
  rows: NavRow[];
  sections: NavSection[];
}
export interface NavOptions {
  filter: NavFilter;
  query: string;
  groupBy?: NavGrouping;
  showSubagents?: boolean;
  sort?: NavSort;
  needsInputFirst?: boolean;
  scope?: Scope | null;
  where?: Where | null;
  keepId?: string | null;
}

export interface NavInput {
  projects: Record<string, Project>;
  workspaces: Record<string, Workspace>;
  sessions: Record<string, Session>;
  hosts: Record<string, Host>;
  attention: Record<string, AttentionItem>;
  interactions: Record<string, Interaction>;
  /** Tracked issues: decide a GitHub scope's sessions. */
  issues?: Record<string, TrackedIssue>;
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
  issue: TrackedIssue | null;
  leaves: boolean;
  outside: NavOutside | null;
}

function projectLabel(projectId: string | null, project: Project | null): string {
  return project?.name ?? (projectId ? "Unknown project" : "Other sessions");
}

function branchFor(e: NavEntry): string | null {
  if (e.ws) return e.ws.provenance === "main" ? null : workspaceLabel(e.ws);
  return e.projectId === null ? lastSegment(e.session.cwd) : null;
}

/** One row per eligible session; grouping changes headings, not membership. */
export function buildSessionList(input: NavInput, opts: NavOptions): SessionList {
  const groupBy = opts.groupBy ?? "none";
  const sort = opts.sort ?? "activity";
  const needsFirst = opts.needsInputFirst ?? true;
  const q = opts.query.trim().toLowerCase();
  const attn = sessionsNeedingAttention(input.attention, input.interactions);
  const issueSet = opts.scope
    ? issueBranchSet(opts.scope, Object.values(input.issues ?? {}))
    : null;
  const issueOf = issueLookup(Object.values(input.issues ?? {}));
  const multiHost = liveHostIds(input.hosts).length >= 2;
  const entries: NavEntry[] = [];
  for (const s of Object.values(input.sessions)) {
    if (s.archivedAt !== null || (s.provenance === "subagent" && !opts.showSubagents)) continue;
    const parent =
      s.provenance === "subagent" && s.parentSessionId
        ? input.sessions[s.parentSessionId]
        : undefined;
    const reason = opts.scope
      ? sessionScopeReason(opts.scope, parent ?? s, input.workspaces, issueSet)
      : "filter";
    const needs = attn.has(s.id);
    const outside: NavOutside | null =
      reason === null
        ? "scope"
        : !sessionIsWhere(opts.where, s)
          ? "where"
          : (opts.filter === "active" && !isLive(s) && !needs) ||
              (opts.filter === "attention" && !needs)
            ? "status"
            : null;
    if (outside && s.id !== opts.keepId) continue;
    const ws = s.workspaceId ? (input.workspaces[s.workspaceId] ?? null) : null;
    const projectId = s.projectId ?? ws?.projectId ?? null;
    const project = projectId ? (input.projects[projectId] ?? null) : null;
    const hostId = s.hostId;
    const hostName = input.hosts[hostId]?.name ?? "Unknown host";
    const issue = issueOf(ws);
    if (
      q &&
      ![
        s.title,
        s.subtitle ?? "",
        ws?.branch ?? "",
        project?.name ?? "",
        hostName,
        s.cwd,
        issue ? `#${issue.number}\n${issue.title}` : "",
      ]
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
      issue,
      leaves: reason === "live",
      outside,
    });
  }
  entries.sort((a, b) => {
    if (needsFirst && a.attention !== b.attention) return Number(b.attention) - Number(a.attention);
    const comparison =
      sort === "created"
        ? b.session.createdAt.localeCompare(a.session.createdAt)
        : sort === "name"
          ? a.session.title.localeCompare(b.session.title, undefined, {
              numeric: true,
              sensitivity: "base",
            })
          : sort === "status"
            ? BUCKET_RANK[a.bucket] - BUCKET_RANK[b.bucket]
            : b.session.lastActivityAt.localeCompare(a.session.lastActivityAt);
    return comparison || a.session.id.localeCompare(b.session.id);
  });
  const row = (e: NavEntry): NavRow => ({
    session: e.session,
    attention: e.attention,
    bucket: e.bucket,
    project: projectLabel(e.projectId, e.project),
    branch: branchFor(e),
    where: sessionWhereToken(e.session, e.hostName, multiHost),
    issue: e.issue ? { number: e.issue.number, url: e.issue.url, title: e.issue.title } : null,
    leaves: e.leaves,
    outside: e.outside,
  });
  if (groupBy === "none") return { rows: entries.map(row), sections: [] };
  const sections = new Map<string, NavSection>();
  for (const e of entries) {
    const key =
      groupBy === "project"
        ? `p:${e.projectId ?? "__none"}`
        : groupBy === "host"
          ? `h:${e.hostId}`
          : `s:${e.bucket}`;
    let section = sections.get(key);
    if (!section) {
      const host = input.hosts[e.hostId];
      section =
        groupBy === "project"
          ? {
              key,
              label: projectLabel(e.projectId, e.project),
              rows: [],
              ...(e.projectId ? { projectId: e.projectId } : {}),
            }
          : groupBy === "host"
            ? {
                key,
                label: e.hostName,
                rows: [],
                hostId: e.hostId,
                hostState: host && !host.revokedAt ? host.connectivity : "unreachable",
              }
            : {
                key,
                label:
                  e.bucket === "idle"
                    ? "Other sessions"
                    : STATUS_BUCKETS.find((b) => b.value === e.bucket)!.label,
                rows: [],
              };
      sections.set(key, section);
    }
    section.rows.push(row(e));
  }
  const ordered = [...sections.values()];
  ordered.sort((a, b) => {
    if (groupBy === "status") {
      return (
        BUCKET_RANK[a.key.slice(2) as StatusBucket] - BUCKET_RANK[b.key.slice(2) as StatusBucket]
      );
    }
    const missing = (s: NavSection) =>
      groupBy === "project"
        ? Number(!s.projectId || !input.projects[s.projectId])
        : Number(!input.hosts[s.hostId!]);
    return missing(a) - missing(b) || a.label.localeCompare(b.label) || a.key.localeCompare(b.key);
  });
  return { rows: [], sections: ordered };
}

function listRows(list: SessionList): NavRow[] {
  return [...list.rows, ...list.sections.flatMap((section) => section.rows)];
}
export function navRowCount(list: SessionList): number {
  return listRows(list).filter((row) => !row.outside).length;
}
export function navNeedsInput(list: SessionList): { count: number; first: string | null } {
  const matching = listRows(list).filter((row) => !row.outside && row.attention);
  matching.sort(
    (a, b) =>
      b.session.lastActivityAt.localeCompare(a.session.lastActivityAt) ||
      a.session.id.localeCompare(b.session.id),
  );
  return { count: matching.length, first: matching[0]?.session.id ?? null };
}
export function navOutsideRow(list: SessionList): NavRow | null {
  return listRows(list).find((row) => row.outside) ?? null;
}

/** Where a session stands: its issue, and why it is in the selected scope (null: it is not). */
export interface SessionPlace {
  issue: TrackedIssue | null;
  scope: Scope | null;
  reason: ScopeReason | null;
}

export function sessionPlace(input: {
  session: Session;
  sessions: Record<string, Session>;
  workspaces: Record<string, Workspace>;
  issues: TrackedIssue[];
  scope: Scope | null;
}): SessionPlace {
  const { session, scope } = input;
  const ws = session.workspaceId ? input.workspaces[session.workspaceId] : undefined;
  const issue = issueLookup(input.issues)(ws);
  const parent =
    session.provenance === "subagent" && session.parentSessionId
      ? input.sessions[session.parentSessionId]
      : undefined;
  const reason = scope
    ? sessionScopeReason(
        scope,
        parent ?? session,
        input.workspaces,
        issueBranchSet(scope, input.issues),
      )
    : null;
  return { issue, scope, reason };
}

/** A short note on a session's place in the selected scope; null when there is nothing to say. */
export function scopeNote(
  place: SessionPlace,
  session: Pick<Session, "archivedAt">,
): { label: string; title: string } | null {
  const v = place.scope;
  if (!v || session.archivedAt) return null;
  if (place.reason === null)
    return {
      label: `Not in ${v.name}`,
      title: `Outside the selected scope. Pin it to ${v.name} from the session menu to keep it there.`,
    };
  if (place.reason === "live")
    return {
      label: "No issue",
      title: `In ${v.name} only while it is live. Pin it or link an issue to keep it.`,
    };
  return null;
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
  | "failed"
  | "interrupted"
  | "stopped"
  | "starting"
  | "compacting"
  | "automation"
  | "human";
export type SessionStatusAction = "unarchive" | "resume" | "takeover" | "return";

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
 * (subagent, archived, host, failed, interrupted, stopped, starting, compacting, automation,
 * human control). Null when nothing needs saying. A pending question is in the request dock.
 */
export function sessionStatus(input: {
  session: Session;
  hostLink: HostLink;
  hostName: string;
  hostLastSeenAt: string | null | undefined;
  control: AutomationControl;
  canResume: boolean;
  now: number;
}): SessionStatus | null {
  const { session: s, hostLink: link, hostName } = input;
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

export type SendMode = "prompt" | "steer" | "followUp";

/** What Send does, and the other mode while Pi works when the runtime has both. */
export function sendPlan(
  modes: SendModes,
  whileWorking: "queue" | "steer",
): { primary: SendMode | null; alternate: SendMode | null } {
  if (modes.prompt) return { primary: "prompt", alternate: null };
  const primary: SendMode | null =
    whileWorking === "steer" && modes.steer
      ? "steer"
      : modes.followUp
        ? "followUp"
        : modes.steer
          ? "steer"
          : null;
  const alternate: SendMode | null =
    modes.steer && modes.followUp ? (primary === "steer" ? "followUp" : "steer") : null;
  return { primary, alternate };
}

/** Queued messages in delivery order: steering first, then follow-ups. */
export function queuedMessages(
  queue: Session["queue"],
): { kind: "Steering" | "Queued"; text: string }[] {
  return [
    ...queue.steering.map((text) => ({ kind: "Steering" as const, text })),
    ...queue.followUp.map((text) => ({ kind: "Queued" as const, text })),
  ];
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

/**
 * Tool calls a question stands for: the dock shows the question while it waits and the transcript
 * its outcome line afterwards, so the call's own row would say it twice. An approval keeps its
 * row (it is the command being approved), and so does a dialog nobody described.
 */
export function questionToolCalls(
  interactions: Iterable<Pick<Interaction, "sessionId" | "kind" | "toolCallId">>,
  sessionId: string,
): Set<string> {
  const out = new Set<string>();
  for (const i of interactions) {
    if (i.sessionId === sessionId && i.kind === "question" && i.toolCallId) out.add(i.toolCallId);
  }
  return out;
}

/**
 * The entries the transcript draws. A pending interaction is answered in the dock, so its row is
 * dropped unless `keepsRow` says it still has one (a plan's text). Suggestions show in the
 * composer. A tool row is dropped when its view says `hide` or a question stands for the call.
 */
export function transcriptEntries(
  entries: TimelineEntry[],
  pending: Interaction[],
  keepsRow: (i: Interaction) => boolean,
  hiddenToolCalls: ReadonlySet<string> = new Set(),
): TimelineEntry[] {
  const docked = new Set(pending.filter((i) => !keepsRow(i)).map((i) => i.id));
  return entries.filter((e) => {
    if (e.type === "interaction") return !docked.has(e.interaction.id);
    if (e.type !== "item") return true;
    if (e.item.kind === "interaction") return !docked.has(e.item.data.interactionId);
    if (e.item.kind === "tool") {
      return e.item.data.view?.hide !== true && !hiddenToolCalls.has(e.item.data.toolCallId);
    }
    return !(e.item.kind === "system" && e.item.data.suggestion === true);
  });
}

/** Pi's latest suggested next message, while no message of yours follows it. */
export function currentSuggestion(items: TranscriptItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.kind === "user") return null;
    if (item.kind === "system" && item.data.suggestion === true) {
      return item.data.text.trim() || null;
    }
  }
  return null;
}

/** How much tool activity the transcript shows (Settings > This device). */
export type TranscriptDetail = "detailed" | "normal" | "summary";

export interface WorkSummary {
  durationMs: number | null;
  /** Distinct files edited or written. */
  editedFiles: number;
  /** Distinct files read. */
  readFiles: number;
  commands: number;
  searches: number;
  other: number;
  thinking: number;
  failed: number;
}

export type FoldedEntry =
  | TimelineEntry
  | {
      type: "work";
      key: string;
      entries: TimelineEntry[];
      summary: WorkSummary;
      /** The turn is still running: the row counts up instead of giving a total. */
      live: boolean;
      /** When the turn's user message was sent. */
      startAt: string | null;
    };

function isToolEntry(e: TimelineEntry): e is Extract<TimelineEntry, { type: "item" }> {
  return e.type === "item" && e.item.kind === "tool";
}

/** Counts and elapsed time of the folded tool calls and thinking of one turn. */
export function summarizeWork(entries: TimelineEntry[], turnStartAt: string | null): WorkSummary {
  const s: WorkSummary = {
    durationMs: null,
    editedFiles: 0,
    readFiles: 0,
    commands: 0,
    searches: 0,
    other: 0,
    thinking: 0,
    failed: 0,
  };
  const edited = new Set<string>();
  const read = new Set<string>();
  let toolSum: number | null = null;
  let maxEnd: number | null = null;
  for (const e of entries) {
    if (e.type !== "item") continue;
    const item = e.item;
    if (item.kind === "thinking") s.thinking += 1;
    if (item.kind === "tool") {
      const d = item.data;
      if (d.status === "error") s.failed += 1;
      const view = toolViewOf(d, null);
      switch (view.kind) {
        case "edit":
        case "write":
          edited.add(view.path ?? d.toolCallId);
          break;
        case "read":
          read.add(view.path ?? d.toolCallId);
          break;
        case "command":
          s.commands += 1;
          break;
        case "search":
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
  s.editedFiles = edited.size;
  s.readFiles = read.size;
  const startMs = turnStartAt ? Date.parse(turnStartAt) : Number.NaN;
  if (!Number.isNaN(startMs) && maxEnd !== null) s.durationMs = Math.max(0, maxEnd - startMs);
  else s.durationMs = toolSum;
  return s;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * "Worked for 7s · edited 2 files · ran 1 command". A live summary reads "Working… 7s · …" and
 * takes its duration from the caller's clock.
 */
export function formatWorkSummary(s: WorkSummary, live = false): string {
  const dur = formatDuration(s.durationMs);
  const head = live ? (dur ? `Working… ${dur}` : "Working…") : dur ? `Worked for ${dur}` : "Worked";
  const parts = [head];
  if (s.editedFiles) parts.push(`edited ${plural(s.editedFiles, "file", "files")}`);
  if (s.commands) parts.push(`ran ${plural(s.commands, "command", "commands")}`);
  if (s.readFiles) parts.push(`read ${plural(s.readFiles, "file", "files")}`);
  if (s.searches) parts.push(plural(s.searches, "search", "searches"));
  if (s.other) parts.push(plural(s.other, "other tool call", "other tool calls"));
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
 * Collapse the tool calls and thinking of each finished turn into one "work" entry. Interactions,
 * subagents, notices, system and user items and the turn's final reply never fold.
 *
 * The last turn stays open while the session is busy or anything in it is still streaming:
 * "normal" shows it unfolded, "summary" folds what it has done so far into one live entry (its
 * tool calls, thinking, and the text Pi wrote before a tool call). "detailed" folds nothing.
 */
export function foldTimeline(
  entries: TimelineEntry[],
  busy: boolean,
  level: TranscriptDetail = "normal",
): FoldedEntry[] {
  if (level === "detailed") return entries;
  const turns: TimelineEntry[][] = [];
  for (const e of entries) {
    if (turns.length === 0 || (e.type === "item" && e.item.kind === "user")) turns.push([e]);
    else turns[turns.length - 1]?.push(e);
  }
  const out: FoldedEntry[] = [];
  turns.forEach((turn, idx) => {
    const first = turn[0];
    const startsWithUser = first?.type === "item" && first.item.kind === "user";
    const live = idx === turns.length - 1 && turnIsOpen(turn, busy);
    if (live && level !== "summary") {
      out.push(...turn);
      return;
    }
    let lastAssistant = -1;
    let lastTool = -1;
    turn.forEach((e, i) => {
      if (e.type !== "item") return;
      if (e.item.kind === "assistant") lastAssistant = i;
      if (e.item.kind === "tool") lastTool = i;
    });
    const foldable = new Set<number>();
    turn.forEach((e, i) => {
      if (e.type !== "item") return;
      const k = e.item.kind;
      // A finished turn keeps its last reply; a running one keeps whatever follows its last tool.
      const interim = k === "assistant" && (live ? i < lastTool : i !== lastAssistant);
      if (k === "tool" || k === "thinking" || interim) foldable.add(i);
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
        live,
        startAt,
      });
    });
  });
  return out;
}

/** Vertical rhythm between two transcript rows: tool and thinking lines sit close together. */
export function entrySpacing(
  prev: FoldedEntry | null,
  cur: FoldedEntry,
): "none" | "tight" | "normal" | "turn" {
  if (!prev) return "none";
  const quiet = (e: FoldedEntry) =>
    e.type === "item" && (e.item.kind === "tool" || e.item.kind === "thinking");
  if (quiet(prev) && quiet(cur)) return "tight";
  if (cur.type === "item" && cur.item.kind === "user") return "turn";
  return "normal";
}

/** When the running turn began: the time of the last user message. */
export function workingSince(entries: FoldedEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type === "item" && e.item.kind === "user") return e.item.at;
  }
  return null;
}

/** The host's subscription usage for the provider a session's model uses. */
export function sessionUsage(session: Session, host: Host | undefined): ProviderUsage | null {
  const p = session.model?.provider;
  const provider = p === "anthropic" ? "anthropic" : p === "openai-codex" ? "openai-codex" : null;
  if (!provider) return null;
  return host?.usage?.find((u) => u.provider === provider) ?? null;
}

export function usageTone(pct: number): "neutral" | "warning" | "danger" {
  return pct >= 90 ? "danger" : pct >= 70 ? "warning" : "neutral";
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

export { stringifyArgs } from "./toolView";

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

export type CommandSource = "switchyard" | SlashCommand["source"] | "terminal" | "adapter";

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
