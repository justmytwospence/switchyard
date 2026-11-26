import type { Client, GitHubSource, Project, Scope, TrackedIssue } from "@switchyard/protocol";
import { findScope, openClients, sourceFollow } from "@switchyard/protocol";
import type { ApiClient } from "@switchyard/terminal";
import { CliError, type ConnectionFlags } from "../config.js";
import { type Ctx, connect, printList } from "../context.js";
import { listClients } from "./clients.js";
import { resolveHost } from "./hosts.js";
import { resolveProject } from "./work.js";

/** The GitHub source options of `scopes create` and `scopes edit`. */
export interface GitHubFlags {
  /** The host whose `gh` login reads the issues (`--github-host`). */
  githubHost?: string;
  owner?: string;
  repo?: string[];
  allRepos?: boolean;
  /** Repositories of other owners (`--also`). */
  also?: string[];
  /** commander's `--no-also`: true when given. */
  noAlso?: boolean;
  board?: string;
  /** commander's `--no-board`: true when given. */
  noBoard?: boolean;
  statusField?: string;
  onStart?: string;
  onReview?: string;
  follow?: string;
  /** The board's priority field (`--priority-field`). */
  priorityField?: string;
  /** commander's `--no-priority-field`: true when given. */
  noPriorityField?: boolean;
  /** Backlog columns (`--backlog`, repeatable). */
  backlog?: string[];
  /** commander's `--no-backlog`: true when given. */
  noBacklog?: boolean;
  writeBack?: boolean;
  moveShared?: boolean;
  worktrees?: boolean;
  enable?: boolean;
  disable?: boolean;
  /** `--no-github`: remove the source. */
  noGithub?: boolean;
}

export interface ScopeFlags extends ConnectionFlags, GitHubFlags {
  json?: boolean;
  mode?: "all" | "pinned";
  project?: string[];
  /** Host limit (`--host`, repeatable). */
  host?: string[];
  anyProject?: boolean;
  anyHost?: boolean;
  name?: string;
  /** List only scopes with a source (the old `trackers list`). */
  onlySources?: boolean;
}

const GITHUB_KEYS: (keyof GitHubFlags)[] = [
  "githubHost",
  "owner",
  "repo",
  "allRepos",
  "also",
  "noAlso",
  "board",
  "noBoard",
  "statusField",
  "onStart",
  "onReview",
  "follow",
  "priorityField",
  "noPriorityField",
  "backlog",
  "noBacklog",
  "writeBack",
  "moveShared",
  "worktrees",
  "enable",
  "disable",
];

/** Options that are only ever `true` when given. */
const SWITCHES = new Set<keyof GitHubFlags>([
  "allRepos",
  "noAlso",
  "noBoard",
  "noPriorityField",
  "noBacklog",
  "enable",
  "disable",
]);

/** Whether any GitHub source option was given. */
export function hasGitHubFlags(flags: GitHubFlags): boolean {
  return GITHUB_KEYS.some((k) => {
    const v = flags[k];
    if (Array.isArray(v)) return v.length > 0;
    return SWITCHES.has(k) ? v === true : v !== undefined;
  });
}

export async function resolveScope(api: ApiClient, ref: string): Promise<Scope> {
  const scopes = await api.get<Scope[]>("/api/scopes");
  const v = findScope(scopes, ref);
  if (v) return v;
  const known = scopes.map((x) => x.name).join(", ") || "none";
  throw new CliError(`Unknown scope "${ref}". Scopes: ${known}`);
}

function checkMode(mode: string | undefined): void {
  if (mode !== undefined && mode !== "all" && mode !== "pinned") {
    throw new CliError('--mode must be "all" or "pinned"');
  }
}

function boardNumber(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new CliError("--board must be a project number");
  return n;
}

function followOf(flags: GitHubFlags): "assigned" | "board" | undefined {
  if (flags.follow === undefined) return undefined;
  if (flags.follow !== "assigned" && flags.follow !== "board")
    throw new CliError("--follow must be assigned or board");
  return flags.follow;
}

function boardFields(flags: GitHubFlags): {
  statusField?: string;
  onStart?: string;
  onReview?: string;
  backlog?: string[];
  priorityField?: string | null;
} {
  return {
    ...(flags.noPriorityField
      ? { priorityField: null }
      : flags.priorityField
        ? { priorityField: flags.priorityField }
        : {}),
    ...(flags.noBacklog
      ? { backlog: [] }
      : flags.backlog?.length
        ? { backlog: flags.backlog }
        : {}),
    ...(flags.statusField ? { statusField: flags.statusField } : {}),
    ...(flags.onStart ? { onStart: flags.onStart } : {}),
    ...(flags.onReview ? { onReview: flags.onReview } : {}),
  };
}

