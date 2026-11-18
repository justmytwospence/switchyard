import {
  BRANCH_STAGES,
  type Branch,
  branchInView,
  buildBranches,
  issueInView,
  type TrackedIssue,
  type Tracker,
  type TrackerStatusOption,
  type View,
} from "@switchyard/protocol";
import { sessionsNeedingAttention } from "../../sync/selectors";
import { type NavInput, type StatusBucket, statusBucket } from "../code/model";

/**
 * The Board: branches as cards in columns, by stage (from facts: branch, pull request) or, for a
 * tracker's view with a GitHub Projects board, by that board's columns. Pure; tested without a DOM.
 */

export type BoardMode = "stage" | "tracker";

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

/** The tracker board a view can show, when it is a tracker's view and its issues have a board. */
export function trackerBoardOf(
  view: View | null,
  trackers: Tracker[],
  issues: TrackedIssue[],
): { tracker: Tracker; options: TrackerStatusOption[] } | null {
  if (!view?.trackerId) return null;
  const tracker = trackers.find((t) => t.id === view.trackerId);
  if (!tracker?.board) return null;
  const withBoard = issues.find((i) => i.trackerId === tracker.id && i.board);
  if (!withBoard?.board) return null;
  return { tracker, options: withBoard.board.options };
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
  };
}

function branchCard(b: Branch, input: BoardInput, attn: Set<string>): BoardCard {
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
  ]
    .join("\n")
    .toLowerCase()
    .includes(q);
}

const order = (a: BoardCard, b: BoardCard) =>
  Number(b.attention) - Number(a.attention) || b.lastActivityAt.localeCompare(a.lastActivityAt);

/** The board's columns for a view, a search and a mode. */
export function buildBoard(
  input: BoardInput,
  opts: { view: View | null; query: string; mode: BoardMode; tracker: Tracker | null },
): BoardColumn[] {
  const q = opts.query.trim().toLowerCase();
  const attn = sessionsNeedingAttention(input.attention, input.interactions);
  const { branches, unstarted } = buildBranches({
    workspaces: Object.values(input.workspaces),
    sessions: Object.values(input.sessions),
    issues: Object.values(input.issues),
  });
  const cards: BoardCard[] = [];
  for (const b of branches) {
    if (!b.primary && (b.main || b.kind === "scratch")) continue;
    if (opts.view && !branchInView(opts.view, b, input.workspaces)) continue;
    cards.push(branchCard(b, input, attn));
  }
  const issueCards = unstarted
    .filter((i) => !opts.view || issueInView(opts.view, i))
    .map((i) => issueCard(i, input));
  const all = [...issueCards, ...cards].filter((c) => matches(c, q));

  if (opts.mode === "tracker" && opts.tracker) {
    const options =
      Object.values(input.issues).find((i) => i.trackerId === opts.tracker!.id && i.board)?.board
        ?.options ?? [];
    const mine = (c: BoardCard) => c.issue?.trackerId === opts.tracker!.id;
    const columns: BoardColumn[] = options.map((o) => ({
      id: o.id,
      label: o.name,
      cards: all.filter((c) => mine(c) && c.issue?.board?.statusOptionId === o.id).sort(order),
    }));
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
  tracker: Tracker | null,
): { ok: true } | { ok: false; reason: string } {
  if (mode === "stage") {
    if (!card.branch && column.id === "working") return { ok: true };
    return { ok: false, reason: "Moves when the branch or its pull request changes" };
  }
  if (!tracker?.writeBack) return { ok: false, reason: "Write-back is off for this tracker" };
  if (!card.issue?.board || card.issue.trackerId !== tracker.id)
    return { ok: false, reason: "This branch has no issue on the board" };
  if (column.id === NO_STATUS || column.id === OFF_BOARD)
    return { ok: false, reason: "Pick a board column" };
  return { ok: true };
}
