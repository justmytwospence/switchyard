import { spawnSync } from "node:child_process";
import { hostname } from "node:os";
import type { Session } from "@switchyard/protocol";
import type { ConnectionFlags } from "../config.js";
import type { Ctx } from "../context.js";
import { offMessage, pickerBinding, pinNote, terminalId } from "../mirror/binding.js";
import { chooseSession } from "../mirror/choose.js";
import { Screen, type TerminalIO } from "../mirror/picker.js";
import { loadMirrorState, type MirrorState } from "../mirror/state.js";
import { tmuxRun, tmuxSessionName } from "./client.js";
import { WINDOW_OPTION } from "./mirror.js";
import { tmuxPane } from "./pane.js";

/** The workspace of the session in the window you came from (tmux's last window), if any. */
async function lastWindowWorkspace(st: MirrorState): Promise<string | undefined> {
  try {
    const sid = (await tmuxRun(["display-message", "-p", "-t", "!", `#{${WINDOW_OPTION}}`])).trim();
    const ws = st.sessions.find((s) => s.id === sid)?.workspaceId;
    return ws && st.workspaces.some((w) => w.id === ws && w.archivedAt === null) ? ws : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `switchyard tmux new`: start a session from a tmux window. The window then becomes the
 * session's window. Leaving the picker keeps a plain shell.
 */
export async function tmuxNew(
  ctx: Ctx,
  flags: ConnectionFlags & { workspace?: string },
  io?: TerminalIO,
): Promise<void> {
  ctx.err("Connecting to Switchyard…");
  const { client, state } = await loadMirrorState(ctx, flags);
  const name = await tmuxSessionName(ctx.env);
  const id = terminalId("tmux", name, hostname());
  const bound = pickerBinding(state(), ctx.env, id);
  if (bound === "off") {
    client.close();
    ctx.err(offMessage("tmux", id));
    if (!io) spawnSync(ctx.env.SHELL || "/bin/sh", [], { stdio: "inherit" });
    return;
  }
  const screen = new Screen(
    io ?? { input: process.stdin, output: process.stdout, color: !("NO_COLOR" in ctx.env) },
  );
  let created: Session | null = null;
  let opened: string | null = null;
  // `prefix S` opens this window from another: offer that window's workspace first.
  const workspace = flags.workspace ?? (io ? undefined : await lastWindowWorkspace(state()));
  try {
    const choice = await chooseSession(state(), screen, {
      ...(workspace ? { workspaceId: workspace } : {}),
    });
    screen.leave();
    if (!choice) {
      ctx.err("Kept this window as a shell.");
      if (!io) spawnSync(ctx.env.SHELL || "/bin/sh", [], { stdio: "inherit" });
      return;
    }
    if ("openSessionId" in choice) {
      opened = choice.openSessionId;
    } else {
      created = await client.api.post<Session>("/api/sessions", {
        ...choice,
        prompt: "",
        ...(bound ? { viewId: bound.id } : {}),
      });
      ctx.err(`Starting ${created.title}…`);
      if (bound) {
        const note = await pinNote(client.api, bound, created.id);
        if (note) ctx.err(note);
      }
    }
  } finally {
    screen.leave();
    client.close();
  }
  const show = created?.id ?? opened;
  if (show) await tmuxPane(ctx, show, flags);
}