/** What feeds a scope, for a table. */
export function sourceText(source: GitHubSource | null): string {
  if (!source) return "-";
  return (
    `GitHub ${source.owner}` +
    (source.board ? ` board #${source.board.projectNumber}` : "") +
    (sourceFollow(source) === "board" ? " (whole board)" : "") +
    (source.enabled ? "" : " (paused)")
  );
}

export async function scopesList(ctx: Ctx, flags: ScopeFlags): Promise<void> {
  const { api } = connect(ctx, flags);
  const [all, projects, clients] = await Promise.all([
    api.get<Scope[]>("/api/scopes"),
    api.get<Project[]>("/api/projects"),
    listClients(api).catch(() => [] as Client[]),
  ]);
  const scopes = flags.onlySources ? all.filter((s) => s.source) : all;
  const names = (ids: string[] | null, known: { id: string; name: string }[]) =>
    ids === null
      ? "any"
      : ids.map((i) => known.find((x) => x.id === i)?.name ?? i).join(", ") || "-";
  printList(
    ctx,
    flags.json,
    scopes,
    ["NAME", "SOURCE", "MODE", "PROJECTS", "PINNED", "MIRRORED IN", "LAST SYNC", "ERROR"],
    scopes.map((v) => [
      v.name,
      sourceText(v.source),
      v.mode,
      names(v.projectIds, projects),
      String(v.sessionIds.length),
      openClients(clients, v.id)
        .map((c) => `${c.kind} ${c.name} (${c.machine})`)
        .join(", ") || "-",
      v.source ? (v.source.lastSyncedAt ?? "never") : "-",
      v.source?.lastError ?? "-",
    ]),
    "No scopes.",
  );
}

async function ids(api: ApiClient, refs: string[] | undefined, kind: "project" | "host") {
  if (!refs || refs.length === 0) return undefined;
  const out: string[] = [];
  for (const r of refs) {
    out.push((kind === "project" ? await resolveProject(api, r) : await resolveHost(api, r)).id);
  }
  return out;
}

/** The source to create from the flags (`--owner` and `--github-host` are required). */
async function newSource(api: ApiClient, flags: GitHubFlags): Promise<Record<string, unknown>> {
  if (!flags.owner) throw new CliError("GitHub options need --owner");
  if (!flags.githubHost) throw new CliError("--github-host is required with --owner");
  const fields = boardFields(flags);
  const follow = followOf(flags);
  if (follow === "board" && !flags.board) throw new CliError("--follow board needs --board");
  if (!flags.board && Object.keys(fields).length > 0)
    throw new CliError(
      "--status-field, --on-start, --on-review, --backlog and --priority-field need --board",
    );
  const host = await resolveHost(api, flags.githubHost);
  return {
    hostId: host.id,
    owner: flags.owner,
    ...(flags.repo?.length ? { repositories: flags.repo } : {}),
    ...(flags.also?.length ? { extraRepositories: flags.also } : {}),
    ...(flags.board ? { board: { projectNumber: boardNumber(flags.board), ...fields } } : {}),
    ...(follow ? { follow } : {}),
    ...(flags.writeBack ? { writeBack: true } : {}),
    ...(flags.moveShared === false ? { moveShared: false } : {}),
    ...(flags.worktrees === false ? { worktrees: false } : {}),
    ...(flags.disable ? { enabled: false } : {}),
  };
}

/** The changes to an existing source from the flags. */
async function sourcePatch(
  api: ApiClient,
  t: GitHubSource,
  flags: GitHubFlags,
): Promise<Record<string, unknown>> {
  if (flags.noBacklog && flags.backlog?.length)
    throw new CliError("--no-backlog cannot be combined with --backlog");
  const fields = boardFields(flags);
  const follow = followOf(flags);
  if (flags.noBoard && (flags.board || Object.keys(fields).length > 0))
    throw new CliError("--no-board cannot be combined with other board options");
  if (flags.allRepos && flags.repo?.length)
    throw new CliError("--all-repos cannot be combined with --repo");
  if (flags.enable && flags.disable) throw new CliError("--enable and --disable conflict");
  if (flags.noAlso && flags.also?.length)
    throw new CliError("--no-also cannot be combined with --also");
  let board: GitHubSource["board"] | undefined;
  if (flags.noBoard) board = null;
  else if (flags.board || Object.keys(fields).length > 0) {
    if (!flags.board && !t.board) throw new CliError("This scope has no board; pass --board");
    board = {
      ...(t.board ?? { statusField: "Status", onStart: null, onReview: null }),
      projectNumber: flags.board ? boardNumber(flags.board) : t.board!.projectNumber,
      ...fields,
    } as NonNullable<GitHubSource["board"]>;
  }
  return {
    ...(flags.githubHost ? { hostId: (await resolveHost(api, flags.githubHost)).id } : {}),
    ...(flags.owner ? { owner: flags.owner } : {}),
    ...(flags.allRepos
      ? { repositories: null }
      : flags.repo?.length
        ? { repositories: flags.repo }
        : {}),
    ...(flags.noAlso
      ? { extraRepositories: [] }
      : flags.also?.length
        ? { extraRepositories: flags.also }
        : {}),
    ...(board !== undefined ? { board } : {}),
    ...(flags.noBoard ? { follow: "assigned" } : follow ? { follow } : {}),
    ...(flags.writeBack !== undefined ? { writeBack: flags.writeBack } : {}),
    ...(flags.moveShared !== undefined ? { moveShared: flags.moveShared } : {}),
    ...(flags.worktrees !== undefined ? { worktrees: flags.worktrees } : {}),
    ...(flags.enable ? { enabled: true } : flags.disable ? { enabled: false } : {}),
  };
}

