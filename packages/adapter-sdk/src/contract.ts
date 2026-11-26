/**
 * The Switchyard adapter contract (version 2) as plain types, with no imports.
 *
 * An adapter that ships inside a Pi package cannot import `@switchyard/*` at run time. Copy this
 * file next to the adapter and use it with `import type`: Node strips it on load. It is checked
 * against the SDK's own types (`test/contract.test.ts`), so a copy taken from a release matches
 * that release.
 *
 * A host from before contract v2 still loads a v2 adapter: it never calls `toolView`, and it
 * rejects the v2 nodes and placements. `ctx.features` is undefined there, so guard with
 * `supports(ctx, feature)` and give the v1 shape otherwise.
 */

// ---------------------------------------------------------------------------
// Portable UI

export type Tone = "default" | "muted" | "success" | "warning" | "danger";
export type ActionTone = "default" | "primary" | "danger";

export interface FieldOption {
  value: string;
  label: string;
  description?: string;
  preview?: string;
}
export interface ShowIf {
  field: string;
  values: string[];
}
export type Field =
  | {
      kind: "select";
      name: string;
      label: string;
      options: FieldOption[];
      allowOther?: { label: string; placeholder?: string };
      showIf?: ShowIf;
    }
  | {
      kind: "multiselect";
      name: string;
      label: string;
      options: FieldOption[];
      allowOther?: { label: string; placeholder?: string };
      min?: number;
      max?: number;
      showIf?: ShowIf;
    }
  | {
      kind: "text";
      name: string;
      label: string;
      placeholder?: string;
      multiline?: boolean;
      prefill?: string;
      showIf?: ShowIf;
    };

export type UIRef =
  | { kind: "file"; path: string }
  | { kind: "session"; sessionId: string }
  | { kind: "task"; taskId: string }
  | { kind: "native_session"; hostId: string; sessionFile: string }
  /** `ui.nodes.v2`: an http(s) link. */
  | { kind: "url"; url: string };

/** `ui.nodes.v2` */
export interface ChecklistItem {
  text: string;
  state: "todo" | "doing" | "done" | "skipped";
  note?: string;
}
/** `ui.nodes.v2` */
export interface UIRow {
  title: string;
  status?: string;
  tone?: Tone;
  meta?: string;
  ref?: UIRef;
}

export type UINode =
  | { t: "text"; text: string; tone?: Tone }
  | { t: "markdown"; text: string }
  | { t: "code"; text: string; lang?: string }
  | { t: "diff"; patch: string }
  | { t: "list"; items: UINode[]; ordered?: boolean }
  | { t: "table"; columns: string[]; rows: string[][] }
  /** `open: false` starts a collapsible section closed (`ui.nodes.v2`). */
  | { t: "section"; title?: string; collapsible?: boolean; open?: boolean; children: UINode[] }
  | { t: "tabs"; tabs: { id: string; label: string; children: UINode[] }[] }
  | { t: "progress"; label: string; value?: number; status?: "running" | "ok" | "error" }
  | { t: "ref"; ref: UIRef; label: string }
  | { t: "form"; formId: string; fields: Field[]; submitLabel: string; cancelLabel?: string }
  | {
      t: "confirm";
      message: string;
      confirmLabel: string;
      cancelLabel: string;
      destructive?: boolean;
    }
  | { t: "actions"; actions: { id: string; label: string; tone?: ActionTone }[] }
  /** `ui.nodes.v2`: the four below. */
  | { t: "checklist"; items: ChecklistItem[] }
  | { t: "facts"; items: { label: string; value: string; mono?: boolean }[] }
  | { t: "rows"; rows: UIRow[] }
  | { t: "badge"; text: string; tone?: Tone };

export type FormValue = string | string[] | { other: string };
export type InteractionResponse =
  | { kind: "form"; values: Record<string, FormValue> }
  | { kind: "confirm"; confirmed: boolean }
  | { kind: "action"; actionId: string }
  | { kind: "cancel" };

