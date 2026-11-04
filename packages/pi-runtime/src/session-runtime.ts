import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import {
  type ContextUsage,
  type NativeHandle,
  newId,
  type Profile,
  type RuntimeState,
  SessionCompleteResult,
  type SessionCompleteResult as SessionCompleteResultT,
  type SessionModel,
  type SlashCommand,
  type StreamDelta,
  SwitchyardError,
  ThinkingLevel,
  type ToolItemData,
  type TranscriptItem,
} from "@switchyard/protocol";
import { modelInfo } from "./bridge/pi-model.js";
import { readArgumentHint } from "./command-hints.js";
import { readSessionNameSync } from "./importable.js";
import { type PiExit, PiRpcError, PiRpcProcess } from "./rpc-process.js";
import { PiTerminalProcess } from "./terminal-process.js";
import {
  contentText,
  genericToolSummary,
  type ItemData,
  initialToolData,
  makeItem,
  messagesToItems,
  toolOutputText,
} from "./transcript.js";
import type { PiTransport } from "./transport.js";
import {
  type BridgeEvent,
  isDialogRequest,
  type PiDialogRequest,
  type PiEvent,
  type PiSessionStats,
  type PiState,
  type PiUiRequest,
  type PiUiResponseBody,
  type PromptDisposition,
} from "./types.js";

export type PromptMode = "prompt" | "steer" | "followUp";
export type ProfileFlags = Pick<
  Profile,
  "provider" | "model" | "thinking" | "projectTrust" | "extraArgs" | "resources"
>;

export interface ModelState {
  model: SessionModel | null;
  thinking: ThinkingLevel | null;
}

export interface ManagedSessionOptions {
  /** Switchyard session id (`ses_...`), stamped on every item and stream delta. */
  sessionId: string;
  /** Working directory for Pi. */
  cwd: string;
  title: string;
  profile: ProfileFlags;
  /** Existing native session to resume with `--session <file>`, or null for a new one. */
  nativeHandle?: NativeHandle | null;
  /** UUID for a new native session (`--session-id`); random by default. */
  newNativeSessionId?: string;
  piBin?: string;
  /** Extra environment for Pi (merged over `process.env`). */
  env?: Record<string, string | undefined>;
  /** Additional extensions loaded with `-e` (host-managed, e.g. test fixtures). */
  extensions?: string[];
  /** Additional raw arguments after the profile flags (not validated). */
  extraArgs?: string[];
  /** Directory for the bridge socket. */
  runtimeDir?: string;
  /** First transcript order number to assign (the host persists the counter). */
  nextOrder?: number;
  newItemId?: () => string;
  now?: () => string;
  /** Timeout for Pi to answer `get_state` after spawn (default 30 s). */
  startTimeoutMs?: number;
  /**
   * Whether a custom message becomes a notice item. Default: when `display !== false`.
   * Hosts return false for messages an adapter renders instead.
   */
  customMessageNotice?: (message: any) => boolean;
  /** `rpc` (default): `pi --mode rpc`. `terminal`: interactive Pi in a pty holder. */
  transport?: "rpc" | "terminal";
  /** Terminal transport: attach to this running holder instead of starting Pi. */
  terminalSocket?: string;
}

export const STARTING_IN_TERMINAL =
  "Waiting for Pi to start; if it is asking something, answer it in the terminal";
export const GAP_NOTICE =
  "Some activity while the host agent was restarting is not shown here; open the terminal to see it";
export const QUIT_IN_TERMINAL = "Pi was quit in the terminal";

export interface RuntimeChange {
  runtime: RuntimeState;
  detail: string | null;
}

export interface SettledInfo {
  aborted: boolean;
  lastAssistantText: string | null;
}

export interface QueueState {
  steering: string[];
  followUp: string[];
}

export interface UiResolved {
  id: string;
  /**
   * `host` = answered through `respondUi`; `pi` = Pi closed it (timeout/abort); `exit` = Pi died;
   * `terminal` = answered in the session's terminal.
   */
  by: "host" | "pi" | "exit" | "terminal";
  request: PiDialogRequest;
}

export interface SessionDiagnostic {
  level: "info" | "warning" | "error";
  message: string;
  source?: string;
}

export interface PartialBlock {
  itemId: string;
  kind: "text" | "thinking" | "tool_args";
  order: number;
  text: string;
}

export interface SessionSnapshot {
  runtime: RuntimeState;
  detail: string | null;
  nativeHandle: NativeHandle | null;
  queue: QueueState;
  pendingUi: PiDialogRequest[];
  partial: PartialBlock[];
  nextOrder: number;
}

export interface ManagedSessionEventMap {
  /** Transcript item upsert (the same id repeats as it updates). */
  item: [TranscriptItem];
  /** Ephemeral streaming delta. */
  stream: [StreamDelta];
  /** Every raw `extension_ui_request` (dialogs and fire-and-forget), for adapter claiming. */
  ui_request: [PiUiRequest];
  /** A pending dialog stopped pending. */
  ui_resolved: [UiResolved];
  /** Raw bridge socket line. */
  bridge: [BridgeEvent];
  runtime: [RuntimeChange];
  settled: [SettledInfo];
  queue: [QueueState];
  native: [NativeHandle];
  /** `session_info_changed`: the native display name changed. */
  title: [string | null];
  /** Every raw Pi session event (tool_execution_*, entry_appended, message_end, ...). */
  pi_event: [PiEvent];
  diagnostic: [SessionDiagnostic];
  stderr: [string];
  /** The live model or effort changed. */
  model: [ModelState];
  compacting: [boolean];
  exit: [PiExit];
}