export async function scopesCreate(ctx: Ctx, name: string, flags: ScopeFlags): Promise<void> {
  checkMode(flags.mode);
  const github = hasGitHubFlags(flags);
  if (github && flags.owner && flags.project?.length)
    throw new CliError(
      "--project cannot be combined with --owner: GitHub keeps the scope's projects",
    );
  const { api } = connect(ctx, flags);
  const source = github ? await newSource(api, flags) : undefined;
  const projectIds = await ids(api, flags.project, "project");
  const hostIds = await ids(api, flags.host, "host");
  const v = await api.post<Scope>("/api/scopes", {
    name,
    ...(flags.mode ? { mode: flags.mode } : {}),
    ...(projectIds ? { projectIds } : {}),
    ...(hostIds ? { hostIds } : {}),
    ...(source ? { source } : {}),
  });
  ctx.out(`Created scope ${v.name} (${v.id})`);
}

export async function scopesEdit(ctx: Ctx, ref: string, flags: ScopeFlags): Promise<void> {
  checkMode(flags.mode);
  const github = hasGitHubFlags(flags);
  if (flags.noGithub && github)
    throw new CliError("--no-github cannot be combined with GitHub options");
  const { api } = connect(ctx, flags);
  const v = await resolveScope(api, ref);
  const source = flags.noGithub
    ? null
    : !github
      ? undefined
      : v.source
        ? await sourcePatch(api, v.source, flags)
        : await newSource(api, flags);
  const projectIds = flags.anyProject ? null : await ids(api, flags.project, "project");
  const hostIds = flags.anyHost ? null : await ids(api, flags.host, "host");
  const body = {
    ...(flags.name ? { name: flags.name } : {}),
    ...(flags.mode ? { mode: flags.mode } : {}),
    ...(projectIds !== undefined ? { projectIds } : {}),
    ...(hostIds !== undefined ? { hostIds } : {}),
    ...(source !== undefined ? { source } : {}),
  };
  await api.request<Scope>("PATCH", `/api/scopes/${encodeURIComponent(v.id)}`, body);
  ctx.out(`Updated scope ${flags.name ?? v.name}`);
}

export async function scopesDelete(ctx: Ctx, ref: string, flags: ScopeFlags): Promise<void> {
  const { api } = connect(ctx, flags);
  const v = await resolveScope(api, ref);
  await api.request("DELETE", `/api/scopes/${encodeURIComponent(v.id)}`);
  ctx.out(`Deleted scope ${v.name}`);
}

/** The old `trackers delete`: remove the scope's GitHub source and keep the scope. */
export async function scopesRemoveSource(ctx: Ctx, ref: string, flags: ScopeFlags): Promise<void> {
  const { api } = connect(ctx, flags);
  const v = await resolveScope(api, ref);
  await api.request<Scope>("PATCH", `/api/scopes/${encodeURIComponent(v.id)}`, { source: null });
  ctx.out(
    `Removed the GitHub source of scope ${v.name}; "switchyard scopes delete" deletes the scope`,
  );
}

export async function scopesPin(
  ctx: Ctx,
  ref: string,
  sessionId: string,
  flags: ScopeFlags,
  unpin = false,
): Promise<void> {
  const { api } = connect(ctx, flags);
  const v = await resolveScope(api, ref);
  const path = `/api/scopes/${encodeURIComponent(v.id)}/sessions/${encodeURIComponent(sessionId)}`;
  await api.request(unpin ? "DELETE" : "POST", path);
  ctx.out(`${unpin ? "Unpinned" : "Pinned"} ${sessionId} ${unpin ? "from" : "in"} ${v.name}`);
}

export async function scopesSync(ctx: Ctx, ref: string, flags: ScopeFlags): Promise<void> {
  const { api } = connect(ctx, flags);
  const v = await resolveScope(api, ref);
  const synced = await api.post<Scope>(`/api/scopes/${encodeURIComponent(v.id)}/sync`, {});
  const issues = (await api.get<TrackedIssue[]>("/api/issues")).filter((i) => i.scopeId === v.id);
  if (synced.source?.lastError) ctx.err(`${synced.name}: ${synced.source.lastError}`);
  ctx.out(`Synced ${synced.name}: ${issues.length} ${issues.length === 1 ? "issue" : "issues"}`);
}
