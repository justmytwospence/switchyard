import { existsSync, realpathSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import {
  type AdapterEffect,
  type AdapterRegistry,
  type AdapterSession,
  type ClaimedInteraction,
  genericClaim,
  genericStatusPanel,
  genericWidgetPanel,
  piAgentDir,
  type PiUiRequest as SdkUiRequest,
} from "@switchyard/adapter-sdk";
import {
  type BridgeEvent,
  branchSession,
  entriesToMessages,
  type HolderSweep,
  listImportable,
  loadPiSessionManager,
  ManagedSession,
  messagesToItems,
  type PiDialogRequest,
  type PiEvent,
  type PiUiRequest,
  readNativeTranscript,
  type SettledInfo,
  socketDirs,
  sweepHolders,
  treeRows,
  type UiResolved,
} from "@switchyard/pi-runtime";
import {
  type AnswerResult,
  type ImportableSession,
  type Interaction,
  type InteractionResponse,
  isPlaceholderTitle,
  type NativeHandle,
  newId,
  type Panel,
  type Profile,
  type RuntimeState,
  type Session,
  type SessionModel,
  type SessionStats,
  type SnapshotResult,
  SwitchyardError,
  type ThinkingLevel,
  type TranscriptItem,
  titleFrom,
  type UINode,
  ui,
} from "@switchyard/protocol";
import type { AdapterCatalog } from "./adapters.js";
import type { HostDb } from "./db/index.js";
import type { CoordinatorLink } from "./link.js";
import type { Logger } from "./logger.js";

export const RESTART_NOTICE = "Host agent restarted while Pi was working; resume to continue";
export const RESTART_DETAIL = "Host agent restarted";
export const RESTART_TERMINAL_LOST_DETAIL =
  "Host agent restarted and the terminal session had ended";
/** The notice for a terminal session whose holder was gone (or unusable) when the agent came back. */
export const terminalLostNotice = (reason: string): string =>
  `Host agent restarted and the terminal session had ended (${reason}); resume to continue`;
export const QUEUED_ANSWER_SUMMARY = "Answered from your earlier form";
export const PI_CLOSED_SUMMARY = "Pi closed this question (timeout or abort)";
export const UNSUPPORTED_TITLE = "Terminal-only interface requested";
export const UNSUPPORTED_TEXT =
  "An extension opened a terminal-only dialog. In RPC mode Pi gave it no answer, so the extension continued without one.";
export const PROMPT_NOT_SENT = "The launch prompt was not sent to Pi";
export const PROMPT_NOT_SENT_LIVE = "Session was already live; the initial prompt was not sent";
/** What a person can do about a command that needs a live session, by command. */
const NOT_LIVE = {
  prompt: "resume to send",
  abort: "nothing to abort",
  models: "resume to list models",
  commands: "resume to list commands",
  complete: "resume for completions",
  reload: "resume to reload",
  setModel: "resume to change the model",
  setThinking: "resume to change the thinking level",
  compact: "resume to compact",
  navigate: "resume to rewind",
} as const;

export const SESSION_LIVE_CONFLICT = "Session already live on this host";

/** What a session the previous agent lost becomes: mid-turn work is interrupted, idle is stopped. */
export function lostRuntime(
  rec: Pick<HostSessionRecord, "runtime" | "compacting">,
): "interrupted" | "stopped" {
  return rec.runtime === "idle" && !rec.compacting ? "stopped" : "interrupted";
}
export const TERMINAL_PROMPT_TITLE = "Waiting in the terminal";
export const TERMINAL_PROMPT_TEXT =
  "An extension is showing its own interface in this session's terminal. Open the terminal (switchyard tui) to answer it.";
export const TERMINAL_ANSWERED = "Answered in the terminal";
export const REATTACH_EXPIRED =
  "Host agent restarted; if Pi is still asking, the question appears again";
/** Panel adapter id for the generic status and widget panels. */
export const GENERIC_ADAPTER_ID = "generic";

/** The host's own record of a session (table `sessions`). */
export interface HostSessionRecord {
  id: string;
  title: string;
  subtitle: string | null;
  cwd: string;
  projectId: string | null;
  workspaceId: string | null;
  runId: string | null;
  taskId: string | null;
  dispatchKey: string | null;
  profile: Profile;
  nativeHandle: NativeHandle | null;
  runtime: RuntimeState;
  runtimeDetail: string | null;
  controlRevision: number;
  controlMode: "automation" | "human";
  origin: "human" | "automation";
  readOnly: boolean;
  provenance: Session["provenance"];
  /** Next transcript order number. */
  nextOrder: number;
  queue: Session["queue"];
  stats: SessionStats | null;
  model?: SessionModel | null;
  thinking?: ThinkingLevel | null;
  compacting?: boolean;
  lastAssistantText: string | null;
  lastActivityAt: string;
  createdAt: string;
  /** Terminal sessions: the holder's socket while the session is live. */
  terminal?: { socketPath: string } | null;
  /** Dispatch whose launch prompt this session was sent; a retry dispatch with another key sends its own. */
  promptedDispatchKey?: string | null;
  /** When the session last left a live runtime (pruning age). */
  endedAt?: string | null;
}

export interface StartParams {
  sessionId: string;
  title: string;
  workspacePath: string;
  projectId: string | null;
  profile: Profile;
  nativeHandle: NativeHandle | null;
  initialPrompt: string | null;
  dispatchKey: string | null;
  controlRevision: number;
  controlMode: "automation" | "human";
  origin: "human" | "automation";
  readOnly?: boolean;
  runId?: string | null;
  taskId?: string | null;
}

export interface StartResult {
  sessionId: string;
  nativeHandle: NativeHandle | null;
  workspacePath: string;
  runtime: RuntimeState;
  reused: boolean;
  /** Set when the launch prompt could not be delivered (the session itself is running). */
  promptError: string | null;
}

export interface SupervisorOptions {
  db: HostDb;
  link: CoordinatorLink;
  hostId: string;
  catalog: AdapterCatalog;
  log: Logger;
  piBin?: string;
  /** Extra environment for Pi (e.g. PI_CODING_AGENT_DIR). */
  env?: Record<string, string | undefined>;
  /** Extra `-e` extensions for every Pi (tests). */
  extraExtensions?: string[];
  /** Directory for bridge sockets. */
  runtimeDir?: string;
  /** Pi compatibility; sessions are refused when not compatible. */
  pi: () => { compatible: boolean; reason: string | null };
  /** Run new sessions as interactive Pi in a terminal holder. */
  terminalSessions?: boolean;
}

interface Live {
  rec: HostSessionRecord;
  ms: ManagedSession | null;
  registry: AdapterRegistry | null;
  adapters: AdapterSession | null;
  claims: Map<string, ClaimedInteraction>;
  /** Pi request id -> interaction id. */
  byPiRequest: Map<string, string>;
  chain: Promise<void>;
  statuses: Map<string, string>;
  subagents: Map<string, { id: string; order: number }>;
  awaitingSettled: boolean;
  /** Terminal sessions: the open "waiting in the terminal" interaction. */
  terminalPrompt: string | null;
}

const LIVE_RUNTIMES: RuntimeState[] = ["starting", "idle", "running", "waiting_input"];

interface ControlState {
  controlRevision: number;
  controlMode: "automation" | "human";
}

/**
 * Whether control `next` replaces `cur`: a newer revision always does; at an equal revision only
 * human control does (never back to automation).
 */
export function supersedes(next: ControlState, cur: ControlState): boolean {
  if (next.controlRevision > cur.controlRevision) return true;
  return (
    next.controlRevision === cur.controlRevision &&
    next.controlMode === "human" &&
    cur.controlMode !== "human"
  );
}

function nowIso(): string {
  return new Date().toISOString();
}

function realpathOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Human-readable summary of an answer. */
export function summarizeResponse(resp: InteractionResponse, presentation?: UINode): string {
  switch (resp.kind) {
    case "form": {
      const parts = Object.values(resp.values).map((v) =>
        typeof v === "string" ? v : Array.isArray(v) ? v.join(", ") : v.other,
      );
      const text = parts.filter((p) => p !== "").join("; ");
      return text ? `Answered: ${text}`.slice(0, 500) : "Answered";
    }
    case "confirm":
      return resp.confirmed ? "Confirmed" : "Declined";
    case "action": {
      const label = presentation ? findActionLabel(presentation, resp.actionId) : undefined;
      return label ?? resp.actionId;
    }
    case "cancel":
      return "Canceled";
  }
}

function findActionLabel(node: UINode, actionId: string): string | undefined {
  if (node.t === "actions") return node.actions.find((a) => a.id === actionId)?.label;
  if (node.t === "section") {
    for (const c of node.children) {
      const l = findActionLabel(c, actionId);
      if (l) return l;
    }
  }
  if (node.t === "tabs") {
    for (const tab of node.tabs) {
      for (const c of tab.children) {
        const l = findActionLabel(c, actionId);
        if (l) return l;
      }
    }
  }
  return undefined;
}

function toSdkRequest(req: PiDialogRequest): SdkUiRequest {
  const { type: _t, ...rest } = req;
  return rest as SdkUiRequest;
}

const UNSUPPORTED_ACTIONS = [
  { id: "abort", label: "Stop the run", tone: "danger" as const },
  { id: "message", label: "Send a message to Pi", tone: "primary" as const },
];

/** Presentation of an unsupported terminal-only `ctx.ui.custom()` call. */
export function unsupportedPresentation(): UINode {
  return ui.section(UNSUPPORTED_TITLE, [
    ui.text(UNSUPPORTED_TEXT),
    ui.actions(UNSUPPORTED_ACTIONS),
  ]);
}

/** Presentation of a dialog that can only be answered in a terminal session's terminal. */
export function terminalPromptPresentation(): UINode {
  return ui.section(TERMINAL_PROMPT_TITLE, [
    ui.text(TERMINAL_PROMPT_TEXT),
    ui.actions(UNSUPPORTED_ACTIONS),
  ]);
}

/**
 * Owns every live Pi session on this host: one `ManagedSession` per session (and at most one per
 * native session file), adapter dispatch, interactions, panels, and the mapping of runtime events
 * to durable host events.
 */
export class SessionSupervisor {
  private readonly opts: SupervisorOptions;
  private readonly db: HostDb;
  private readonly link: CoordinatorLink;
  private readonly live = new Map<string, Live>();
  private readonly records = new Map<string, HostSessionRecord>();
  private spawned = 0;
  private closing = false;
  /** Control changes for sessions this host has not created yet. */
  private readonly pendingControl = new Map<string, ControlState>();

  constructor(opts: SupervisorOptions) {
    this.opts = opts;
    this.db = opts.db;
    this.link = opts.link;
    // Only live sessions load now (recovery needs them); the rest load on first use.
    for (const rec of this.db.allJson<HostSessionRecord>(
      "SELECT json FROM sessions WHERE json_extract(json, '$.runtime') IN (?, ?, ?, ?)",
      LIVE_RUNTIMES,
    )) {
      this.records.set(rec.id, rec);
    }
  }

  /** A session's record; startup loads only live ones, the rest load on first use. */
  private getRecord(id: string): HostSessionRecord | undefined {
    let rec = this.records.get(id);
    if (!rec) {
      rec = this.db.getJson<HostSessionRecord>("SELECT json FROM sessions WHERE id = ?", [id]);
      if (rec) this.records.set(id, rec);
    }
    return rec;
  }

  /** Pi processes spawned since this supervisor started. */
  get spawnedProcesses(): number {
    return this.spawned;
  }

  /**
   * Host-agent restart: sessions recorded as live lost their Pi process with the previous agent.
   * Never auto-resume; expire their pending interactions. Sessions that were working become
   * interrupted with a notice; idle ones quietly become stopped (they resume when sent to).
   */
  recoverAfterRestart(): { interrupted: string[]; stopped: string[] } {
    const interrupted: string[] = [];
    const stopped: string[] = [];
    this.db.tx(() => {
      for (const rec of this.records.values()) {
        if (!LIVE_RUNTIMES.includes(rec.runtime)) continue;
        if (rec.terminal) {
          // Its Pi lives in a terminal holder that outlived the agent: reattach later.
          this.expirePending(rec.id, REATTACH_EXPIRED);
          this.reattachCandidates.push(rec.id);
          continue;
        }
        const next = this.markLost(rec, {
          detail: RESTART_DETAIL,
          notice: RESTART_NOTICE,
          expireSummary: "Host agent restarted before this question was answered",
        });
        (next === "interrupted" ? interrupted : stopped).push(rec.id);
      }
    });
    return { interrupted, stopped };
  }

  /** Sessions whose terminal holders may still run after a host-agent restart. */
  private readonly reattachCandidates: string[] = [];

  /**
   * Lost with the previous agent: never auto-resume; expire questions. Working sessions become
   * interrupted with `lost.detail` and the notice `lost.notice`; idle ones quietly become
   * stopped. `was` is the state
   * the previous agent recorded (default: the record as it is now). Call in a tx.
   */
  private markLost(
    rec: HostSessionRecord,
    lost: { detail: string; notice: string; expireSummary: string },
    was: Pick<HostSessionRecord, "runtime" | "compacting"> = rec,
  ): "interrupted" | "stopped" {
    const next = lostRuntime(was);
    rec.runtime = next;
    rec.runtimeDetail = next === "interrupted" ? lost.detail : null;
    rec.compacting = false;
    rec.queue = { steering: [], followUp: [] };
    rec.terminal = null;
    this.expirePending(rec.id, lost.expireSummary);
    if (next === "interrupted") {
      const item: TranscriptItem = {
        id: newId("itm"),
        sessionId: rec.id,
        order: rec.nextOrder++,
        at: nowIso(),
        kind: "notice",
        data: { level: "warning", text: lost.notice },
      };
      this.link.emit({ type: "transcript.item", sessionId: rec.id, data: item });
    }
    this.saveAndEmit(rec);
    return next;
  }

  /**
   * Stop terminal holders no session record refers to (a record lost in a crash, a start that
   * never finished). Killed, not adopted: with no record there is no session, run or control state
   * to attach them to, and Pi's conversation is safe in its native session file. Only this agent's
   * own socket directories are scanned (see `socketDirs`), so other agents' holders are untouched.
   */
  async sweepOrphanHolders(): Promise<HolderSweep> {
    const keep = new Set<string>();
    for (const rec of this.records.values()) if (rec.terminal) keep.add(rec.terminal.socketPath);
    // Records not loaded yet (startup loads only live ones) may still name a holder.
    for (const rec of this.db.allJson<HostSessionRecord>(
      "SELECT json FROM sessions WHERE json_extract(json, '$.terminal.socketPath') IS NOT NULL",
    )) {
      if (!this.records.has(rec.id) && rec.terminal) keep.add(rec.terminal.socketPath);
    }
    return sweepHolders({
      dirs: socketDirs(this.opts.runtimeDir ?? join(tmpdir(), "switchyard")),
      keep,
    });
  }

  /**
   * After `recoverAfterRestart()`: reattach to the terminal holders of sessions that were live.
   * A holder that is gone loses its session like an RPC one: `lost` (interrupted) if it was
   * working, `stopped` if it was idle.
   */
  async reattachTerminals(): Promise<{
    reattached: string[];
    lost: string[];
    stopped: string[];
    starting: string[];
  }> {
    const reattached: string[] = [];
    const lost: string[] = [];
    const stopped: string[] = [];
    const starting: string[] = [];
    for (const id of this.reattachCandidates.splice(0)) {
      const rec = this.getRecord(id);
      if (!rec?.terminal) continue;
      const was = { runtime: rec.runtime, compacting: rec.compacting };
      if (was.runtime === "starting") {
        // Pi may wait on a trust prompt for a long time: finish starting in the background.
        starting.push(rec.id);
        void this.reattachOne(rec, was)
          .then((result) =>
            this.opts.log.info(
              { sessionId: rec.id, result },
              "starting terminal session reattached",
            ),
          )
          .catch((err: unknown) =>
            this.opts.log.warn(
              { sessionId: rec.id, err: errorMessage(err) },
              "starting terminal session could not be reattached",
            ),
          );
        continue;
      }
      const result = await this.reattachOne(rec, was);
      if (result === "reattached") reattached.push(rec.id);
      else if (result === "interrupted") lost.push(rec.id);
      else if (result === "stopped") stopped.push(rec.id);
    }
    return { reattached, lost, stopped, starting };
  }

  private async reattachOne(
    rec: HostSessionRecord,
    was: Pick<HostSessionRecord, "runtime" | "compacting">,
  ): Promise<"reattached" | "interrupted" | "stopped" | "detached"> {
    const socketPath = rec.terminal?.socketPath;
    if (!socketPath) return "stopped";
    const l = this.newLive(rec);
    this.live.set(rec.id, l);
    await this.openAdapters(l, rec.cwd);
    const ms = new ManagedSession({
      sessionId: rec.id,
      cwd: rec.cwd,
      title: rec.title,
      profile: rec.profile,
      nativeHandle: rec.nativeHandle,
      piBin: this.opts.piBin,
      env: this.opts.env,
      runtimeDir: this.opts.runtimeDir,
      nextOrder: rec.nextOrder,
      transport: "terminal",
      terminalSocket: socketPath,
      reattachStarting: was.runtime === "starting",
    });
    l.ms = ms;
    this.wire(l, ms);
    try {
      await ms.start();
      // Stopped while it was still starting: nothing to mark lost.
      if (ms.runtime === "stopped") return "stopped";
      return "reattached";
    } catch (err) {
      if (this.closing) {
        // The agent is stopping again: keep the record so the next agent reattaches.
        this.teardown(l);
        return "detached";
      }
      const reason = errorMessage(err);
      this.opts.log.warn(
        { sessionId: rec.id, err: reason },
        "terminal session could not be reattached",
      );
      this.teardown(l);
      return this.db.tx(() =>
        this.markLost(
          rec,
          {
            detail: `${RESTART_TERMINAL_LOST_DETAIL} (${reason})`,
            notice: terminalLostNotice(reason),
            expireSummary: "Host agent restarted before this question was answered",
          },
          was,
        ),
      );
    }
  }

  private newLive(rec: HostSessionRecord): Live {
    return {
      rec,
      ms: null,
      registry: null,
      adapters: null,
      claims: new Map(),
      byPiRequest: new Map(),
      chain: Promise.resolve(),
      statuses: new Map(),
      subagents: new Map(),
      awaitingSettled: false,
      terminalPrompt: null,
    };
  }

  private async openAdapters(l: Live, workspacePath: string): Promise<void> {
    try {
      l.registry = await this.opts.catalog.forWorkspace(workspacePath);
      this.emitAdapters();
      l.adapters = l.registry.openSession({
        sessionId: l.rec.id,
        emit: (effect) => this.onAdapterEffect(l, effect),
        initialState: this.loadAdapterState(l.rec.id),
      });
    } catch (err) {
      this.opts.log.warn({ err: errorMessage(err) }, "adapter loading failed; using generic only");
      this.diagnostic(
        l.rec.id,
        null,
        "error",
        `Adapters could not be loaded: ${errorMessage(err)}`,
      );
    }
  }

  record(sessionId: string): HostSessionRecord | undefined {
    return this.getRecord(sessionId);
  }

  isLive(sessionId: string): boolean {
    return this.live.get(sessionId)?.ms?.isAlive === true;
  }

  liveSessionIds(): string[] {
    return [...this.live.keys()];
  }

  managedSession(sessionId: string): ManagedSession | null {
    return this.live.get(sessionId)?.ms ?? null;
  }

  /** Whether a live session runs in `path` (or below it). */
  hasActiveSession(path: string): boolean {
    const target = realpathOr(path);
    for (const l of this.live.values()) {
      const cwd = realpathOr(l.rec.cwd);
      if (cwd === target || cwd.startsWith(target + sep)) return true;
    }
    return false;
  }

  /** The Session entity as the host knows it (coordinator-owned fields are placeholders). */
  toSession(rec: HostSessionRecord): Session {
    return {
      id: rec.id,
      title: rec.title,
      subtitle: rec.subtitle,
      hostId: this.opts.hostId,
      workspaceId: rec.workspaceId,
      projectId: rec.projectId,
      cwd: rec.cwd,
      nativeHandle: rec.nativeHandle,
      profileSnapshot: rec.profile,
      runtime: rec.runtime,
      runtimeDetail: rec.runtimeDetail,
      connectivity: "connected",
      runId: rec.runId,
      taskId: rec.taskId,
      provenance: rec.provenance,
      readOnly: rec.readOnly,
      lastActivityAt: rec.lastActivityAt,
      archivedAt: null,
      queue: rec.queue,
      stats: rec.stats,
      model: rec.model ?? null,
      thinking: rec.thinking ?? null,
      compacting: rec.compacting ?? false,
      lastAssistantText: rec.lastAssistantText,
      createdAt: rec.createdAt,
      terminal: rec.terminal != null,
    };
  }

  // ---- control ----

  controlOf(
    sessionId: string,
  ): { controlRevision: number; controlMode: "automation" | "human" } | null {
    const rec = this.getRecord(sessionId);
    return rec ? { controlRevision: rec.controlRevision, controlMode: rec.controlMode } : null;
  }

  /**
   * Apply a control change. Human control wins at an equal revision; automation needs a strictly
   * newer one, so a launch replaying its own revision can never undo a takeover. A session this
   * host does not know yet (a launch still preparing its worktree) keeps the change until
   * `start()` creates it.
   */
  setControl(sessionId: string, controlRevision: number, mode: "automation" | "human") {
    const next: ControlState = { controlRevision, controlMode: mode };
    const rec = this.getRecord(sessionId);
    if (!rec) {
      const pending = this.pendingControl.get(sessionId);
      if (!pending || supersedes(next, pending)) this.pendingControl.set(sessionId, next);
      return { ...this.pendingControl.get(sessionId)! };
    }
    if (supersedes(next, rec)) {
      rec.controlRevision = controlRevision;
      rec.controlMode = mode;
      this.db.tx(() => this.saveRecord(rec));
    }
    return { controlRevision: rec.controlRevision, controlMode: rec.controlMode };
  }

  /**
   * An automation command with a strictly newer revision was accepted: the coordinator only
   * sends those after returning the run to automation, so record automation control too (a
   * missed `setControl` must not stall later continuations).
   */
  noteRevision(sessionId: string, controlRevision: number): void {
    const rec = this.getRecord(sessionId);
    if (rec && controlRevision > rec.controlRevision) {
      rec.controlRevision = controlRevision;
      rec.controlMode = "automation";
      this.db.tx(() => this.saveRecord(rec));
    }
  }

  // ---- lifecycle ----

  /** Start or resume a session. Never starts a second process for a live session or file. */
  async start(p: StartParams): Promise<StartResult> {
    if (this.closing) throw new SwitchyardError("host_unreachable", "Host agent is shutting down");
    // A start for this session is already in flight: let it finish, then decide.
    await this.starts.get(p.sessionId)?.done.catch(() => {});
    if (this.closing) throw new SwitchyardError("host_unreachable", "Host agent is shutting down");
    const existing = this.live.get(p.sessionId);
    if (existing) {
      if (existing.ms?.isAlive || existing.rec.runtime === "starting") {
        const promptError = await this.promptOnReuse(existing, p);
        return {
          sessionId: p.sessionId,
          nativeHandle: existing.rec.nativeHandle,
          workspacePath: existing.rec.cwd,
          runtime: existing.rec.runtime,
          reused: true,
          promptError,
        };
      }
      this.live.delete(p.sessionId);
    }
    const abort = new AbortController();
    const done = this.startNew(p, abort.signal);
    this.starts.set(p.sessionId, { abort, done });
    try {
      return await done;
    } finally {
      if (this.starts.get(p.sessionId)?.done === done) this.starts.delete(p.sessionId);
    }
  }

  /** Starts in flight, so `stop()` can interrupt one that is still waiting for Pi. */
  private readonly starts = new Map<string, { abort: AbortController; done: Promise<unknown> }>();

  private async startNew(p: StartParams, signal: AbortSignal): Promise<StartResult> {
    if (p.readOnly) {
      throw new SwitchyardError(
        "forbidden",
        "Read-only subagent view: live control is not supported",
      );
    }
    const pi = this.opts.pi();
    if (!pi.compatible) {
      throw new SwitchyardError("pi_incompatible", pi.reason ?? "Pi is not available on this host");
    }
    if (!existsSync(p.workspacePath) || !statSync(p.workspacePath).isDirectory()) {
      throw new SwitchyardError("not_found", `Workspace ${p.workspacePath} does not exist`);
    }
    const prev = this.getRecord(p.sessionId);
    const nativeHandle = p.nativeHandle ?? prev?.nativeHandle ?? null;
    if (nativeHandle) {
      const file = realpathOr(nativeHandle.sessionFile);
      for (const l of this.live.values()) {
        const other = l.rec.nativeHandle?.sessionFile;
        if (other && realpathOr(other) === file) {
          throw new SwitchyardError("conflict", SESSION_LIVE_CONFLICT, { sessionId: l.rec.id });
        }
      }
    }

    let nextOrder = prev?.nextOrder ?? 0;
    if (!prev && nativeHandle && existsSync(nativeHandle.sessionFile)) {
      // A session imported by the coordinator: its cached items use orders 0..n-1.
      try {
        const native = await readNativeTranscript(nativeHandle.sessionFile, {
          piBin: this.opts.piBin,
        });
        nextOrder = native.items.length;
      } catch {
        nextOrder = 0;
      }
    }
    const t0 = Date.now();
    let adaptersMs = 0;
    const now = nowIso();
    // The newest control wins: the launch's own, the record's, or a takeover that arrived while
    // the launch was still preparing its workspace.
    let control: ControlState = { controlRevision: p.controlRevision, controlMode: p.controlMode };
    for (const c of [prev, this.pendingControl.get(p.sessionId)]) {
      if (c && supersedes(c, control)) {
        control = { controlRevision: c.controlRevision, controlMode: c.controlMode };
      }
    }
    this.pendingControl.delete(p.sessionId);
    const rec: HostSessionRecord = {
      id: p.sessionId,
      title: p.title,
      subtitle: prev?.subtitle ?? null,
      cwd: p.workspacePath,
      projectId: p.projectId ?? prev?.projectId ?? null,
      workspaceId: prev?.workspaceId ?? null,
      runId: p.runId ?? prev?.runId ?? null,
      taskId: p.taskId ?? prev?.taskId ?? null,
      dispatchKey: p.dispatchKey ?? prev?.dispatchKey ?? null,
      profile: p.profile,
      nativeHandle,
      runtime: "starting",
      runtimeDetail: "Starting Pi…",
      controlRevision: control.controlRevision,
      controlMode: control.controlMode,
      origin: p.origin,
      readOnly: false,
      provenance: prev?.provenance ?? (nativeHandle ? "imported" : "created"),
      nextOrder,
      queue: { steering: [], followUp: [] },
      stats: prev?.stats ?? null,
      model: prev?.model ?? null,
      thinking: prev?.thinking ?? null,
      compacting: false,
      lastAssistantText: prev?.lastAssistantText ?? null,
      lastActivityAt: now,
      createdAt: prev?.createdAt ?? now,
    };
    this.records.set(rec.id, rec);
    const l = this.newLive(rec);
    this.live.set(rec.id, l);
    this.db.tx(() => this.saveAndEmit(rec));
    if (signal.aborted) return this.canceledStart(l);

    // Adapters load while Pi starts; Pi events queue behind them on the session chain.
    const adaptersStart = Date.now();
    this.enqueue(l, async () => {
      await this.openAdapters(l, p.workspacePath);
      adaptersMs = Date.now() - adaptersStart;
    });

    const ms = new ManagedSession({
      sessionId: rec.id,
      cwd: p.workspacePath,
      title: p.title,
      profile: p.profile,
      nativeHandle,
      piBin: this.opts.piBin,
      env: this.opts.env,
      extensions: this.opts.extraExtensions,
      runtimeDir: this.opts.runtimeDir,
      nextOrder,
      transport: this.opts.terminalSessions ? "terminal" : "rpc",
    });
    l.ms = ms;
    this.wire(l, ms);
    const piStart = Date.now();
    try {
      await ms.start(signal);
      if (signal.aborted || ms.runtime === "stopped") {
        if (ms.process) this.spawned++;
        return this.canceledStart(l);
      }
      this.opts.log.info(
        {
          sessionId: rec.id,
          piStartMs: Date.now() - piStart,
          adaptersMs,
          totalMs: Date.now() - t0,
          transport: ms.transport,
        },
        "session started",
      );
      const socketPath = ms.terminalSocket;
      rec.terminal = socketPath ? { socketPath } : null;
      this.db.tx(() => this.saveAndEmit(rec));
    } catch (err) {
      if (ms.process) this.spawned++;
      this.teardown(l);
      if (signal.aborted) return this.canceledStart(l);
      if (this.closing && rec.terminal) {
        // Detached at shutdown while Pi was still starting: keep the record for the next agent.
        throw err instanceof SwitchyardError
          ? err
          : new SwitchyardError("host_unreachable", "Host agent is shutting down");
      }
      rec.terminal = null;
      if (rec.runtime === "starting") {
        rec.runtime = "failed";
        rec.runtimeDetail = errorMessage(err);
      }
      this.db.tx(() => this.saveAndEmit(rec));
      throw err instanceof SwitchyardError
        ? err
        : new SwitchyardError("internal", `Pi failed to start: ${errorMessage(err)}`);
    }
    this.spawned++;
    const promptError = await this.sendInitialPrompt(l, ms, p);
    return {
      sessionId: rec.id,
      nativeHandle: rec.nativeHandle,
      workspacePath: rec.cwd,
      runtime: rec.runtime,
      reused: false,
      promptError,
    };
  }

  /** A stop arrived while Pi was still starting: the session ends `stopped`, resolved, not thrown. */
  private canceledStart(l: Live): StartResult {
    const { rec } = l;
    rec.terminal = null;
    if (rec.runtime === "starting") {
      rec.runtime = "stopped";
      rec.runtimeDetail = null;
    }
    this.teardown(l);
    this.db.tx(() => this.saveAndEmit(rec));
    this.opts.log.info({ sessionId: rec.id }, "start canceled by stop");
    return {
      sessionId: rec.id,
      nativeHandle: rec.nativeHandle,
      workspacePath: rec.cwd,
      runtime: "stopped",
      reused: false,
      promptError: null,
    };
  }

  /**
   * Send a launch's prompt. The dispatch is marked before the prompt goes out, so a duplicate or
   * concurrent call never sends it twice. Returns why it was not delivered, or null.
   */
  private async sendInitialPrompt(
    l: Live,
    ms: ManagedSession,
    p: StartParams,
  ): Promise<string | null> {
    if (!p.initialPrompt) return null;
    // An automated launch taken over meanwhile starts Pi but never sends its prompt.
    if (p.origin === "automation" && l.rec.controlMode === "human") {
      this.opts.log.info(
        { sessionId: l.rec.id, controlRevision: l.rec.controlRevision },
        "launch prompt withheld: a person took over before it was sent",
      );
      return null;
    }
    if (p.dispatchKey) {
      l.rec.promptedDispatchKey = p.dispatchKey;
      this.db.tx(() => this.saveRecord(l.rec));
    }
    try {
      await ms.prompt(p.initialPrompt, [], "prompt");
      return null;
    } catch (err) {
      const msg = errorMessage(err);
      this.opts.log.warn({ sessionId: l.rec.id, err: msg }, "launch prompt failed");
      this.hostItem(l, "notice", { level: "error", text: `${PROMPT_NOT_SENT}: ${msg}` });
      return msg;
    }
  }

  /** A start that found the session already live: deliver a retry's own prompt, or say why not. */
  private async promptOnReuse(existing: Live, p: StartParams): Promise<string | null> {
    if (!p.initialPrompt) return null;
    let reason: string | null = null;
    if (p.dispatchKey) {
      if (existing.rec.promptedDispatchKey === p.dispatchKey) return null;
      if (existing.ms?.isAlive && existing.rec.runtime !== "starting") {
        return this.sendInitialPrompt(existing, existing.ms, p);
      }
      reason =
        existing.rec.runtime === "starting"
          ? "Session is still starting; the prompt was not sent"
          : "Session is not running; the prompt was not sent";
    } else {
      reason = PROMPT_NOT_SENT_LIVE;
    }
    this.hostItem(existing, "notice", {
      level: "error",
      text: reason === PROMPT_NOT_SENT_LIVE ? reason : `${PROMPT_NOT_SENT}: ${reason}`,
    });
    return reason;
  }

  async prompt(
    sessionId: string,
    text: string,
    images: { mimeType: string; data: string }[],
    mode: "prompt" | "steer" | "followUp",
  ) {
    const ms = this.requireLive(sessionId, "prompt");
    const { disposition, view } = await ms.prompt(text, images, mode);
    if (mode === "prompt" && disposition === "started") await this.autoTitle(sessionId, text);
    return { disposition, view };
  }

  /** A session still named by its placeholder takes its name from the first prompt that starts a turn. */
  private async autoTitle(sessionId: string, text: string): Promise<void> {
    const rec = this.getRecord(sessionId);
    if (!rec || !isPlaceholderTitle(rec.title)) return;
    const first = text.trim().split("\n")[0]?.trim() ?? "";
    // Commands and bash lines do not describe the session: wait for a real prompt.
    if (!first || first.startsWith("/") || first.startsWith("!")) return;
    try {
      await this.rename(sessionId, titleFrom(text));
    } catch (err) {
      this.opts.log.warn({ sessionId, err: errorMessage(err) }, "auto-title failed");
    }
  }

  async abort(sessionId: string, clearQueue: boolean) {
    const ms = this.requireLive(sessionId, "abort");
    const { cleared } = await ms.abort(clearQueue);
    return { cleared };
  }

  /** Graceful stop; the runtime becomes `stopped`. A session that is not live is a no-op. */
  async stop(sessionId: string): Promise<{ runtime: RuntimeState }> {
    // A start still waiting for Pi is interrupted, not waited for.
    const pending = this.starts.get(sessionId);
    if (pending) {
      pending.abort.abort();
      await pending.done.catch(() => {});
    }
    const l = this.live.get(sessionId);
    if (!l?.ms) {
      const rec = this.requireRecord(sessionId);
      if (rec.runtime === "starting") {
        rec.runtime = "stopped";
        this.db.tx(() => this.saveAndEmit(rec));
      }
      return { runtime: rec.runtime };
    }
    await l.ms.stop();
    return { runtime: l.rec.runtime };
  }

  async rename(sessionId: string, title: string) {
    const rec = this.requireRecord(sessionId);
    const ms = this.live.get(sessionId)?.ms;
    if (ms?.isAlive) await ms.rename(title);
    rec.title = title;
    this.db.tx(() => this.saveAndEmit(rec));
    return { title };
  }

  async models(sessionId: string) {
    return { models: await this.requireLive(sessionId, "models").models() };
  }

  async commands(sessionId: string) {
    return { commands: await this.requireLive(sessionId, "commands").commands() };
  }

  async complete(sessionId: string, text: string) {
    return this.requireLive(sessionId, "complete").complete(text);
  }

  async reload(sessionId: string) {
    await this.requireLive(sessionId, "reload").reload();
    return { ok: true };
  }

  private piFile(sessionId: string): string {
    const file = this.requireRecord(sessionId).nativeHandle?.sessionFile;
    if (!file) throw new SwitchyardError("invalid_request", "This session has no Pi session file");
    return file;
  }

  async tree(sessionId: string) {
    const file = this.piFile(sessionId);
    const SM = await loadPiSessionManager(this.opts.piBin);
    if (!SM) {
      throw new SwitchyardError(
        "invalid_request",
        "Pi's SessionManager could not be loaded on this host",
      );
    }
    return {
      rows: treeRows(SM.open(file, dirname(file)), this.live.get(sessionId)?.ms?.leafId ?? null),
    };
  }

  async branch(sessionId: string, entryId: string | null, fork: boolean) {
    return branchSession(
      this.piFile(sessionId),
      entryId,
      fork,
      this.opts.piBin,
      undefined,
      true,
      this.live.get(sessionId)?.ms?.leafId ?? null,
    );
  }

  /** Move the running Pi's leaf to an earlier message and rebuild the transcript from its branch. */
  async navigate(
    sessionId: string,
    entryId: string,
    summarize: boolean,
    instructions: string | null,
  ): Promise<{ items: TranscriptItem[]; prefill: string | null }> {
    const ms = this.requireLive(sessionId, "navigate");
    const l = this.live.get(sessionId)!;
    const r = await ms.navigate(entryId, summarize, instructions);
    const start = ms.snapshot().nextOrder;
    const items = messagesToItems(entriesToMessages(r.entries as any[]), {
      sessionId,
      startOrder: start,
      fallbackAt: nowIso(),
    });
    ms.reserveOrders(items.length);
    l.rec.nextOrder = ms.snapshot().nextOrder;
    this.db.tx(() => this.saveAndEmit(l.rec));
    void this.refreshStats(l);
    return { items, prefill: r.editorText };
  }

  async exportSession(sessionId: string) {
    const file = this.piFile(sessionId);
    const info = await stat(file).catch(() => null);
    if (!info) {
      throw new SwitchyardError("native_session_missing", `Native session file not found: ${file}`);
    }
    if (info.size > 50 * 1024 * 1024) {
      throw new SwitchyardError(
        "invalid_request",
        "Session file is too large to export (over 50 MB)",
      );
    }
    return { fileName: basename(file), content: await readFile(file, "utf8") };
  }

  async setModel(sessionId: string, provider: string, modelId: string) {
    return this.requireLive(sessionId, "setModel").setModel(provider, modelId);
  }

  async setThinking(sessionId: string, level: ThinkingLevel) {
    return this.requireLive(sessionId, "setThinking").setThinking(level);
  }

  async compact(sessionId: string, instructions: string | null) {
    const ms = this.requireLive(sessionId, "compact");
    if (ms.compacting) throw new SwitchyardError("conflict", "Compaction is already running");
    if (ms.runtime !== "idle") {
      throw new SwitchyardError("conflict", "Wait for the run to finish before compacting");
    }
    await ms.compact(instructions);
    return { ok: true };
  }

  async adapterAction(sessionId: string, adapterId: string, actionId: string, payload: unknown) {
    const l = this.live.get(sessionId);
    if (!l?.adapters) {
      throw new SwitchyardError(
        "invalid_request",
        "Session is not running; adapter actions need a live session",
      );
    }
    const r = await l.adapters.onAction(adapterId, actionId, payload);
    if (!r.ok) throw new SwitchyardError("invalid_request", r.reason);
    return { ok: true };
  }

  snapshot(sessionId: string): SnapshotResult & { runtime: RuntimeState | null } {
    const rec = this.requireRecord(sessionId);
    const ms = this.live.get(sessionId)?.ms;
    const partial: TranscriptItem[] = [];
    if (ms) {
      const at = nowIso();
      for (const b of ms.snapshot().partial) {
        if (b.kind === "text") {
          partial.push({
            id: b.itemId,
            sessionId,
            order: b.order,
            at,
            kind: "assistant",
            data: { text: b.text, streaming: true },
          });
        } else if (b.kind === "thinking") {
          partial.push({
            id: b.itemId,
            sessionId,
            order: b.order,
            at,
            kind: "thinking",
            data: { text: b.text },
          });
        }
      }
    }
    return {
      partial,
      pendingInteractions: this.pendingInteractions(sessionId),
      runtime: rec.runtime,
    };
  }

  pendingInteractions(sessionId: string): Interaction[] {
    return this.db.allJson<Interaction>(
      "SELECT json FROM interactions WHERE session_id = ? AND state = 'pending' ORDER BY rowid",
      [sessionId],
    );
  }

  interaction(id: string): Interaction | undefined {
    return this.db.getJson<Interaction>("SELECT json FROM interactions WHERE id = ?", [id]);
  }

  async importable(): Promise<{ sessions: ImportableSession[] }> {
    const env = { ...process.env, ...(this.opts.env ?? {}) } as NodeJS.ProcessEnv;
    const root = join(piAgentDir(env), "sessions");
    const list = await listImportable(root);
    const liveFiles = new Set(
      [...this.live.values()].flatMap((l) =>
        l.rec.nativeHandle ? [realpathOr(l.rec.nativeHandle.sessionFile)] : [],
      ),
    );
    return {
      sessions: list.map((s) => ({
        ...s,
        inactive: s.inactive && !liveFiles.has(realpathOr(s.sessionFile)),
      })),
    };
  }

  async readNative(sessionFile: string) {
    if (!existsSync(sessionFile)) {
      throw new SwitchyardError(
        "native_session_missing",
        `Native session file not found: ${sessionFile}`,
      );
    }
    return readNativeTranscript(sessionFile, { piBin: this.opts.piBin });
  }

  /** Stop every live session gracefully (SIGTERM path); each becomes `stopped`. */
  /**
   * Agent shutdown. RPC sessions stop gracefully (runtime `stopped`). Terminal sessions are
   * detached by default: their Pi keeps running in its holder and the next agent reattaches.
   */
  async stopAll(opts: { terminals?: "detach" | "stop" } = {}): Promise<void> {
    this.closing = true;
    await Promise.allSettled(
      [...this.live.values()].map(async (l) => {
        const ms = l.ms;
        if (ms?.transport === "terminal" && ms.isAlive && opts.terminals !== "stop") {
          ms.detach();
          await l.chain.catch(() => {});
          this.teardown(l);
          return;
        }
        await ms?.stop({ graceMs: 5000, termMs: 3000 });
        await l.chain.catch(() => {});
      }),
    );
  }

  // ---- interactions ----

  /**
   * Answer an interaction. The check of id + revision + pending state is atomic with marking
   * it answered (callers serialize per session); a stale or second answer returns
   * `already_answered` with the current interaction and nothing reaches Pi.
   */
  async answer(
    sessionId: string,
    interactionId: string,
    revision: number,
    response: InteractionResponse,
    deviceId: string,
  ): Promise<AnswerResult> {
    // One answer at a time per interaction, even for callers that do not serialize.
    const before = this.answering.get(interactionId) ?? Promise.resolve();
    const run = before
      .catch(() => {})
      .then(() => this.answerNow(sessionId, interactionId, revision, response, deviceId));
    this.answering.set(interactionId, run);
    try {
      return await run;
    } finally {
      if (this.answering.get(interactionId) === run) this.answering.delete(interactionId);
    }
  }

  private readonly answering = new Map<string, Promise<unknown>>();

  private async answerNow(
    sessionId: string,
    interactionId: string,
    revision: number,
    response: InteractionResponse,
    deviceId: string,
  ): Promise<AnswerResult> {
    const current = this.interaction(interactionId);
    if (!current || current.sessionId !== sessionId) {
      throw new SwitchyardError("not_found", `Interaction ${interactionId} not found`);
    }
    if (current.state === "unsupported") {
      return this.answerUnsupported(current, revision, response, deviceId);
    }
    if (current.state !== "pending" || current.revision !== revision) {
      return { status: "already_answered", interaction: current };
    }
    const l = this.live.get(sessionId);
    const claimed = l?.claims.get(interactionId);
    const piRequestId =
      current.source.kind === "extension_ui" ? current.source.piRequestIds.at(-1) : undefined;
    if (!l?.ms?.isAlive || !claimed || !l.adapters || !piRequestId) {
      const expired = this.updateInteraction(current, {
        state: "expired",
        resolution: { by: "pi", summary: "Pi is no longer waiting for this answer", at: nowIso() },
      });
      return { status: "already_answered", interaction: expired };
    }

    const out = await l.adapters.respond(claimed, response).catch((err: unknown) => {
      if (err instanceof Error && err.name === "InteractionResponseError") {
        throw new SwitchyardError("invalid_request", err.message);
      }
      throw err;
    });
    // Re-check after the async mapping: Pi may have closed the dialog meanwhile.
    const latest = this.interaction(interactionId);
    if (latest?.state !== "pending" || latest.revision !== revision) {
      return { status: "already_answered", interaction: latest ?? current };
    }
    if (out.kind === "reclaim") {
      l.claims.set(interactionId, {
        kind: "claim",
        claim: out.claim,
        adapterId: null,
        request: out.request,
      });
      const reshown = this.updateInteraction(latest, {
        adapterId: null,
        title: out.claim.title,
        presentation: out.claim.presentation,
      });
      throw new SwitchyardError(
        "conflict",
        "The adapter for this question failed; it is shown again as a generic form",
        { interaction: reshown, reason: out.reason },
      );
    }
    let resolved: Interaction;
    try {
      resolved = this.updateInteraction(latest, {
        state: response.kind === "cancel" ? "canceled" : "resolved",
        resolution: {
          by: deviceId,
          summary: summarizeResponse(response, latest.presentation),
          at: nowIso(),
        },
      });
    } catch (err) {
      if (err instanceof SwitchyardError && err.code === "already_answered") {
        return {
          status: "already_answered",
          interaction: this.interaction(interactionId) ?? latest,
        };
      }
      throw err;
    }
    l.claims.delete(interactionId);
    if (!l.ms?.isAlive) return { status: "answered", interaction: resolved };
    await l.ms.respondUi(piRequestId, out.response);
    return { status: "answered", interaction: resolved };
  }

  private async answerUnsupported(
    current: Interaction,
    revision: number,
    response: InteractionResponse,
    deviceId: string,
  ): Promise<AnswerResult> {
    if (current.revision !== revision || current.resolution) {
      return { status: "already_answered", interaction: current };
    }
    if (response.kind !== "action" || !["abort", "message"].includes(response.actionId)) {
      throw new SwitchyardError(
        "invalid_request",
        "This interaction only offers: Stop the run, Send a message to Pi",
      );
    }
    const resolved = this.updateInteraction(current, {
      resolution: {
        by: deviceId,
        summary: summarizeResponse(response, current.presentation),
        at: nowIso(),
      },
    });
    if (response.actionId === "abort") {
      const ms = this.live.get(current.sessionId)?.ms;
      if (ms?.isAlive) await ms.abort(true);
    }
    return { status: "answered", interaction: resolved };
  }

  // ---- internals: wiring ----

  private wire(l: Live, ms: ManagedSession): void {
    const rec = l.rec;
    ms.on("item", (item) => {
      rec.nextOrder = Math.max(rec.nextOrder, ms.nextOrder, item.order + 1);
      rec.lastActivityAt = nowIso();
      this.db.tx(() => {
        this.saveRecord(rec);
        this.link.emit({ type: "transcript.item", sessionId: rec.id, data: item });
      });
    });
    ms.on("terminal", ({ socketPath }) => {
      // Recorded as soon as the holder is up, so an agent that stops while Pi is still starting
      // can reattach, and the terminal can be opened to answer a trust prompt.
      rec.terminal = { socketPath };
      this.db.tx(() => this.saveAndEmit(rec));
    });
    ms.on("stream", (delta) => this.link.sendStream(delta));
    ms.on("runtime", ({ runtime, detail }) => {
      const prevRuntime = rec.runtime;
      rec.runtime = runtime;
      rec.runtimeDetail = detail;
      if (runtime !== "running" && runtime !== "waiting_input") {
        rec.queue = runtime === "idle" ? rec.queue : { steering: [], followUp: [] };
      }
      if (runtime === "idle" && (prevRuntime === "running" || prevRuntime === "waiting_input")) {
        // `settled` follows synchronously; emit once, with the settle info.
        l.awaitingSettled = true;
        queueMicrotask(() => {
          if (!l.awaitingSettled) return;
          l.awaitingSettled = false;
          this.db.tx(() => this.saveAndEmit(rec));
        });
        return;
      }
      this.db.tx(() => this.saveAndEmit(rec));
    });
    ms.on("settled", (info: SettledInfo) => {
      l.awaitingSettled = false;
      if (info.lastAssistantText !== null) rec.lastAssistantText = info.lastAssistantText;
      rec.lastActivityAt = nowIso();
      this.db.tx(() =>
        this.saveAndEmit(rec, {
          settled: { aborted: info.aborted, lastAssistantText: info.lastAssistantText },
        }),
      );
      void this.refreshStats(l);
    });
    ms.on("queue", (q) => {
      rec.queue = q;
      this.db.tx(() => this.saveAndEmit(rec));
    });
    ms.on("native", (handle) => {
      rec.nativeHandle = handle;
      this.db.tx(() => this.saveAndEmit(rec));
    });
    ms.on("title", (name) => {
      if (name && name !== rec.title) {
        rec.title = name;
        this.db.tx(() => this.saveAndEmit(rec));
      }
    });
    ms.on("model", (m) => {
      rec.model = m.model;
      rec.thinking = m.thinking;
      this.db.tx(() => this.saveAndEmit(rec));
      void this.refreshStats(l);
    });
    ms.on("compacting", (c) => {
      rec.compacting = c;
      this.db.tx(() => this.saveAndEmit(rec));
      if (!c) void this.refreshStats(l);
    });
    ms.on("diagnostic", (d) => this.diagnostic(rec.id, null, d.level, d.message));
    ms.on("stderr", (text) =>
      this.opts.log.debug({ sessionId: rec.id, stderr: text.slice(0, 2000) }, "pi stderr"),
    );
    ms.on("ui_request", (req) => this.enqueue(l, () => this.onUiRequest(l, req)));
    ms.on("ui_resolved", (r) => this.enqueue(l, () => this.onUiResolved(l, r)));
    ms.on("bridge", (b) => this.enqueue(l, () => this.onBridge(l, b)));
    ms.on("pi_event", (ev) => this.enqueue(l, () => this.onPiEvent(l, ev)));
    ms.on("exit", () => {
      // Runtime (stopped/interrupted) was already recorded by the runtime handler.
      if (rec.terminal) {
        rec.terminal = null;
        this.db.tx(() => this.saveAndEmit(rec));
      }
      void l.chain.finally(() => this.teardown(l));
    });
  }

  private teardown(l: Live): void {
    if (this.live.get(l.rec.id) === l) this.live.delete(l.rec.id);
    l.adapters?.close();
    l.registry?.closeSession(l.rec.id);
    l.claims.clear();
    l.ms = null;
  }

  private enqueue(l: Live, fn: () => Promise<void> | void): void {
    l.chain = l.chain.then(fn).catch((err: unknown) => {
      this.opts.log.error(
        { sessionId: l.rec.id, err: errorMessage(err) },
        "session event handling failed",
      );
      this.diagnostic(
        l.rec.id,
        null,
        "error",
        `Host failed to handle a Pi event: ${errorMessage(err)}`,
      );
    });
  }

  private async refreshStats(l: Live): Promise<void> {
    const ms = l.ms;
    if (!ms?.isAlive) return;
    try {
      const s = await ms.stats();
      const stats = { tokens: s.tokens, costUsd: s.costUsd, context: s.context };
      if (JSON.stringify(stats) === JSON.stringify(l.rec.stats)) return;
      l.rec.stats = stats;
      this.db.tx(() => this.saveAndEmit(l.rec));
    } catch {
      // stats are best effort
    }
  }

  // ---- internals: Pi events ----

  private async onPiEvent(l: Live, ev: PiEvent): Promise<void> {
    const adapters = l.adapters;
    const ms = l.ms;
    switch (ev.type) {
      case "tool_execution_start": {
        if (ev.parentToolCallId || !adapters) return;
        const e = { toolCallId: String(ev.toolCallId), name: String(ev.toolName), args: ev.args };
        await adapters.onToolStart(e);
        await this.applyToolCard(l, e);
        return;
      }
      case "tool_execution_update": {
        if (ev.parentToolCallId || !adapters) return;
        const id = String(ev.toolCallId);
        const pr = ev.partialResult;
        const details =
          pr && typeof pr === "object" && "details" in pr
            ? (pr as { details?: unknown }).details
            : undefined;
        await adapters.onToolUpdate({
          toolCallId: id,
          name: String(ev.toolName),
          args: ms?.toolItem(id)?.data.args ?? {},
          partialResult: pr,
          details,
        });
        return;
      }
      case "tool_execution_end": {
        if (ev.parentToolCallId || !adapters) return;
        const result = ev.result;
        const details =
          result && typeof result === "object" && "details" in result
            ? (result as { details?: unknown }).details
            : undefined;
        const args = ms?.toolItem(String(ev.toolCallId))?.data.args ?? {};
        const e = {
          toolCallId: String(ev.toolCallId),
          name: String(ev.toolName),
          args,
          result,
          isError: ev.isError === true,
          details,
        };
        await adapters.onToolEnd(e);
        await this.applyToolCard(l, e);
        return;
      }
      case "entry_appended":
        if (adapters && ev.entry && typeof ev.entry === "object") await adapters.onEntry(ev.entry);
        return;
      case "message_end": {
        const m = ev.message;
        if (m?.role === "assistant") void this.refreshStats(l);
        if (adapters && m?.role === "custom" && typeof m.customType === "string") {
          await adapters.onCustomMessage({
            customType: m.customType,
            content: m.content,
            display: m.display,
            details: m.details,
          });
        }
        return;
      }
      default:
        return;
    }
  }

  private async applyToolCard(
    l: Live,
    tool: {
      toolCallId: string;
      name: string;
      args: unknown;
      result?: unknown;
      isError?: boolean;
      details?: unknown;
    },
  ): Promise<void> {
    if (!l.adapters || !l.ms) return;
    const card = await l.adapters.toolCard(tool);
    if (!card) return;
    const item = l.ms?.toolItem(tool.toolCallId);
    if (item) l.ms?.patchItem(item.id, { card: card.node, adapterId: card.adapterId });
  }

  private async onUiRequest(l: Live, req: PiUiRequest): Promise<void> {
    const rec = l.rec;
    switch (req.method) {
      case "notify":
        this.hostItem(l, "notice", {
          level:
            req.notifyType === "error"
              ? "error"
              : req.notifyType === "warning"
                ? "warning"
                : "info",
          text: req.message,
        });
        return;
      case "setStatus": {
        const presented = (await l.adapters?.onStatus(req.statusKey, req.statusText)) === true;
        // An adapter that presented this key owns it: leave it out of the generic Status panel.
        if (presented || req.statusText === undefined || req.statusText === "") {
          l.statuses.delete(req.statusKey);
        } else l.statuses.set(req.statusKey, req.statusText);
        this.setPanel(rec.id, {
          adapterId: GENERIC_ADAPTER_ID,
          slot: "status",
          title: "Status",
          node: genericStatusPanel(l.statuses),
          webRenderer: false,
          mobileFallback: null,
        });
        return;
      }
      case "setWidget": {
        const presented = (await l.adapters?.onWidget(req.widgetKey, req.widgetLines)) === true;
        this.setPanel(rec.id, {
          adapterId: GENERIC_ADAPTER_ID,
          slot: `widget:${req.widgetKey}`,
          title: req.widgetKey,
          node: presented ? null : genericWidgetPanel(req.widgetLines),
          webRenderer: false,
          mobileFallback: presented ? null : (req.widgetLines?.join("\n") ?? null),
        });
        return;
      }
      case "setTitle":
        rec.subtitle = req.title || null;
        this.db.tx(() => this.saveAndEmit(rec));
        return;
      case "set_editor_text":
        this.hostItem(l, "system", { text: req.text, suggestion: true });
        return;
      default:
        return this.onDialog(l, req);
    }
  }

  private async onDialog(l: Live, req: PiDialogRequest): Promise<void> {
    const rec = l.rec;
    const sdkReq = toSdkRequest(req);
    const at = nowIso();
    const outcome = l.adapters
      ? await l.adapters.onUiRequest(sdkReq)
      : ({
          kind: "claim",
          claim: genericClaim(sdkReq),
          adapterId: null,
          request: sdkReq,
        } as ClaimedInteraction);
    if (outcome.kind === "queued") {
      const interaction: Interaction = {
        id: newId("int"),
        sessionId: rec.id,
        revision: 1,
        source: { kind: "extension_ui", method: req.method, piRequestIds: [req.id] },
        adapterId: outcome.adapterId,
        title: req.title.split("\n")[0] ?? req.title,
        presentation: ui.text(QUEUED_ANSWER_SUMMARY, "muted"),
        state: "resolved",
        resolution: { by: "host", summary: QUEUED_ANSWER_SUMMARY, at },
        createdAt: at,
      };
      this.db.tx(() => this.insertInteraction(l, interaction));
      if (l.ms?.isAlive) await l.ms.respondUi(req.id, outcome.response);
      return;
    }
    const interaction: Interaction = {
      id: newId("int"),
      sessionId: rec.id,
      revision: 1,
      source: { kind: "extension_ui", method: req.method, piRequestIds: [req.id] },
      adapterId: outcome.adapterId,
      title: outcome.claim.title,
      presentation: outcome.claim.presentation,
      state: "pending",
      resolution: null,
      createdAt: at,
    };
    l.claims.set(interaction.id, outcome);
    l.byPiRequest.set(req.id, interaction.id);
    // Pi may already have closed it (fast timeout) while adapters were consulted.
    const stillPending = l.ms?.pendingUi.some((p) => p.id === req.id) ?? false;
    if (!stillPending) {
      interaction.state = "expired";
      interaction.resolution = { by: "pi", summary: PI_CLOSED_SUMMARY, at };
      l.claims.delete(interaction.id);
    }
    this.db.tx(() => this.insertInteraction(l, interaction));
  }

  private onUiResolved(l: Live, r: UiResolved): void {
    if (r.by === "host") return;
    const interactionId = l.byPiRequest.get(r.id);
    if (!interactionId) return;
    const current = this.interaction(interactionId);
    if (current?.state !== "pending") return;
    l.claims.delete(interactionId);
    if (r.by === "terminal") {
      this.updateInteraction(current, {
        state: "resolved",
        resolution: { by: "terminal", summary: TERMINAL_ANSWERED, at: nowIso() },
      });
      return;
    }
    this.updateInteraction(current, {
      state: "expired",
      resolution: {
        by: "pi",
        summary: r.by === "pi" ? PI_CLOSED_SUMMARY : "Pi exited before this question was answered",
        at: nowIso(),
      },
    });
  }

  private onBridge(l: Live, b: BridgeEvent): void {
    if (l.ms?.transport === "terminal") {
      this.onTerminalPrompt(l, b);
      return;
    }
    if (b.type !== "ui_prompt_start" || b.kind !== "custom") return;
    const at = nowIso();
    const interaction: Interaction = {
      id: newId("int"),
      sessionId: l.rec.id,
      revision: 1,
      source: { kind: "unsupported_custom", title: b.title ?? null },
      adapterId: null,
      title: UNSUPPORTED_TITLE,
      presentation: unsupportedPresentation(),
      state: "unsupported",
      resolution: null,
      createdAt: at,
    };
    this.db.tx(() => this.insertInteraction(l, interaction));
  }

  /**
   * Terminal sessions: a `custom()` interface (or any dialog, when remote answers are unavailable)
   * can only be answered in the terminal. Show that, and mark it answered when the prompt ends.
   */
  private onTerminalPrompt(l: Live, b: BridgeEvent): void {
    if (b.type === "ui_prompt_start") {
      if (b.kind === "custom" && b.remoteBacked) return;
      if (b.kind !== "custom" && l.ms?.remoteDialogs) return;
      if (l.terminalPrompt) return;
      const interaction: Interaction = {
        id: newId("int"),
        sessionId: l.rec.id,
        revision: 1,
        source: { kind: "unsupported_custom", title: b.title ?? null },
        adapterId: null,
        title: TERMINAL_PROMPT_TITLE,
        presentation: terminalPromptPresentation(),
        state: "unsupported",
        resolution: null,
        createdAt: nowIso(),
      };
      l.terminalPrompt = interaction.id;
      this.db.tx(() => this.insertInteraction(l, interaction));
      return;
    }
    if (b.type === "ui_prompt_end" && l.terminalPrompt) {
      const current = this.interaction(l.terminalPrompt);
      l.terminalPrompt = null;
      if (current && current.resolution === null) {
        this.updateInteraction(current, {
          resolution: { by: "terminal", summary: TERMINAL_ANSWERED, at: nowIso() },
        });
      }
    }
  }

  // ---- internals: adapters ----

  private onAdapterEffect(l: Live, effect: AdapterEffect): void {
    const sessionId = l.rec.id;
    switch (effect.type) {
      case "panel":
        this.setPanel(sessionId, {
          adapterId: effect.adapterId,
          slot: effect.slot,
          title: effect.title,
          node: effect.node,
          webRenderer: effect.webRenderer,
          mobileFallback: effect.mobileFallback,
          ...("state" in effect ? { state: effect.state } : {}),
        });
        return;
      case "state":
        this.db.tx(() => {
          if (effect.value === undefined) {
            this.db.run(
              "DELETE FROM adapter_state WHERE session_id = ? AND adapter_id = ? AND key = ?",
              [sessionId, effect.adapterId, effect.key],
            );
          } else {
            this.db.run(
              `INSERT INTO adapter_state (session_id, adapter_id, key, json) VALUES (?, ?, ?, ?)
               ON CONFLICT(session_id, adapter_id, key) DO UPDATE SET json = excluded.json`,
              [sessionId, effect.adapterId, effect.key, JSON.stringify(effect.value)],
            );
          }
        });
        return;
      case "subagent": {
        const link = effect.link;
        const known = l.subagents.get(link.runId);
        const order = known?.order ?? this.allocOrder(l);
        const id = known?.id ?? newId("itm");
        l.subagents.set(link.runId, { id, order });
        const item: TranscriptItem = {
          id,
          sessionId,
          order,
          at: nowIso(),
          kind: "subagent",
          data: {
            runId: link.runId,
            label: link.label,
            status: link.status,
            sessionFile: link.sessionFile,
            linkedSessionId: null,
          },
        };
        this.db.tx(() => {
          this.saveRecord(l.rec);
          this.link.emit({ type: "transcript.item", sessionId, data: item });
        });
        return;
      }
      case "attention":
        // Hosts cannot emit attention events; the coordinator owns attention. Report it as a
        // diagnostic carrying the semantic reason so the coordinator can raise the item.
        this.diagnostic(
          sessionId,
          effect.adapterId,
          "info",
          `Attention (${effect.reason}): ${effect.summary}`,
          {
            attention: { reason: effect.reason, summary: effect.summary },
          },
        );
        return;
      case "log":
        this.opts.log[effect.level === "warning" ? "warn" : effect.level](
          { sessionId, adapterId: effect.adapterId },
          effect.message,
        );
        return;
      case "diagnostic":
        this.diagnostic(
          effect.sessionId ?? sessionId,
          effect.adapterId,
          effect.level,
          effect.message,
        );
        return;
    }
  }

  private loadAdapterState(sessionId: string): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {};
    for (const r of this.db.all<{ adapter_id: string; key: string; json: string }>(
      "SELECT adapter_id, key, json FROM adapter_state WHERE session_id = ?",
      [sessionId],
    )) {
      out[r.adapter_id] ??= {};
      out[r.adapter_id]![r.key] = JSON.parse(r.json);
    }
    return out;
  }

  private lastAdapters = "";

  /** Emit `adapters.updated` when the host's adapter list changed. */
  emitAdapters(): void {
    const adapters = this.opts.catalog.info();
    const json = JSON.stringify(adapters);
    if (json === this.lastAdapters) return;
    this.lastAdapters = json;
    this.db.tx(() =>
      this.link.emit({ type: "adapters.updated", data: { hostId: this.opts.hostId, adapters } }),
    );
  }

  // ---- internals: persistence + events ----

  private setPanel(
    sessionId: string,
    p: Omit<Panel, "sessionId" | "updatedAt"> & { state?: unknown },
  ): void {
    const panel = { ...p, sessionId, updatedAt: nowIso() };
    const prev = this.db.get<{ json: string }>(
      "SELECT json FROM panels WHERE session_id = ? AND adapter_id = ? AND slot = ?",
      [sessionId, p.adapterId, p.slot],
    );
    if (!prev && panel.node === null) return;
    if (prev) {
      const old = JSON.parse(prev.json) as Panel;
      if (JSON.stringify({ ...old, updatedAt: "" }) === JSON.stringify({ ...panel, updatedAt: "" }))
        return;
    }
    this.db.tx(() => {
      if (panel.node === null) {
        this.db.run("DELETE FROM panels WHERE session_id = ? AND adapter_id = ? AND slot = ?", [
          sessionId,
          p.adapterId,
          p.slot,
        ]);
      } else {
        this.db.run(
          `INSERT INTO panels (session_id, adapter_id, slot, json) VALUES (?, ?, ?, ?)
           ON CONFLICT(session_id, adapter_id, slot) DO UPDATE SET json = excluded.json`,
          [sessionId, p.adapterId, p.slot, JSON.stringify(panel)],
        );
      }
      this.link.emit({ type: "panel.updated", sessionId, data: panel });
    });
  }

  panels(sessionId: string): Panel[] {
    return this.db.allJson<Panel>("SELECT json FROM panels WHERE session_id = ?", [sessionId]);
  }

  /** Allocate a transcript order for a host-created item (through the live ManagedSession when there is one). */
  private allocOrder(l: Live): number {
    const order = l.ms ? l.ms.allocOrder(l.rec.nextOrder) : l.rec.nextOrder;
    l.rec.nextOrder = order + 1;
    return order;
  }

  private hostItem<K extends "notice" | "system" | "interaction">(
    l: Live,
    kind: K,
    data: Extract<TranscriptItem, { kind: K }>["data"],
  ): TranscriptItem {
    const item = {
      id: newId("itm"),
      sessionId: l.rec.id,
      order: this.allocOrder(l),
      at: nowIso(),
      kind,
      data,
    } as TranscriptItem;
    l.rec.lastActivityAt = item.at;
    this.db.tx(() => {
      this.saveRecord(l.rec);
      this.link.emit({ type: "transcript.item", sessionId: l.rec.id, data: item });
    });
    return item;
  }

  private insertInteraction(l: Live, i: Interaction): void {
    this.db.run(
      "INSERT INTO interactions (id, session_id, revision, state, json) VALUES (?, ?, ?, ?, ?)",
      [i.id, i.sessionId, i.revision, i.state, JSON.stringify(i)],
    );
    this.link.emit({ type: "interaction.updated", sessionId: i.sessionId, data: i });
    this.hostItem(l, "interaction", { interactionId: i.id });
  }

  private updateInteraction(current: Interaction, patch: Partial<Interaction>): Interaction {
    const next: Interaction = { ...current, ...patch, revision: current.revision + 1 };
    this.db.tx(() => {
      const r = this.db.run(
        "UPDATE interactions SET revision = ?, state = ?, json = ? WHERE id = ? AND revision = ?",
        [next.revision, next.state, JSON.stringify(next), next.id, current.revision],
      );
      if (r.changes !== 1) {
        throw new SwitchyardError("already_answered", "This question was already answered", {
          interaction: this.interaction(current.id),
        });
      }
      this.link.emit({ type: "interaction.updated", sessionId: next.sessionId, data: next });
    });
    return next;
  }

  private expirePending(sessionId: string, summary: string): void {
    for (const i of this.pendingInteractions(sessionId)) {
      this.updateInteraction(i, {
        state: "expired",
        resolution: { by: "host", summary, at: nowIso() },
      });
    }
  }

  private diagnostic(
    sessionId: string | null,
    adapterId: string | null,
    level: "info" | "warning" | "error",
    message: string,
    extra: Record<string, unknown> = {},
  ): void {
    this.db.tx(() =>
      this.link.emit({
        type: "diagnostic",
        ...(sessionId ? { sessionId } : {}),
        data: { sessionId, adapterId, level, message, at: nowIso(), ...extra },
      }),
    );
  }

  private saveRecord(rec: HostSessionRecord): void {
    if (LIVE_RUNTIMES.includes(rec.runtime)) rec.endedAt = null;
    else rec.endedAt ??= nowIso();
    this.db.run(
      "INSERT INTO sessions (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json",
      [rec.id, JSON.stringify(rec)],
    );
  }

  /** Persist the record and emit `session.updated` (plus optional extra keys such as `settled`). */
  private saveAndEmit(rec: HostSessionRecord, extra: Record<string, unknown> = {}): void {
    this.saveRecord(rec);
    this.link.emit({
      type: "session.updated",
      sessionId: rec.id,
      ...(rec.projectId ? { projectId: rec.projectId } : {}),
      ...(rec.taskId ? { taskId: rec.taskId } : {}),
      data: { ...this.toSession(rec), ...extra },
    });
  }

  private requireRecord(sessionId: string): HostSessionRecord {
    const rec = this.getRecord(sessionId);
    if (!rec)
      throw new SwitchyardError("not_found", `Session ${sessionId} is not known on this host`);
    return rec;
  }

  private requireLive(sessionId: string, action: keyof typeof NOT_LIVE): ManagedSession {
    const ms = this.live.get(sessionId)?.ms;
    if (!ms?.isAlive) {
      const rec = this.getRecord(sessionId);
      throw new SwitchyardError(
        rec ? "invalid_request" : "not_found",
        rec
          ? `Session stopped (${rec.runtime}): ${NOT_LIVE[action]}`
          : `Session ${sessionId} is not known on this host`,
      );
    }
    return ms;
  }
}