type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;

interface Block {
  itemId: string;
  order: number;
  kind: "assistant" | "thinking" | "tool";
  text: string;
  toolCallId?: string;
}

const RUNNING_MESSAGE = "Session is running: choose Steer or Queue follow-up";
const TRACKED_ITEMS = 500;

/**
 * One live Pi session: owns a `PiRpcProcess`, maps its events to transcript items, tracks runtime
 * state, queue and pending dialogs. Interaction claiming, persistence and fan-out are the host's job.
 */
export class ManagedSession extends EventEmitter<ManagedSessionEventMap> {
  readonly sessionId: string;
  private readonly opts: ManagedSessionOptions;
  private proc: PiTransport | null = null;
  private order: number;
  private readonly newItemId: () => string;
  /** UUID passed as `--session-id` when starting a new native session. */
  private readonly newNativeId: string;
  private readonly now: () => string;

  private _runtime: RuntimeState = "starting";
  private _detail: string | null = null;
  private terminal: RuntimeState | null = null;
  private started = false;
  private busy = false;
  private abortRequested = false;
  private closeRequested = false;
  private _native: NativeHandle | null;
  private _queue: QueueState = { steering: [], followUp: [] };
  private readonly pending = new Map<string, PiDialogRequest>();

  private current: { blocks: Map<number, Block> } | null = null;
  private readonly tools = new Map<string, ToolItem>();
  private readonly items = new Map<string, TranscriptItem>();
  private readonly partialToolOutput = new Map<string, string>();
  private runAssistantText: string | null = null;
  private _model: SessionModel | null = null;
  private scoped: Set<string> | null = null;
  private _thinking: ThinkingLevel | null = null;
  private _compacting = false;
  private lastModelJson = "";

  constructor(opts: ManagedSessionOptions) {
    super();
    this.opts = opts;
    this.sessionId = opts.sessionId;
    this.order = opts.nextOrder ?? 0;
    this.newItemId = opts.newItemId ?? (() => newId("itm"));
    this.now = opts.now ?? (() => new Date().toISOString());
    this._native = opts.nativeHandle ?? null;
    this.newNativeId = opts.newNativeSessionId ?? randomUUID();
  }

  /** Create and start a session. */
  static async start(opts: ManagedSessionOptions): Promise<ManagedSession> {
    const s = new ManagedSession(opts);
    await s.start();
    return s;
  }

  get runtime(): RuntimeState {
    return this._runtime;
  }
  get runtimeDetail(): string | null {
    return this._detail;
  }
  get nativeHandle(): NativeHandle | null {
    return this._native;
  }
  get queue(): QueueState {
    return { steering: [...this._queue.steering], followUp: [...this._queue.followUp] };
  }
  /** Next order number the session will assign (persist it with the items). */
  get nextOrder(): number {
    return this.order;
  }
  get pendingUi(): PiDialogRequest[] {
    return [...this.pending.values()];
  }
  /** The underlying process (for diagnostics and tests). */
  get process(): PiRpcProcess | PiTerminalProcess | null {
    return this.proc as PiRpcProcess | PiTerminalProcess | null;
  }
  get transport(): "rpc" | "terminal" {
    return this.opts.transport ?? "rpc";
  }
  /** The terminal holder's socket (terminal transport while attached). */
  get terminalSocket(): string | null {
    return this.proc instanceof PiTerminalProcess ? this.proc.socketPath : null;
  }
  /** Whether remote clients can answer extension dialogs (always for RPC). */
  get remoteDialogs(): boolean {
    return this.proc instanceof PiTerminalProcess ? this.proc.remoteDialogs : true;
  }
  get modelState(): ModelState {
    return { model: this._model ? { ...this._model } : null, thinking: this._thinking };
  }
  get compacting(): boolean {
    return this._compacting;
  }
  get isAlive(): boolean {
    return this.proc !== null && this.proc.exited === null;
  }

  /** Build the Pi arguments for this session (without `--mode rpc` and the bridge). */
  buildArgs(): string[] {
    const { profile, title } = this.opts;
    const args: string[] = [];
    if (this._native) {
      args.push("--session", this._native.sessionFile);
      // Pi appends a session_info entry for every --name; only pass it when the name changes.
      if (readSessionNameSync(this._native.sessionFile) !== title) args.push("--name", title);
    } else {
      args.push("--session-id", this.newNativeId);
      args.push("--name", title);
    }
    if (profile.model) {
      if (profile.provider) args.push("--provider", profile.provider);
      args.push("--model", profile.model);
    }
    if (profile.thinking) args.push("--thinking", profile.thinking);
    if (profile.projectTrust === "approve") args.push("--approve");
    else if (profile.projectTrust === "ignore") args.push("--no-approve");
    if (profile.resources === "vanilla") {
      args.push("--no-extensions", "--no-skills", "--no-prompt-templates");
    }
    args.push(...profile.extraArgs);
    args.push(...(this.opts.extraArgs ?? []));
    for (const ext of this.opts.extensions ?? []) args.push("-e", ext);
    return args;
  }

