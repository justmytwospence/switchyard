import type { Session } from "@switchyard/protocol";
import { ApiRequestError, runRawTerminal } from "@switchyard/terminal";
import type { ConnectionFlags } from "../config.js";
import { type Ctx, connect } from "../context.js";
import { type HerdrCall, herdrCall, nextSeq } from "./client.js";
import { SESSION_TOKEN, SOURCE } from "./mirror.js";
import { readKey, stableLauncherPath } from "./util.js";

const LIVE = new Set(["starting", "idle", "running", "waiting_input"]);

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
  const { api, conn } = connect(ctx, flags);
  if (paneId) {
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
  }

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
        if ((await menu(`${(err as Error).message}. Enter: retry   q: close tab`)) === "close") {
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
        `${session.title} is ${session.runtime}. Enter: resume   q: close tab (archives it)`,
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
      // Headless (RPC) sessions have no Pi terminal; the mirror closes their tabs.
      const choice = await menu(
        `This session runs without a terminal. Open it in the web app: ${conn.url}/code/${sessionId}\nEnter: retry   q: close tab`,
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
      `Detached from ${session.title}. Enter: reattach   q: close tab (archives it)`,
    );
    if (choice === "close") break;
  }

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
    .call("pane.release_agent", { pane_id: paneId, source: SOURCE, agent: SOURCE, seq: nextSeq() })
    .catch(() => {});
  try {
    const tabId = (await deps.call("pane.get", { pane_id: paneId }))?.pane?.tab_id;
    if (tabId) await deps.call("tab.close", { tab_id: tabId });
  } catch {
    // leave the shell
  }
}
