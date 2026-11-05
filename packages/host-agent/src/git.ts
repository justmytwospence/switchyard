import { execFile } from "node:child_process";
import { appendFile, lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  branchSlug,
  type CheckoutInfo,
  DEFAULT_WORKTREE_DIR,
  type DiffFile,
  type DiffResult,
  type DiscoveredWorktree,
  type GitState,
  SwitchyardError,
  WorktreeDir,
} from "@switchyard/protocol";
import { spawnShell, tailBytes } from "./checks.js";

const MAX_BUFFER = 64 * 1024 * 1024;
/** Git's well-known empty tree, the diff base for a repository without commits. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MAX_PATCH_BYTES = 2 * 1024 * 1024;
const MAX_UNTRACKED_CONTENT_BYTES = 1024 * 1024;
const SETUP_LOG_BYTES = 64 * 1024;
const SETUP_TIMEOUT_MS = 30 * 60 * 1000;

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Run git (never through a shell). Throws `internal` with git's stderr on failure unless `allowFail`. */
export function runGit(
  cwd: string,
  args: string[],
  opts: { allowFail?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<GitResult> {
  const env = { ...process.env, ...opts.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
  return new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      args,
      { cwd, env, maxBuffer: MAX_BUFFER, encoding: "utf8" },
      (err, stdout, stderr) => {
        let result: GitResult;
        if (!err) {
          result = { stdout, stderr, code: 0 };
        } else {
          const raw = (err as { code?: unknown }).code;
          result = {
            stdout: stdout ?? "",
            stderr: stderr || err.message,
            code: typeof raw === "number" ? raw : -1,
          };
        }
        if (result.code !== 0 && !opts.allowFail) {
          reject(
            new SwitchyardError(
              "internal",
              result.stderr.trim() || `git ${args[0] ?? ""} failed (${result.code})`,
            ),
          );
          return;
        }
        resolvePromise(result);
      },
    );
  });
}

/** Normalize a remote URL to a comparable identity: `https://host/path` with a lowercase host. */
export function normalizeRemote(url: string): string {
  let u = url.trim();
  const stripTail = () => {
    u = u.replace(/\/+$/, "");
    if (u.endsWith(".git")) u = u.slice(0, -4);
    u = u.replace(/\/+$/, "");
  };
  stripTail();
  const scheme =
    /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^/:]+)(?::(\d+))?(\/.*)?$/i.exec(u);
  if (scheme) {
    const proto = scheme[1]!.toLowerCase();
    const host = scheme[2]!.toLowerCase();
    const port = scheme[3];
    const path = scheme[4] ?? "";
    if (proto === "http" || proto === "https") {
      return `${proto}://${host}${port ? `:${port}` : ""}${path}`;
    }
    if (proto === "file") return u;
    // ssh://, git://, git+ssh://: the same repository over https.
    return `https://${host}${path}`;
  }
  // scp-like syntax: [user@]host:path
  const scp = /^(?:[^@/]+@)?([^/:]+):(?!\/\/)(.+)$/.exec(u);
  if (scp) {
    const path = scp[2]!.replace(/^\/+/, "");
    return `https://${scp[1]!.toLowerCase()}/${path}`;
  }
  return u;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function realpathOr(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/** `git rev-parse --git-common-dir` in `path`, absolute and realpath'd. */
async function commonDirOf(path: string): Promise<string> {
  const { stdout } = await runGit(path, ["rev-parse", "--git-common-dir"]);
  return realpathOr(resolve(path, stdout.trim()));
}

function notARepo(path: string): SwitchyardError {
  return new SwitchyardError("not_a_git_repo", `${path} is not a git repository`);
}

/** Describe the checkout containing `path`: root, common git dir, repository identity, default branch. */
export async function inspectCheckout(path: string): Promise<CheckoutInfo> {
  try {
    if (!(await stat(path)).isDirectory()) throw notARepo(path);
  } catch {
    throw notARepo(path);
  }
  const top = await runGit(path, ["rev-parse", "--show-toplevel"], { allowFail: true });
  if (top.code !== 0 || top.stdout.trim() === "") throw notARepo(path);
  const root = await realpathOr(top.stdout.trim());
  let commonDir: string;
  try {
    commonDir = await commonDirOf(path);
  } catch {
    throw notARepo(path);
  }

  let repoIdentity: string;
  const remote = await runGit(root, ["remote", "get-url", "origin"], { allowFail: true });
  if (remote.code === 0 && remote.stdout.trim() !== "") {
    repoIdentity = normalizeRemote(remote.stdout.trim());
  } else {
    const roots = await runGit(root, ["rev-list", "--max-parents=0", "HEAD"], { allowFail: true });
    const first = roots.code === 0 ? roots.stdout.split("\n")[0]!.trim() : "";
    repoIdentity = first ? `local:${first}` : `local:${root}`;
  }

  let defaultBranch = "main";
  const head = await runGit(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
    allowFail: true,
  });
  const ref = head.code === 0 ? head.stdout.trim() : "";
  if (ref) defaultBranch = ref.startsWith("origin/") ? ref.slice("origin/".length) : ref;

  return { root, commonDir, repoIdentity, defaultBranch };
}

