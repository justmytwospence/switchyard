import type { Session } from "@switchyard/protocol";
import { runRawTerminal } from "@switchyard/terminal";
import { CliError, type ConnectionFlags } from "../config.js";
import { type Ctx, connect } from "../context.js";

const LIVE = new Set(["starting", "idle", "running", "waiting_input"]);

export const DETACHED_MESSAGE = "Detached; the session keeps running.";

/**
 * `switchyard tui <sessionId>`: open the session's Pi terminal (terminal sessions only), resuming
 * a stopped session first. Ctrl+] detaches.
 */
export async function tuiCommand(
  ctx: Ctx,
  sessionId: string,
  flags: ConnectionFlags,
  run: typeof runRawTerminal = runRawTerminal,
): Promise<void> {
  const { api, conn } = connect(ctx, flags);
  const session = await api.get<Session>(`/api/sessions/${encodeURIComponent(sessionId)}`);
  if (!LIVE.has(session.runtime)) {
    ctx.err(`Resuming ${session.title}...`);
    await api.post(`/api/sessions/${encodeURIComponent(sessionId)}/resume`);
  }
  const result = await run({
    coordinatorUrl: conn.url,
    credential: conn.credential,
    sessionId,
  });
  if (result.reason === "detached") {
    ctx.err(DETACHED_MESSAGE);
    return;
  }
  throw new CliError(result.message);
}
