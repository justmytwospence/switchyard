import type { BigIntStats } from "node:fs";
import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  type CheckoutInfo,
  type CheckoutLocateResult,
  type CheckoutPreviewResult,
  type ErrorBody,
  type HostCommandOf,
  SwitchyardError,
} from "@switchyard/protocol";
import { normalizeRemote, parseWorktreePorcelain, runCheckoutGit } from "./git.js";
import { expandHome } from "./project-folders.js";

// Set by clone itself in the new repo, before checkout. A restart during clone must not
// turn an incomplete checkout into a reuse candidate. No credentials go into this config.
const PROVISIONING_KEY = "switchyard.provisioning";
const CLONE_TIMEOUT_MS = 120_000;
const GITHUB_IDENTITY =
  /^https:\/\/github\.com\/(?!\.{1,2}\/)[A-Za-z0-9_.-]+\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/;
const CONTROL = /\p{Cc}/u;
const PARTIAL = { partialCheckout: true };
const CHECK_STATUS = "Check checkout status before trying again.";

// Only these fixed messages/details may escape a checkout command. Never forward Node/Git
// diagnostics (which can contain credentials or the full subprocess configuration).
class CheckoutCommandError extends SwitchyardError {}

export function checkoutCommandError(err: unknown): ErrorBody {
  return err instanceof CheckoutCommandError
    ? err.toBody()
    : { code: "internal", message: `Checkout operation failed. ${CHECK_STATUS}` };
}

export function checkoutCommandType(raw: unknown): string | null {
  const { type } = (raw ?? {}) as { type?: unknown };
  return type === "checkout.preview" || type === "checkout.provision" || type === "checkout.locate"
    ? type
    : null;
}

function pathChanged() {
  return new CheckoutCommandError("conflict", "Checkout destination changed. Preview it again.");
}

function unsafePath(raw: string): boolean {
  // Check before expansion/normalization can erase traversal. ':' is a separator in Git's
  // ceiling-directory list, which keeps clone from discovering config in a parent repository.
  return CONTROL.test(raw) || /[\\:]/.test(raw) || raw.split("/").includes("..");
}

function validFolder(name: string): boolean {
  return (
    name.length > 0 &&
    name.trim() === name &&
    !name.endsWith(".") &&
    name.toLowerCase() !== ".git" &&
    !/[/\\<>:"|?*]/.test(name) &&
    !CONTROL.test(name) &&
    Buffer.byteLength(name) <= 255
  );
}

function containsPath(root: string, path: string): boolean {
  const child = relative(root, path);
  return !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`);
}

async function resolveDestination(rawRoot: string, name: string) {
  const expanded = expandHome(rawRoot);
  if (!validFolder(name) || unsafePath(rawRoot) || !isAbsolute(expanded)) {
    throw new CheckoutCommandError(
      "invalid_request",
      "Choose a checkout root and a safe folder name.",
    );
  }
  const root = await realpath(expanded).catch(() => null);
  const entry = root ? await lstat(root, { bigint: true }).catch(() => null) : null;
  if (!root || !entry?.isDirectory() || unsafePath(root)) {
    throw new CheckoutCommandError("not_found", "Checkout root is not an accessible directory.");
  }
  const path = join(root, name);
  if (path === root || !containsPath(root, path)) throw pathChanged();
  return { path, root, entry };
}

async function entryAt(path: string): Promise<BigIntStats | null> {
  try {
    return await lstat(path, { bigint: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function stillDirectory(path: string, entry: BigIntStats): Promise<boolean> {
  const current = await entryAt(path);
  return Boolean(
    current?.isDirectory() &&
      current.dev === entry.dev &&
      current.ino === entry.ino &&
      (await realpath(path).catch(() => null)) === path,
  );
}

async function gitPaths(cwd: string) {
  const out = await runCheckoutGit(cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
    "--git-dir",
    "--git-common-dir",
  ]);
  const paths = out.stdout.replace(/\n$/, "").split("\n");
  if (
    out.code !== 0 ||
    paths.length !== 3 ||
    !paths.every((p) => isAbsolute(p) && !CONTROL.test(p))
  )
    return null;
  const [top, gitDir, commonDir] = await Promise.all(paths.map((p) => realpath(p)));
  return { top: top!, gitDir: gitDir!, commonDir: commonDir! };
}

async function exactLocalConfig(root: string, key: string) {
  return runCheckoutGit(root, ["config", "--local", "--no-includes", "--null", "--get-all", key]);
}

async function branchOf(root: string, clone: boolean): Promise<string | null> {
  const symref = async (ref: string, prefix: string) => {
    const branch = await runCheckoutGit(root, ["symbolic-ref", "--quiet", "--no-recurse", ref]);
    const value = branch.stdout.replace(/\n$/, "");
    if (
      branch.code !== 0 ||
      !value.startsWith(prefix) ||
      !value.slice(prefix.length) ||
      CONTROL.test(value)
    )
      return null;
    const commit = await runCheckoutGit(root, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${value}^{commit}`,
    ]);
    return commit.code === 0 ? value.slice(prefix.length) : null;
  };
  const remoteHead = await symref("refs/remotes/origin/HEAD", "refs/remotes/origin/");
  // Manually attached checkouts can lack origin/HEAD. An actual local branch is evidence;
  // guessing 'main' is not. A managed clone must have the advertised remote HEAD.
  return remoteHead ?? (clone ? null : await symref("HEAD", "refs/heads/"));
}

