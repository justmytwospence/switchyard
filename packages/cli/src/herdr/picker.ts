/**
 * A small full-screen fuzzy picker and text prompt for the herdr new-session flow. Matching, key
 * parsing and rendering are pure; `Screen` owns the terminal (alternate screen, raw mode).
 */

// ---------------------------------------------------------------------------------------------
// Fuzzy matching

export interface FuzzyMatch {
  score: number;
  /** Matched indices into the searched text. */
  positions: number[];
}

const BOUNDARY = new Set([" ", "/", "-", "_", ".", "·", ":", "(", "@"]);

function scorePositions(text: string, pos: number[]): number {
  let score = 0;
  for (let k = 0; k < pos.length; k++) {
    const p = pos[k]!;
    score += 1;
    const prev = text[p - 1];
    if (p === 0) score += 8;
    else if (prev !== undefined && BOUNDARY.has(prev)) score += 6;
    else if (prev !== undefined && /[a-z]/.test(prev) && /[A-Z]/.test(text[p]!)) score += 5;
    if (k > 0) {
      const gap = p - pos[k - 1]! - 1;
      score += gap === 0 ? 5 : -Math.min(gap, 12) * 0.3;
    }
  }
  return score;
}

function matchToken(token: string, text: string): FuzzyMatch | null {
  const t = text.toLowerCase();
  const q = token.toLowerCase();
  let best: FuzzyMatch | null = null;
  for (let start = t.indexOf(q[0]!); start !== -1; start = t.indexOf(q[0]!, start + 1)) {
    const pos = [start];
    let from = start + 1;
    for (let k = 1; k < q.length; k++) {
      const j = t.indexOf(q[k]!, from);
      if (j === -1) return best; // later starts cannot match either
      pos.push(j);
      from = j + 1;
    }
    const score = scorePositions(text, pos);
    if (!best || score > best.score) best = { score, positions: pos };
  }
  return best;
}

/**
 * fzf-style match: every space-separated token must appear in order (case-insensitive); word
 * starts and runs score higher. Returns null when a token does not match.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { score: 0, positions: [] };
  let score = 0;
  const positions = new Set<number>();
  for (const tok of tokens) {
    const m = matchToken(tok, text);
    if (!m) return null;
    score += m.score;
    for (const p of m.positions) positions.add(p);
  }
  return { score, positions: [...positions].sort((a, b) => a - b) };
}

export interface PickItem<T> {
  label: string;
  /** Dimmed text after the label; searched too, but label matches rank higher. */
  detail?: string;
  value: T;
}

export interface Ranked<T> {
  item: PickItem<T>;
  labelPositions: number[];
  detailPositions: number[];
}

/**
 * Each query token must match within the label or within the detail (never across both); label
 * matches score higher.
 */
function matchItem(
  query: string,
  label: string,
  detail: string,
): { score: number; labelPositions: number[]; detailPositions: number[] } | null {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  let score = 0;
  const inLabel = new Set<number>();
  const inDetail = new Set<number>();
  for (const tok of tokens) {
    const l = matchToken(tok, label);
    const d = detail ? matchToken(tok, detail) : null;
    if (l && (!d || l.score + 4 >= d.score)) {
      score += l.score + 4;
      for (const p of l.positions) inLabel.add(p);
    } else if (d) {
      score += d.score;
      for (const p of d.positions) inDetail.add(p);
    } else {
      return null;
    }
  }
  const sorted = (x: Set<number>) => [...x].sort((a, b) => a - b);
  return { score, labelPositions: sorted(inLabel), detailPositions: sorted(inDetail) };
}

/** Matching items, best first (stable), followed by `extra` (always shown, unfiltered). */
export function filterItems<T>(
  items: PickItem<T>[],
  query: string,
  extra: PickItem<T>[] = [],
): Ranked<T>[] {
  const plain = (item: PickItem<T>): Ranked<T> => ({
    item,
    labelPositions: [],
    detailPositions: [],
  });
  if (query.trim() === "") return [...items.map(plain), ...extra.map(plain)];
  const ranked: (Ranked<T> & { score: number; index: number })[] = [];
  for (const [index, item] of items.entries()) {
    const m = matchItem(query, item.label, item.detail ?? "");
    if (m) ranked.push({ item, index, ...m });
  }
  ranked.sort((a, b) => b.score - a.score || a.index - b.index);
  return [
    ...ranked.map(({ item, labelPositions, detailPositions }) => ({
      item,
      labelPositions,
      detailPositions,
    })),
    ...extra.map(plain),
  ];
}

// ---------------------------------------------------------------------------------------------
// Keys