  /** Spawn Pi, read `get_state`, and emit `native`. */
  async start(): Promise<void> {
    if (this.proc) throw new Error("ManagedSession already started");
    this.setRuntime();
    if (this.transport === "terminal" && this.opts.terminalSocket) {
      await this.attachTerminal(this.opts.terminalSocket);
      return;
    }
    if (this._native && !existsSync(this._native.sessionFile)) {
      const message = `Native session file not found: ${this._native.sessionFile}`;
      this.fail(message);
      throw new SwitchyardError("native_session_missing", message, {
        sessionFile: this._native.sessionFile,
      });
    }
    const expectedId = this._native?.sessionId ?? this.newNativeId;
    let args: string[];
    try {
      args = this.buildArgs();
    } catch (err) {
      this.fail((err as Error).message);
      throw err;
    }
    const terminal = this.transport === "terminal";
    try {
      const startOpts = {
        piBin: this.opts.piBin,
        cwd: this.opts.cwd,
        args,
        env: this.opts.env,
        runtimeDir: this.opts.runtimeDir,
      };
      this.proc = terminal
        ? await PiTerminalProcess.start(startOpts)
        : await PiRpcProcess.start(startOpts);
    } catch (err) {
      this.fail((err as Error).message);
      throw new SwitchyardError("internal", (err as Error).message);
    }
    this.wire(this.proc);
    if (terminal) this.setRuntime(STARTING_IN_TERMINAL);
    let state: PiState;
    try {
      state = await this.proc.request<PiState>(
        { type: "get_state" },
        this.opts.startTimeoutMs ?? (terminal ? 15 * 60_000 : 30000),
      );
    } catch (err) {
      const message = `Pi did not start: ${(err as Error).message}`;
      this.fail(message);
      void this.proc.close({ graceMs: 1000, termMs: 1000 });
      throw new SwitchyardError("internal", message);
    }
    if (!state.sessionFile) {
      this.fail("Pi reported no session file");
      void this.proc.close({ graceMs: 1000, termMs: 1000 });
      throw new SwitchyardError("internal", "Pi reported no session file");
    }
    if (state.sessionId !== expectedId) {
      const message = `Pi opened session ${state.sessionId} instead of ${expectedId}`;
      this.fail(message);
      void this.proc.close({ graceMs: 1000, termMs: 1000 });
      throw new SwitchyardError(this._native ? "native_session_missing" : "internal", message);
    }
    this._native = { sessionId: state.sessionId, sessionFile: state.sessionFile };
    this.started = true;
    this.busy = state.isStreaming;
    this.applyModel(state.model);
    this.applyThinking(state.thinkingLevel);
    this.emitModelIfChanged();
    this.emit("native", { ...this._native });
    this.setRuntime();
  }

  /** Terminal transport: attach to a running holder and adopt its Pi's state. */
  private async attachTerminal(socketPath: string): Promise<void> {
    try {
      this.proc = await PiTerminalProcess.attach(socketPath);
    } catch (err) {
      this.fail((err as Error).message);
      throw new SwitchyardError("internal", (err as Error).message);
    }
    this.wire(this.proc);
    let state: PiState;
    try {
      state = await this.proc.request<PiState>({ type: "get_state" }, 10000);
    } catch (err) {
      const message = `Terminal session did not answer: ${(err as Error).message}`;
      this.fail(message);
      (this.proc as PiTerminalProcess).detach();
      throw new SwitchyardError("internal", message);
    }
    if (state.sessionFile) {
      this._native = { sessionId: state.sessionId, sessionFile: state.sessionFile };
      this.emit("native", { ...this._native });
    }
    this.started = true;
    this.busy = state.isStreaming;
    this.applyModel(state.model);
    this.applyThinking(state.thinkingLevel);
    this.emitModelIfChanged();
    this.setRuntime();
  }

  /** Terminal transport: let go of the holder; Pi keeps running and no exit is reported. */
  detach(): void {
    if (!(this.proc instanceof PiTerminalProcess)) {
      throw new Error("detach needs a terminal session");
    }
    const proc = this.proc;
    proc.removeAllListeners();
    proc.on("error", () => {});
    proc.detach();
    this.proc = null;
    this.started = false;
  }

