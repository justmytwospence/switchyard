import type {
  AdapterInfo,
  AttentionReason,
  InteractionResponse,
  UINode,
} from "@switchyard/protocol";
import type { AdapterManifest } from "./manifest.js";
import type { PiUiMethod, PiUiRequest, PiUiResponse } from "./pi-ui.js";

export type MaybePromise<T> = T | Promise<T>;
export type AdapterTier = AdapterInfo["tier"];
export const TIER_ORDER: readonly AdapterTier[] = ["project", "owner", "plugin", "bundled"];

// ---------------------------------------------------------------------------
// Events delivered to hooks

/** `tool_execution_start`. */
export interface ToolStartEvent {
  toolCallId: string;
  name: string;
  args: unknown;
}

/** `tool_execution_update`: `details` is `partialResult.details` when present. */
export interface ToolUpdateEvent extends ToolStartEvent {
  partialResult: unknown;
  details?: unknown;
}

/** `tool_execution_end`. `details` is `result.details` when present. */
export interface ToolEndEvent extends ToolStartEvent {
  result: unknown;
  isError: boolean;
  details?: unknown;
}

/** The tool as seen by `toolCard`: running (no result yet) or finished. */
export interface ToolInfo {
  toolCallId: string;
  name: string;
  args: unknown;
  result?: unknown;
  isError?: boolean;
  details?: unknown;
}

/** A session entry (e.g. a `custom` entry written with `pi.appendEntry`). */
export interface SessionEntryInfo {
  type: string;
  customType?: string;
  data?: unknown;
  [key: string]: unknown;
}

/** A custom message (`pi.sendMessage`), role `custom`. */
export interface CustomMessageInfo {
  customType: string;
  content: unknown;
  display?: boolean;
  details?: unknown;
}

// ---------------------------------------------------------------------------
// Claims

/**
 * Selects which later dialog a queued answer belongs to. The object form matches by method and
 * optional title text; a function gets the full request.
 */
export type AnswerMatcher =
  | {
      method?: PiUiMethod | PiUiMethod[];
      titleIncludes?: string;
      titleStartsWith?: string;
    }
  | ((req: PiUiRequest) => boolean);

/** A response, or a function that builds it from the actual request when it arrives. */
export type AnswerSource = PiUiResponse | ((req: PiUiRequest) => PiUiResponse | undefined);

/** One step of a response sequence with an explicit matcher. */
export interface QueuedStep {
  match: AnswerMatcher;
  response: AnswerSource;
}

/**
 * The result of mapping a user's answer. A sequence answers the current request with its first
 * step and queues the rest for later dialogs of the same tool call (in order). Untagged steps
 * after the first match by response shape: `{value}` -> select/input/editor, `{confirmed}` ->
 * confirm. Queued answers are always re-checked against the real request (a select value must
 * be one of its options) and expire when the owning tool call ends.
 */
export type ClaimResponse = PiUiResponse | { sequence: (PiUiResponse | QueuedStep)[] };

export interface Claim {
  title: string;
  presentation: UINode;
  /** Map the user's answer to Pi responses. Throw InteractionResponseError for invalid input. */
  toPiResponse(resp: InteractionResponse): MaybePromise<ClaimResponse>;
  /** Tool call that owns any queued follow-up answers (default: the latest running tool call). */
  ownerToolCallId?: string;
}

// ---------------------------------------------------------------------------
// Context

export interface SubagentLink {
  runId: string;
  label: string;
  status: string;
  sessionFile: string | null;
}

export interface PanelOptions {
  /** Display title; defaults to the slot. */
  title?: string;
  /** Plain-text fallback for clients that cannot render the custom web renderer. */
  mobileFallback?: string | null;
  /** Opaque JSON passed to the custom web renderer as `state`. */
  state?: unknown;
}

export type LogLevel = "debug" | "info" | "warning" | "error";

export interface AdapterStateStore {
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  keys(): string[];
}

