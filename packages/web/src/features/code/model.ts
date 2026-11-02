import type {
  AttentionItem,
  Checkout,
  Host,
  Interaction,
  Project,
  Run,
  RuntimeCapabilities,
  Session,
  TranscriptItem,
  Workspace,
} from "@switchyard/protocol";
import { PANE_LIMITS } from "../../prefs";
import type { StreamBuffer } from "../../sync/store";

/**
 * Pure helpers for the Code feature (navigator tree, composer state,
 * transcript timeline, new-session preview). Tested without a DOM.
 */

export const LIVE_RUNTIMES: Session["runtime"][] = ["starting", "idle", "running", "waiting_input"];
export const BUSY_RUNTIMES: Session["runtime"][] = ["running", "waiting_input"];

export function isLive(s: Pick<Session, "runtime">): boolean {
  return LIVE_RUNTIMES.includes(s.runtime);
}

export function isBusy(s: Pick<Session, "runtime">): boolean {
  return BUSY_RUNTIMES.includes(s.runtime);
}

/* ------------------------------------------------------------------ */
/* Worktree preview                                                    */
/* ------------------------------------------------------------------ */

/** Same rule as the coordinator: slashes in the branch become dashes. */
export function branchSlug(branch: string): string {
  return branch.replaceAll("/", "-");
}

