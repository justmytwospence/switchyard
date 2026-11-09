import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import {
  GitHubCheck,
  GitHubHostLogsRequest,
  GitHubHostMergeRequest,
  type GitHubJobLog,
  GitHubLogs,
  GitHubMergeResult,
  GitHubPullRequest,
  GitHubRepository,
  GitHubSha,
  type GitHubThread,
  GitHubViewResult,
  type HostGitHub,
  SwitchyardError,
  WorkspaceGitHub,
} from "@switchyard/protocol";
import { tailBytes } from "./checks.js";
import { mapLimit } from "./concurrency.js";
import type { HostDb } from "./db/index.js";
import { normalizeRemote } from "./git.js";

const JSON_BYTES = 2 * 1024 * 1024;
const SNAPSHOT_BYTES = 512 * 1024;
const PR_FIELDS =
  "number,url,title,state,isDraft,headRefName,headRefOid,headRepository,headRepositoryOwner,baseRefName,mergeable,mergeStateStatus,reviewDecision";
const CHECK_FIELDS = "name,state,bucket,link,workflow,event,startedAt,completedAt,description";
// Queries are fixed; all values (including cursors) are passed as typed variables.
const REVIEW_QUERY = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){squashMergeAllowed pullRequest(number:$number){id isMergeQueueEnabled isInMergeQueue autoMergeRequest{enabledAt} reviewThreads(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{id isResolved isOutdated path line startLine diffSide comments(first:10){pageInfo{hasNextPage} nodes{id author{login} body url createdAt}}}}}}}`;
const MERGED_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){id state headRefOid mergeCommit{oid}}}}`;

export interface GitHubProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  tail: boolean;
}
export interface GitHubProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  tooLarge?: boolean;
  truncated?: boolean;
}
export type GitHubRunner = (
  file: string,
  args: string[],
  options: GitHubProcessOptions,
) => Promise<GitHubProcessResult>;
export interface GitHubServiceOptions {
  env?: NodeJS.ProcessEnv;
  runner?: GitHubRunner;
  publish?: (path: string, snapshot: WorkspaceGitHub) => void;
  /** The existing host meta table fences uncertain external mutations across restarts. */
  db?: Pick<HostDb, "getMeta" | "setMeta">;
}
interface Identity {
  path: string;
  branch: string;
  headRepository: string;
  baseRepository: string;
  repositories: string[];
  fingerprint: string;
}
interface Entry {
  snapshot?: WorkspaceGitHub;
  fingerprint?: string;
  flight?: Promise<GitHubViewResult>;
  timer?: NodeJS.Timeout;
  trailing: boolean;
  generation: number;
  reconcile?: boolean;
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* exited */
    }
  }
}
function clean(s: string): string {
  return (
    s
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Strip terminal escape sequences from untrusted stderr.
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Strip nonprinting controls from diagnostics.
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
      .replace(/(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|Bearer\s+\S+)/gi, "[redacted]")
  );
}
function reason(error: unknown): string {
  return (
    clean(error instanceof Error ? error.message : String(error)).slice(0, 2000) ||
    "GitHub operation failed"
  );
}
function fail(message: string): never {
  throw new SwitchyardError("conflict", message);
}
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid GitHub object");
  return value as Record<string, any>;
}
function array(value: unknown): any[] {
  if (!Array.isArray(value)) throw new Error("Invalid GitHub list");
  return value;
}
function same(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}
function positive(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("Invalid GitHub integer");
  return value;
}
function actionsId(value: unknown): string {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 1))
    throw new Error("Unsafe Actions ID");
  const result = String(value);
  if (!/^[1-9][0-9]{0,19}$/.test(result)) throw new Error("Invalid Actions ID");
  return result;
}
function instant(value: unknown): string | null {
  return value == null || value === "" ? null : new Date(String(value)).toISOString();
}
function displayUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const u = new URL(value);
    return ["https:", "http:"].includes(u.protocol) && !u.username && !u.password ? value : null;
  } catch {
    return null;
  }
}
function publicUrl(value: unknown): URL | null {
  const link = displayUrl(value);
  if (!link) return null;
  const u = new URL(link);
  return u.protocol === "https:" && u.hostname === "github.com" && !u.port ? u : null;
}
function prIdentity(value: unknown): { repository: string; number: number; url: string } {
  const u = publicUrl(value);
  const m = u && /^\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]*)$/.exec(u.pathname);
  if (!u || !m || u.search || u.hash) throw new Error("Invalid public GitHub PR URL");
  const repository = GitHubRepository.parse(m[1]);
  const number = positive(Number(m[2]));
  return { repository, number, url: `https://github.com/${repository}/pull/${number}` };
}
function sha(value: unknown): string {
  return GitHubSha.parse(typeof value === "string" ? value.toLowerCase() : value);
}
function empty(
  status: WorkspaceGitHub["status"],
  message: string,
  identity?: Identity,
): WorkspaceGitHub {
  return {
    repository: identity?.headRepository ?? null,
    headRepository: identity?.headRepository ?? null,
    branch: identity?.branch ?? null,
    fetchedAt: null,
    attemptedAt: new Date().toISOString(),
    status,
    reason: message,
    pullRequest: null,
    checks: [],
    checksComplete: false,
    threads: [],
    threadsComplete: false,
    truncated: false,
  };
}

/** Host credentials never leave this service. All subprocesses use argv, never a shell. */
export class GitHubService {
  private readonly opts: GitHubServiceOptions;
  private readonly env: NodeJS.ProcessEnv;
  private readonly children = new Set<ChildProcess>();
  private readonly kills = new Set<NodeJS.Timeout>();
  private readonly entries = new Map<string, Entry>();
  private readonly resolving = new Set<Promise<GitHubViewResult>>();
  private readonly unknown = new Set<string>();
  private readonly mutating = new Set<string>();
  private readonly mutationEpoch = new Map<string, number>();
  private readonly operations = new Set<Promise<unknown>>();
  private stopped = false;
  private probing?: Promise<HostGitHub>;
  github: HostGitHub = { available: false, reason: "GitHub has not been probed" };