/** Find the actual main checkout via the common Git directory and porcelain worktree list. */
async function inspectAt(cwd: string, cloneUrl?: string): Promise<CheckoutLocateResult> {
  const found = await gitPaths(cwd);
  if (!found || !containsPath(found.top, cwd)) return null;
  const list = await runCheckoutGit(cwd, ["worktree", "list", "--porcelain", "-z"]);
  if (list.code !== 0) return null;
  const worktrees = parseWorktreePorcelain(list.stdout);
  const main = worktrees[0];
  if (!main || main.bare || main.prunable || !isAbsolute(main.path)) return null;
  const root = await realpath(main.path);
  if (!worktrees.some((w) => !w.bare && !w.prunable && w.path === found.top)) {
    // Git normally supplies absolute real paths; allow the main checkout's configured alias.
    if (root !== found.top || found.gitDir !== found.commonDir) return null;
  }
  const mainGit = root === found.top ? found : await gitPaths(root);
  if (
    mainGit?.top !== root ||
    mainGit.gitDir !== found.commonDir ||
    mainGit.commonDir !== found.commonDir
  )
    return null;
  if (cloneUrl && root !== cwd) return null;

  // No remote URL rewriting and no local includes. Only a single credential-free identity
  // for the supported v1 authority can be returned to the coordinator.
  const [origin, marker] = await Promise.all([
    exactLocalConfig(root, "remote.origin.url"),
    exactLocalConfig(root, PROVISIONING_KEY),
  ]);
  if (marker.code !== (cloneUrl ? 0 : 1) || (cloneUrl && marker.stdout !== "true\0")) return null;
  const urls = origin.stdout.split("\0");
  if (origin.code !== 0 || urls.length !== 2 || urls[1] !== "" || !urls[0]) return null;
  if (cloneUrl && urls[0] !== cloneUrl) return null;
  const repoIdentity = normalizeRemote(urls[0]);
  if (!GITHUB_IDENTITY.test(repoIdentity)) return null;
  const defaultBranch = await branchOf(root, cloneUrl !== undefined);
  if (!defaultBranch) {
    if (cloneUrl)
      throw new CheckoutCommandError("conflict", "No default branch to start work on", PARTIAL);
    return null;
  }
  if (cloneUrl) {
    const [branch, head, remoteHead] = await Promise.all([
      runCheckoutGit(root, ["symbolic-ref", "--quiet", "--no-recurse", "HEAD"]),
      runCheckoutGit(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]),
      runCheckoutGit(root, [
        "rev-parse",
        "--verify",
        "--quiet",
        "refs/remotes/origin/HEAD^{commit}",
      ]),
    ]);
    if (
      branch.code !== 0 ||
      branch.stdout !== `refs/heads/${defaultBranch}\n` ||
      head.code !== 0 ||
      remoteHead.code !== 0 ||
      head.stdout !== remoteHead.stdout
    )
      return null;
  }
  return {
    checkout: { root, commonDir: found.commonDir, repoIdentity, defaultBranch },
    worktreePath: found.top,
  };
}