/** Per-session, per-adapter context handed to every hook. */
export interface AdapterContext {
  readonly sessionId: string;
  readonly adapterId: string;
  /** Persistent, server-authoritative key/value state (JSON values). */
  readonly state: AdapterStateStore;
  setPanel(slot: string, node: UINode | null, opts?: PanelOptions): void;
  attention(reason: AttentionReason, summary: string): void;
  linkSubagent(link: SubagentLink): void;
  /**
   * Pre-answer later dialogs of a tool call with values the user already gave. Responses are
   * consumed in order by the next matching dialogs and expire when the tool call ends.
   */
  queueAnswers(
    matcher: AnswerMatcher,
    responses: AnswerSource[],
    opts?: { toolCallId?: string },
  ): void;
  log(level: LogLevel, message: string): void;
}

// ---------------------------------------------------------------------------
// Server adapter

/** `true` when a status/widget hook presented the value (the host then hides the generic one); hooks may also return nothing. */
// biome-ignore lint/suspicious/noConfusingVoidType: hooks without a return statement are fine
export type PresentedFlag = boolean | undefined | void;

/**
 * A server adapter. Every hook is optional and may be async. Hooks run in the host agent with a
 * 2 s timeout; a throw or timeout disables the adapter for that session.
 *
 * `onStatus` and `onWidget` may return true to say they presented the value; the host then
 * leaves that status key out of the generic Status panel, or removes the generic widget panel.
 */
export interface ServerAdapter {
  toolCard?(tool: ToolInfo, ctx: AdapterContext): MaybePromise<UINode | undefined>;
  claimInteraction?(req: PiUiRequest, ctx: AdapterContext): MaybePromise<Claim | undefined>;
  onToolStart?(e: ToolStartEvent, ctx: AdapterContext): MaybePromise<void>;
  onToolUpdate?(e: ToolUpdateEvent, ctx: AdapterContext): MaybePromise<void>;
  onToolEnd?(e: ToolEndEvent, ctx: AdapterContext): MaybePromise<void>;
  onEntry?(entry: SessionEntryInfo, ctx: AdapterContext): MaybePromise<void>;
  onCustomMessage?(m: CustomMessageInfo, ctx: AdapterContext): MaybePromise<void>;
  onStatus?(
    key: string,
    text: string | undefined,
    ctx: AdapterContext,
  ): MaybePromise<PresentedFlag>;
  onWidget?(
    key: string,
    lines: string[] | undefined,
    ctx: AdapterContext,
  ): MaybePromise<PresentedFlag>;
  onAction?(actionId: string, payload: unknown, ctx: AdapterContext): MaybePromise<void>;
}

export interface AdapterFactoryInit {
  manifest: AdapterManifest;
  dir: string | null;
}
export type ServerAdapterFactory = (init: AdapterFactoryInit) => MaybePromise<ServerAdapter>;

/** An adapter ready to run: manifest, resolved paths and the server object. */
export interface LoadedAdapter {
  manifest: AdapterManifest;
  tier: AdapterTier;
  /** Directory holding the manifest (null for adapters built in code). */
  dir: string | null;
  manifestPath: string | null;
  webRendererPath: string | null;
  server: ServerAdapter;
}

// ---------------------------------------------------------------------------
// Effects emitted to the host

export interface AdapterDiagnostic {
  sessionId: string | null;
  adapterId: string | null;
  level: "info" | "warning" | "error";
  message: string;
}

export type AdapterEffect =
  | {
      type: "panel";
      adapterId: string;
      slot: string;
      title: string;
      node: UINode | null;
      webRenderer: boolean;
      mobileFallback: string | null;
      state?: unknown;
    }
  | { type: "attention"; adapterId: string; reason: AttentionReason; summary: string }
  | { type: "subagent"; adapterId: string; link: SubagentLink }
  | { type: "state"; adapterId: string; key: string; value: unknown }
  | { type: "log"; adapterId: string; level: LogLevel; message: string }
  | ({ type: "diagnostic" } & AdapterDiagnostic);

/** What the host provides when opening a per-session adapter context. */
export interface AdapterSessionHost {
  sessionId: string;
  /** Receives every effect (panels, attention, subagent links, state writes, diagnostics). */
  emit(effect: AdapterEffect): void;
  /** Previously persisted adapter state: adapterId -> key -> value. */
  initialState?: Record<string, Record<string, unknown>>;
}

/** Client sent an answer the claim cannot map (e.g. unknown option). Keep the interaction. */
export class InteractionResponseError extends Error {
  readonly code = "invalid_request";
  constructor(message: string) {
    super(message);
    this.name = "InteractionResponseError";
  }
}
