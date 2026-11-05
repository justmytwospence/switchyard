import { runRawTerminal } from "@switchyard/terminal";
import type { ConnectionFlags } from "../config.js";
import type { Ctx } from "../context.js";
import { readKey } from "../herdr/util.js";
import { type PaneHooks, runSessionPane } from "../mirror/session-pane.js";
import { type TmuxRun, tmuxRun } from "./client.js";
import { WINDOW_OPTION } from "./mirror.js";

export interface TmuxPaneDeps {
  run: TmuxRun;
  runRaw: typeof runRawTerminal;
  readKey: () => Promise<string>;
}

const defaultDeps = (): TmuxPaneDeps => ({ run: tmuxRun, runRaw: runRawTerminal, readKey });

/** `switchyard tmux pane <id>`: a mirrored window's pane. `q` closes the window (archives the session). */
export async function tmuxPane(
  ctx: Ctx,
  sessionId: string,
  flags: ConnectionFlags,
  deps: TmuxPaneDeps = defaultDeps(),
): Promise<void> {
  const pane = ctx.env.TMUX_PANE;
  const hooks: PaneHooks = {
    noun: "window",
    async claim() {
      if (!pane) return;
      await deps.run(["set-option", "-w", "-t", pane, WINDOW_OPTION, sessionId]).catch(() => {});
      await deps.run(["set-option", "-w", "-t", pane, "remain-on-exit", "on"]).catch(() => {});
    },
    async release() {
      if (!pane) return;
      await deps.run(["set-option", "-w", "-u", "-t", pane, WINDOW_OPTION]).catch(() => {});
    },
    async closeContainer() {
      if (!pane) return;
      await deps.run(["kill-window", "-t", pane]).catch(() => {});
    },
  };
  await runSessionPane(ctx, sessionId, flags, hooks, deps);
}
