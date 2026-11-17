import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, type Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";

/*
 * Private Unix socket paths for the host agent's runtime directory. In bridge/ so the Pi
 * extension (which may only import its siblings) can use them too.
 */

export const MAX_SOCKET_PATH = 100;

/** Short fallback for long runtime dirs: one private subdirectory per runtime dir, so agents never share it. */
export function fallbackSocketDir(runtimeDir: string): string {
  const hash = createHash("sha256").update(resolve(runtimeDir)).digest("hex").slice(0, 8);
  return join("/tmp", `switchyard-${process.getuid?.() ?? "u"}`, hash);
}

/** Directories a runtime dir's sockets can live in (for sweeps). */
export function socketDirs(runtimeDir: string): string[] {
  return [runtimeDir, fallbackSocketDir(runtimeDir)];
}

/** Pure check: "ok", "chmod" (ours but looser than 0700), or throws. */
export function checkPrivateDir(
  dir: string,
  st: Pick<Stats, "uid" | "mode" | "isDirectory" | "isSymbolicLink">,
  uid: number | undefined,
): "ok" | "chmod" {
  if (st.isSymbolicLink())
    throw new Error(
      `Socket directory ${dir} is a symlink; remove it so Switchyard can create a private directory`,
    );
  if (!st.isDirectory())
    throw new Error(
      `Socket directory ${dir} is not a directory; remove it so Switchyard can create a private directory`,
    );
  if (uid !== undefined && st.uid !== uid)
    throw new Error(
      `Socket directory ${dir} belongs to uid ${st.uid}, not ${uid}; remove it or use a shorter SWITCHYARD_STATE_DIR`,
    );
  return (st.mode & 0o077) !== 0 ? "chmod" : "ok";
}

/** Create `dir` (0700) if missing, then require: not a symlink, a directory, ours, mode 0700 (tightened if looser). */
export function ensurePrivateDir(dir: string): void {
  let st: Stats | null = null;
  try {
    st = lstatSync(dir);
  } catch {
    /* missing */
  }
  if (!st) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    st = lstatSync(dir);
  }
  if (checkPrivateDir(dir, st, process.getuid?.()) === "chmod") chmodSync(dir, 0o700);
}

/** A fresh Unix socket path in `runtimeDir`, or in a short private `/tmp` directory when that is too long. */
export function shortSocketPath(runtimeDir: string, prefix: string): string {
  const name = `${prefix}-${randomUUID().slice(0, 8)}.sock`;
  if (join(runtimeDir, name).length <= MAX_SOCKET_PATH) {
    ensurePrivateDir(runtimeDir);
    return join(runtimeDir, name);
  }
  // Unix socket paths are limited (104 bytes on macOS); fall back to a short directory.
  const dir = fallbackSocketDir(runtimeDir);
  ensurePrivateDir(dirname(dir)); // /tmp/switchyard-<uid>
  ensurePrivateDir(dir);
  return join(dir, name);
}
