import type { CommandView } from "@switchyard/protocol";

/**
 * Wire shapes of Pi's RPC mode (Pi 1.4.x), from docs/rpc*.md, docs/json.md and rpc-types.d.ts.
 * Only the fields Switchyard reads are typed; everything else stays available on the raw records.
 */

/** A session event on Pi's stdout (anything that is not a response or an extension UI request). */
export interface PiEvent {
  type: string;
  [key: string]: any;
}

export type PiDialogMethod = "select" | "confirm" | "input" | "editor";
export type PiFireAndForgetMethod =
  | "notify"
  | "setStatus"
  | "setWidget"
  | "setTitle"
  | "set_editor_text";

/** `extension_ui_request` as emitted by Pi. */
export type PiUiRequest =
  | {
      type: "extension_ui_request";
      id: string;
      method: "select";
      title: string;
      options: string[];
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "confirm";
      title: string;
      message: string;
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "input";
      title: string;
      placeholder?: string;
      timeout?: number;
    }
  | { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
  | {
      type: "extension_ui_request";
      id: string;
      method: "notify";
      message: string;
      notifyType?: "info" | "warning" | "error";
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setStatus";
      statusKey: string;
      statusText?: string;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setWidget";
      widgetKey: string;
      widgetLines?: string[];
      widgetPlacement?: "aboveEditor" | "belowEditor";
    }
  | { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
  | { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

/** Dialog requests only (they block until answered). */
export type PiDialogRequest = Extract<PiUiRequest, { method: PiDialogMethod }>;

export function isDialogRequest(req: PiUiRequest): req is PiDialogRequest {
  return (
    req.method === "select" ||
    req.method === "confirm" ||
    req.method === "input" ||
    req.method === "editor"
  );
}

/** Body of an `extension_ui_response` (without `type` and `id`). */
export type PiUiResponseBody = { value: string } | { confirmed: boolean } | { cancelled: true };

export type UiPromptKind = "select" | "confirm" | "input" | "editor" | "custom";

/** A line from the bridge extension socket. */
export interface BridgeEvent {
  type: "hello" | "ui_prompt_start" | "ui_prompt_end" | "model_state";
  model?: unknown;
  thinkingLevel?: string | null;
  scoped?: string[];
  kind?: UiPromptKind | string;
  title?: string | null;
  /** A custom terminal dialog whose question is also shown to remote clients. */
  remoteBacked?: boolean;
  seq: number;
  at: string;
  pid: number;
}

/** `get_state` response data. */
export interface PiState {
  model?: { id: string; provider: string; [key: string]: unknown };
  thinkingLevel?: string;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode?: string;
  followUpMode?: string;
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  autoCompactionEnabled?: boolean;
  messageCount: number;
  pendingMessageCount: number;
}

/** `get_session_stats` response data. */
export interface PiSessionStats {
  sessionFile?: string;
  sessionId: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
}

export type PromptDisposition = "started" | "queued" | "handled" | "view";

export interface PromptOutcome {
  disposition: PromptDisposition;
  view: CommandView | null;
}
