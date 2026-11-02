import type { Host, Interaction, Run, Session, TranscriptItem } from "@switchyard/protocol";
import type { ClientState, StreamBuffer } from "./store.js";
import { markdownToText } from "./uinode.js";

/** Pure selectors and text formatting for the terminal screens. */

export interface SessionGroup {
  projectId: string | null;
  projectName: string;
  sessions: Session[];
}

function matches(s: Session, query: string, extra: string[]): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [s.title, s.subtitle ?? "", s.cwd, s.id, ...extra].some((v) =>
    v.toLowerCase().includes(q),
  );
}

/** Non-archived sessions grouped by project (named groups first, "No project" last). */
export function groupSessions(state: ClientState, query = ""): SessionGroup[] {
  const groups = new Map<string, SessionGroup>();
  for (const s of Object.values(state.sessions)) {
    if (s.archivedAt) continue;
    const project = s.projectId ? state.projects[s.projectId] : undefined;
    const projectName = project?.name ?? "No project";
    const hostName = state.hosts[s.hostId]?.name ?? "";
    if (!matches(s, query, [projectName, hostName])) continue;
    const key = project ? project.id : "";
    let g = groups.get(key);
    if (!g) {
      g = { projectId: project?.id ?? null, projectName, sessions: [] };
      groups.set(key, g);
    }
    g.sessions.push(s);
  }
  for (const g of groups.values()) {
    g.sessions.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  }
  return [...groups.values()].sort((a, b) => {
    if (a.projectId === null) return 1;
    if (b.projectId === null) return -1;
    return a.projectName.localeCompare(b.projectName);
  });
}

/** Sessions in display order (the selectable rows of the list). */
export function flatSessions(groups: SessionGroup[]): Session[] {
  return groups.flatMap((g) => g.sessions);
}

const RUNTIME_LABELS: Record<Session["runtime"], string> = {
  starting: "Starting",
  idle: "Idle",
  running: "Running",
  waiting_input: "Needs input",
  interrupted: "Interrupted",
  failed: "Failed",
  stopped: "Stopped",
};

export function runtimeLabel(runtime: Session["runtime"]): string {
  return RUNTIME_LABELS[runtime];
}

export function connectivityLabel(c: Host["connectivity"]): string {
  return c === "connected" ? "online" : c === "reconnecting" ? "reconnecting" : "unreachable";
}

/** The run currently attached to the session, if any. */
export function sessionRun(state: ClientState, s: Session): Run | null {
  return s.runId ? (state.runs[s.runId] ?? null) : null;
}

export function controlLabel(run: Run | null): string {
  if (!run) return "manual";
  return run.controlMode === "automation" ? "automation" : "you (taken over)";
}

/** Status line parts: runtime, control mode, host + connectivity, client connection. */
export function statusLine(state: ClientState, s: Session): string {
  const host = state.hosts[s.hostId];
  const run = sessionRun(state, s);
  const conn =
    state.connection.state === "live"
      ? "live"
      : state.connection.state === "logged_out"
        ? "signed out"
        : "reconnecting to coordinator";
  const parts = [
    runtimeLabel(s.runtime),
    `control: ${controlLabel(run)}`,
    `host: ${host?.name ?? s.hostId} (${connectivityLabel(host?.connectivity ?? s.connectivity)})`,
    conn,
  ];
  const q = s.queue.followUp.length + s.queue.steering.length;
  if (q > 0) parts.splice(1, 0, `${q} queued`);
  return parts.join(" | ");
}

/** Busy: the agent is working, so Enter queues a follow-up instead of starting a turn. */
export function isBusy(s: Session): boolean {
  return s.runtime === "running" || s.runtime === "waiting_input";
}

/** Why the composer cannot send, or null when it can. */
export function composerDisabledReason(state: ClientState, s: Session): string | null {
  if (s.readOnly) return "Read-only subagent view";
  const host = state.hosts[s.hostId];
  if ((host?.connectivity ?? s.connectivity) !== "connected") return "Host offline";
  if (s.runtime === "starting") return "Session is starting";
  if (s.runtime === "stopped" || s.runtime === "interrupted" || s.runtime === "failed") {
    return `Session ${runtimeLabel(s.runtime).toLowerCase()}: resume it from the web app to send`;
  }
  return null;
}

export function canSteer(state: ClientState, s: Session): boolean {
  return state.hosts[s.hostId]?.capabilities?.steer === true;
}

export function pendingInteractions(state: ClientState, sessionId: string): Interaction[] {
  return Object.values(state.interactions)
    .filter((i) => i.sessionId === sessionId && i.state === "pending")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export type TimelineEntry =
  | { kind: "item"; item: TranscriptItem; stream: StreamBuffer | null }
  | { kind: "stream"; stream: StreamBuffer };

/** Durable items merged with live stream buffers (buffers without an item sort last). */
export function timeline(state: ClientState, sessionId: string): TimelineEntry[] {
  const items = state.transcripts[sessionId]?.items ?? [];
  const ids = new Set(items.map((i) => i.id));
  const out: TimelineEntry[] = items.map((item) => ({
    kind: "item",
    item,
    stream: state.streaming[item.id] ?? null,
  }));
  const orphans = Object.values(state.streaming)
    .filter((b) => b.sessionId === sessionId && !ids.has(b.itemId))
    .sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER));
  for (const stream of orphans) out.push({ kind: "stream", stream });
  return out;
}

