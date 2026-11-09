import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import {
  canonicalPolicyJson,
  HostPolicyBoundary,
  type HostPolicySampleRequest,
  type HostPolicySampleResult,
  SwitchyardError,
} from "@switchyard/protocol";
import { parse } from "shell-quote";

export function unverifiedBoundary(): SwitchyardError {
  return new SwitchyardError(
    "forbidden",
    "Cannot verify workspace boundary for policy enforcement.",
  );
}

export async function resolvePolicyBoundary(
  cwd: string,
  workspaceRoot: string,
): Promise<HostPolicyBoundary> {
  try {
    // Parse raw paths before touching the filesystem; schema normalization is lexical only.
    const raw = {
      cwd: HostPolicyBoundary.shape.cwd.parse(cwd),
      workspaceRoot: HostPolicyBoundary.shape.workspaceRoot.parse(workspaceRoot),
    };
    const [cwdReal, workspaceRootReal] = await Promise.all([
      realpath(raw.cwd),
      realpath(raw.workspaceRoot),
    ]);
    return HostPolicyBoundary.parse({
      cwd: raw.cwd,
      workspaceRoot: raw.workspaceRoot,
      cwdReal,
      workspaceRootReal,
    });
  } catch {
    throw unverifiedBoundary();
  }
}

/** Only the local symbolic remote HEAD is evidence; never infer a default of main. */
async function policyDefaultBranch(cwdReal: string, signal?: AbortSignal): Promise<string | null> {
  const stdout = await new Promise<string | null>((resolve) => {
    execFile(
      "git",
      ["-C", cwdReal, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
      {
        encoding: "utf8",
        timeout: 2000,
        maxBuffer: 8192,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        signal,
      },
      (error, output) => resolve(error ? null : output),
    );
  }).catch(() => null);
  if (stdout === null) return null;
  const ref = stdout.replace(/\r?\n$/, "");
  if (!ref.startsWith("origin/")) return null;
  const branch = ref.slice("origin/".length);
  if (
    !branch ||
    branch.length > 255 ||
    branch === "HEAD" ||
    branch.startsWith("-") ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Git refs must reject control characters.
    /[\x00-\x20\x7f~^:?*[\\]/.test(branch) ||
    branch.includes("..") ||
    branch.includes("@{") ||
    branch.endsWith(".") ||
    branch.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))
  )
    return null;
  return branch;
}

/**
 * Collect the same read-only proof for real invocations and tester samples. The caller owns
 * identities and the already pinned boundary; collecting never establishes or changes a bind.
 */
export async function collectToolPolicyContext(
  input: HostPolicySampleRequest["tool"],
  options: {
    verifyBoundary: () => Promise<HostPolicyBoundary>;
    check: () => void;
    signal?: AbortSignal;
    classify?: typeof classifyToolSafety;
  },
): Promise<Pick<HostPolicySampleResult, "toolHash" | "boundary" | "defaultBranch" | "safety">> {
  const check = () => {
    options.signal?.throwIfAborted();
    options.check();
  };
  check();
  const toolJson = canonicalPolicyJson(input);
  const tool = JSON.parse(toolJson) as HostPolicySampleRequest["tool"];
  const boundary = await options.verifyBoundary();
  check();
  const defaultBranch = await policyDefaultBranch(boundary.cwdReal, options.signal);
  check();
  // Detect a symlink/rename change while git was running as well.
  await options.verifyBoundary();
  check();
  let safety: ToolSafety;
  try {
    safety = (options.classify ?? classifyToolSafety)(
      tool.name,
      tool.args,
      boundary.cwdReal,
      boundary.workspaceRootReal,
      defaultBranch,
    );
  } catch {
    throw new SwitchyardError("host_unreachable", "Tool safety classification is unavailable");
  }
  check();
  return {
    toolHash: createHash("sha256").update(toolJson).digest("hex"),
    boundary,
    defaultBranch,
    safety,
  };
}

