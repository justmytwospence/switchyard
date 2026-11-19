import type { Host, TrackedIssue, Tracker } from "@switchyard/protocol";
import type { ApiClient } from "@switchyard/terminal";
import { CliError, type ConnectionFlags } from "../config.js";
import { type Ctx, connect, printList } from "../context.js";
import { resolveHost } from "./hosts.js";

export interface TrackerFlags extends ConnectionFlags {
  json?: boolean;
  name?: string;
  host?: string;
  owner?: string;
  repo?: string[];
  allRepos?: boolean;
  /** Repositories of other owners (`--also`). */
  also?: string[];
  /** commander's `--no-also`: true when given. */
  noAlso?: boolean;
  board?: string;
  /** commander's `--no-board`: false when given. */
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
  enable?: boolean;
  disable?: boolean;
}

export async function resolveTracker(api: ApiClient, ref: string): Promise<Tracker> {
  const trackers = await api.get<Tracker[]>("/api/trackers");
  const exact = trackers.find((t) => t.id === ref);
  if (exact) return exact;
  const named = trackers.filter((t) => t.name.toLowerCase() === ref.toLowerCase());
  if (named.length === 1) return named[0]!;
  const known = trackers.map((t) => t.name).join(", ") || "none";
  throw new CliError(`Unknown tracker "${ref}". Trackers: ${known}`);
}

function boardNumber(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new CliError("--board must be a project number");
  return n;
}

function followOf(flags: TrackerFlags): "assigned" | "board" | undefined {
  if (flags.follow === undefined) return undefined;
  if (flags.follow !== "assigned" && flags.follow !== "board")
    throw new CliError("--follow must be assigned or board");
  return flags.follow;
}

function boardFields(flags: TrackerFlags): {
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

export async function trackersList(ctx: Ctx, flags: TrackerFlags): Promise<void> {
  const { api } = connect(ctx, flags);
  const [trackers, hosts] = await Promise.all([
    api.get<Tracker[]>("/api/trackers"),
    api.get<Host[]>("/api/hosts"),
  ]);
  printList(
    ctx,
    flags.json,
    trackers,
    ["NAME", "HOST", "OWNER", "REPOS", "BOARD", "WRITE-BACK", "FOLLOWS", "LAST SYNC", "ERROR"],
    trackers.map((t) => [
      t.name,
      hosts.find((h) => h.id === t.hostId)?.name ?? t.hostId,
      t.owner,
      (t.repositories ? t.repositories.join(", ") : "any") +
        (t.extraRepositories?.length ? ` + ${t.extraRepositories.join(", ")}` : ""),
      t.board ? `#${t.board.projectNumber}` : "-",
      t.writeBack ? "on" : "off",
      t.follow === "board" && t.board ? "board" : "assigned",
      t.lastSyncedAt ?? "never",
      t.lastError ?? "-",
    ]),
    "No trackers.",
  );
}

export async function trackersCreate(ctx: Ctx, name: string, flags: TrackerFlags): Promise<void> {
  if (!flags.host) throw new CliError("--host is required");
  if (!flags.owner) throw new CliError("--owner is required");
  const fields = boardFields(flags);
  const follow = followOf(flags);
  if (follow === "board" && !flags.board) throw new CliError("--follow board needs --board");
  if (!flags.board && Object.keys(fields).length > 0)
    throw new CliError(
      "--status-field, --on-start, --on-review, --backlog and --priority-field need --board",
    );
  const { api } = connect(ctx, flags);
  const host = await resolveHost(api, flags.host);
  const t = await api.post<Tracker>("/api/trackers", {
    name,
    hostId: host.id,
    owner: flags.owner,
    ...(flags.repo?.length ? { repositories: flags.repo } : {}),
    ...(flags.also?.length ? { extraRepositories: flags.also } : {}),
    ...(flags.board ? { board: { projectNumber: boardNumber(flags.board), ...fields } } : {}),
    ...(follow ? { follow } : {}),
    ...(flags.writeBack ? { writeBack: true } : {}),
    ...(flags.moveShared === false ? { moveShared: false } : {}),
  });
  ctx.out(`Created tracker ${t.name} (${t.id})`);
}

export async function trackersEdit(ctx: Ctx, ref: string, flags: TrackerFlags): Promise<void> {
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
  const { api } = connect(ctx, flags);
  const t = await resolveTracker(api, ref);
  let board: Tracker["board"] | undefined;
  if (flags.noBoard) board = null;
  else if (flags.board || Object.keys(fields).length > 0) {
    if (!flags.board && !t.board) throw new CliError("This tracker has no board; pass --board");
    board = {
      ...(t.board ?? { statusField: "Status", onStart: null, onReview: null }),
      projectNumber: flags.board ? boardNumber(flags.board) : t.board!.projectNumber,
      ...fields,
    } as NonNullable<Tracker["board"]>;
  }
  const body = {
    ...(flags.name ? { name: flags.name } : {}),
    ...(flags.host ? { hostId: (await resolveHost(api, flags.host)).id } : {}),
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
    ...(flags.enable ? { enabled: true } : flags.disable ? { enabled: false } : {}),
  };
  await api.request<Tracker>("PATCH", `/api/trackers/${encodeURIComponent(t.id)}`, body);
  ctx.out(`Updated tracker ${flags.name ?? t.name}`);
}

export async function trackersDelete(ctx: Ctx, ref: string, flags: TrackerFlags): Promise<void> {
  const { api } = connect(ctx, flags);
  const t = await resolveTracker(api, ref);
  await api.request("DELETE", `/api/trackers/${encodeURIComponent(t.id)}`);
  ctx.out(`Deleted tracker ${t.name}`);
}

export async function trackersSync(ctx: Ctx, ref: string, flags: TrackerFlags): Promise<void> {
  const { api } = connect(ctx, flags);
  const t = await resolveTracker(api, ref);
  const synced = await api.post<Tracker>(`/api/trackers/${encodeURIComponent(t.id)}/sync`, {});
  const issues = (await api.get<TrackedIssue[]>("/api/issues")).filter((i) => i.trackerId === t.id);
  if (synced.lastError) ctx.err(`${synced.name}: ${synced.lastError}`);
  ctx.out(`Synced ${synced.name}: ${issues.length} ${issues.length === 1 ? "issue" : "issues"}`);
}
