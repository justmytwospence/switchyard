import {
  type BoardStatusOption,
  BRANCH_STAGES,
  type Branch,
  branchInScope,
  buildBranches,
  compareIssues,
  type GitHubScope,
  issueBranchSet,
  issueInScope,
  type Scope,
  sessionScopeReason,
  sourceBacklog,
  type TrackedIssue,
} from "@switchyard/protocol";
import { sessionsNeedingAttention } from "../../sync/selectors";
import { type NavInput, type StatusBucket, statusBucket } from "../code/model";

/**
 * The Board: branches as cards in columns, by stage (from facts: branch, pull request) or, for a
 * GitHub scope with a Projects board, by that board's columns. Pure; tested without a DOM.
 */

export type BoardMode = "stage" | "github";

/** The board mode a browser stored; "tracker" is how 0.20 stored "github". */
export function boardMode(stored: string | undefined): BoardMode {
  return stored === "github" || stored === "tracker" ? "github" : "stage";
}

export interface BoardCard {
  /** The branch key, or `i:<issue id>` for an issue no branch has yet. */
  key: string;
  branch: Branch | null;
  issue: TrackedIssue | null;
  title: string;
  project: string;
  /** Null for a main checkout. */
  branchLabel: string | null;
  /** Only when the project has checkouts on more than one host. */
  host: string | null;
  sessionId: string | null;
  bucket: StatusBucket | null;
  attention: boolean;
  extraCount: number;
  lastActivityAt: string;
  /** In the selected GitHub scope only while a session is live. */
  leaves: boolean;
}

export interface BoardColumn {
  id: string;
  label: string;
  cards: BoardCard[];
}

export interface BoardInput extends NavInput {
  issues: Record<string, TrackedIssue>;
}

export const NOT_STARTED = "not_started";
export const NO_STATUS = "none";
export const OFF_BOARD = "off";

/** The Projects board a scope can show, when it is a GitHub scope and its issues have a board. */
export function githubBoardOf(
  scope: Scope | null,
  issues: TrackedIssue[],
): { scope: GitHubScope; options: BoardStatusOption[] } | null {
  if (!scope?.source?.board) return null;
  const withBoard = issues.find((i) => i.scopeId === scope.id && i.board);
  if (!withBoard?.board) return null;
  return { scope: scope as GitHubScope, options: withBoard.board.options };
}

function issueCard(i: TrackedIssue, input: BoardInput): BoardCard {
  return {
    key: `i:${i.id}`,
    branch: null,
    issue: i,
    title: i.title,
    project: input.projects[i.projectId]?.name ?? i.repository,
    branchLabel: null,
    host: null,
    sessionId: null,
    bucket: null,
    attention: false,
    extraCount: 0,
    lastActivityAt: i.updatedAt,
    leaves: false,
  };
}

function branchCard(b: Branch, input: BoardInput, attn: Set<string>, leaves: boolean): BoardCard {
  const projectId = b.projectId;
  const hostsOfProject = new Set(
    Object.values(input.workspaces)
      .filter((w) => w.projectId === projectId && !w.archivedAt)
      .map((w) => w.hostId),
  );
  const first = b.placements[0];
  const attention = [b.primary, ...b.extras].some((s) => !!s && attn.has(s.id));
  return {
    key: b.key,
    branch: b,
    issue: b.issue,
    title: b.primary?.title ?? b.issue?.title ?? b.branch ?? "Detached worktree",
    project: (projectId && input.projects[projectId]?.name) || "Other sessions",
    branchLabel: b.main ? null : b.branch,
    host:
      hostsOfProject.size > 1 && first ? (input.hosts[first.hostId]?.name ?? "Unknown host") : null,
    sessionId: b.primary?.id ?? null,
    bucket: b.primary ? statusBucket(b.primary, attn.has(b.primary.id)) : null,
    attention,
    extraCount: b.extras.length,
    lastActivityAt: b.lastActivityAt,
    leaves,
  };
}

function matches(card: BoardCard, q: string): boolean {
  if (!q) return true;
  return [
    card.title,
    card.branchLabel ?? "",
    card.branch?.branch ?? "",
    card.project,
    card.issue ? `#${card.issue.number}` : "",
    card.issue?.board?.priority?.name ?? "",
  ]
    .join("\n")
    .toLowerCase()
    .includes(q);
}

const order = (a: BoardCard, b: BoardCard) =>
  Number(b.attention) - Number(a.attention) ||
  Number(!!b.branch) - Number(!!a.branch) ||
  (!a.branch && a.issue && b.issue
    ? compareIssues(a.issue, b.issue)
    : b.lastActivityAt.localeCompare(a.lastActivityAt));