export type LineStyle = "user" | "assistant" | "muted" | "tool" | "warning" | "error" | "accent";

export interface Line {
  text: string;
  style: LineStyle;
}

export function toolStatusText(status: "running" | "ok" | "error"): string {
  return status === "running" ? "running" : status === "ok" ? "done" : "failed";
}

function oneLine(text: string, max = 100): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Lines for one timeline entry: messages as plain text, tools as a single line. */
export function entryLines(state: ClientState, entry: TimelineEntry): Line[] {
  if (entry.kind === "stream") {
    const b = entry.stream;
    const out: Line[] = [];
    if (b.thinking)
      out.push({ text: `thinking: ${oneLine(b.thinking.slice(-200))}`, style: "muted" });
    if (b.text) {
      for (const l of markdownToText(b.text)) out.push({ text: l, style: "assistant" });
    }
    if (b.toolArgs || b.toolOutput) {
      out.push({ text: `tool: ${oneLine(b.toolOutput || b.toolArgs)}`, style: "tool" });
    }
    return out;
  }
  const { item, stream } = entry;
  switch (item.kind) {
    case "user": {
      const lines = markdownToText(item.data.text);
      const imgs = item.data.images
        ? ` (+${item.data.images} image${item.data.images > 1 ? "s" : ""})`
        : "";
      return [
        { text: `you: ${lines[0] ?? ""}${lines.length <= 1 ? imgs : ""}`, style: "user" },
        ...lines.slice(1).map((t, i) => ({
          text: `     ${t}${i === lines.length - 2 ? imgs : ""}`,
          style: "user" as const,
        })),
      ];
    }
    case "assistant": {
      const text = item.data.text + (stream?.text ?? "");
      return markdownToText(text).map((t) => ({ text: t, style: "assistant" as const }));
    }
    case "thinking": {
      const text = item.data.text + (stream?.thinking ?? "");
      return [{ text: `thinking: ${oneLine(text.slice(-300))}`, style: "muted" }];
    }
    case "tool": {
      const d = item.data;
      const summary =
        d.summary ||
        oneLine(typeof d.args === "string" ? d.args : JSON.stringify(d.args ?? ""), 80);
      const dur = d.status === "running" ? "" : ` ${formatDuration(d.durationMs)}`;
      return [
        {
          text: `tool ${d.name}: ${oneLine(summary, 80)} [${toolStatusText(d.status)}${dur}]`,
          style: d.status === "error" ? "error" : "tool",
        },
      ];
    }
    case "notice":
      return [
        {
          text: `notice: ${item.data.text}`,
          style:
            item.data.level === "error"
              ? "error"
              : item.data.level === "warning"
                ? "warning"
                : "muted",
        },
      ];
    case "interaction": {
      const i = state.interactions[item.data.interactionId];
      if (!i) return [{ text: "question", style: "accent" }];
      const state_ =
        i.state === "pending"
          ? "waiting for your answer"
          : i.resolution
            ? `${i.state}: ${i.resolution.summary}`
            : i.state;
      return [{ text: `question: ${oneLine(i.title, 80)} (${state_})`, style: "accent" }];
    }
    case "subagent":
      return [
        {
          text: `subagent ${item.data.label}: ${item.data.status} (view only; live control is not supported)`,
          style: "muted",
        },
      ];
    case "system":
      return [
        {
          text: item.data.suggestion ? `suggestion: ${oneLine(item.data.text)}` : item.data.text,
          style: "muted",
        },
      ];
  }
}

/** The last `max` screen lines of the session timeline, wrapped to `width` when given. */
export function transcriptTail(
  state: ClientState,
  sessionId: string,
  max: number,
  width?: number,
): Line[] {
  let lines: Line[] = [];
  for (const e of timeline(state, sessionId)) lines.push(...entryLines(state, e));
  if (width !== undefined) lines = wrapLines(lines, width);
  return lines.slice(Math.max(0, lines.length - max));
}

/** Hard-wrap a line to `width` columns, preferring breaks at spaces. */
export function wrapText(text: string, width: number): string[] {
  const w = Math.max(10, width);
  if (text.length <= w) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > w) {
    let cut = rest.lastIndexOf(" ", w);
    if (cut < w / 2) cut = w;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^ /, "");
  }
  if (rest) out.push(rest);
  return out;
}

/** Wrap styled lines to a width, keeping each line's style. */
export function wrapLines(lines: Line[], width: number): Line[] {
  return lines.flatMap((l) => wrapText(l.text, width).map((text) => ({ text, style: l.style })));
}