export interface PorcelainWorktree {
  path: string;
  head: string | null;
  branch: string | null;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
}

/** Parse `git worktree list --porcelain -z`. */
export function parseWorktreePorcelain(out: string): PorcelainWorktree[] {
  const result: PorcelainWorktree[] = [];
  let cur: PorcelainWorktree | null = null;
  for (const field of out.split("\0")) {
    if (field === "") {
      if (cur) result.push(cur);
      cur = null;
      continue;
    }
    const space = field.indexOf(" ");
    const key = space === -1 ? field : field.slice(0, space);
    const value = space === -1 ? "" : field.slice(space + 1);
    if (key === "worktree") {
      if (cur) result.push(cur);
      cur = {
        path: value,
        head: null,
        branch: null,
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
      };
      continue;
    }
    if (!cur) continue;
    switch (key) {
      case "HEAD":
        cur.head = value || null;
        break;
      case "branch":
        cur.branch = value.startsWith("refs/heads/") ? value.slice("refs/heads/".length) : value;
        break;
      case "bare":
        cur.bare = true;
        break;
      case "detached":
        cur.detached = true;
        break;
      case "locked":
        cur.locked = true;
        break;
      case "prunable":
        cur.prunable = true;
        break;
    }
  }
  if (cur) result.push(cur);
  return result;
}

