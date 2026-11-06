import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CliError } from "../config.js";
import type { Env } from "../paths.js";
import { type HerdrCall, herdrSessionName } from "./client.js";

/** `${XDG_STATE_HOME:-~/.local/state}/switchyard-herdr` */
export function herdrStateDir(env: Env = process.env, home = homedir()): string {
  const xdg = env.XDG_STATE_HOME?.trim();
  return join(xdg || join(home, ".local", "state"), "switchyard-herdr");
}

/** State of the mirror for this herdr session: `<state>/<herdr session>`. */
export function sessionStateDir(env: Env = process.env): string {
  const dir = join(herdrStateDir(env), herdrSessionName(env));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** The stable launcher path used in typed commands and resume commands. */
export function stableLauncherPath(env: Env = process.env): string {
  return env.SWITCHYARD_HERDR_LAUNCHER || join(herdrStateDir(env), "switchyard-herdr");
}

/**
 * Write `<stateRoot>/switchyard-herdr`, which runs the current plugin's launcher. herdr's resume
 * commands must start with a plain command name, and plugin directories change on update, so
 * panes always go through this file.
 */
export function writeStableLauncher(stateRoot: string, pluginRoot: string): string {
  if (pluginRoot.includes("'") || stateRoot.includes("'")) {
    throw new CliError("Plugin path contains an apostrophe");
  }
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const path = join(stateRoot, "switchyard-herdr");
  const nodeDir = dirname(process.execPath);
  if (nodeDir.includes("'")) throw new CliError("Node path contains an apostrophe");
  writeFileSync(
    path,
    `#!/bin/sh\n# Panes run under the user's shell rc, which may put another node first.\nPATH='${nodeDir}':"$PATH"\nexport PATH\nexec sh '${pluginRoot}/switchyard-herdr.sh' "$@"\n`,
    {
      mode: 0o755,
    },
  );
  chmodSync(path, 0o755);
  return path;
}

export function launcherExists(env: Env = process.env): boolean {
  return existsSync(stableLauncherPath(env));
}

/** Whether a pane sits at its shell prompt (nothing else in the foreground). */
export async function isAtShell(call: HerdrCall, paneId: string): Promise<boolean> {
  const info = (await call("pane.process_info", { pane_id: paneId }))?.process_info ?? {};
  const procs: { pid?: number }[] = info.foreground_processes ?? [];
  return procs.length === 0 || procs.every((p) => p.pid === info.shell_pid);
}

/** How long `runInPane` waits for a new shell's prompt. */
export const SHELL_READY_MS = 5_000;

/** Type a command into a pane's shell and press Enter. */
export async function runInPane(call: HerdrCall, paneId: string, command: string): Promise<void> {
  // Text typed before a new tab's shell has started is echoed and read again by whatever runs
  // next (the picker's query, or Pi's editor). Wait for the prompt, then type.
  try {
    await call("pane.wait_for_output", {
      pane_id: paneId,
      source: "visible",
      match: { type: "regex", value: "\\S" },
      timeout_ms: SHELL_READY_MS,
    });
  } catch {
    // An older herdr, or a shell that prints nothing: type anyway.
  }
  await call("pane.send_text", { pane_id: paneId, text: command });
  await call("pane.send_keys", { pane_id: paneId, keys: ["enter"] });
}

/** `sh '<launcher>' <args...>`, every argument single-quoted. */
export function launcherCommand(launcher: string, args: string[]): string {
  const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
  return ["sh", q(launcher), ...args.map(q)].join(" ");
}

/** Read one key in raw mode. */
export function readKey(): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.once("data", (d: Buffer) => {
      stdin.setRawMode?.(false);
      stdin.pause();
      resolve(d.toString("utf8"));
    });
  });
}