export type Key =
  | { name: "char"; ch: string }
  | {
      name:
        | "up"
        | "down"
        | "pageup"
        | "pagedown"
        | "home"
        | "end"
        | "enter"
        | "esc"
        | "cancel"
        | "backspace"
        | "clear"
        | "deleteWord"
        | "tab";
    };

const SEQUENCES: [string, Key["name"]][] = [
  ["\x1b[A", "up"],
  ["\x1bOA", "up"],
  ["\x1b[B", "down"],
  ["\x1bOB", "down"],
  ["\x1b[5~", "pageup"],
  ["\x1b[6~", "pagedown"],
  ["\x1b[H", "home"],
  ["\x1b[1~", "home"],
  ["\x1b[F", "end"],
  ["\x1b[4~", "end"],
  ["\x1b\x7f", "deleteWord"],
];

const CONTROLS: Record<string, Key["name"]> = {
  "\r": "enter",
  "\n": "enter",
  "\x03": "cancel",
  "\x04": "cancel",
  "\x7f": "backspace",
  "\b": "backspace",
  "\x15": "clear",
  "\x17": "deleteWord",
  "\x10": "up",
  "\x0b": "up",
  "\x0e": "down",
  "\t": "tab",
};

/** Split one stdin chunk into keys. A lone ESC is Esc; unknown sequences are dropped. */
export function parseKeys(chunk: string): Key[] {
  const keys: Key[] = [];
  let i = 0;
  while (i < chunk.length) {
    if (chunk[i] === "\x1b") {
      const seq = SEQUENCES.find(([s]) => chunk.startsWith(s, i));
      if (seq) {
        keys.push({ name: seq[1] } as Key);
        i += seq[0].length;
        continue;
      }
      // CSI / SS3 we do not know: skip it whole.
      const m = /^(\[[0-9;?]*[ -/]*[@-~]|O.)/.exec(chunk.slice(i + 1));
      if (m) {
        i += 1 + m[0].length;
        continue;
      }
      keys.push({ name: "esc" });
      i += 1;
      continue;
    }
    const ch = chunk[i]!;
    const ctl = CONTROLS[ch];
    if (ctl) keys.push({ name: ctl } as Key);
    else if (ch >= " ") keys.push({ name: "char", ch });
    i += 1;
  }
  return keys;
}

// ---------------------------------------------------------------------------------------------
// Rendering

export interface Style {
  color: boolean;
}

const A = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  accent: "\x1b[36m",
  match: "\x1b[1;33m",
  error: "\x1b[31m",
};

function paint(s: Style, code: string, text: string): string {
  return s.color && text ? `${code}${text}${A.reset}` : text;
}

function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

/** `text` cut to `width`, matched characters highlighted over `base`. */
function highlight(s: Style, text: string, positions: number[], width: number, base: string) {
  const cut = truncate(text, width);
  if (!s.color) return cut;
  const hit = new Set(positions);
  let out = "";
  let run = "";
  let runHit = false;
  const flush = () => {
    if (run) out += `${runHit ? A.match : base}${run}${A.reset}`;
    run = "";
  };
  for (let i = 0; i < cut.length; i++) {
    const h = hit.has(i) && !(i === cut.length - 1 && cut.length < text.length);
    if (h !== runHit) {
      flush();
      runHit = h;
    }
    run += cut[i];
  }
  flush();
  return out;
}

export interface Frame {
  /** Breadcrumb, e.g. ["New session", "29ers"]. */
  crumbs: string[];
  /** Above the input, e.g. "Workspace". */
  heading: string;
  /** Shown under the list when there is nothing to pick from. */
  empty?: string;
  hint: string;
}

function header(s: Style, frame: Frame): string[] {
  const crumbs = ["Switchyard", ...frame.crumbs]
    .map((c, i) => (i === 0 ? paint(s, A.accent + A.bold, c) : paint(s, A.bold, c)))
    .join(paint(s, A.dim, " › "));
  return ["", ` ${crumbs}`, ""];
}