function isUnder(parent: string, child: string): boolean {
  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

async function listWorktrees(root: string): Promise<(PorcelainWorktree & { real: string })[]> {
  const { stdout } = await runGit(root, ["worktree", "list", "--porcelain", "-z"]);
  return Promise.all(
    parseWorktreePorcelain(stdout).map(async (w) => ({ ...w, real: await realpathOr(w.path) })),
  );
}

/** All worktrees of the checkout at `checkoutPath`, with provenance and (optionally) git status. */
export async function discoverWorktrees(
  checkoutPath: string,
  opts: { withStatus?: boolean; base?: string | null; worktreeDir?: string } = {},
): Promise<DiscoveredWorktree[]> {
  const worktreeDir = checkWorktreeDir(opts.worktreeDir ?? DEFAULT_WORKTREE_DIR);
  const info = await inspectCheckout(checkoutPath);
  const withStatus = opts.withStatus ?? true;
  const base = opts.base ?? info.defaultBranch;
  const managedDir = join(info.root, worktreeDir);
  const worktrees = await listWorktrees(info.root);
  return Promise.all(
    worktrees.map(async (w): Promise<DiscoveredWorktree> => {
      const provenance: DiscoveredWorktree["provenance"] =
        w.real === info.root ? "main" : isUnder(managedDir, w.real) ? "managed" : "discovered";
      let git: GitState | null = null;
      if (withStatus && !w.bare && !w.prunable) {
        git = await worktreeStatus(w.real, base).catch(() => null);
      }
      return {
        path: w.real,
        head: w.head,
        branch: w.branch,
        bare: w.bare,
        detached: w.detached,
        locked: w.locked,
        prunable: w.prunable,
        provenance,
        git,
      };
    }),
  );
}

/** Reject names git would not accept as a branch. */
export async function validateBranch(name: string): Promise<void> {
  const invalid = () => new SwitchyardError("branch_invalid", `Invalid branch name: ${name}`);
  if (name === "" || name.startsWith("-") || name.includes("\0")) throw invalid();
  const res = await runGit(tmpdir(), ["check-ref-format", "--branch", name], { allowFail: true });
  if (res.code !== 0 || res.stdout.trim() !== name) throw invalid();
}

/** Re-validate a project's worktree folder: a plain relative path inside the checkout. */
export function checkWorktreeDir(worktreeDir: string): string {
  const parsed = WorktreeDir.safeParse(worktreeDir);
  if (!parsed.success) {
    const reason = parsed.error.issues[0]?.message ?? "invalid";
    throw new SwitchyardError(
      "invalid_request",
      `Invalid worktree folder ${JSON.stringify(worktreeDir)}: ${reason}`,
    );
  }
  return parsed.data;
}

/** Where Switchyard creates the worktree for `branch`. */
export function managedWorktreePath(
  root: string,
  branch: string,
  worktreeDir: string = DEFAULT_WORKTREE_DIR,
): string {
  return join(root, checkWorktreeDir(worktreeDir), branchSlug(branch));
}

/** Make sure `<worktreeDir>/` is ignored through the repository's `info/exclude`. */
async function ensureExcluded(commonDir: string, worktreeDir: string): Promise<void> {
  const infoDir = join(commonDir, "info");
  const excludePath = join(infoDir, "exclude");
  await mkdir(infoDir, { recursive: true });
  let current = "";
  try {
    current = await readFile(excludePath, "utf8");
  } catch {
    current = "";
  }
  const lines = current.split(/\r?\n/).map((l) => l.trim());
  const line = `/${worktreeDir}/`;
  if (lines.includes(line) || (!worktreeDir.includes("/") && lines.includes(`${worktreeDir}/`))) {
    return;
  }
  const prefix = current !== "" && !current.endsWith("\n") ? "\n" : "";
  await appendFile(excludePath, `${prefix}${line}\n`);
}

/** Create a managed worktree for `branch` (from `base` when the branch does not exist yet). */
export async function createWorktree(
  checkoutPath: string,
  branch: string,
  base: string,
  worktreeDir: string = DEFAULT_WORKTREE_DIR,
): Promise<{ path: string; branch: string; baseBranch: string; root: string }> {
  const dir = checkWorktreeDir(worktreeDir);
  const info = await inspectCheckout(checkoutPath);
  await validateBranch(branch);
  if (base === "" || base.startsWith("-")) {
    throw new SwitchyardError("invalid_request", `Invalid base: ${base}`);
  }
  const path = managedWorktreePath(info.root, branch, dir);
  if (await exists(path)) throw new SwitchyardError("path_collision", `${path} already exists`);

  const slug = branchSlug(branch);
  for (const w of await listWorktrees(info.root)) {
    if (w.real === path || w.path === path) {
      throw new SwitchyardError("path_collision", `${path} already exists`);
    }
    if (w.branch === branch) {
      throw new SwitchyardError(
        "path_collision",
        `Branch ${branch} is already checked out at ${w.real}`,
      );
    }
    if (w.branch !== null && branchSlug(w.branch) === slug) {
      throw new SwitchyardError(
        "path_collision",
        `Branch ${w.branch} at ${w.real} already maps to ${path}`,
      );
    }
  }

  await ensureExcluded(info.commonDir, dir);

  const known = await runGit(
    info.root,
    ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
    {
      allowFail: true,
    },
  );
  if (known.code === 0) {
    await runGit(info.root, ["worktree", "add", "--", path, branch]);
  } else {
    await runGit(info.root, ["worktree", "add", "-b", branch, "--", path, base]);
  }

  let created: string;
  let commonDir: string | null = null;
  try {
    created = await realpath(path);
    commonDir = await commonDirOf(created);
  } catch {
    created = path;
  }
  if (commonDir !== info.commonDir) {
    await runGit(info.root, ["worktree", "remove", "--force", path], { allowFail: true });
    throw new SwitchyardError(
      "repo_mismatch",
      `Worktree at ${path} does not belong to the repository at ${info.root}`,
    );
  }
  return { path: created, branch, baseBranch: base, root: info.root };
}

async function refResolves(cwd: string, ref: string): Promise<boolean> {
  if (ref === "" || ref.startsWith("-")) return false;
  const res = await runGit(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    allowFail: true,
  });
  return res.code === 0;
}

