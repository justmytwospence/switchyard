import type { Presence } from "@switchyard/protocol";

/** Refresh a focus report this often; the coordinator's foreground lease is 45 s. */
const EVERY_MS = 15_000;

/**
 * Report the session focused in this client as being viewed, so a session you watch in herdr
 * or tmux is not marked unread and its notifications stay inline. `focused` returns null while
 * no client is attached or the focused pane shows no session. Reports when the focus changes
 * (`check()`) and every 15 s while something is focused.
 */
export function startFocusPresence(opts: {
  clientId: string;
  send: (presence: Presence) => boolean;
  focused: () => Promise<string | null>;
  log: (line: string) => void;
  /** How often to check without an event (default: the 15 s refresh). */
  pollMs?: number;
}): { check(): void; stop(): void } {
  let last: string | null = null;
  let lastSentAt = 0;
  let stopped = false;
  let running = false;
  let again = false;
  let lastError = "";
  const report = (sessionId: string | null) =>
    opts.send({
      foreground: sessionId !== null,
      interactedAt: null,
      viewing: sessionId ? { sessionId } : null,
      clientId: opts.clientId,
    });
  const check = async (): Promise<void> => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      const now = Date.now();
      const sid = await opts.focused().catch((err: Error) => {
        if (err.message !== lastError) opts.log(`focus check failed: ${err.message}`);
        lastError = err.message;
        return null;
      });
      const due = sid !== null && now - lastSentAt >= EVERY_MS - 1000;
      if ((sid !== last || due) && report(sid)) {
        last = sid;
        lastSentAt = now;
      }
    } finally {
      running = false;
    }
    if (again) {
      again = false;
      await check();
    }
  };
  const timer = setInterval(() => void check(), opts.pollMs ?? EVERY_MS);
  timer.unref?.();
  void check();
  return {
    check: () => void check(),
    stop() {
      stopped = true;
      clearInterval(timer);
      if (last !== null) report(null);
    },
  };
}

/**
 * Whether a herdr client is attached to the herdr session `name`, from `ps -axo args=` lines:
 * `herdr` (the unnamed session, `default`), `herdr --session <name>` or `herdr session attach
 * <name>`. The herdr server and remote bridges do not count.
 */
export function herdrClientAttached(psLines: string[], name: string): boolean {
  for (const line of psLines) {
    const argv = line.trim().split(/\s+/);
    const i = argv.findIndex((a) => a === "herdr" || a.endsWith("/herdr"));
    if (i < 0) continue;
    const args = argv.slice(i + 1);
    if (args[0] === "session" && args[1] === "attach") {
      if (args[2] === name) return true;
      continue;
    }
    if (args.some((a) => !a.startsWith("-") && a !== name)) continue; // a subcommand
    const s = args.indexOf("--session");
    const session = s >= 0 ? args[s + 1] : "default";
    if (session === name) return true;
  }
  return false;
}
