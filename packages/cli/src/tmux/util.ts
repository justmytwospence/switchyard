import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CliError } from "../config.js";
import type { Env } from "../paths.js";

/** `${XDG_STATE_HOME:-~/.local/state}/switchyard-tmux` */
export function tmuxStateDir(env: Env = process.env, home = homedir()): string {
  const xdg = env.XDG_STATE_HOME?.trim();
  return join(xdg || join(home, ".local", "state"), "switchyard-tmux");
}

/** State of the mirror for one tmux session: `<state>/<session>`. */
export function tmuxSessionStateDir(session: string, env: Env = process.env): string {
  const dir = join(tmuxStateDir(env), session);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function stableTmuxLauncherPath(env: Env = process.env): string {
  return env.SWITCHYARD_TMUX_LAUNCHER || join(tmuxStateDir(env), "switchyard-tmux");
}

/** Write `<stateRoot>/switchyard-tmux`, which runs the plugin's launcher. */
export function writeStableTmuxLauncher(stateRoot: string, pluginRoot: string): string {
  if (pluginRoot.includes("'") || stateRoot.includes("'")) {
    throw new CliError("Plugin path contains an apostrophe");
  }
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const path = join(stateRoot, "switchyard-tmux");
  writeFileSync(path, `#!/bin/sh\nexec sh '${pluginRoot}/switchyard-tmux.sh' "$@"\n`, {
    mode: 0o755,
  });
  chmodSync(path, 0o755);
  return path;
}

export function tmuxLauncherExists(env: Env = process.env): boolean {
  return existsSync(stableTmuxLauncherPath(env));
}
