import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "@switchyard/protocol";
import { CliError, type ConnectionFlags } from "../config.js";
import type { Ctx } from "../context.js";
import { chooseSession } from "../mirror/choose.js";
import { Screen, type TerminalIO } from "../mirror/picker.js";
import { loadMirrorState, resolveBoundView } from "../mirror/state.js";
import { herdrCall } from "./client.js";
import { herdrPane } from "./pane.js";
import { launcherCommand, runInPane, sessionStateDir, stableLauncherPath } from "./util.js";

export interface NewFlags extends ConnectionFlags {
  workspace?: string;
  here?: boolean;
}

/**
 * `switchyard herdr new`: start a Switchyard session from a herdr tab. With `--workspace`, offers
 * that workspace first; otherwise picks a project and a workspace (or a new worktree). The tab
 * then becomes the session's tab. Leaving the picker keeps a plain shell.
 */
export async function herdrNew(ctx: Ctx, flags: NewFlags, io?: TerminalIO): Promise<void> {
  if (flags.here) return newHere(ctx);
  ctx.err("Connecting to Switchyard…");
  const { client, state } = await loadMirrorState(ctx, flags);
  const screen = new Screen(
    io ?? {
      input: process.stdin,
      output: process.stdout,
      color: !("NO_COLOR" in ctx.env),
    },
  );
  let created: Session | null = null;
  try {
    const choice = await chooseSession(state(), screen, {
      ...(flags.workspace ? { workspaceId: flags.workspace } : {}),
    });
    screen.leave();
    if (!choice) {
      ctx.err("Kept this tab as a shell.");
      return;
    }
    const { view } = resolveBoundView(state(), ctx.env.SWITCHYARD_VIEW);
    created = await client.api.post<Session>("/api/sessions", {
      ...choice,
      prompt: "",
      ...(view ? { viewId: view.id } : {}),
    });
    ctx.err(`Starting ${created.title}…`);
  } finally {
    screen.leave();
    client.close();
  }
  if (created) await herdrPane(ctx, created.id, flags);
}

/** The `new` action: a new tab in the focused space, running the picker. */
async function newHere(ctx: Ctx): Promise<void> {
  const call = (method: string, params: Record<string, unknown>) => herdrCall(method, params);
  const snap = (await call("session.snapshot", {}))?.snapshot ?? {};
  const ws: string | undefined = snap.focused_workspace_id;
  let key: string | null = null;
  try {
    const raw = JSON.parse(readFileSync(join(sessionStateDir(ctx.env), "spaces.json"), "utf8"));
    key = ws ? (raw.spaces?.[ws]?.key ?? null) : null;
  } catch {
    key = null;
  }
  const r = await call("tab.create", { ...(ws ? { workspace_id: ws } : {}), focus: true });
  const paneId = r?.root_pane?.pane_id;
  if (!paneId) throw new CliError("herdr did not open a tab");
  const args = key && !key.startsWith("cwd:") ? ["new", "--workspace", key] : ["new"];
  await runInPane(call, paneId, launcherCommand(stableLauncherPath(ctx.env), args));
}