/** The picker's screen as lines (no trailing clear codes). `cursorRow` is the input line. */
export function renderPicker<T>(
  s: Style,
  frame: Frame,
  query: string,
  ranked: Ranked<T>[],
  selected: number,
  scroll: number,
  total: number,
  width: number,
  height: number,
): { lines: string[]; cursorRow: number; cursorCol: number } {
  const lines = header(s, frame);
  lines.push(` ${paint(s, A.dim, frame.heading)}`);
  const count = `${ranked.length}/${total}`;
  const prompt = " ❯ ";
  const inputWidth = Math.max(1, width - prompt.length - count.length - 2);
  const shown = query.length > inputWidth ? `…${query.slice(-(inputWidth - 1))}` : query;
  const pad = Math.max(1, width - prompt.length - shown.length - count.length - 1);
  lines.push(`${paint(s, A.accent, prompt)}${shown}${" ".repeat(pad)}${paint(s, A.dim, count)}`);
  const cursorRow = lines.length - 1;
  const cursorCol = prompt.length + shown.length;
  lines.push(` ${paint(s, A.dim, "─".repeat(Math.max(0, width - 2)))}`);

  const listHeight = Math.max(1, height - lines.length - 2);
  const labelWidth = Math.min(
    Math.max(8, ...ranked.map((r) => r.item.label.length)),
    Math.max(8, Math.floor((width - 4) * 0.5)),
  );
  if (ranked.length === 0) {
    lines.push(`   ${paint(s, A.dim, frame.empty ?? "No matches")}`);
  }
  for (let i = scroll; i < Math.min(ranked.length, scroll + listHeight); i++) {
    const r = ranked[i]!;
    const sel = i === selected;
    const bar = sel ? paint(s, A.accent, " ▌ ") : "   ";
    const label = highlight(s, r.item.label, r.labelPositions, labelWidth, sel ? A.bold : "");
    const labelPad = " ".repeat(
      Math.max(0, labelWidth - Math.min(r.item.label.length, labelWidth)),
    );
    const detailWidth = width - 3 - labelWidth - 2 - 1;
    const detail = r.item.detail
      ? highlight(s, r.item.detail, r.detailPositions, detailWidth, A.dim)
      : "";
    lines.push(`${bar}${label}${detail ? `${labelPad}  ${detail}` : ""}`);
  }
  while (lines.length < height - 1) lines.push("");
  lines.push(` ${paint(s, A.dim, truncate(frame.hint, width - 2))}`);
  return { lines, cursorRow, cursorCol };
}

export function renderInput(
  s: Style,
  frame: Frame,
  value: string,
  placeholder: string,
  error: string | null,
  note: string | null,
  width: number,
  height: number,
): { lines: string[]; cursorRow: number; cursorCol: number } {
  const lines = header(s, frame);
  lines.push(` ${paint(s, A.dim, frame.heading)}`);
  const prompt = " ❯ ";
  const room = Math.max(1, width - prompt.length - 1);
  const shown = value.length > room ? `…${value.slice(-(room - 1))}` : value;
  lines.push(
    `${paint(s, A.accent, prompt)}${shown || paint(s, A.dim, truncate(placeholder, room))}`,
  );
  const cursorRow = lines.length - 1;
  const cursorCol = prompt.length + shown.length;
  lines.push("");
  if (error) lines.push(`   ${paint(s, A.error, truncate(error, width - 4))}`);
  else if (note) lines.push(`   ${paint(s, A.dim, truncate(note, width - 4))}`);
  while (lines.length < height - 1) lines.push("");
  lines.push(` ${paint(s, A.dim, truncate(frame.hint, width - 2))}`);
  return { lines, cursorRow, cursorCol };
}

// ---------------------------------------------------------------------------------------------
// Terminal

export interface TerminalIO {
  input: NodeJS.ReadableStream & { setRawMode?: (raw: boolean) => unknown; isTTY?: boolean };
  output: NodeJS.WritableStream & {
    columns?: number;
    rows?: number;
    on?: (ev: "resize", fn: () => void) => unknown;
    off?: (ev: "resize", fn: () => void) => unknown;
  };
  color?: boolean;
}

/** A step's result; `query` is what was typed, for returning to the step later. */
export type Outcome<T> =
  | { kind: "ok"; value: T; query: string }
  | { kind: "back"; query: string }
  | { kind: "cancel" };

/** The terminal for the picker steps: one alternate screen, raw input, a key queue. */
export class Screen {
  private queue: Key[] = [];
  private waiter: (() => void) | null = null;
  private redraw: (() => void) | null = null;
  private readonly style: Style;
  private readonly onData = (d: Buffer | string) => {
    this.queue.push(...parseKeys(d.toString()));
    this.waiter?.();
  };
  private readonly onResize = () => this.redraw?.();
  private open = false;

  constructor(private readonly io: TerminalIO) {
    this.style = { color: io.color ?? true };
  }

  enter(): void {
    if (this.open) return;
    this.open = true;
    this.io.input.setRawMode?.(true);
    this.io.input.on("data", this.onData);
    this.io.input.resume();
    this.io.output.on?.("resize", this.onResize);
    this.io.output.write("\x1b[?1049h\x1b[H");
  }

  leave(): void {
    if (!this.open) return;
    this.open = false;
    this.io.output.off?.("resize", this.onResize);
    this.io.input.off("data", this.onData);
    this.io.input.setRawMode?.(false);
    this.io.input.pause();
    this.io.output.write("\x1b[?25h\x1b[?1049l");
  }