/** Dirty state, change count, upstream ahead/behind and whether HEAD has commits not in `base`. */
export async function worktreeStatus(path: string, base: string | null): Promise<GitState> {
  const { stdout } = await runGit(path, ["status", "--porcelain=v2", "--branch", "-z"], {
    env: { GIT_OPTIONAL_LOCKS: "0" },
  });
  let changedFiles = 0;
  let ahead = 0;
  let behind = 0;
  const fields = stdout.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!;
    if (f === "") continue;
    if (f.startsWith("# ")) {
      const ab = /^# branch\.ab \+(\d+) -(\d+)/.exec(f);
      if (ab) {
        ahead = Number(ab[1]);
        behind = Number(ab[2]);
      }
      continue;
    }
    changedFiles++;
    if (f.startsWith("2 ")) i++; // rename/copy entries carry the original path as an extra field
  }

  const baseRef = base ?? (await inspectCheckout(path)).defaultBranch;
  let unmerged = false;
  if (await refResolves(path, baseRef)) {
    const cherry = await runGit(path, ["cherry", baseRef, "HEAD"], { allowFail: true });
    unmerged = cherry.code === 0 && cherry.stdout.split("\n").some((l) => l.startsWith("+"));
  }
  return { dirty: changedFiles > 0, changedFiles, ahead, behind, unmerged };
}

function parseNumstat(
  out: string,
): Map<string, { oldPath: string | null; added: number | null; deleted: number | null }> {
  const result = new Map<
    string,
    { oldPath: string | null; added: number | null; deleted: number | null }
  >();
  const fields = out.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!;
    if (f === "") continue;
    const t1 = f.indexOf("\t");
    const t2 = t1 === -1 ? -1 : f.indexOf("\t", t1 + 1);
    if (t2 === -1) continue;
    const a = f.slice(0, t1);
    const d = f.slice(t1 + 1, t2);
    let path = f.slice(t2 + 1);
    let oldPath: string | null = null;
    if (path === "") {
      oldPath = fields[++i] ?? "";
      path = fields[++i] ?? "";
    }
    result.set(path, {
      oldPath,
      added: a === "-" ? null : Number(a),
      deleted: d === "-" ? null : Number(d),
    });
  }
  return result;
}

function parseNameStatus(
  out: string,
): Map<string, { status: DiffFile["status"]; oldPath: string | null }> {
  const result = new Map<string, { status: DiffFile["status"]; oldPath: string | null }>();
  const fields = out.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const code = fields[i]!;
    if (code === "") continue;
    const letter = code[0];
    if (letter === "R" || letter === "C") {
      const oldPath = fields[++i] ?? "";
      const path = fields[++i] ?? "";
      result.set(path, {
        status: letter === "R" ? "renamed" : "added",
        oldPath: letter === "R" ? oldPath : null,
      });
      continue;
    }
    const path = fields[++i] ?? "";
    const status: DiffFile["status"] =
      letter === "A" ? "added" : letter === "D" ? "deleted" : "modified";
    result.set(path, { status, oldPath: null });
  }
  return result;
}