  constructor(opts: GitHubServiceOptions = {}) {
    this.opts = opts;
    this.env = {
      ...process.env,
      ...opts.env,
      GH_HOST: "github.com",
      // Do not let a host-user repository override redirect cwd discovery to Enterprise.
      GH_REPO: undefined,
      GH_PROMPT_DISABLED: "1",
      GH_PAGER: "cat",
      PAGER: "cat",
      GIT_TERMINAL_PROMPT: "0",
    };
  }

  private runProcess: GitHubRunner = (file, args, opts) =>
    new Promise((resolve) => {
      const child = spawn(file, args, {
        cwd: opts.cwd,
        env: opts.env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.children.add(child);
      let stdout = Buffer.alloc(0),
        stderr = Buffer.alloc(0),
        total = 0,
        timedOut = false,
        tooLarge = false,
        settled = false;
      let closeTimer: NodeJS.Timeout | undefined;
      const terminate = () => {
        signalGroup(child, "SIGTERM");
        const kill = setTimeout(() => {
          signalGroup(child, "SIGKILL");
          this.kills.delete(kill);
        }, 3000);
        this.kills.add(kill);
        kill.unref();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, opts.timeoutMs);
      const finish = (code: number | null, error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(closeTimer);
        child.stdout.destroy();
        child.stderr.destroy();
        this.children.delete(child);
        let start = 0;
        while (start < stdout.length && (stdout[start]! & 0xc0) === 0x80) start++;
        resolve({
          code,
          stdout: stdout.subarray(start).toString("utf8"),
          stderr: tailBytes(clean(error?.message ?? stderr.toString("utf8")), 8192),
          timedOut,
          tooLarge,
          truncated: total > stdout.length,
        });
      };
      child.stdout.on("data", (chunk: Buffer) => {
        total += chunk.length;
        const limit = opts.tail ? 65536 : JSON_BYTES;
        if (!opts.tail && total > limit) {
          if (!tooLarge) {
            tooLarge = true;
            terminate();
          }
          return;
        }
        stdout = Buffer.concat([stdout, chunk]);
        if (stdout.length > limit) stdout = Buffer.from(stdout.subarray(stdout.length - limit));
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = Buffer.concat([stderr, chunk]).subarray(-8192);
      });
      child.on("error", (error) => finish(null, error));
      child.on("exit", (code) => {
        closeTimer = setTimeout(() => finish(code), 1000);
      });
      child.on("close", (code) => finish(code));
    });

  private async run(
    file: string,
    args: string[],
    path: string,
    deadline: number,
    tail = false,
  ): Promise<GitHubProcessResult> {
    if (this.stopped) throw new SwitchyardError("host_unreachable", "GitHub service stopped");
    const timeoutMs = Math.min(20_000, deadline - Date.now());
    if (timeoutMs <= 0) throw new SwitchyardError("timeout", "GitHub operation deadline exceeded");
    const result = await (this.opts.runner ?? this.runProcess)(file, args, {
      cwd: path,
      env: this.env,
      timeoutMs,
      tail,
    });
    if (result.timedOut) throw new SwitchyardError("timeout", "GitHub command timed out");
    if (result.tooLarge || (!tail && Buffer.byteLength(result.stdout) > JSON_BYTES))
      throw new SwitchyardError("too_large", "GitHub JSON exceeded 2 MiB");
    return { ...result, stderr: tailBytes(clean(tailBytes(result.stderr, 8192)), 8192) };
  }

  private async json(args: string[], path: string, deadline: number, checks = false): Promise<any> {
    const r = await this.run("gh", args, path, deadline);
    // gh checks may return normal pending/failure exit codes even with complete JSON.
    if (r.code !== 0 && !(checks && (r.code === 1 || r.code === 8)))
      throw new Error(r.stderr || "GitHub command failed");
    const parsed = JSON.parse(r.stdout);
    if (r.code !== 0 && (r.stderr.trim() || !Array.isArray(parsed) || parsed.length === 0))
      throw new Error(r.stderr || "GitHub checks did not complete successfully");
    return parsed;
  }
  private api(endpoint: string, path: string, deadline: number): Promise<any> {
    return this.json(["api", "--hostname", "github.com", endpoint], path, deadline);
  }
  private async graphql(
    query: string,
    repository: string,
    number: number,
    path: string,
    deadline: number,
    cursor?: string,
  ): Promise<any> {
    const [owner, name] = repository.split("/");
    const args = [
      "api",
      "--hostname",
      "github.com",
      "graphql",
      "-f",
      `query=${query}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${name}`,
      "-F",
      `number=${number}`,
    ];
    if (cursor) args.push("-f", `cursor=${cursor}`);
    const raw = await this.json(args, path, deadline);
    if (raw.errors?.length) throw new Error("GitHub GraphQL returned incomplete data");
    return object(raw.data?.repository);
  }

  probe(operationDeadline = Infinity): Promise<HostGitHub> {
    this.probing ??= (async () => {
      const deadline = Math.min(Date.now() + 5000, operationDeadline);
      try {
        for (const args of [
          ["--version"],
          ["auth", "status", "--hostname", "github.com", "--active", "--no-refresh"],
        ]) {
          const r = await this.run("gh", args, process.cwd(), deadline);
          if (r.code !== 0)
            throw new Error(r.stderr || "gh is missing or not signed in to github.com");
        }
        this.github = { available: true, reason: null };
      } catch (e) {
        this.github = { available: false, reason: reason(e) };
      }
      return this.github;
    })().finally(() => {
      this.probing = undefined;
    });
    return this.probing;
  }

  private async identity(path: string, deadline: number): Promise<Identity> {
    const git = async (args: string[]) => {
      const r = await this.run("git", args, path, deadline);
      return r.code === 0 ? r.stdout.trim() : "";
    };
    // Same root/remote normalization as inspectCheckout, with this service's bounded runner.
    const root = await git(["rev-parse", "--show-toplevel"]);
    if (!root) throw new Error("Not a Git checkout");
    const branch = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (!branch) throw new Error("Detached HEAD has no GitHub branch association");
    const names = [
      await git(["config", "--get", `branch.${branch}.pushRemote`]),
      await git(["config", "--get", "remote.pushDefault"]),
      await git(["config", "--get", `branch.${branch}.remote`]),
      "origin",
    ];
    const repositories: string[] = [];
    const byRemote = new Map<string, string>();
    let selected: string | undefined;
    for (const name of [...new Set(names.filter((n) => n && n !== "."))]) {
      // '--' ensures even an unusual remote name cannot become an option.
      const raw = await git(["remote", "get-url", "--push", "--", name]);
      if (!/^(?:(?:https?|ssh|git|git\+ssh):\/\/|(?:[^@/]+@)?github\.com:)/i.test(raw)) continue;
      const u = publicUrl(normalizeRemote(raw).replace(/^http:/, "https:"));
      const repo = u && GitHubRepository.safeParse(u.pathname.slice(1));
      if (!u || u.search || u.hash || !repo?.success) continue;
      selected ??= repo.data;
      byRemote.set(name, repo.data);
      if (!repositories.some((r) => same(r, repo.data))) repositories.push(repo.data);
    }
    if (!selected) throw new Error("No public github.com head remote");
    return {
      path,
      branch,
      headRepository: selected,
      baseRepository: byRemote.get(names[2]!) ?? byRemote.get("origin") ?? selected,
      repositories,
      fingerprint: JSON.stringify([
        branch,
        selected.toLowerCase(),
        names,
        repositories.map((r) => r.toLowerCase()),
      ]),
    };
  }

  private entry(path: string): Entry {
    let entry = this.entries.get(path);
    if (!entry) {
      entry = { trailing: false, generation: 0 };
      // Keep branch association stable across host restarts too. This is only bounded
      // display data, never logs or merge authority; every operation still revalidates it.
      const stored = this.opts.db?.getMeta(`github.snapshot:${path}`);
      if (stored) {
        try {
          const cached = JSON.parse(stored);
          const snapshot = WorkspaceGitHub.safeParse(cached.snapshot);
          if (snapshot.success && typeof cached.fingerprint === "string") {
            entry.snapshot = snapshot.data;
            entry.fingerprint = cached.fingerprint;
          }
        } catch {
          /* Ignore corrupt local display cache; never infer authorization from it. */
        }
      }
      this.entries.set(path, entry);
    }
    return entry;
  }
  private key(path: string): string {
    return `github.mergeUnknown:${path}`;
  }
  private isUnknown(path: string): boolean {
    return this.unknown.has(path) || this.opts.db?.getMeta(this.key(path)) === "1";
  }
  private markUnknown(path: string, value: boolean): void {
    if (value) this.unknown.add(path);
    else this.unknown.delete(path);
    this.opts.db?.setMeta(this.key(path), value ? "1" : "0");
  }

  /** Explicit refresh is the only operation allowed to clear an uncertain mutation fence. */
  refresh(path: string): Promise<GitHubViewResult> {
    const work = (async () => {
      let canonical: string;
      try {
        canonical = await realpath(path);
      } catch (e) {
        return this.view({ github: await this.probe(), snapshot: empty("unavailable", reason(e)) });
      }
      return this.freshAt(canonical, true);
    })().finally(() => this.resolving.delete(work));
    this.resolving.add(work);
    return work;
  }
  private async freshAt(
    path: string,
    explicit: boolean,
    deadline?: number,
  ): Promise<GitHubViewResult> {
    // An earlier background or explicit read cannot reconcile a later merge attempt, nor
    // supply a fresh identity for a new merge preflight.
    while (this.entry(path).flight) await this.entry(path).flight;
    if (this.stopped) throw new SwitchyardError("host_unreachable", "GitHub service stopped");
    return this.refreshAt(path, explicit, deadline);
  }
  private refreshAt(
    path: string,
    explicit: boolean,
    deadline = Date.now() + 40_000,
  ): Promise<GitHubViewResult> {
    const entry = this.entry(path);
    if (entry.flight) {
      entry.reconcile ||= explicit;
      return entry.flight;
    }
    entry.reconcile = explicit;
    const generation = ++entry.generation;
    const mutationEpoch = this.mutationEpoch.get(path) ?? 0;
    entry.flight = this.fetch(path, entry, Math.min(deadline, Date.now() + 40_000))
      .then(async (result) => {
        if (this.stopped || generation !== entry.generation) return result;
        if (
          entry.reconcile &&
          result.snapshot.status === "ready" &&
          !this.mutating.has(path) &&
          mutationEpoch === (this.mutationEpoch.get(path) ?? 0)
        )
          this.markUnknown(path, false);
        if (this.isUnknown(path))
          result.snapshot = {
            ...result.snapshot,
            status: "error",
            reason: "Merge outcome unknown. Refresh before retrying.",
            checksComplete: false,
            threadsComplete: false,
          };
        result = this.view(result);
        entry.snapshot = result.snapshot;
        this.opts.db?.setMeta(
          `github.snapshot:${path}`,
          JSON.stringify({ fingerprint: entry.fingerprint, snapshot: result.snapshot }),
        );
        this.opts.publish?.(path, result.snapshot);
        return result;
      })
      .finally(() => {
        entry.flight = undefined;
        if (entry.trailing && !this.stopped) {
          entry.trailing = false;
          this.schedule(path);
        }
      });
    return entry.flight;
  }

  private async fetch(path: string, entry: Entry, deadline: number): Promise<GitHubViewResult> {
    const github = await this.probe(deadline);
    let identity: Identity | undefined;
    try {
      try {
        identity = await this.identity(path, deadline);
      } catch (e) {
        entry.fingerprint = undefined;
        return this.view({ github, snapshot: empty("unavailable", reason(e)) });
      }
      const prior = entry.fingerprint === identity.fingerprint ? entry.snapshot : undefined;
      if (!prior) entry.snapshot = undefined;
      entry.fingerprint = identity.fingerprint;
      if (!github.available)
        return this.view({
          github,
          snapshot: {
            ...(prior ?? empty("unavailable", github.reason!, identity)),
            attemptedAt: new Date().toISOString(),
            status: "unavailable",
            reason: github.reason,
            checksComplete: false,
            threadsComplete: false,
          },
        });
      const association = await this.associate(identity, prior, deadline);
      const snapshot: WorkspaceGitHub = {
        ...empty("ready", "", identity),
        status: "ready",
        reason: null,
        fetchedAt: new Date().toISOString(),
        checksComplete: true,
        threadsComplete: true,
      };
      if (association) {
        snapshot.repository = association.repository;
        snapshot.pullRequest = this.pullRequest(association.raw);
        if (association.unverified) {
          snapshot.status = "unavailable";
          snapshot.reason =
            "PR head repository is unavailable; its head association cannot be verified";
          snapshot.fetchedAt = prior?.fetchedAt ?? null;
          snapshot.checksComplete = false;
          snapshot.threadsComplete = false;
        } else {
          await this.reviews(snapshot, path, deadline);
          await this.checks(snapshot, path, deadline);
        }
      }
      this.fit(snapshot);
      const current = await this.identity(path, deadline);
      if (current.fingerprint !== identity.fingerprint) {
        entry.generation++;
        entry.fingerprint = undefined;
        entry.snapshot = undefined;
        entry.trailing = true;
        return this.view({
          github,
          snapshot: empty(
            "unavailable",
            "Workspace branch or remote changed during refresh",
            current,
          ),
        });
      }
      return this.view({ github, snapshot });
    } catch (e) {
      let stale: WorkspaceGitHub | undefined;
      if (identity && entry.fingerprint === identity.fingerprint) {
        try {
          const current = await this.identity(path, deadline);
          if (current.fingerprint === identity.fingerprint) stale = entry.snapshot;
          else {
            entry.generation++;
            entry.fingerprint = undefined;
            entry.snapshot = undefined;
            entry.trailing = true;
            return this.view({
              github,
              snapshot: empty(
                "unavailable",
                "Workspace branch or remote changed during refresh",
                current,
              ),
            });
          }
        } catch {
          entry.fingerprint = undefined;
          entry.snapshot = undefined;
        }
      }
      return this.view({
        github,
        snapshot: {
          ...(stale ?? empty("error", reason(e), identity)),
          attemptedAt: new Date().toISOString(),
          status: /ambiguous/i.test(reason(e)) ? "ambiguous" : "error",
          reason: reason(e),
          checksComplete: false,
          threadsComplete: false,
        },
      });
    }
  }

  private head(raw: any): string | null {
    if (!raw.headRepository) return null;
    const owner = raw.headRepositoryOwner?.login ?? raw.headRepository.owner?.login;
    return GitHubRepository.parse(`${owner}/${raw.headRepository.name}`);
  }
  private matches(raw: any, identity: Identity): boolean {
    return raw.headRefName === identity.branch && same(this.head(raw), identity.headRepository);
  }
  private async associate(
    identity: Identity,
    prior: WorkspaceGitHub | undefined,
    deadline: number,
  ): Promise<{ raw: any; repository: string; unverified?: boolean } | null> {
    const view = async (number?: number, repository?: string) => {
      const args = ["pr", "view"];
      if (number) args.push(String(number));
      if (repository) args.push("--repo", `github.com/${repository}`);
      args.push("--json", PR_FIELDS);
      const r = await this.run("gh", args, identity.path, deadline);
      if (r.code !== 0) {
        if (
          r.code === 1 &&
          /no pull requests? (?:found|associated)|no pull request found/i.test(r.stderr)
        )
          return null;
        throw new Error(r.stderr || "Unable to discover pull request");
      }
      return object(JSON.parse(r.stdout));
    };
    if (prior?.pullRequest && prior.repository) {
      const raw = await view(prior.pullRequest.number, prior.repository);
      if (
        !raw ||
        raw.headRefName !== identity.branch ||
        (raw.headRepository !== null && !this.matches(raw, identity))
      )
        throw new Error("Previous PR head association can no longer be verified");
      const parsed = prIdentity(raw.url);
      if (!same(parsed.repository, prior.repository) || parsed.number !== prior.pullRequest.number)
        throw new Error("PR identity changed");
      return { raw, repository: parsed.repository, unverified: raw.headRepository === null };
    }
    const raw = await view(undefined, identity.baseRepository);
    const candidate = raw ? prIdentity(raw.url) : null;
    // A deleted fork may still be displayed, but never becomes a verified association.
    if (raw?.headRepository === null && raw.headRefName === identity.branch)
      return { raw, repository: candidate!.repository, unverified: true };
    // GH_HOST alone does not override an Enterprise remote in cwd. Resolve public fork
    // metadata ourselves rather than allowing implicit base selection to contact it.
    const metadata = object(
      await this.api(`repos/${identity.headRepository}`, identity.path, deadline),
    );
    if (!same(metadata.full_name, identity.headRepository) || typeof metadata.fork !== "boolean")
      throw new Error("Incomplete GitHub head repository identity");
    const parents: string[] = [];
    if (metadata.fork) {
      for (const parent of [metadata.parent, metadata.source]) {
        if (!parent) continue;
        const repository = GitHubRepository.parse(parent.full_name);
        if (!parents.some((p) => same(p, repository))) parents.push(repository);
      }
      if (!parents.length) throw new Error("Fork base repository cannot be verified");
    }
    // Forks and mismatches need bounded enumeration, never an owner-equality shortcut.
    if (
      !metadata.fork &&
      raw &&
      this.matches(raw, identity) &&
      same(candidate!.repository, identity.headRepository)
    )
      return { raw, repository: candidate!.repository };
    const repos = [
      ...new Set([
        ...(candidate ? [candidate.repository] : []),
        ...identity.repositories,
        ...parents,
      ]),
    ];
    const found = new Map<string, { raw: any; repository: string }>();
    for (const repository of repos) {
      const rows = array(
        await this.json(
          [
            "pr",
            "list",
            "--repo",
            `github.com/${repository}`,
            "--head",
            identity.branch,
            "--state",
            "all",
            "--limit",
            "100",
            "--json",
            PR_FIELDS,
          ],
          identity.path,
          deadline,
        ),
      );
      if (rows.length >= 100) throw new Error("Ambiguous PR association: discovery limit reached");
      for (const item of rows) {
        const p = prIdentity(item.url);
        if (same(p.repository, repository) && this.matches(item, identity))
          found.set(p.url.toLowerCase(), { raw: item, repository: p.repository });
      }
    }
    if (found.size > 1) throw new Error("Ambiguous PR association: multiple verified matches");
    if (found.size === 0 && raw)
      throw new Error("Ambiguous PR association: returned head does not match checkout");
    return found.values().next().value ?? null;
  }

  private pullRequest(raw: any): GitHubPullRequest {
    const p = prIdentity(raw.url);
    const reviewDecision =
      raw.reviewDecision == null || raw.reviewDecision === "" ? null : raw.reviewDecision;
    return GitHubPullRequest.parse({
      number: raw.number,
      url: p.url,
      title: raw.title,
      state: raw.state,
      isDraft: raw.isDraft,
      headRefName: raw.headRefName,
      headRefOid: sha(raw.headRefOid),
      headRepository: this.head(raw),
      baseRefName: raw.baseRefName,
      mergeable: raw.mergeable,
      mergeStateStatus: raw.mergeStateStatus,
      reviewDecision,
      mergeQueueEnabled: false,
      inMergeQueue: false,
      autoMergeEnabled: false,
      squashMergeAllowed: false,
    });
  }
  private async reviews(snapshot: WorkspaceGitHub, path: string, deadline: number): Promise<void> {
    let cursor: string | undefined;
    const cursors = new Set<string>();
    const ids = new Set<string>();
    for (let page = 0; page < 5; page++) {
      const raw = await this.graphql(
        REVIEW_QUERY,
        snapshot.repository!,
        snapshot.pullRequest!.number,
        path,
        deadline,
        cursor,
      );
      const pr = object(raw.pullRequest);
      if (typeof pr.id !== "string" || !pr.id.trim())
        throw new Error("Missing verified GitHub PR node ID");
      if (snapshot.pullRequest!.nodeId && snapshot.pullRequest!.nodeId !== pr.id)
        throw new Error("GitHub PR node ID changed during discovery");
      snapshot.pullRequest!.nodeId = pr.id;
      for (const value of [raw.squashMergeAllowed, pr.isMergeQueueEnabled, pr.isInMergeQueue])
        if (typeof value !== "boolean") throw new Error("Incomplete GitHub merge settings");
      if (!("autoMergeRequest" in pr)) throw new Error("Incomplete GitHub auto-merge settings");
      Object.assign(snapshot.pullRequest!, {
        squashMergeAllowed: raw.squashMergeAllowed,
        mergeQueueEnabled: pr.isMergeQueueEnabled,
        inMergeQueue: pr.isInMergeQueue,
        autoMergeEnabled: pr.autoMergeRequest !== null,
      });
      const connection = object(pr.reviewThreads);
      const nodes = array(connection.nodes);
      if (nodes.length > 100) throw new Error("GitHub thread page exceeded limit");
      for (const t of nodes) {
        if (typeof t.isResolved !== "boolean") throw new Error("Incomplete review thread");
        if (t.isResolved) continue;
        if (ids.has(t.id)) throw new Error("Repeated review thread");
        ids.add(t.id);
        const comments = array(t.comments?.nodes);
        const normalized = comments.slice(0, 10).map((c) => {
          if (typeof c.body !== "string") throw new Error("Incomplete GitHub comment body");
          const body = Array.from(c.body);
          return {
            id: c.id,
            author: c.author?.login ?? null,
            body: body.slice(0, 8000).join(""),
            bodyTruncated: body.length > 8000,
            url: c.url,
            createdAt: instant(c.createdAt),
          };
        });
        const complete =
          comments.length <= 10 &&
          t.comments?.pageInfo?.hasNextPage === false &&
          normalized.every((c) => !c.bodyTruncated);
        const thread: GitHubThread = {
          id: t.id,
          isResolved: false,
          isOutdated: t.isOutdated,
          path: t.path ?? null,
          line: t.line ?? null,
          startLine: t.startLine ?? null,
          side: t.diffSide ?? null,
          comments: normalized,
          commentsComplete: complete,
        };
        snapshot.threads.push(thread);
        if (!complete) {
          snapshot.threadsComplete = false;
          snapshot.truncated = true;
        }
      }
      if (connection.pageInfo?.hasNextPage === false) return;
      const next = connection.pageInfo?.endCursor;
      if (typeof next !== "string" || !next || cursors.has(next))
        throw new Error("Invalid review pagination cursor");
      cursor = next;
      cursors.add(next);
    }
    snapshot.threadsComplete = false;
    snapshot.truncated = true;
  }
  private async checks(snapshot: WorkspaceGitHub, path: string, deadline: number): Promise<void> {
    const raw = array(
      await this.json(
        [
          "pr",
          "checks",
          String(snapshot.pullRequest!.number),
          "--repo",
          `github.com/${snapshot.repository}`,
          "--json",
          CHECK_FIELDS,
        ],
        path,
        deadline,
        true,
      ),
    );
    const ids = new Set<string>();
    for (const item of raw) {
      const link = displayUrl(item.link);
      const workflow = item.workflow ?? null,
        event = item.event ?? null;
      const id = createHash("sha256")
        .update(JSON.stringify([item.name, workflow, event, link]))
        .digest("hex");
      if (ids.has(id)) continue;
      ids.add(id);
      if (snapshot.checks.length === 500) {
        snapshot.checksComplete = false;
        snapshot.truncated = true;
        break;
      }
      snapshot.checks.push(
        GitHubCheck.parse({
          id,
          name: item.name,
          state: item.state,
          bucket: ["pass", "fail", "pending", "skipping", "cancel"].includes(item.bucket)
            ? item.bucket
            : "unknown",
          link,
          workflow,
          event,
          startedAt: instant(item.startedAt),
          completedAt: instant(item.completedAt),
          description: item.description ?? null,
          actionsJob: null,
        }),
      );
    }
  }
  private view(result: GitHubViewResult): GitHubViewResult {
    this.fit(result.snapshot);
    return GitHubViewResult.parse(result);
  }

  private fit(snapshot: WorkspaceGitHub): void {
    const checks = snapshot.checks,
      threads = snapshot.threads;
    snapshot.checks = [];
    snapshot.threads = [];
    // Reserve a few bytes for the false/true completeness changes below.
    const fits = () => Buffer.byteLength(JSON.stringify(snapshot)) <= SNAPSHOT_BYTES - 64;
    if (!fits()) throw new SwitchyardError("too_large", "GitHub snapshot metadata exceeds 512 KiB");
    for (const [items, target, flag] of [
      [checks, snapshot.checks, "checksComplete"],
      [threads, snapshot.threads, "threadsComplete"],
    ] as const) {
      for (const item of items) {
        (target as unknown[]).push(item);
        if (!fits()) {
          target.pop();
          snapshot[flag] = false;
          snapshot.truncated = true;
          break;
        }
      }
    }
  }

  /** Tool text is only a debounce hint. It is never association or mutation authority. */
  observeToolOutput(path: string, result: unknown): void {
    if (this.stopped || !result || typeof result !== "object") return;
    const r = result as { content?: unknown; structuredContent?: { output?: unknown } };
    let remaining = 128 * 1024;
    const pieces: string[] = [];
    const take = (value: string) => {
      // Slice before encoding: even an enormous tool result allocates only a bounded tail.
      const text = tailBytes(value.slice(-remaining), remaining);
      pieces.unshift(text);
      remaining -= Buffer.byteLength(text);
    };
    if (typeof r.structuredContent?.output === "string") take(r.structuredContent.output);
    if (Array.isArray(r.content))
      for (let i = r.content.length - 1; i >= 0 && remaining > 0; i--) {
        const part = r.content[i];
        if (part?.type === "text" && typeof part.text === "string") take(part.text);
      }
    const tail = pieces.join("");
    const urls = tail.match(/https:\/\/github\.com\/[^\s<>"'`]+/g) ?? [];
    if (
      !urls.some((url) => {
        const u = publicUrl(url);
        if (!u) return false;
        const m =
          /^\/([^/]+\/[^/]+)\/(?:pull\/(?:[1-9][0-9]*|new(?:\/.*)?)|compare(?:\/.*)?)$/.exec(
            u.pathname,
          );
        return !!m && GitHubRepository.safeParse(m[1]).success;
      })
    )
      return;
    void realpath(path)
      .then((p) => this.schedule(p))
      .catch(() => {});
  }
  private schedule(path: string): void {
    if (this.stopped) return;
    const entry = this.entry(path);
    if (entry.flight) {
      entry.trailing = true;
      return;
    }
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void this.refreshAt(path, false).catch(() => {});
    }, 500);
    entry.timer.unref();
  }

  private async verified(
    input: GitHubHostLogsRequest,
    deadline?: number,
  ): Promise<{ path: string; snapshot: WorkspaceGitHub }> {
    const path = await realpath(input.path);
    const { snapshot } = await this.freshAt(path, false, deadline);
    if (snapshot.status !== "ready") fail(snapshot.reason ?? "GitHub snapshot is unavailable");
    if (
      !same(snapshot.repository, input.repository) ||
      snapshot.pullRequest?.number !== input.number
    )
      fail("PR association changed. Refresh before continuing.");
    if (snapshot.pullRequest.headRefOid !== input.expectedHeadOid)
      fail("PR head changed. Refresh and review the new head.");
    if (
      !same(snapshot.headRepository, snapshot.pullRequest.headRepository) ||
      snapshot.branch !== snapshot.pullRequest.headRefName
    )
      fail("PR head repository or branch cannot be verified");
    return { path, snapshot };
  }

  async merge(raw: GitHubHostMergeRequest): Promise<GitHubMergeResult> {
    const input = GitHubHostMergeRequest.parse(raw);
    const canonical = await realpath(input.path);
    if (this.mutating.has(canonical)) fail("A merge is already in progress");
    if (this.isUnknown(canonical)) fail("Merge outcome unknown. Refresh before retrying.");
    if (this.stopped) throw new SwitchyardError("host_unreachable", "GitHub service stopped");
    this.mutating.add(canonical);
    this.mutationEpoch.set(canonical, (this.mutationEpoch.get(canonical) ?? 0) + 1);
    const work = this.mergeAt(input);
    this.operations.add(work);
    try {
      return await work;
    } finally {
      this.mutating.delete(canonical);
      this.operations.delete(work);
    }
  }

  private async mergeAt(input: GitHubHostMergeRequest): Promise<GitHubMergeResult> {
    // Leave room inside the 60-second host request for a state reread and process cleanup.
    const deadline = Date.now() + 50_000;
    const { path, snapshot: s } = await this.verified(input, Date.now() + 20_000);
    const pr = s.pullRequest!;
    if (!pr.nodeId || pr.nodeId !== input.expectedPullRequestNodeId)
      fail("PR identity changed or could not be verified. Refresh before continuing.");
    if (pr.mergeQueueEnabled || pr.inMergeQueue)
      fail("Merge queues are not supported by this action; merge on GitHub.");
    if (pr.autoMergeEnabled) fail("Auto-merge is enabled; merge on GitHub.");
    if (pr.state !== "OPEN") fail("PR is not open");
    if (pr.isDraft) fail("Draft PRs cannot be merged");
    if (pr.mergeable !== "MERGEABLE" || pr.mergeStateStatus !== "CLEAN")
      fail("PR is not clean and mergeable");
    if (pr.reviewDecision !== null && pr.reviewDecision !== "APPROVED")
      fail("Required reviews are not approved");
    if (!pr.squashMergeAllowed) fail("Squash merging is disabled");
    if (!s.checksComplete || !s.threadsComplete || s.truncated)
      fail("GitHub snapshot is incomplete");
    if (s.checks.some((c) => c.bucket !== "pass" && c.bucket !== "skipping"))
      fail("Checks are not all passing or skipped");
    const fields = {
      github: this.github,
      repository: input.repository,
      number: input.number,
      url: pr.url,
      expectedHeadOid: input.expectedHeadOid,
    };
    const attemptedAt = new Date().toISOString();
    this.markUnknown(path, true); // Persist BEFORE crossing the external mutation boundary.
    let merged: { commit: string | null } | undefined;
    let denied: Error | undefined;
    try {
      const r = await this.run(
        "gh",
        [
          "api",
          "--hostname",
          "github.com",
          "--method",
          "PUT",
          `repos/${input.repository}/pulls/${input.number}/merge`,
          "-f",
          `sha=${input.expectedHeadOid}`,
          "-f",
          "merge_method=squash",
        ],
        path,
        deadline - 10_000,
      );
      if (r.code === 0) {
        const response = object(JSON.parse(r.stdout));
        if (response.merged === true)
          merged = { commit: response.sha == null ? null : sha(response.sha) };
        else if (response.merged === false)
          denied = new Error(String(response.message || "GitHub refused the merge"));
      } else if (/HTTP (?:400|401|403|404|405|409|422)\b/.test(r.stderr))
        denied = new Error(r.stderr);
    } catch {
      /* A lost response is not a failed mutation; reconcile, never retry PUT. */
    }
    if (!merged && !denied) {
      try {
        const state = await this.graphql(
          MERGED_QUERY,
          input.repository,
          input.number,
          path,
          deadline,
        );
        if (
          state.pullRequest?.id === input.expectedPullRequestNodeId &&
          state.pullRequest.state === "MERGED" &&
          sha(state.pullRequest.headRefOid) === input.expectedHeadOid
        )
          merged = {
            commit:
              state.pullRequest.mergeCommit?.oid == null
                ? null
                : sha(state.pullRequest.mergeCommit.oid),
          };
      } catch {
        /* Remain uncertain. */
      }
    }
    if (merged || denied) this.markUnknown(path, false);
    // Refresh failures must never erase confirmed merge success.
    await this.refreshAt(path, false, deadline).catch(() => {});
    if (denied) fail(reason(denied));
    if (merged)
      return GitHubMergeResult.parse({
        status: "merged",
        ...fields,
        mergeCommitOid: merged.commit,
        confirmedAt: new Date().toISOString(),
      });
    return GitHubMergeResult.parse({
      status: "outcome_unknown",
      ...fields,
      attemptedAt,
      reason: "Merge outcome unknown. Refresh before retrying.",
    });
  }

  private actionLink(
    link: unknown,
    repository: string,
  ): { runId?: string; jobId?: string; checkRunId?: string; attempt?: number } | null {
    const u = publicUrl(link);
    if (!u) return null;
    const m =
      /^\/([^/]+\/[^/]+)\/(?:actions\/runs\/([1-9][0-9]{0,19})(?:\/attempts\/([1-9][0-9]*))?(?:\/job\/([1-9][0-9]{0,19}))?|runs\/([1-9][0-9]{0,19}))\/?$/.exec(
        u.pathname,
      );
    if (!m || !same(m[1], repository)) return null;
    return {
      runId: m[2],
      attempt: m[3] ? positive(Number(m[3])) : undefined,
      jobId: m[4],
      checkRunId: m[5],
    };
  }
  private async resolveJob(
    check: GitHubCheck,
    input: GitHubHostLogsRequest,
    path: string,
    deadline: number,
  ): Promise<{ runId: string; jobId: string; attempt: number; complete: boolean } | null> {
    let link = this.actionLink(check.link, input.repository);
    if (!link) return null;
    if (link.checkRunId) {
      const cr = object(
        await this.api(`repos/${input.repository}/check-runs/${link.checkRunId}`, path, deadline),
      );
      if (actionsId(cr.id) !== link.checkRunId || sha(cr.head_sha) !== input.expectedHeadOid)
        return null;
      link = this.actionLink(cr.details_url, input.repository);
      if (!link || link.checkRunId || !link.runId) return null;
    }
    if (!link.runId) return null;
    const runId = actionsId(link.runId);
    const run = object(
      await this.api(`repos/${input.repository}/actions/runs/${runId}`, path, deadline),
    );
    if (
      actionsId(run.id) !== runId ||
      sha(run.head_sha) !== input.expectedHeadOid ||
      !same(run.repository?.full_name, input.repository)
    )
      return null;
    const latestAttempt = positive(run.run_attempt);
    const requestedAttempt = link.attempt ?? (link.jobId ? undefined : latestAttempt);
    if (requestedAttempt !== undefined && requestedAttempt > latestAttempt) return null;
    let job: any;
    if (link.jobId)
      job = object(
        await this.api(`repos/${input.repository}/actions/jobs/${link.jobId}`, path, deadline),
      );
    else {
      const found: any[] = [];
      let complete = false;
      for (let page = 1; page <= 5; page++) {
        const result = object(
          await this.api(
            `repos/${input.repository}/actions/runs/${runId}/attempts/${requestedAttempt}/jobs?per_page=100&page=${page}`,
            path,
            deadline,
          ),
        );
        const jobs = array(result.jobs);
        if (jobs.length > 100) return null;
        for (const candidate of jobs) if (candidate.name === check.name) found.push(candidate);
        if (jobs.length < 100) {
          complete = true;
          break;
        }
      }
      if (!complete || found.length !== 1) return null;
      // Enumeration alone is not proof: verify the selected job's own endpoint too.
      job = object(
        await this.api(
          `repos/${input.repository}/actions/jobs/${actionsId(found[0].id)}`,
          path,
          deadline,
        ),
      );
    }
    const jobId = actionsId(job.id);
    const attempt = positive(job.run_attempt);
    if (
      (link.jobId && jobId !== link.jobId) ||
      actionsId(job.run_id) !== runId ||
      attempt > latestAttempt ||
      (requestedAttempt !== undefined && attempt !== requestedAttempt)
    )
      return null;
    return {
      runId,
      jobId,
      attempt,
      complete: job.status === "completed" && run.status === "completed",
    };
  }

  async failedLogs(raw: GitHubHostLogsRequest): Promise<GitHubLogs> {
    const input = GitHubHostLogsRequest.parse(raw);
    const work = this.logsAt(input);
    this.operations.add(work);
    try {
      return await work;
    } finally {
      this.operations.delete(work);
    }
  }

  private async logsAt(input: GitHubHostLogsRequest): Promise<GitHubLogs> {
    const deadline = Date.now() + 120_000;
    let path: string, snapshot: WorkspaceGitHub;
    try {
      ({ path, snapshot } = await this.verified(input, deadline));
    } catch (e) {
      if (
        e instanceof SwitchyardError &&
        e.code === "conflict" &&
        /head changed|association changed/.test(e.message)
      )
        throw e;
      return GitHubLogs.parse({
        github: this.github,
        repository: input.repository,
        number: input.number,
        headOid: input.expectedHeadOid,
        fetchedAt: new Date().toISOString(),
        status: this.github.available ? "error" : "unavailable",
        reason: reason(e),
        jobs: [],
        complete: false,
        truncated: false,
        omittedJobs: null,
      });
    }
    const failed = snapshot.checks.filter((c) => c.bucket === "fail" || c.bucket === "cancel");
    const omittedJobs = snapshot.checksComplete ? Math.max(0, failed.length - 10) : null;
    const jobs = await mapLimit(failed.slice(0, 10), 2, async (check): Promise<GitHubJobLog> => {
      const base: GitHubJobLog = {
        checkId: check.id,
        name: check.name,
        url: check.link,
        runId: null,
        jobId: null,
        attempt: null,
        status: "unmapped",
        outputTail: null,
        lineCount: 0,
        truncated: false,
        reason: "Check could not be uniquely mapped to a verified Actions job",
      };
      try {
        const mapping = await this.resolveJob(check, input, path, deadline);
        if (!mapping) return base;
        Object.assign(base, {
          runId: mapping.runId,
          jobId: mapping.jobId,
          attempt: mapping.attempt,
        });
        if (!mapping.complete)
          return { ...base, status: "incomplete", reason: "Actions job or run is not complete" };
        const r = await this.run(
          "gh",
          [
            "run",
            "view",
            "--repo",
            `github.com/${input.repository}`,
            "--job",
            mapping.jobId,
            "--log",
          ],
          path,
          deadline,
          true,
        );
        if (r.code !== 0) throw new Error(r.stderr || "Actions logs could not be retrieved");
        const bytesTail = tailBytes(r.stdout, 65536).replace(/\r\n/g, "\n");
        const lines = bytesTail ? bytesTail.split("\n") : [];
        if (lines[lines.length - 1] === "") lines.pop();
        const selected = lines.slice(-150);
        return {
          ...base,
          status: "available",
          reason: null,
          outputTail: selected.length
            ? selected.join("\n") + (bytesTail.endsWith("\n") ? "\n" : "")
            : "",
          lineCount: selected.length,
          truncated: !!r.truncated || Buffer.byteLength(r.stdout) > 65536 || lines.length > 150,
        };
      } catch (e) {
        const message = reason(e);
        const status = /timeout|timed out|deadline/i.test(message)
          ? "timeout"
          : /HTTP 403|forbidden|permission/i.test(message)
            ? "forbidden"
            : /HTTP 404|HTTP 410|expired|not found/i.test(message)
              ? "expired"
              : "error";
        return { ...base, status, reason: message };
      }
    });
    return GitHubLogs.parse({
      github: this.github,
      repository: input.repository,
      number: input.number,
      headOid: input.expectedHeadOid,
      fetchedAt: new Date().toISOString(),
      status: "ready",
      reason: null,
      jobs,
      complete:
        snapshot.checksComplete && omittedJobs === 0 && jobs.every((j) => j.status === "available"),
      truncated:
        snapshot.truncated ||
        omittedJobs === null ||
        omittedJobs > 0 ||
        jobs.some((j) => j.truncated),
      omittedJobs,
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const entry of this.entries.values()) {
      clearTimeout(entry.timer);
      entry.generation++;
    }
    const children = [...this.children];
    for (const child of children) signalGroup(child, "SIGTERM");
    if (children.length || this.kills.size)
      await new Promise((resolve) => setTimeout(resolve, 3000));
    for (const child of children) signalGroup(child, "SIGKILL");
    for (const timer of this.kills) clearTimeout(timer);
    this.kills.clear();
    // No late publication may touch the DB after shutdown.
    await Promise.allSettled([
      this.probing,
      ...this.resolving.values(),
      ...this.operations,
      ...[...this.entries.values()].map((entry) => entry.flight),
    ]);
  }
}
