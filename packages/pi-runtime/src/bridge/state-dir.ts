import { homedir } from "node:os";
import { join } from "node:path";

type Env = Record<string, string | undefined>;

/**
 * The host agent's state directory: `SWITCHYARD_STATE_DIR`, else
 * `~/Library/Application Support/switchyard` on macOS and
 * `${XDG_STATE_HOME:-~/.local/state}/switchyard` elsewhere.
 */
export function defaultStateDir(
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
): string {
  const fromEnv = env.SWITCHYARD_STATE_DIR?.trim();
  if (fromEnv) return fromEnv;
  if (platform === "darwin") return join(home, "Library", "Application Support", "switchyard");
  const xdg = env.XDG_STATE_HOME?.trim();
  return join(xdg || join(home, ".local", "state"), "switchyard");
}