function countLines(text: string): number {
  if (text === "") return 0;
  let n = 0;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) n++;
  return text.endsWith("\n") ? n : n + 1;
}

interface UntrackedFile {
  path: string;
  lines: number;
  patch: string;
}

/** Line count and a synthesized "new file" patch for an untracked file. */
async function describeUntracked(top: string, rel: string): Promise<UntrackedFile> {
  const header = (mode: string) => `diff --git a/${rel} b/${rel}\nnew file mode ${mode}\n`;
  let st: Awaited<ReturnType<typeof lstat>>;
  try {
    st = await lstat(join(top, rel));
  } catch {
    return { path: rel, lines: 0, patch: header("100644") };
  }
  if (st.isSymbolicLink()) return { path: rel, lines: 0, patch: header("120000") };
  const mode = (Number(st.mode) & 0o111) !== 0 ? "100755" : "100644";
  if (!st.isFile() || Number(st.size) > MAX_UNTRACKED_CONTENT_BYTES) {
    return { path: rel, lines: 0, patch: header(mode) };
  }
  let buf: Buffer;
  try {
    buf = await readFile(join(top, rel));
  } catch {
    return { path: rel, lines: 0, patch: header(mode) };
  }
  if (buf.subarray(0, 8000).includes(0)) {
    return {
      path: rel,
      lines: 0,
      patch: `${header(mode)}Binary files /dev/null and b/${rel} differ\n`,
    };
  }
  const text = buf.toString("utf8");
  const lines = countLines(text);
  if (lines === 0) return { path: rel, lines: 0, patch: header(mode) };
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  let patch = `${header(mode)}--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1${lines === 1 ? "" : `,${lines}`} @@\n`;
  patch += `${body
    .split("\n")
    .map((l) => `+${l}`)
    .join("\n")}\n`;
  if (!text.endsWith("\n")) patch += "\\ No newline at end of file\n";
  return { path: rel, lines, patch };
}

/**
 * Changes of the worktree at `path` against its merge base with `base`: committed and uncommitted
 * changes plus untracked files. `file` limits the patch (not the file list) to one path.
 */