export async function locateCheckout(cwd: string): Promise<CheckoutLocateResult> {
  if (!isAbsolute(cwd) || CONTROL.test(cwd)) return null;
  // Untrusted session cwd is only a starting point. Verify its actual worktree and its main
  // checkout; unavailable or ambiguous local Git data leaves the session projectless.
  try {
    const path = await realpath(cwd);
    return (await stat(path)).isDirectory() ? await inspectAt(path) : null;
  } catch {
    return null;
  }
}

export async function previewCheckout(
  rootPath: string,
  folderName: string,
): Promise<CheckoutPreviewResult> {
  const { path, root } = await resolveDestination(rootPath, folderName);
  const entry = await entryAt(path);
  if (!entry) return { path, root, state: "missing" };
  if (entry.isDirectory() && (await stillDirectory(path, entry))) {
    const info = await locateCheckout(path);
    if (
      info?.checkout.root === path &&
      info.worktreePath === path &&
      (await stillDirectory(path, entry))
    ) {
      return { path, root, state: "existing", checkout: info.checkout };
    }
  }
  return { path, root, state: "collision" };
}

export async function provisionCheckout(
  command: HostCommandOf<"checkout.provision">,
): Promise<CheckoutInfo> {
  const { cloneUrl, grant } = command;
  if (
    CONTROL.test(cloneUrl) ||
    !cloneUrl.endsWith(".git") ||
    !GITHUB_IDENTITY.test(cloneUrl.slice(0, -4))
  ) {
    throw new CheckoutCommandError(
      "invalid_request",
      "Expected a canonical GitHub HTTPS clone URL.",
    );
  }
  const expires = Date.parse(grant.expiresAt);
  const checkExpiry = () => {
    if (!(expires > Date.now())) {
      throw new CheckoutCommandError(
        "conflict",
        "Clone access expired. Preview the checkout again.",
      );
    }
  };
  checkExpiry();
  const { path, root, entry } = await resolveDestination(command.root, command.folderName);
  if (path !== command.expectedPath || !(await stillDirectory(root, entry))) throw pathChanged();
  checkExpiry();
  try {
    // Never adopt an existing path, even an empty directory or one another command just cloned.
    await mkdir(path, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") throw pathChanged();
    throw new CheckoutCommandError("conflict", "Could not reserve the checkout destination.");
  }

  try {
    const reserved = await entryAt(path);
    const stillReserved = async () =>
      reserved && (await stillDirectory(root, entry)) && (await stillDirectory(path, reserved));
    if (!(await stillReserved())) throw pathChanged();
    checkExpiry();
    const clone = await runCheckoutGit(
      path,
      [
        "clone",
        "--template=",
        "--no-recurse-submodules",
        "-c",
        `${PROVISIONING_KEY}=true`,
        "--",
        cloneUrl,
        ".",
      ],
      {
        httpsOnly: true,
        timeoutMs: Math.min(CLONE_TIMEOUT_MS, expires - Date.now()),
        config: [
          ["core.hooksPath", "/dev/null"],
          ["http.followRedirects", "false"],
          ["credential.helper", ""],
          ["credential.interactive", "never"],
          [
            `http.${cloneUrl}.extraHeader`,
            `Authorization: Basic ${Buffer.from(`x-access-token:${grant.token}`).toString("base64")}`,
          ],
        ],
      },
    );
    if (clone.timedOut)
      throw new CheckoutCommandError("timeout", `Clone timed out. ${CHECK_STATUS}`, PARTIAL);
    if (clone.code !== 0 || !(await stillReserved())) throw new Error();
    const info = await inspectAt(path, cloneUrl);
    if (!info || !(await stillReserved())) throw new Error();
    const complete = await runCheckoutGit(path, ["config", "--local", "--unset", PROVISIONING_KEY]);
    if (complete.code !== 0 || !(await stillReserved())) throw new Error();
    return info.checkout;
  } catch (err) {
    // Leave the reserved path alone. Git may already have written files, or a local process
    // may have changed it. Never remove it or replay the clone to recover.
    if (err instanceof CheckoutCommandError)
      throw new CheckoutCommandError(err.code, err.message, PARTIAL);
    throw new CheckoutCommandError("internal", `Clone did not complete. ${CHECK_STATUS}`, PARTIAL);
  }
}
