/**
 * Key events in the shape Ink delivers them (`useInput(input, key)`), with every flag optional so
 * pure logic and tests can build them cheaply.
 */
export interface KeyPress {
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
  return?: boolean;
  escape?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  tab?: boolean;
  backspace?: boolean;
  delete?: boolean;
}

export type Screen = "list" | "session" | "help";

export type GlobalAction = "quit" | "help" | "back" | "takeover" | "stop" | "search" | null;

/**
 * Global key decisions, checked before screen-specific handling.
 *
 * - Ctrl+C quits (detach only; it never stops execution).
 * - `?` opens help when the user is not typing (empty composer, no text entry focused).
 * - Esc goes back (session to list, help to the previous screen).
 * - Ctrl+T toggles take over / return to automation, Ctrl+X asks to stop (session view).
 * - `/` starts the search on the session list.
 */
export function globalAction(
  input: string,
  key: KeyPress,
  ctx: { screen: Screen; typing: boolean; searching?: boolean },
): GlobalAction {
  if (key.ctrl && input === "c") return "quit";
  if (ctx.screen === "help") return key.escape || input === "?" || input === "q" ? "back" : null;
  if (key.ctrl && input === "t" && ctx.screen === "session") return "takeover";
  if (key.ctrl && input === "x" && ctx.screen === "session") return "stop";
  if (ctx.searching) return null;
  if (key.escape) return "back";
  if (!ctx.typing && input === "?" && !key.ctrl && !key.meta) return "help";
  if (ctx.screen === "list" && input === "/" && !key.ctrl) return "search";
  return null;
}

/** Printable text carried by a key event, or "" for control keys. */
export function printable(input: string, key: KeyPress): string {
  if (key.ctrl || key.meta || key.escape || key.return || key.tab) return "";
  if (key.backspace || key.delete) return "";
  if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return "";
  if (key.pageUp || key.pageDown) return "";
  // Pasted text may carry newlines; normalize CRLF.
  return input.replace(/\r\n?/g, "\n");
}

/** Whether a key inserts a newline in a multi-line text entry (Alt+Enter, or a raw LF). */
export function isNewline(input: string, key: KeyPress): boolean {
  return (key.return === true && key.meta === true) || (!key.return && input === "\n");
}

/** Edit a single-cursor-at-end text buffer: printable characters, Backspace, newline. */
export function editText(
  value: string,
  input: string,
  key: KeyPress,
  opts: { multiline: boolean },
): string | null {
  if (opts.multiline && isNewline(input, key)) return `${value}\n`;
  if (key.backspace || key.delete) return value.slice(0, -1);
  const text = printable(input, key);
  if (!text) return null;
  return value + (opts.multiline ? text : text.replace(/\n/g, " "));
}

export type ComposerAction =
  | { kind: "edit"; draft: string }
  | { kind: "send"; mode: "prompt" | "followUp" | "steer"; text: string }
  | { kind: "blocked"; reason: string }
  | { kind: "none" };

/**
 * Composer key handling. Enter sends; Alt+Enter inserts a newline. While the session is running,
 * Enter queues a follow-up and Ctrl+S steers (only when the host supports steering).
 */
export function composerKey(
  draft: string,
  input: string,
  key: KeyPress,
  ctx: { busy: boolean; canSteer: boolean; disabledReason: string | null },
): ComposerAction {
  if (key.ctrl && input === "s") {
    if (!ctx.busy) return { kind: "none" };
    if (!ctx.canSteer) return { kind: "blocked", reason: "This host does not support steering" };
    if (!draft.trim()) return { kind: "none" };
    if (ctx.disabledReason) return { kind: "blocked", reason: ctx.disabledReason };
    return { kind: "send", mode: "steer", text: draft };
  }
  if (key.return && !key.meta) {
    if (!draft.trim()) return { kind: "none" };
    if (ctx.disabledReason) return { kind: "blocked", reason: ctx.disabledReason };
    return { kind: "send", mode: ctx.busy ? "followUp" : "prompt", text: draft };
  }
  const next = editText(draft, input, key, { multiline: true });
  return next === null ? { kind: "none" } : { kind: "edit", draft: next };
}