export interface ToolSafety {
  destructiveDelete: boolean;
  forcePush: boolean;
  defaultBranchPush: boolean;
  uncertain: boolean;
  reasons: string[];
}

const unknown = "__SWITCHYARD_UNKNOWN_EXPANSION__";
const separators = new Set([";", "&&", "||", "|", "|&", "&", ";;", ";&", ";;&", "(", ")"]);

type Word = { text: string; unresolved: boolean };

// Append without path.resolve/join: symlink/.. must traverse the symlink FIRST.
function fromDirectory(directory: string, target: string): string {
  return path.isAbsolute(target) ? target : `${directory}${path.sep}${target}`;
}

// Walk filesystem components in order; only a missing suffix may be inferred.
function realTarget(target: string): string | null {
  if (!path.isAbsolute(target)) return null;
  let current = path.parse(target).root;
  let missing = false;
  for (const component of target.slice(current.length).split(path.sep)) {
    if (!component || component === ".") continue;
    if (component === "..") {
      // A missing ancestor cannot establish what traversal through it would mean.
      if (missing) return null;
      current = path.dirname(current);
      continue;
    }
    const next = fromDirectory(current, component);
    if (!missing) {
      try {
        lstatSync(next);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
        missing = true;
      }
      if (!missing) {
        try {
          current = realpathSync(next);
        } catch {
          // In particular, a dangling symlink is not a missing literal leaf.
          return null;
        }
        continue;
      }
    }
    current = next;
  }
  return current;
}

