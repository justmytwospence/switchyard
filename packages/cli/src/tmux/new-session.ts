import { spawnSync } from "node:child_process";
import type { Session } from "@switchyard/protocol";
import type { ConnectionFlags } from "../config.js";
import type { Ctx } from "../context.js";
import { bindingRef, noViewMessage, viewOrMissing } from "../mirror/binding.js";
import { chooseSession } from "../mirror/choose.js";
import { Screen, type TerminalIO } from "../mirror/picker.js";
import { loadMirrorState } from "../mirror/state.js";
import { tmuxSessionName } from "./client.js";
import { tmuxPane } from "./pane.js";

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
  const bound = viewOrMissing(state(), bindingRef(ctx.env, name));
  if (bound === "missing") {
    client.close();
    ctx.err(noViewMessage("tmux", bindingRef(ctx.env, name)));
    if (!io) spawnSync(ctx.env.SHELL || "/bin/sh", [], { stdio: "inherit" });
    return;
  }
  const screen = new Screen(
    io ?? { input: process.stdin, output: process.stdout, color: !("NO_COLOR" in ctx.env) },
  );
  let created: Session | null = null;
  try {
    const choice = await chooseSession(state(), screen, {
      ...(flags.workspace ? { workspaceId: flags.workspace } : {}),
    });
    screen.leave();
    if (!choice) {
      ctx.err("Kept this window as a shell.");
      if (!io) spawnSync(ctx.env.SHELL || "/bin/sh", [], { stdio: "inherit" });
      return;
    }
    created = await client.api.post<Session>("/api/sessions", {
      ...choice,
      prompt: "",
      viewId: bound.id,
    });
    ctx.err(`Starting ${created.title}…`);
  } finally {
    screen.leave();
    client.close();
  }
  if (created) await tmuxPane(ctx, created.id, flags);
}
