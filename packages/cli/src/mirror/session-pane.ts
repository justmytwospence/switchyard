import type { Session } from "@switchyard/protocol";
import { ApiRequestError, type runRawTerminal } from "@switchyard/terminal";
import type { ConnectionFlags } from "../config.js";
import { type Ctx, connect } from "../context.js";

const LIVE = new Set(["starting", "idle", "running", "waiting_input"]);

export interface PaneHooks {
  /** Mark the pane as showing this session (so a restart can resume it). */
  claim(): Promise<void>;
  /** Undo `claim` once the session is left. */
  release(): Promise<void>;
  /** Close the tab or window. */
  closeContainer(): Promise<void>;
  noun: "tab" | "window";
}

export interface SessionPaneDeps {
  runRaw: typeof runRawTerminal;
  readKey: () => Promise<string>;
}

/**
 * A mirrored tab's or window's pane: claims it for the session, then shows the session's Pi TUI
 * (reattach, resume and close menus between runs). `q` closes the container, which archives the
 * session.
 */
export async function runSessionPane(
  ctx: Ctx,
  sessionId: string,
  flags: ConnectionFlags,
  hooks: PaneHooks,
  deps: SessionPaneDeps,
): Promise<void> {
  const { api, conn } = connect(ctx, flags);
  const noun = hooks.noun;
  await hooks.claim();

  const menu = async (line: string): Promise<"again" | "close"> => {
    ctx.err(line);
    for (;;) {
      const key = await deps.readKey();
      if (key === "\r" || key === "\n") return "again";
      if (key === "q" || key === "Q" || key === "\u0003") return "close";
    }
  };

  let announced = false;
  for (;;) {
    let session: Session | null = null;
    try {
      session = await api.get<Session>(`/api/sessions/${encodeURIComponent(sessionId)}`);
    } catch (err) {
      if (!(err instanceof ApiRequestError && err.code === "not_found")) {
        if (
          (await menu(`${(err as Error).message}. Enter: retry   q: close ${noun}`)) === "close"
        ) {
          break;
        }
        continue;
      }
    }
    if (!session || session.archivedAt !== null) {
      ctx.err("This session was archived.");
      break;
    }
    if (session.runtime === "starting") {
      // Wait until the host says whether it is a terminal session.
      if (!announced) ctx.err(`Starting ${session.title}…`);
      announced = true;
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    if (!LIVE.has(session.runtime)) {
      const choice = await menu(
        `${session.title} is ${session.runtime}. Enter: resume   q: close ${noun} (archives it)`,
      );
      if (choice === "close") break;
      try {
        await api.post(`/api/sessions/${encodeURIComponent(sessionId)}/resume`);
      } catch (err) {
        ctx.err(`Could not resume: ${(err as Error).message}`);
      }
      continue;
    }
    if (!session.terminal) {
      // Headless (RPC) sessions have no Pi terminal; the mirror closes their containers.
      const choice = await menu(
        `This session runs without a terminal. Open it in the web app: ${conn.url}/code/${sessionId}\nEnter: retry   q: close ${noun}`,
      );
      if (choice === "close") break;
      continue;
    }
    const r = await deps.runRaw({
      coordinatorUrl: conn.url,
      credential: conn.credential,
      sessionId,
    });
    if (r.reason === "closed") ctx.err(r.message);
    const choice = await menu(
      `Detached from ${session.title}. Enter: reattach   q: close ${noun} (archives it)`,
    );
    if (choice === "close") break;
  }

  await hooks.release();
  await hooks.closeContainer();
}