function realDirectory(target: string): string | null {
  const resolved = realTarget(target);
  try {
    return resolved && statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

/** Metadata for policy evaluation, not a sandbox or an analysis of scripts/interpreters. */
export function classifyToolSafety(
  toolName: string,
  input: unknown,
  cwd: string,
  workspaceRoot: string,
  defaultBranch: string | null,
): ToolSafety {
  const result: ToolSafety = {
    destructiveDelete: false,
    forcePush: false,
    defaultBranchPush: false,
    uncertain: false,
    reasons: [],
  };
  const reason = (message: string) => {
    if (!result.reasons.includes(message) && result.reasons.length < 16)
      result.reasons.push(message);
  };
  const uncertain = (message: string) => {
    result.uncertain = true;
    reason(message);
  };
  if (toolName !== "bash" || !input || typeof input !== "object") return result;
  const command = (input as { command?: unknown }).command;
  if (typeof command !== "string") return result;
  let tokens: ReturnType<typeof parse>;
  try {
    tokens = parse(command, () => unknown);
  } catch {
    if (/\b(?:rm|git)\b/.test(command))
      uncertain("Could not parse a potentially destructive command.");
    return result;
  }
  const root = realDirectory(workspaceRoot);
  const originalDirectory = realDirectory(cwd);
  let directory: string | null = originalDirectory;
  let segment: Word[] = [];
  let complex = false;
  let cwdChanged = false;
  const process = () => {
    let words = segment;
    segment = [];
    if (!words.length) return;
    let index = 0;
    let commandDirectory = directory;
    let wrapperUnresolved = false;
    // Environment assignments and common command wrappers. Cwd-changing wrappers
    // are not transparent; unknown wrapper options cannot establish safety.
    while (index < words.length) {
      const word = words[index]?.text ?? "";
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
        index++;
        continue;
      }
      if (word === "command" || word === "env" || word === "sudo") {
        index++;
        while (index < words.length) {
          const option = words[index]?.text ?? "";
          if (option === "--") {
            index++;
            break;
          }
          if (word === "env" && ["-u", "--unset", "-C", "--chdir"].includes(option)) {
            if (option === "-C" || option === "--chdir") commandDirectory = null;
            index += 2;
            continue;
          }
          if (
            (word === "env" && (option.startsWith("--chdir=") || option.startsWith("-C"))) ||
            (word === "sudo" &&
              (option.startsWith("--chdir=") ||
                option.startsWith("-D") ||
                option.startsWith("--chroot=") ||
                option.startsWith("-R")))
          ) {
            commandDirectory = null;
          }
          if (
            word === "sudo" &&
            [
              "-u",
              "-g",
              "-h",
              "-p",
              "-C",
              "-T",
              "--user",
              "--group",
              "--host",
              "--prompt",
              "--chdir",
              "-D",
              "--chroot",
              "-R",
            ].includes(option)
          ) {
            if (["--chdir", "-D", "--chroot", "-R"].includes(option)) commandDirectory = null;
            index += 2;
            continue;
          }
          if (
            option.startsWith("-") ||
            (word === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(option))
          ) {
            if (option.startsWith("-")) wrapperUnresolved = true;
            index++;
            continue;
          }
          break;
        }
        continue;
      }
      break;
    }
    words = words.slice(index);
    const executable = words[0] && path.basename(words[0].text);
    const args = words.slice(1);
    if (executable === "cd") {
      cwdChanged = true;
      const target = args[0];
      directory =
        args.length === 1 && target && !target.unresolved && commandDirectory && !wrapperUnresolved
          ? realDirectory(fromDirectory(commandDirectory, target.text))
          : null;
      return;
    }
    if (executable === "rm") {
      let recursive = false,
        force = false,
        options = true,
        unknownOption = false;
      const targets: Word[] = [];
      for (const arg of args) {
        if (options && arg.text === "--") {
          options = false;
          continue;
        }
        if (options && arg.unresolved) {
          unknownOption = true;
          targets.push(arg);
          continue;
        }
        if (options && arg.text.startsWith("-") && arg.text !== "-") {
          if (arg.text === "--recursive") recursive = true;
          else if (arg.text === "--force") force = true;
          else if (!arg.text.startsWith("--")) {
            recursive ||= /[rR]/.test(arg.text.slice(1));
            force ||= arg.text.slice(1).includes("f");
          }
          continue;
        }
        targets.push(arg);
      }
      if (!(recursive && force) && !(unknownOption && (recursive || force || unknownOption)))
        return;
      if (!(recursive && force) || complex || wrapperUnresolved)
        uncertain("Recursive forced deletion has unresolved shell syntax or options.");
      for (const target of targets) {
        if (target.unresolved || !commandDirectory || !root) {
          uncertain("Deletion target cannot be resolved.");
          continue;
        }
        const resolved = realTarget(fromDirectory(commandDirectory, target.text));
        if (!resolved) uncertain("Deletion target cannot be resolved.");
        else if (!inside(root, resolved)) {
          result.destructiveDelete = true;
          reason("Recursive forced deletion targets outside the workspace.");
        }
      }
      return;
    }
    if (executable !== "git") return;
    let i = 0;
    let gitDirectory = commandDirectory;
    let repositoryChanged = gitDirectory !== originalDirectory;
    while (i < args.length) {
      const arg = args[i];
      if (!arg) break;
      if (arg.text === "-C") {
        repositoryChanged = true;
        const target = args[i + 1];
        gitDirectory =
          target && !target.unresolved && gitDirectory
            ? realDirectory(fromDirectory(gitDirectory, target.text))
            : null;
        i += 2;
      } else if (arg.text.startsWith("-C") && arg.text.length > 2) {
        repositoryChanged = true;
        gitDirectory =
          !arg.unresolved && gitDirectory
            ? realDirectory(fromDirectory(gitDirectory, arg.text.slice(2)))
            : null;
        i++;
      } else if (
        ["-c", "--git-dir", "--work-tree", "--namespace", "--config-env"].includes(arg.text)
      ) {
        repositoryChanged = true;
        i += 2;
      } else if (arg.text.startsWith("-")) {
        // Git global options can select repositories or alter their configuration.
        repositoryChanged = true;
        i++;
      } else break;
    }
    if (args[i]?.text !== "push") return;
    const pushArgs = args.slice(i + 1);
    let options = true;
    const positional: Word[] = [];
    for (let j = 0; j < pushArgs.length; j++) {
      const arg = pushArgs[j];
      if (!arg) continue;
      if (options && arg.text === "--") {
        options = false;
        continue;
      }
      if (options && arg.text.startsWith("-")) {
        if (
          arg.text === "--force" ||
          arg.text === "--force-with-lease" ||
          arg.text.startsWith("--force-with-lease=") ||
          (!arg.text.startsWith("--") && arg.text.slice(1).includes("f"))
        )
          result.forcePush = true;
        if (["-o", "--push-option", "--receive-pack", "--exec", "--repo"].includes(arg.text)) j++;
        if (["--all", "--branches", "--mirror"].includes(arg.text))
          uncertain("Push destinations are not explicit.");
        continue;
      }
      positional.push(arg);
    }
    if (result.forcePush) reason("Forced git push.");
    if (
      !gitDirectory ||
      repositoryChanged ||
      wrapperUnresolved ||
      args.some((arg) => arg.unresolved) ||
      complex ||
      !defaultBranch ||
      positional.length < 2 ||
      positional.some((word) => word.unresolved)
    )
      uncertain("Push destination or repository is unresolved.");
    for (const ref of positional.slice(1)) {
      if (ref.unresolved) continue;
      const spec = ref.text.replace(/^\+/, "");
      if (ref.text.startsWith("+")) {
        result.forcePush = true;
        reason("Forced git push.");
      }
      const destination = spec.includes(":") ? spec.slice(spec.lastIndexOf(":") + 1) : spec;
      if (!destination || destination === "HEAD" || destination.includes("*")) {
        uncertain("Push destination is unresolved.");
        continue;
      }
      if (
        !repositoryChanged &&
        defaultBranch &&
        (destination === defaultBranch || destination === `refs/heads/${defaultBranch}`)
      ) {
        result.defaultBranchPush = true;
        reason("Push targets the default branch.");
      }
    }
  };
  // shell-quote treats newlines as whitespace and comments can hide later lines.
  // Do not confidently authorize a multiline potential destructive command.
  if (
    command.includes("\n") &&
    (/\brm\b[^\n]*(?:-[^\s]*[rfR]|--recursive|--force|\$|`)/.test(command) ||
      /\bgit\b[^\n]*\bpush\b/.test(command))
  ) {
    uncertain("Multiline shell command cannot be resolved confidently.");
  }
  let redirectTarget = false;
  for (const token of tokens) {
    if (typeof token === "string") {
      if (redirectTarget) {
        redirectTarget = false;
        continue;
      }
      segment.push({
        text: token,
        // shell-quote does not mark brace expansion or bracket globs as glob tokens.
        // Quoting provenance is unavailable here, so these also fail conservatively.
        unresolved:
          token.includes(unknown) ||
          token.includes("`") ||
          token.startsWith("~") ||
          /[{}[\]]/.test(token),
      });
    } else if ("op" in token && token.op === "glob") {
      segment.push({ text: token.pattern, unresolved: true });
    } else if ("op" in token && separators.has(token.op)) {
      process();
      // A cd in a pipeline or subshell does not reliably affect subsequent commands.
      if (["||", "|", "|&", "&", "(", ")"].includes(token.op) || (cwdChanged && token.op !== "&&"))
        directory = null;
    } else if ("op" in token) {
      complex = true;
      // Consume only shell-quote's redirection operand, not the executable after it.
      if ([">", ">>", "<", "<>", ">|", ">&", "<&", "<<", "<<<"].includes(token.op)) {
        if (/^\d+$/.test(segment.at(-1)?.text ?? "")) segment.pop();
        redirectTarget = true;
      }
    } else if ("comment" in token) {
      // shell-quote incorrectly treats mid-word # as a comment and can hide targets.
      // Without quote/position provenance, no candidate with a comment is proven safe.
      complex = true;
    }
  }
  process();
  return result;
}
