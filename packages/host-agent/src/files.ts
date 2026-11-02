import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { type FileEntry, SwitchyardError } from "@switchyard/protocol";

export const MAX_READ_BYTES = 1024 * 1024;

/** Bytes inspected for a NUL byte when deciding whether a file is binary. */
const BINARY_SNIFF_BYTES = 8000;

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
}

function errnoCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

/** Relative path of `abs` under `root`, with `/` separators ("" for the root itself). */
function toRel(root: string, abs: string): string {
  const rel = relative(root, abs);
  return rel === "" ? "" : rel.split(sep).join("/");
}

async function realRoot(root: string): Promise<string> {
  try {
    return await realpath(root);
  } catch {
    throw new SwitchyardError("not_found", `Workspace not found: ${root}`);
  }
}

/**
 * Resolve `rel` inside the workspace `root`, following symlinks, and refuse anything that lands
 * outside it. An absolute `rel` is taken relative to the root ("/" and "" are the root).
 */
export async function resolveInside(root: string, rel: string): Promise<string> {
  if (rel.includes("\0")) throw new SwitchyardError("invalid_request", "Invalid path");
  const rootReal = await realRoot(root);
  const target = resolve(rootReal, rel.replace(/^[/\\]+/, ""));
  if (!isInside(rootReal, target)) {
    throw new SwitchyardError("forbidden", "Path is outside the workspace");
  }
  let real: string;
  try {
    real = await realpath(target);
  } catch (err) {
    if (errnoCode(err) === "EACCES") {
      throw new SwitchyardError("forbidden", `Permission denied: ${rel}`);
    }
    throw new SwitchyardError("not_found", `Path not found: ${rel}`);
  }
  if (!isInside(rootReal, real)) {
    throw new SwitchyardError("forbidden", "Path is outside the workspace");
  }
  return real;
}

/** List a directory of the workspace: directories first, then by name; `.git` is hidden. */
export async function listDir(
  root: string,
  dir: string,
): Promise<{ dir: string; entries: FileEntry[] }> {
  const rootReal = await realRoot(root);
  const abs = await resolveInside(rootReal, dir);
  const st = await stat(abs);
  if (!st.isDirectory()) throw new SwitchyardError("invalid_request", `Not a directory: ${dir}`);
  const relDir = toRel(rootReal, abs);
  const names = await readdir(abs);
  const entries: FileEntry[] = [];
  for (const name of names) {
    if (name === ".git") continue;
    let ls: Awaited<ReturnType<typeof lstat>>;
    try {
      ls = await lstat(join(abs, name));
    } catch {
      continue; // removed while listing
    }
    const kind: FileEntry["kind"] = ls.isSymbolicLink()
      ? "symlink"
      : ls.isDirectory()
        ? "dir"
        : "file";
    entries.push({
      name,
      path: relDir === "" ? name : `${relDir}/${name}`,
      kind,
      size: kind === "file" ? Number(ls.size) : null,
    });
  }
  entries.sort((a, b) => {
    const ad = a.kind === "dir" ? 0 : 1;
    const bd = b.kind === "dir" ? 0 : 1;
    if (ad !== bd) return ad - bd;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return { dir: relDir, entries };
}

/** Read a regular file of the workspace (at most 1 MB); binary content comes back base64-encoded. */
export async function readWorkspaceFile(
  root: string,
  file: string,
): Promise<{
  path: string;
  size: number;
  encoding: "utf8" | "base64";
  content: string;
  binary: boolean;
}> {
  const rootReal = await realRoot(root);
  const abs = await resolveInside(rootReal, file);
  const st = await stat(abs);
  if (!st.isFile()) throw new SwitchyardError("invalid_request", `Not a regular file: ${file}`);
  const tooLarge = (size: number) =>
    new SwitchyardError("too_large", "File is larger than 1 MB", { size });
  if (st.size > MAX_READ_BYTES) throw tooLarge(st.size);
  const buf = await readFile(abs);
  if (buf.length > MAX_READ_BYTES) throw tooLarge(buf.length);
  const binary = buf.subarray(0, BINARY_SNIFF_BYTES).includes(0);
  return {
    path: toRel(rootReal, abs),
    size: buf.length,
    encoding: binary ? "base64" : "utf8",
    content: buf.toString(binary ? "base64" : "utf8"),
    binary,
  };
}