  private size(): { width: number; height: number } {
    return {
      width: Math.max(20, this.io.output.columns ?? 80),
      height: Math.max(8, this.io.output.rows ?? 24),
    };
  }

  private draw(frame: { lines: string[]; cursorRow: number; cursorCol: number }): void {
    const body = frame.lines.map((l) => `${l}\x1b[K`).join("\r\n");
    this.io.output.write(
      `\x1b[?25l\x1b[H${body}\x1b[J\x1b[${frame.cursorRow + 1};${frame.cursorCol + 1}H\x1b[?25h`,
    );
  }

  private async key(): Promise<Key> {
    while (this.queue.length === 0) {
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
      this.waiter = null;
    }
    return this.queue.shift()!;
  }

  /**
   * Pick one item. `extra(query)` adds items shown after the matches whatever the query (such as
   * "new worktree <query>"). Esc goes back, Ctrl+C cancels.
   */
  async pick<T>(
    frame: Frame,
    items: PickItem<T>[],
    extra: (query: string) => PickItem<T>[] = () => [],
    initialQuery = "",
  ): Promise<Outcome<T>> {
    this.enter();
    let query = initialQuery;
    let selected = 0;
    let scroll = 0;
    let ranked = filterItems(items, query, extra(query));
    const render = () => {
      const { width, height } = this.size();
      const listHeight = Math.max(1, height - 8);
      selected = Math.max(0, Math.min(selected, ranked.length - 1));
      if (selected < scroll) scroll = selected;
      if (selected >= scroll + listHeight) scroll = selected - listHeight + 1;
      scroll = Math.max(0, Math.min(scroll, Math.max(0, ranked.length - listHeight)));
      const total = items.length + extra(query).length;
      this.draw(
        renderPicker(this.style, frame, query, ranked, selected, scroll, total, width, height),
      );
    };
    this.redraw = render;
    const requery = (q: string) => {
      query = q;
      ranked = filterItems(items, query, extra(query));
      selected = 0;
      scroll = 0;
    };
    render();
    for (;;) {
      const k = await this.key();
      const page = Math.max(1, this.size().height - 9);
      switch (k.name) {
        case "char":
          requery(query + k.ch);
          break;
        case "backspace":
          requery(query.slice(0, -1));
          break;
        case "clear":
          requery("");
          break;
        case "deleteWord":
          requery(query.replace(/\s*\S+\s*$/, ""));
          break;
        case "up":
          selected = selected > 0 ? selected - 1 : ranked.length - 1;
          break;
        case "down":
        case "tab":
          selected = selected < ranked.length - 1 ? selected + 1 : 0;
          break;
        case "pageup":
          selected = Math.max(0, selected - page);
          break;
        case "pagedown":
          selected = Math.min(ranked.length - 1, selected + page);
          break;
        case "home":
          selected = 0;
          break;
        case "end":
          selected = ranked.length - 1;
          break;
        case "enter": {
          const r = ranked[selected];
          if (r) return { kind: "ok", value: r.item.value, query };
          break;
        }
        case "esc":
          return { kind: "back", query };
        case "cancel":
          return { kind: "cancel" };
      }
      render();
    }
  }

  /**
   * Read one line. `check` returns an error to show (Enter is refused) or null; `preview` a note
   * under the input (such as the branch name the value becomes).
   */
  async ask(
    frame: Frame,
    opts: {
      placeholder?: string;
      initial?: string;
      check?: (value: string) => string | null;
      preview?: (value: string) => string | null;
    } = {},
  ): Promise<Outcome<string>> {
    this.enter();
    let value = opts.initial ?? "";
    let error: string | null = null;
    const render = () => {
      const { width, height } = this.size();
      const note = opts.preview?.(value) ?? null;
      this.draw(
        renderInput(this.style, frame, value, opts.placeholder ?? "", error, note, width, height),
      );
    };
    this.redraw = render;
    render();
    for (;;) {
      const k = await this.key();
      switch (k.name) {
        case "char":
          value += k.ch;
          error = null;
          break;
        case "backspace":
          value = value.slice(0, -1);
          error = null;
          break;
        case "clear":
          value = "";
          error = null;
          break;
        case "deleteWord":
          value = value.replace(/\s*\S+\s*$/, "");
          error = null;
          break;
        case "enter":
          error = opts.check?.(value) ?? null;
          if (!error) return { kind: "ok", value, query: value };
          break;
        case "esc":
          return { kind: "back", query: value };
        case "cancel":
          return { kind: "cancel" };
        default:
          break;
      }
      render();
    }
  }
}