export async function diffWorkspace(
  path: string,
  base: string | null,
  file: string | null,
): Promise<DiffResult> {
  const top = await realpathOr(
    (await runGit(path, ["rev-parse", "--show-toplevel"])).stdout.trim(),
  );
  const baseRef = base ?? (await inspectCheckout(top)).defaultBranch;

  let mergeBase: string;
  const mb = (await refResolves(top, baseRef))
    ? await runGit(top, ["merge-base", baseRef, "HEAD"], { allowFail: true })
    : null;
  if (mb && mb.code === 0 && mb.stdout.trim() !== "") mergeBase = mb.stdout.trim();
  else mergeBase = (await refResolves(top, "HEAD")) ? "HEAD" : EMPTY_TREE;

  const [numstatOut, nameStatusOut, untrackedOut] = await Promise.all([
    runGit(top, ["diff", "--no-color", "-M", "--numstat", "-z", mergeBase, "--"]),
    runGit(top, ["diff", "--no-color", "-M", "--name-status", "-z", mergeBase, "--"]),
    runGit(top, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const numstat = parseNumstat(numstatOut.stdout);
  const nameStatus = parseNameStatus(nameStatusOut.stdout);

  const files: DiffFile[] = [];
  for (const [p, n] of numstat) {
    const ns = nameStatus.get(p);
    const binary = n.added === null || n.deleted === null;
    files.push({
      path: p,
      oldPath: n.oldPath ?? ns?.oldPath ?? null,
      added: binary ? 0 : n.added!,
      deleted: binary ? 0 : n.deleted!,
      status: binary ? "binary" : (ns?.status ?? "modified"),
    });
  }
  const untrackedPaths = untrackedOut.stdout.split("\0").filter((p) => p !== "");
  const wanted = file === null ? untrackedPaths : untrackedPaths.filter((p) => p === file);
  const untracked = new Map<string, UntrackedFile>();
  await Promise.all(
    untrackedPaths.map(async (p) => {
      untracked.set(p, await describeUntracked(top, p));
    }),
  );
  for (const p of untrackedPaths) {
    files.push({
      path: p,
      oldPath: null,
      added: untracked.get(p)!.lines,
      deleted: 0,
      status: "untracked",
    });
  }

  const diffArgs = ["--literal-pathspecs", "diff", "--no-color", "-M", mergeBase, "--"];
  if (file !== null) diffArgs.push(file);
  let patch = (await runGit(top, diffArgs)).stdout;
  for (const p of wanted) patch += untracked.get(p)!.patch;
  const limitPatch = file === null && Buffer.byteLength(patch, "utf8") > MAX_PATCH_BYTES;
  return { base: baseRef, files, patch: limitPatch ? null : patch };
}

/**
 * Remove a worktree of the checkout (never the main checkout, never the branch). Refuses when
 * sessions are active, or when dirty or unmerged unless forced.
 */
export async function removeWorktree(opts: {
  path: string;
  checkoutPath: string;
  base: string | null;
  force: { dirty: boolean; unmerged: boolean };
  hasActiveSession?: (path: string) => boolean;
}): Promise<void> {
  let real: string;
  try {
    real = await realpath(opts.path);
  } catch {
    throw new SwitchyardError("not_found", `Workspace not found: ${opts.path}`);
  }
  const info = await inspectCheckout(opts.checkoutPath);
  const worktrees = await listWorktrees(info.root);
  // The first entry of `git worktree list` is always the main worktree.
  if (real === info.root || real === worktrees[0]?.real) {
    throw new SwitchyardError("forbidden", "Cannot remove the main checkout");
  }
  if (!worktrees.some((w) => w.real === real)) {
    throw new SwitchyardError("not_found", `${opts.path} is not a worktree of ${info.root}`);
  }
  if (opts.hasActiveSession?.(real)) {
    throw new SwitchyardError(
      "workspace_active_sessions",
      "Stop the sessions in this workspace before removing it",
    );
  }
  const base = opts.base ?? info.defaultBranch;
  const status = await worktreeStatus(real, base);
  if (status.dirty && !opts.force.dirty) {
    throw new SwitchyardError("workspace_dirty", "Workspace has uncommitted changes");
  }
  if (status.unmerged && !opts.force.unmerged) {
    throw new SwitchyardError(
      "workspace_unmerged",
      `Workspace has commits not merged into ${base}`,
    );
  }
  const args = ["worktree", "remove"];
  if (status.dirty) args.push("--force");
  args.push(real);
  await runGit(info.root, args);
}

/** Run the owner-configured setup command in a new workspace; resolves with its outcome and the last 64 KB of output. */
export async function runSetup(
  path: string,
  cmd: string,
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<{ state: "succeeded" | "failed"; log: string }> {
  const timeoutMs = opts.timeoutMs ?? SETUP_TIMEOUT_MS;
  let log = "";
  const outcome = await spawnShell(path, cmd, {
    timeoutMs,
    env: opts.env,
    onChunk: (chunk) => {
      log = tailBytes(log + chunk, SETUP_LOG_BYTES);
    },
  });

  let state: "succeeded" | "failed";
  if (outcome.error) {
    state = "failed";
    const nl = log && !log.endsWith("\n") ? "\n" : "";
    log = tailBytes(`${log}${nl}${outcome.error.message}`, SETUP_LOG_BYTES);
  } else if (outcome.code === 0 && !outcome.timedOut) {
    state = "succeeded";
  } else {
    state = "failed";
    const nl = log && !log.endsWith("\n") ? "\n" : "";
    const reason = outcome.timedOut
      ? `timed out after ${timeoutMs} ms\nexit code ${outcome.signal ?? "null"}`
      : `exit code ${outcome.code ?? outcome.signal}`;
    log = tailBytes(`${log}${nl}${reason}`, SETUP_LOG_BYTES);
  }
  return { state, log };
}
