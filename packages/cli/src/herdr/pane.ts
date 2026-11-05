import { runRawTerminal } from "@switchyard/terminal";
import type { ConnectionFlags } from "../config.js";
import type { Ctx } from "../context.js";
import { type PaneHooks, runSessionPane } from "../mirror/session-pane.js";
import { type HerdrCall, herdrCall, nextSeq } from "./client.js";
import { SESSION_TOKEN, SOURCE } from "./mirror.js";
import { readKey, stableLauncherPath } from "./util.js";

export interface PaneDeps {
  call: HerdrCall;
  runRaw: typeof runRawTerminal;
  readKey: () => Promise<string>;
}

const defaultDeps = (): PaneDeps => ({
  call: (method, params) => herdrCall(method, params),
  runRaw: runRawTerminal,
  readKey,
});

/**
 * `switchyard herdr pane <id>`: a mirrored tab's pane. Claims the pane for the session (so herdr
 * can resume it after a restart), then shows the session's Pi TUI. `q` closes the tab, which archives the session.
 */
export async function herdrPane(
  ctx: Ctx,
  sessionId: string,
  flags: ConnectionFlags,
  deps: PaneDeps = defaultDeps(),
): Promise<void> {
  const paneId = ctx.env.HERDR_PANE_ID;
  const hooks: PaneHooks = {
    noun: "tab",
    async claim() {
      if (!paneId) return;
      await deps
        .call("pane.report_agent", {
          pane_id: paneId,
          source: SOURCE,
          agent: SOURCE,
          state: "idle",
          agent_session_id: sessionId,
          resume_argv: ["sh", stableLauncherPath(ctx.env), "pane", sessionId],
          seq: nextSeq(),
        })
        .catch(() => {});
      await deps
        .call("pane.report_metadata", {
          pane_id: paneId,
          source: SOURCE,
          tokens: { [SESSION_TOKEN]: sessionId },
          seq: nextSeq(),
        })
        .catch(() => {});
    },
    async release() {
      if (!paneId) return;
      await deps
        .call("pane.report_metadata", {
          pane_id: paneId,
          source: SOURCE,
          tokens: { [SESSION_TOKEN]: null },
          seq: nextSeq(),
        })
        .catch(() => {});
      await deps
        .call("pane.release_agent", {
          pane_id: paneId,
          source: SOURCE,
          agent: SOURCE,
          seq: nextSeq(),
        })
        .catch(() => {});
    },
    async closeContainer() {
      if (!paneId) return;
      try {
        const tabId = (await deps.call("pane.get", { pane_id: paneId }))?.pane?.tab_id;
        if (tabId) await deps.call("tab.close", { tab_id: tabId });
      } catch {
        // leave the shell
      }
    },
  };
  await runSessionPane(ctx, sessionId, flags, hooks, deps);
}