export interface BoardOptions {
  scope: Scope | null;
  query: string;
  mode: BoardMode;
  /** The GitHub scope whose board columns to show (mode "github"). */
  github: GitHubScope | null;
  /** Show worktrees nobody is working in (no session, issue or pull request). Default true. */
  showEmpty?: boolean;
}

/** A worktree with no work to show: no session, no issue and no pull request. */
export function isEmptyWorktree(b: Branch): boolean {
  return !b.primary && b.extras.length === 0 && !b.issue && !b.pullRequest;
}

/** The board's columns for a scope, a search and a mode. */
export function buildBoard(input: BoardInput, opts: BoardOptions): BoardColumn[] {
  return buildBoardWithEmpty(input, opts).columns;
}

/** The board's columns, and how many empty worktrees the scope has (shown or not). */
export function buildBoardWithEmpty(
  input: BoardInput,
  opts: BoardOptions,
): { columns: BoardColumn[]; empty: number } {
  let empty = 0;
  const columns = columnsOf(input, opts, () => {
    empty++;
  });
  return { columns, empty };
}

function columnsOf(input: BoardInput, opts: BoardOptions, onEmpty: () => void): BoardColumn[] {
  const q = opts.query.trim().toLowerCase();
  const attn = sessionsNeedingAttention(input.attention, input.interactions);
  const { branches, unstarted } = buildBranches({
    workspaces: Object.values(input.workspaces),
    sessions: Object.values(input.sessions),
    issues: Object.values(input.issues),
  });
  const issueSet = opts.scope ? issueBranchSet(opts.scope, Object.values(input.issues)) : null;
  const cards: BoardCard[] = [];
  for (const b of branches) {
    if (!b.primary && (b.main || b.kind === "scratch")) continue;
    const scope = opts.scope;
    if (scope && !branchInScope(scope, b, input.workspaces, issueSet)) continue;
    if (isEmptyWorktree(b)) {
      onEmpty();
      if (opts.showEmpty === false) continue;
    }
    const leaves =
      !!scope &&
      !!issueSet &&
      b.issue?.scopeId !== issueSet.scopeId &&
      ![b.primary, ...b.extras].some((s) => {
        if (!s) return false;
        const r = sessionScopeReason(scope, s, input.workspaces, issueSet);
        return r !== null && r !== "live";
      });
    cards.push(branchCard(b, input, attn, leaves));
  }
  const issueCards = unstarted
    .filter((i) => !opts.scope || issueInScope(opts.scope, i))
    .map((i) => issueCard(i, input));
  const all = [...issueCards, ...cards].filter((c) => matches(c, q));

  if (opts.mode === "github" && opts.github) {
    const options =
      Object.values(input.issues).find((i) => i.scopeId === opts.github!.id && i.board)?.board
        ?.options ?? [];
    const mine = (c: BoardCard) => c.issue?.scopeId === opts.github!.id;
    const backlog = sourceBacklog(opts.github.source).map((b) => b.toLowerCase());
    const columns: BoardColumn[] = options
      .map((o) => ({
        id: o.id,
        label: o.name,
        cards: all.filter((c) => mine(c) && c.issue?.board?.statusOptionId === o.id).sort(order),
      }))
      .filter((c) => c.cards.length > 0 || !backlog.includes(c.label.toLowerCase()));
    const known = new Set(options.map((o) => o.id));
    columns.push({
      id: NO_STATUS,
      label: "No status",
      cards: all
        .filter(
          (c) =>
            mine(c) &&
            (!c.issue?.board?.statusOptionId || !known.has(c.issue.board.statusOptionId)),
        )
        .sort(order),
    });
    columns.push({
      id: OFF_BOARD,
      label: "Not on the board",
      cards: all.filter((c) => c.branch && !mine(c)).sort(order),
    });
    return columns;
  }

  return BRANCH_STAGES.map((s) => ({
    id: s.value,
    label: s.label,
    cards: all
      .filter((c) => (s.value === NOT_STARTED ? !c.branch : c.branch?.stage === s.value))
      .sort(order),
  }));
}

/** Whether a card may be dropped on a column, and why not. */
export function canDrop(
  card: BoardCard,
  column: BoardColumn,
  mode: BoardMode,
  github: GitHubScope | null,
): { ok: true } | { ok: false; reason: string } {
  if (mode === "stage") {
    if (!card.branch && column.id === "working") return { ok: true };
    return { ok: false, reason: "Moves when the branch or its pull request changes" };
  }
  if (!github?.source.writeBack) return { ok: false, reason: "Write-back is off for this scope" };
  if (!card.issue?.board || card.issue.scopeId !== github.id)
    return { ok: false, reason: "This branch has no issue on the board" };
  if (column.id === NO_STATUS || column.id === OFF_BOARD)
    return { ok: false, reason: "Pick a board column" };
  return { ok: true };
}