  /** Send a prompt, steer or follow-up; returns Pi's disposition. */
  async prompt(
    text: string,
    images: { mimeType: string; data: string }[] = [],
    mode: PromptMode = "prompt",
  ): Promise<PromptDisposition> {
    const proc = this.requireAlive();
    const piImages = images.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType }));
    const body: Record<string, unknown> = { message: text };
    if (piImages.length > 0) body.images = piImages;
    let data: { disposition?: PromptDisposition } | undefined;
    if (mode === "prompt") {
      // Extension commands (`/name`) run immediately even during a run.
      if (this.busy && !text.startsWith("/")) {
        throw new SwitchyardError("invalid_request", RUNNING_MESSAGE);
      }
      if (!this.busy) this.runAssistantText = null;
      data = await this.call(proc, { type: "prompt", ...body });
      if (data?.disposition === "started" && !this.busy) {
        this.busy = true;
        this.setRuntime();
      }
    } else if (mode === "steer") {
      data = await this.call(proc, { type: "steer", ...body });
    } else {
      data = await this.call(proc, { type: "follow_up", ...body });
    }
    return data?.disposition ?? "started";
  }

  /** Abort the current run; with `clearQueue`, first clear and return queued messages. */
  async abort(clearQueue = false): Promise<{ cleared: QueueState | null }> {
    const proc = this.requireAlive();
    let cleared: QueueState | null = null;
    if (clearQueue) {
      const data = await this.call<QueueState>(proc, { type: "clear_queue" });
      cleared = { steering: data?.steering ?? [], followUp: data?.followUp ?? [] };
    }
    if (this.busy) this.abortRequested = true;
    await this.call(proc, { type: "abort" }, 60000);
    return { cleared };
  }

  /** Answer a dialog. Resolves once written to Pi with whether it was still pending. */
  async respondUi(id: string, body: PiUiResponseBody): Promise<boolean> {
    const proc = this.requireAlive();
    const req = this.pending.get(id);
    if (req) {
      this.pending.delete(id);
      this.emit("ui_resolved", { id, by: "host", request: req });
      this.setRuntime();
    }
    // Written even when no longer pending; Pi ignores answers to dialogs it already closed.
    await proc.respondUi(id, body);
    return req !== undefined;
  }

  async rename(title: string): Promise<void> {
    await this.call(this.requireAlive(), { type: "set_session_name", name: title });
  }

  /** Models Pi can use right now. */
  async models(): Promise<SessionModel[]> {
    const data = await this.call<{ models?: unknown[] }>(this.requireAlive(), {
      type: "get_available_models",
    });
    const out: SessionModel[] = [];
    for (const raw of data?.models ?? []) {
      const m = this.toSessionModel(raw);
      if (!m) continue;
      if (this.scoped && this.scoped.size > 0) m.scoped = this.scoped.has(`${m.provider}/${m.id}`);
      out.push(m);
    }
    return out.sort(
      (a, b) =>
        a.provider.localeCompare(b.provider) || (a.name ?? a.id).localeCompare(b.name ?? b.id),
    );
  }

  /** Slash commands Pi knows (extension commands, prompt templates, skills). */
  async commands(): Promise<SlashCommand[]> {
    const data = await this.call<{ commands?: any[] }>(this.requireAlive(), {
      type: "get_commands",
    });
    const out: SlashCommand[] = [];
    const hints: Promise<void>[] = [];
    for (const c of data?.commands ?? []) {
      if (typeof c?.name !== "string" || !c.name) continue;
      if (c.source !== "extension" && c.source !== "prompt" && c.source !== "skill") continue;
      const entry: SlashCommand = {
        name: c.name,
        description: typeof c.description === "string" ? c.description : null,
        source: c.source,
        argumentHint: null,
      };
      if (c.source === "prompt" && typeof c.sourceInfo?.path === "string") {
        hints.push(
          readArgumentHint(c.sourceInfo.path).then((h) => {
            entry.argumentHint = h;
          }),
        );
      }
      out.push(entry);
    }
    await Promise.all(hints);
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Pi's argument completions for a draft such as `/model cl` (terminal sessions only). */
  async complete(text: string): Promise<SessionCompleteResultT> {
    const proc = this.requireAlive();
    if (!(proc instanceof PiTerminalProcess)) return { items: [], prefix: "" };
    const data = await this.call<any>(proc, { type: "complete", text }, 5000);
    return SessionCompleteResult.parse({ items: data?.items ?? [], prefix: data?.prefix ?? "" });
  }

  async setModel(provider: string, modelId: string): Promise<ModelState> {
    await this.call(this.requireAlive(), { type: "set_model", provider, modelId });
    await this.refreshModelState();
    return this.modelState;
  }

  async setThinking(level: ThinkingLevel): Promise<ModelState> {
    await this.call(this.requireAlive(), { type: "set_thinking_level", level });
    await this.refreshModelState();
    return this.modelState;
  }

  /** Start a manual compaction. Terminal sessions answer at once; Pi's RPC answers when done. */
  async compact(instructions: string | null): Promise<void> {
    const proc = this.requireAlive();
    const cmd = { type: "compact", ...(instructions ? { customInstructions: instructions } : {}) };
    if (this.transport === "terminal") {
      await this.call(proc, cmd, 10000);
    } else {
      this.call(proc, cmd, 30 * 60_000).catch(() => {});
    }
  }

  private async refreshModelState(): Promise<void> {
    const s = await this.state();
    this.applyModel(s.model);
    this.applyThinking(s.thinkingLevel);
    this.emitModelIfChanged();
  }

  private toSessionModel(raw: unknown): SessionModel | null {
    const info = modelInfo(raw);
    if (!info) return null;
    return {
      ...info,
      thinkingLevels: info.thinkingLevels.flatMap((l) => {
        const r = ThinkingLevel.safeParse(l);
        return r.success ? [r.data] : [];
      }),
    };
  }

  private applyScoped(raw: unknown): void {
    if (Array.isArray(raw)) this.scoped = new Set(raw.filter((x) => typeof x === "string"));
  }

  private applyModel(raw: unknown): void {
    this._model = this.toSessionModel(raw);
  }

  private applyThinking(raw: unknown): void {
    const r = ThinkingLevel.safeParse(raw);
    this._thinking = r.success ? r.data : null;
  }

  private emitModelIfChanged(): void {
    const json = JSON.stringify(this.modelState);
    if (json === this.lastModelJson) return;
    this.lastModelJson = json;
    this.emit("model", this.modelState);
  }

  private setCompacting(v: boolean): void {
    if (this._compacting === v) return;
    this._compacting = v;
    this.emit("compacting", v);
  }

  /** Token and cost totals (`get_session_stats`). */
  async stats(): Promise<{
    tokens: number | null;
    costUsd: number | null;
    context: ContextUsage | null;
    raw: PiSessionStats;
  }> {
    const raw = await this.call<PiSessionStats>(this.requireAlive(), { type: "get_session_stats" });
    const cu = raw?.contextUsage;
    const context: ContextUsage | null =
      cu && typeof cu.contextWindow === "number"
        ? {
            tokens: typeof cu.tokens === "number" ? cu.tokens : null,
            window: cu.contextWindow,
            percent: typeof cu.percent === "number" ? cu.percent : null,
          }
        : null;
    return {
      context,
      tokens: typeof raw?.tokens?.total === "number" ? raw.tokens.total : null,
      costUsd: typeof raw?.cost === "number" ? raw.cost : null,
      raw,
    };
  }

  /** `get_state` passthrough. */
  async state(): Promise<PiState> {
    return this.call<PiState>(this.requireAlive(), { type: "get_state" });
  }

  /** Map `get_messages` to transcript items (orders from `startOrder`, default 0; live counter untouched). */
  async history(startOrder = 0): Promise<TranscriptItem[]> {
    const data = await this.call<{ messages: unknown[] }>(this.requireAlive(), {
      type: "get_messages",
    });
    return messagesToItems(data?.messages ?? [], {
      sessionId: this.sessionId,
      startOrder,
      newItemId: this.newItemId,
      fallbackAt: this.now(),
    });
  }

  /** Current state for a client (re)attaching mid-stream. */
  snapshot(): SessionSnapshot {
    const partial: PartialBlock[] = [];
    for (const block of this.current?.blocks.values() ?? []) {
      partial.push({
        itemId: block.itemId,
        kind:
          block.kind === "assistant"
            ? "text"
            : block.kind === "thinking"
              ? "thinking"
              : "tool_args",
        order: block.order,
        text: block.text,
      });
    }
    return {
      runtime: this._runtime,
      detail: this._detail,
      nativeHandle: this._native ? { ...this._native } : null,
      queue: this.queue,
      pendingUi: this.pendingUi,
      partial,
      nextOrder: this.order,
    };
  }

  /** The tool item for a Pi tool call id, if tracked. */
  toolItem(toolCallId: string): ToolItem | undefined {
    return this.tools.get(toolCallId);
  }

  /** Merge fields into a tracked item's data (e.g. an adapter card) and re-emit it. */
  patchItem(
    itemId: string,
    patch: Partial<ToolItemData> | Record<string, unknown>,
  ): TranscriptItem | null {
    const item = this.items.get(itemId);
    if (!item) return null;
    Object.assign(item.data as Record<string, unknown>, patch);
    this.emit("item", structuredClone(item));
    return item;
  }

  /** Graceful stop (stdin end, then SIGTERM/SIGKILL); runtime becomes `stopped`. */
  async stop(opts?: { graceMs?: number; termMs?: number }): Promise<PiExit | null> {
    this.closeRequested = true;
    if (!this.proc) {
      this.terminal = "stopped";
      this.setRuntime();
      return null;
    }
    return this.proc.close(opts);
  }

  /** Alias of `stop()`. */
  close(opts?: { graceMs?: number; termMs?: number }): Promise<PiExit | null> {
    return this.stop(opts);
  }

  // ---- internals ----

  private requireAlive(): PiTransport {
    if (!this.proc || this.proc.exited || !this.started) {
      throw new SwitchyardError("invalid_request", `Session is not running (${this._runtime})`);
    }
    return this.proc;
  }

  private async call<T = any>(
    proc: PiTransport,
    cmd: { type: string; [k: string]: unknown },
    timeoutMs = 60000,
  ): Promise<T> {
    try {
      return await proc.request<T>(cmd, timeoutMs);
    } catch (err) {
      if (err instanceof PiRpcError) {
        throw new SwitchyardError("invalid_request", err.message, { command: err.command });
      }
      throw err;
    }
  }

  private fail(detail: string): void {
    this.terminal = "failed";
    this._detail = detail;
    this.setRuntime(detail);
  }

  private computeRuntime(): RuntimeState {
    if (this.terminal) return this.terminal;
    if (!this.started) return "starting";
    if (this.pending.size > 0) return "waiting_input";
    return this.busy ? "running" : "idle";
  }

  private setRuntime(detail?: string | null): void {
    const next = this.computeRuntime();
    const nextDetail = detail !== undefined ? detail : this.terminal ? this._detail : null;
    if (next === this._runtime && nextDetail === this._detail) return;
    this._runtime = next;
    this._detail = nextDetail;
    this.emit("runtime", { runtime: next, detail: nextDetail });
  }

  private wire(proc: PiTransport): void {
    proc.on("event", (ev: PiEvent) => {
      try {
        this.onEvent(ev);
      } catch (err) {
        this.emit("diagnostic", {
          level: "error",
          message: `Failed to map Pi event ${ev.type}: ${(err as Error).message}`,
          source: "pi-runtime",
        });
      }
      this.emit("pi_event", ev);
    });
    proc.on("ui_request", (req: PiUiRequest) => {
      if (isDialogRequest(req)) {
        this.pending.set(req.id, req);
        this.setRuntime();
      }
      this.emit("ui_request", req);
    });
    proc.on("bridge", (msg: BridgeEvent) => {
      this.emit("bridge", msg);
      if (msg.type === "ui_prompt_end") this.onPromptEnd(msg);
      if (msg.type === "model_state") {
        this.applyScoped(msg.scoped);
        this.applyModel(msg.model);
        this.applyThinking(msg.thinkingLevel);
        this.emitModelIfChanged();
      }
    });
    proc.on("stderr", (text: string) => this.emit("stderr", text));
    proc.on("protocol_error", (err: Error, line: string) => {
      this.emit("diagnostic", {
        level: "warning",
        message: `Pi protocol error: ${err.message}${line ? ` (${line.slice(0, 200)})` : ""}`,
        source: "pi-runtime",
      });
    });
    proc.on("exit", (info: PiExit) => this.onExit(info));
    proc.on("ui_closed", (c: { id: string; by: "pi" | "terminal" }) => this.onUiClosed(c));
    proc.on("gap", () => this.notice("warning", GAP_NOTICE));
  }

  /** Terminal transport: the extension reports how each dialog closed. */
  private onUiClosed({ id, by }: { id: string; by: "pi" | "terminal" }): void {
    const req = this.pending.get(id);
    if (!req) return;
    this.pending.delete(id);
    this.emit("ui_resolved", { id, by, request: req });
    this.setRuntime();
  }

  private onPromptEnd(msg: BridgeEvent): void {
    // The terminal extension reports every dialog it closes (`ui_closed`).
    if (this.transport === "terminal") return;
    // Pi only reports the outermost prompt; expire pending dialogs that match it.
    const title = msg.title ?? undefined;
    let changed = false;
    for (const [id, req] of this.pending) {
      if (req.method === msg.kind && (title === undefined || req.title === title)) {
        this.pending.delete(id);
        this.emit("ui_resolved", { id, by: "pi", request: req });
        changed = true;
      }
    }
    if (changed) this.setRuntime();
  }

  private onExit(info: PiExit): void {
    for (const [id, req] of this.pending)
      this.emit("ui_resolved", { id, by: "exit", request: req });
    this.pending.clear();
    this.current = null;
    this.setCompacting(false);
    const wasBusy = this.busy;
    this.busy = false;
    if (this.terminal === "failed") {
      // keep failure detail
    } else if (this.closeRequested || info.requested) {
      this.terminal = "stopped";
      this._detail = null;
    } else if (this.started && this.transport === "terminal" && info.code === 0) {
      this.terminal = "stopped";
      this._detail = QUIT_IN_TERMINAL;
    } else if (!this.started) {
      this.terminal = "failed";
      this._detail = `Pi exited during startup (code ${info.code}, signal ${info.signal})`;
    } else {
      this.terminal = "interrupted";
      this._detail = `Pi exited unexpectedly (code ${info.code}, signal ${info.signal})${
        wasBusy ? " during a run" : ""
      }`;
    }
    this.setRuntime(this._detail);
    this.emit("exit", info);
  }

  private nextMeta(at?: string): { id: string; sessionId: string; order: number; at: string } {
    return {
      id: this.newItemId(),
      sessionId: this.sessionId,
      order: this.order++,
      at: at ?? this.now(),
    };
  }

  private emitItem(item: TranscriptItem): void {
    this.items.set(item.id, item);
    if (this.items.size > TRACKED_ITEMS) {
      const oldest = this.items.keys().next().value;
      if (oldest !== undefined) {
        const old = this.items.get(oldest);
        this.items.delete(oldest);
        if (old?.kind === "tool") this.tools.delete(old.data.toolCallId);
      }
    }
    this.emit("item", structuredClone(item));
  }

  private newItem<K extends TranscriptItem["kind"]>(kind: K, data: ItemData<K>): TranscriptItem {
    return makeItem(kind, data, this.nextMeta());
  }

  private notice(level: "info" | "warning" | "error", text: string): void {
    this.emitItem(this.newItem("notice", { level, text }));
  }

  private block(index: number, kind: Block["kind"], toolCallId?: string): Block {
    this.current ??= { blocks: new Map() };
    let b = this.current.blocks.get(index);
    if (!b) {
      if (kind === "tool" && toolCallId) {
        const tool = this.ensureTool(toolCallId, "tool", {});
        b = { itemId: tool.id, order: tool.order, kind, text: "", toolCallId };
      } else {
        b = { itemId: this.newItemId(), order: this.order++, kind, text: "" };
      }
      this.current.blocks.set(index, b);
    }
    return b;
  }

  private ensureTool(toolCallId: string, name: string, args: unknown): ToolItem {
    let tool = this.tools.get(toolCallId);
    if (!tool) {
      const at = this.now();
      tool = makeItem(
        "tool",
        initialToolData(toolCallId, name, args, at),
        this.nextMeta(at),
      ) as ToolItem;
      this.tools.set(toolCallId, tool);
    }
    return tool;
  }

  private stream(block: Block, kind: StreamDelta["kind"], delta: string): void {
    this.emit("stream", {
      sessionId: this.sessionId,
      itemId: block.itemId,
      kind,
      delta,
      order: block.order,
    });
  }

  private onEvent(ev: PiEvent): void {
    switch (ev.type) {
      case "agent_start":
        // A run not started through prompt() (e.g. an extension message) resets the run text here.
        if (!this.busy) this.runAssistantText = null;
        this.busy = true;
        this.setRuntime();
        break;
      case "agent_settled": {
        this.busy = false;
        const aborted = ev.aborted === true;
        this.current = null;
        if (aborted) this.notice("warning", "Run aborted");
        this.abortRequested = false;
        this.setRuntime();
        this.emit("settled", { aborted, lastAssistantText: this.runAssistantText });
        break;
      }
      case "message_start":
        if (ev.message?.role === "assistant") this.current = { blocks: new Map() };
        break;
      case "message_update":
        this.onMessageUpdate(ev.assistantMessageEvent);
        break;
      case "message_end":
        this.onMessageEnd(ev.message);
        break;
      case "tool_execution_start": {
        if (ev.parentToolCallId) break;
        const tool = this.ensureTool(String(ev.toolCallId), String(ev.toolName), ev.args);
        tool.data.name = String(ev.toolName);
        tool.data.args = ev.args ?? {};
        tool.data.summary = genericToolSummary(tool.data.name, ev.args);
        tool.data.status = "running";
        tool.data.startedAt = this.now();
        this.emitItem(tool);
        break;
      }
      case "tool_execution_update": {
        if (ev.parentToolCallId) break;
        const tool = this.tools.get(String(ev.toolCallId));
        if (!tool) break;
        const text = toolOutputText(ev.partialResult);
        const prev = this.partialToolOutput.get(tool.data.toolCallId) ?? "";
        const delta = text.startsWith(prev) ? text.slice(prev.length) : text;
        this.partialToolOutput.set(tool.data.toolCallId, text);
        if (delta) {
          this.emit("stream", {
            sessionId: this.sessionId,
            itemId: tool.id,
            kind: "tool_output",
            delta,
            order: tool.order,
          });
        }
        break;
      }
      case "tool_execution_end": {
        if (ev.parentToolCallId) break;
        const tool = this.ensureTool(String(ev.toolCallId), String(ev.toolName), {});
        this.partialToolOutput.delete(tool.data.toolCallId);
        tool.data.status = ev.isError ? "error" : "ok";
        tool.data.output = toolOutputText(ev.result);
        tool.data.durationMs =
          typeof ev.durationMs === "number"
            ? ev.durationMs
            : Math.max(0, Date.now() - Date.parse(tool.data.startedAt));
        this.emitItem(tool);
        break;
      }
      case "queue_update":
        this._queue = {
          steering: Array.isArray(ev.steering) ? ev.steering.map(String) : [],
          followUp: Array.isArray(ev.followUp) ? ev.followUp.map(String) : [],
        };
        this.emit("queue", this.queue);
        break;
      case "auto_retry_start":
        this.notice(
          "warning",
          `Retrying after an error (attempt ${ev.attempt}/${ev.maxAttempts}): ${ev.errorMessage ?? "unknown error"}`,
        );
        break;
      case "auto_retry_end":
        if (ev.success === false)
          this.notice("error", `Retry failed: ${ev.finalError ?? "unknown error"}`);
        break;
      case "compaction_start":
        this.setCompacting(true);
        this.notice("info", `Compacting context (${ev.reason ?? "manual"})`);
        break;
      case "compaction_end":
        this.setCompacting(false);
        if (ev.result) this.notice("info", "Context compacted");
        else if (ev.aborted) this.notice("warning", "Compaction aborted");
        else {
          const msg = String(ev.errorMessage ?? "unknown error").replace(
            /^Compaction failed:\s*/,
            "",
          );
          this.notice("error", `Compaction failed: ${msg}`);
        }
        break;
      case "model_state":
        this.applyScoped(ev.scoped);
        this.applyModel(ev.model);
        this.applyThinking(ev.thinkingLevel);
        this.emitModelIfChanged();
        break;
      case "thinking_level_changed":
        this.applyThinking(ev.level);
        this.emitModelIfChanged();
        break;
      case "extension_error":
        this.emit("diagnostic", {
          level: "error",
          message: `Extension error in ${ev.extensionPath ?? "?"} (${ev.event ?? "?"}): ${ev.error ?? ""}`,
          source: typeof ev.extensionPath === "string" ? ev.extensionPath : undefined,
        });
        break;
      case "session_info_changed":
        this.emit("title", typeof ev.name === "string" ? ev.name : null);
        break;
      case "switchyard_native":
        if (typeof ev.sessionId === "string" && typeof ev.sessionFile === "string") {
          this._native = { sessionId: ev.sessionId, sessionFile: ev.sessionFile };
          this.emit("native", { ...this._native });
        }
        break;
      default:
        break;
    }
  }

  private onMessageUpdate(aev: any): void {
    if (!aev || typeof aev !== "object") return;
    const index = typeof aev.contentIndex === "number" ? aev.contentIndex : 0;
    switch (aev.type) {
      case "text_start":
        this.block(index, "assistant");
        break;
      case "text_delta": {
        const b = this.block(index, "assistant");
        b.text += String(aev.delta ?? "");
        this.stream(b, "text", String(aev.delta ?? ""));
        break;
      }
      case "text_end":
        this.block(index, "assistant").text = String(aev.content ?? "");
        break;
      case "thinking_start":
        this.block(index, "thinking");
        break;
      case "thinking_delta": {
        const b = this.block(index, "thinking");
        b.text += String(aev.delta ?? "");
        this.stream(b, "thinking", String(aev.delta ?? ""));
        break;
      }
      case "thinking_end":
        this.block(index, "thinking").text = String(aev.content ?? "");
        break;
      case "toolcall_start": {
        const id = typeof aev.id === "string" ? aev.id : undefined;
        if (!id) break;
        const b = this.block(index, "tool", id);
        const tool = this.tools.get(id);
        if (tool && typeof aev.toolName === "string") {
          tool.data.name = aev.toolName;
          tool.data.summary = genericToolSummary(aev.toolName, tool.data.args);
        }
        b.text = "";
        break;
      }
      case "toolcall_delta": {
        const b = this.current?.blocks.get(index);
        if (b?.kind !== "tool") break;
        b.text += String(aev.delta ?? "");
        if (aev.delta) this.stream(b, "tool_args", String(aev.delta));
        break;
      }
      case "toolcall_end": {
        const call = aev.toolCall;
        if (call?.id) {
          const tool = this.ensureTool(
            String(call.id),
            String(call.name ?? "tool"),
            call.arguments,
          );
          tool.data.args = call.arguments ?? {};
          tool.data.summary = genericToolSummary(tool.data.name, call.arguments);
        }
        break;
      }
      default:
        break;
    }
  }

  private onMessageEnd(message: any): void {
    if (!message || typeof message !== "object") return;
    switch (message.role) {
      case "user": {
        const { text, images } = contentText(message.content);
        this.emitItem(this.newItem("user", images > 0 ? { text, images } : { text }));
        break;
      }
      case "assistant":
        this.onAssistantEnd(message);
        break;
      case "custom": {
        const show = this.opts.customMessageNotice
          ? this.opts.customMessageNotice(message)
          : message.display !== false;
        if (!show) break;
        const { text } = contentText(message.content);
        if (text) this.notice("info", text);
        break;
      }
      case "bashExecution": {
        const output = typeof message.output === "string" ? message.output : "";
        this.emitItem(
          this.newItem("system", { text: `$ ${message.command}\n${output}`.trimEnd() }),
        );
        break;
      }
      default:
        // system prompt messages and tool results (covered by tool items) are not items
        break;
    }
  }

  private onAssistantEnd(message: any): void {
    const content: any[] = Array.isArray(message.content) ? message.content : [];
    const texts: string[] = [];
    content.forEach((block, index) => {
      if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
        const b = this.block(index, "thinking");
        this.emitItem(
          makeItem(
            "thinking",
            { text: block.thinking },
            {
              id: b.itemId,
              sessionId: this.sessionId,
              order: b.order,
              at: this.now(),
            },
          ),
        );
      } else if (block?.type === "text" && typeof block.text === "string" && block.text) {
        const b = this.block(index, "assistant");
        texts.push(block.text);
        this.emitItem(
          makeItem(
            "assistant",
            { text: block.text },
            {
              id: b.itemId,
              sessionId: this.sessionId,
              order: b.order,
              at: this.now(),
            },
          ),
        );
      } else if (block?.type === "toolCall" && typeof block.id === "string") {
        // Emitted at tool_execution_start; make sure the order slot exists.
        const tool = this.ensureTool(block.id, String(block.name ?? "tool"), block.arguments);
        tool.data.args = block.arguments ?? tool.data.args;
      }
    });
    if (texts.length > 0) this.runAssistantText = texts.join("\n");
    const failed = message.stopReason === "error" || message.stopReason === "aborted";
    if (failed && message.errorMessage && !this.abortRequested) {
      this.notice("error", String(message.errorMessage));
    }
    this.current = null;
  }
}