// ---------------------------------------------------------------------------
// Tool views (`tool.views.v1`)

export type ToolKind = "read" | "edit" | "write" | "command" | "search" | "other";

/**
 * A tool call's row. Every field is optional and overrides what the client derives from the
 * tool's name and arguments (its name in mono and its first string argument).
 */
export interface ToolViewData {
  kind?: ToolKind;
  /** Finished: "Asked", "Updated todo". At most 40 characters. */
  verb?: string;
  /** Running: "Asking". Defaults to `verb`. */
  activeVerb?: string;
  /** What the call acted on, shown in mono. At most 500 characters. */
  target?: string;
  /** Up to six short facts after the target ("3 items"), 80 characters each. */
  meta?: string[];
  stat?: { added: number; removed: number };
  /** Shown when the row is opened, in place of the arguments. No forms or confirms. */
  detail?: UINode;
  /** Do not draw the row: a dock question or a tracker already stands for the call. */
  hide?: boolean;
}

// ---------------------------------------------------------------------------
// Contributions

export type ContributionPlacement =
  | "sidebar.header"
  | "sidebar.footer"
  | "session.panel"
  | "composer.pill"
  /** `adapter.trackers.v1`: a live summary above the input that opens `node`. */
  | "composer.tracker"
  /** `adapter.trackers.v1`: a short word (text or badge node, 24 characters) on the session's navigator row. */
  | "session.badge"
  | "palette.item"
  | "slash.command";

/** What a `composer.tracker` shows beside its title. */
export interface TrackerSummary {
  /** Progress or a count: "2/5", "3". At most 24 characters. */
  count?: string;
  status?: "idle" | "running" | "ok" | "error" | "attention";
  /** The step in progress. At most 120 characters. */
  step?: string;
}

export interface AdapterContribution {
  placement: ContributionPlacement;
  /** 1 to 100 characters. A tracker's label. */
  title: string;
  node: UINode;
  /** 1 to 2,000 characters of plain text for clients that cannot draw the node. */
  mobileFallback: string;
  order?: number;
  /** Required when `node` has a form or confirm; never on a pill or badge. */
  actionId?: string;
  /** `composer.tracker` only. */
  tracker?: TrackerSummary;
  /** `session.panel` only. */
  state?: unknown;
  /** `slash.command` only. */
  name?: string;
  /** `palette.item` only. */
  keywords?: string[];
}

// ---------------------------------------------------------------------------
// Pi dialogs and claims

export type PiUiMethod = "select" | "confirm" | "input" | "editor";
export type PiUiRequest =
  | { id: string; method: "select"; title: string; options: string[]; timeout?: number }
  | { id: string; method: "confirm"; title: string; message: string; timeout?: number }
  | { id: string; method: "input"; title: string; placeholder?: string; timeout?: number }
  | { id: string; method: "editor"; title: string; prefill?: string };
export type PiUiResponse = { value: string } | { confirmed: boolean } | { cancelled: true };

export type AnswerMatcher =
  | { method?: PiUiMethod | PiUiMethod[]; titleIncludes?: string; titleStartsWith?: string }
  | ((req: PiUiRequest) => boolean);
export type AnswerSource = PiUiResponse | ((req: PiUiRequest) => PiUiResponse | undefined);
export interface QueuedStep {
  match: AnswerMatcher;
  response: AnswerSource;
}
export type ClaimResponse = PiUiResponse | { sequence: (PiUiResponse | QueuedStep)[] };

/**
 * What a dialog is (`interaction.kinds.v1`). A question hides its tool call's row and takes
 * number keys; an approval keeps the row and is never answered by a key; a plan is read first.
 */
export type InteractionKind = "question" | "approval" | "plan";

export interface Claim {
  title: string;
  presentation: UINode;
  toPiResponse(resp: InteractionResponse): ClaimResponse | Promise<ClaimResponse>;
  ownerToolCallId?: string;
  kind?: InteractionKind;
}

// ---------------------------------------------------------------------------
// Hooks