/** `<checkout>/.worktrees/<branch with / replaced by ->`. */
export function worktreePath(checkoutPath: string, branch: string): string {
  return `${checkoutPath.replace(/\/+$/, "")}/.worktrees/${branchSlug(branch.trim())}`;
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

/* ------------------------------------------------------------------ */
/* Navigator tree                                                      */
/* ------------------------------------------------------------------ */

export type NavFilter = "active" | "attention" | "all";

export interface NavSessionRow {
  session: Session;
  attention: boolean;
}

export interface NavWorkspaceGroup {
  key: string;
  workspace: Workspace | null;
  /** Branch, or a description when the workspace is unknown. */
  label: string;
  hostName: string | null;
  sessions: NavSessionRow[];
}

export interface NavProjectGroup {
  key: string;
  project: Project | null;
  label: string;
  workspaces: NavWorkspaceGroup[];
  sessionCount: number;
}

export interface NavInput {
  projects: Record<string, Project>;
  workspaces: Record<string, Workspace>;
  sessions: Record<string, Session>;
  hosts: Record<string, Host>;
  attention: Record<string, AttentionItem>;
  interactions: Record<string, Interaction>;
}

export function sessionsNeedingAttention(
  attention: Record<string, AttentionItem>,
  interactions: Record<string, Interaction>,
): Set<string> {
  const out = new Set<string>();
  for (const a of Object.values(attention)) {
    if (a.sessionId && a.resolvedAt === null) out.add(a.sessionId);
  }
  for (const i of Object.values(interactions)) if (i.state === "pending") out.add(i.sessionId);
  return out;
}

function lastSegment(p: string): string {
  return p.replace(/\/+$/, "").split("/").pop() || p;
}

export function workspaceLabel(ws: Workspace | null | undefined, cwd?: string): string {
  if (!ws) return cwd ? lastSegment(cwd) : "No workspace";
  if (ws.branch) return ws.branch;
  return `${lastSegment(ws.path)} (detached)`;
}

/**
 * Project -> workspace -> sessions. `active` keeps live sessions and those
 * needing attention (and workspaces/projects that still have rows). `all`
 * includes stopped sessions and workspaces without sessions. Archived sessions
 * are never listed.
 */
export function buildNavTree(
  input: NavInput,
  opts: { filter: NavFilter; query: string },
): NavProjectGroup[] {
  const q = opts.query.trim().toLowerCase();
  const attn = sessionsNeedingAttention(input.attention, input.interactions);
  const projects = new Map<string, NavProjectGroup>();
  const wsGroups = new Map<string, NavWorkspaceGroup>();

  const projectGroup = (projectId: string | null): NavProjectGroup => {
    const key = projectId ?? "__none";
    let g = projects.get(key);
    if (!g) {
      const project = projectId ? (input.projects[projectId] ?? null) : null;
      g = {
        key,
        project,
        label: project?.name ?? (projectId ? "Unknown project" : "Other sessions"),
        workspaces: [],
        sessionCount: 0,
      };
      projects.set(key, g);
    }
    return g;
  };
  const wsGroup = (
    pg: NavProjectGroup,
    ws: Workspace | null,
    fallbackKey: string,
    session?: Session,
  ): NavWorkspaceGroup => {
    const key = ws ? ws.id : `${pg.key}:${fallbackKey}`;
    let g = wsGroups.get(key);
    if (!g) {
      const hostId = ws?.hostId ?? session?.hostId ?? null;
      g = {
        key,
        workspace: ws,
        label: workspaceLabel(ws, session?.cwd),
        hostName: hostId ? (input.hosts[hostId]?.name ?? "Unknown host") : null,
        sessions: [],
      };
      wsGroups.set(key, g);
      pg.workspaces.push(g);
    }
    return g;
  };

  const matches = (s: Session, ws: Workspace | null, project: Project | null) => {
    if (!q) return true;
    return [s.title, s.subtitle ?? "", ws?.branch ?? "", project?.name ?? "", s.cwd]
      .join("\n")
      .toLowerCase()
      .includes(q);
  };

  const sessions = Object.values(input.sessions)
    .filter((s) => s.archivedAt === null)
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));

  for (const s of sessions) {
    const needs = attn.has(s.id);
    if (opts.filter === "active" && !isLive(s) && !needs) continue;
    if (opts.filter === "attention" && !needs) continue;
    const ws = s.workspaceId ? (input.workspaces[s.workspaceId] ?? null) : null;
    const projectId = s.projectId ?? ws?.projectId ?? null;
    const project = projectId ? (input.projects[projectId] ?? null) : null;
    if (!matches(s, ws, project)) continue;
    const pg = projectGroup(projectId);
    const wg = wsGroup(pg, ws, ws ? ws.id : `cwd:${s.hostId}:${s.cwd}`, s);
    wg.sessions.push({ session: s, attention: needs });
    pg.sessionCount++;
  }

  if (opts.filter === "all") {
    // Workspaces and projects without sessions still appear, so a new session can start there.
    for (const ws of Object.values(input.workspaces)) {
      if (ws.archivedAt) continue;
      const project = input.projects[ws.projectId] ?? null;
      if (
        q &&
        ![ws.branch ?? "", project?.name ?? "", ws.path].join("\n").toLowerCase().includes(q)
      )
        continue;
      wsGroup(projectGroup(ws.projectId), ws, ws.id);
    }
    if (!q) for (const p of Object.values(input.projects)) projectGroup(p.id);
  }

  const groups = [...projects.values()];
  for (const g of groups) {
    g.workspaces.sort((a, b) => {
      const la = a.sessions[0]?.session.lastActivityAt ?? "";
      const lb = b.sessions[0]?.session.lastActivityAt ?? "";
      if (la !== lb) return lb.localeCompare(la);
      // The main checkout first, then by branch.
      const ma = a.workspace?.provenance === "main" ? 0 : 1;
      const mb = b.workspace?.provenance === "main" ? 0 : 1;
      return ma - mb || a.label.localeCompare(b.label);
    });
  }
  return groups.sort((a, b) => {
    if (a.key === "__none") return 1;
    if (b.key === "__none") return -1;
    return a.label.localeCompare(b.label);
  });
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

/** Why the composer cannot send, or null when it can. Ordered by what the user must fix first. */
export function composerBlockReason(input: {
  session: Session;
  hostLink: HostLink;
  hostName: string;
}): { reason: string; action?: "resume" } | null {
  const { session, hostLink: link } = input;
  if (session.readOnly) return { reason: "Read-only subagent view" };
  if (session.archivedAt) return { reason: "Session archived: unarchive it to send" };
  if (link !== "connected") {
    return {
      reason:
        link === "reconnecting"
          ? `Host offline: ${input.hostName} is reconnecting`
          : `Host offline: ${input.hostName} is unreachable`,
    };
  }
  if (session.runtime === "starting") return { reason: "Starting… you can send once Pi is ready" };
  if (!isLive(session)) {
    return {
      reason: session.nativeHandle
        ? "Session stopped: Resume to send"
        : "Session stopped: no native Pi session to resume",
      action: session.nativeHandle ? "resume" : undefined,
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
  | { type: "item"; key: string; item: TranscriptItem; stream: StreamBuffer | null }
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