export interface ToolStartEvent {
  toolCallId: string;
  name: string;
  args: unknown;
}
export interface ToolUpdateEvent extends ToolStartEvent {
  partialResult: unknown;
  details?: unknown;
}
export interface ToolEndEvent extends ToolStartEvent {
  result: unknown;
  isError: boolean;
  details?: unknown;
}
/** The tool as `toolCard` and `toolView` see it: running (no result yet) or finished. */
export interface ToolInfo {
  toolCallId: string;
  name: string;
  args: unknown;
  result?: unknown;
  isError?: boolean;
  details?: unknown;
}
export interface SessionEntryInfo {
  type: string;
  customType?: string;
  data?: unknown;
  [key: string]: unknown;
}
export interface CustomMessageInfo {
  customType: string;
  content: unknown;
  display?: boolean;
  details?: unknown;
}

export type AdapterFeature =
  | "tool.views.v1"
  | "ui.nodes.v2"
  | "adapter.trackers.v1"
  | "interaction.kinds.v1";

export interface AdapterContext {
  readonly sessionId: string;
  readonly adapterId: string;
  readonly state: {
    get<T = unknown>(key: string): T | undefined;
    set(key: string, value: unknown): void;
    delete(key: string): void;
    keys(): string[];
  };
  /** Undefined on a host from before contract v2. */
  readonly features?: readonly string[];
  setPanel(
    slot: string,
    node: UINode | null,
    opts?: { title?: string; mobileFallback?: string | null; state?: unknown },
  ): void;
  setContribution(id: string, contribution: AdapterContribution | null): void;
  attention(
    reason:
      | "needs_input"
      | "failed"
      | "ready_for_review"
      | "unsupported_interaction"
      | "host_unreachable"
      | "cache_expiring",
    summary: string,
  ): void;
  linkSubagent(link: {
    runId: string;
    label: string;
    status: string;
    sessionFile: string | null;
  }): void;
  queueAnswers(
    matcher: AnswerMatcher,
    responses: AnswerSource[],
    opts?: { toolCallId?: string },
  ): void;
  log(level: "debug" | "info" | "warning" | "error", message: string): void;
}

type Maybe<T> = T | Promise<T>;
// biome-ignore lint/suspicious/noConfusingVoidType: hooks without a return statement are fine
type Presented = boolean | undefined | void;

export interface ServerAdapter {
  onRestore?(ctx: AdapterContext): Maybe<void>;
  toolCard?(tool: ToolInfo, ctx: AdapterContext): Maybe<UINode | undefined>;
  /** `tool.views.v1`: called when the call starts and again when it ends. */
  toolView?(tool: ToolInfo, ctx: AdapterContext): Maybe<ToolViewData | undefined>;
  customMessageCard?(message: CustomMessageInfo, ctx: AdapterContext): Maybe<UINode | undefined>;
  claimInteraction?(req: PiUiRequest, ctx: AdapterContext): Maybe<Claim | undefined>;
  onToolStart?(e: ToolStartEvent, ctx: AdapterContext): Maybe<void>;
  onToolUpdate?(e: ToolUpdateEvent, ctx: AdapterContext): Maybe<void>;
  onToolEnd?(e: ToolEndEvent, ctx: AdapterContext): Maybe<void>;
  onEntry?(entry: SessionEntryInfo, ctx: AdapterContext): Maybe<void>;
  onCustomMessage?(m: CustomMessageInfo, ctx: AdapterContext): Maybe<void>;
  onStatus?(key: string, text: string | undefined, ctx: AdapterContext): Maybe<Presented>;
  onWidget?(key: string, lines: string[] | undefined, ctx: AdapterContext): Maybe<Presented>;
  onAction?(actionId: string, payload: unknown, ctx: AdapterContext): Maybe<void>;
}

/** Whether this host's contract has a v2 feature. False on every host from before v2. */
export type Supports = (ctx: Pick<AdapterContext, "features">, feature: AdapterFeature) => boolean;
