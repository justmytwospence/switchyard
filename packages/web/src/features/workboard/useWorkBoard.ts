import type { Tracker, TrackerStatusOption, View } from "@switchyard/protocol";
import { useMemo } from "react";
import { useNavigate } from "react-router";
import { BACK_STATE } from "../../app/useBackTo";
import { toast } from "../../components/ui/Toast";
import { useFilter } from "../../prefs";
import { errorMessage } from "../../sync/api";
import { useSyncStore } from "../../sync/store";
import { useTrackers } from "../../sync/trackers";
import { codeApi } from "../code/api";
import { useSelectedView } from "../views/selection";
import { useViewDescriber } from "../views/ViewSelect";
import { openIssue, setIssueStatus } from "./api";
import {
  type BoardCard,
  type BoardColumn,
  type BoardMode,
  buildBoardWithEmpty,
  canDrop,
  trackerBoardOf,
} from "./model";

export interface WorkBoardPrefs {
  mode: BoardMode;
  query: string;
  /** Show worktrees with no session, issue or pull request. */
  empty?: boolean;
}

export interface WorkBoard {
  hydrated: boolean;
  view: View | null;
  describe: (v: View) => string;
  clearView: () => void;
  prefs: WorkBoardPrefs;
  setPrefs: (p: WorkBoardPrefs) => void;
  mode: BoardMode;
  trackerBoard: { tracker: Tracker; options: TrackerStatusOption[] } | null;
  columns: BoardColumn[];
  /** Worktrees in the view with no session, issue or pull request (hidden unless `prefs.empty`). */
  emptyCount: number;
  total: number;
  canDrop: (card: BoardCard, column: BoardColumn) => { ok: true } | { ok: false; reason: string };
  /** Open a card: its session, or start its branch or issue. */
  activate: (card: BoardCard) => Promise<void>;
  /** Move a card to a column (start an issue, or set its board column). */
  move: (card: BoardCard, column: BoardColumn) => Promise<void>;
}

/** Shared state of the Board (desktop and mobile). */
export function useWorkBoard(): WorkBoard {
  const hydrated = useSyncStore((s) => s.hydrated);
  const projects = useSyncStore((s) => s.projects);
  const workspaces = useSyncStore((s) => s.workspaces);
  const sessions = useSyncStore((s) => s.sessions);
  const hosts = useSyncStore((s) => s.hosts);
  const attention = useSyncStore((s) => s.attention);
  const interactions = useSyncStore((s) => s.interactions);
  const issues = useSyncStore((s) => s.issues);
  const { views, describe } = useViewDescriber();
  const [viewId, setViewId] = useSelectedView();
  const view = (viewId ? views[viewId] : null) ?? null;
  const { trackers } = useTrackers();
  const [stored, setPrefs] = useFilter<WorkBoardPrefs>("workboard", { mode: "stage", query: "" });
  const prefs = {
    mode: stored.mode ?? "stage",
    query: stored.query ?? "",
    empty: stored.empty ?? false,
  };
  const trackerBoard = useMemo(
    () => trackerBoardOf(view, trackers ?? [], Object.values(issues)),
    [view, trackers, issues],
  );
  const mode: BoardMode = prefs.mode === "tracker" && trackerBoard ? "tracker" : "stage";
  const tracker = trackerBoard?.tracker ?? null;
  const { columns, empty: emptyCount } = useMemo(
    () =>
      buildBoardWithEmpty(
        { projects, workspaces, sessions, hosts, attention, interactions, issues },
        { view, query: prefs.query, mode, tracker, showEmpty: prefs.empty },
      ),
    [
      projects,
      workspaces,
      sessions,
      hosts,
      attention,
      interactions,
      issues,
      view,
      prefs.query,
      prefs.empty,
      mode,
      tracker,
    ],
  );
  const navigate = useNavigate();
  const go = (id: string) => navigate(`/code/${encodeURIComponent(id)}`, { state: BACK_STATE });
  const viewArg = view ? { viewId: view.id } : {};

  const activate = async (card: BoardCard) => {
    try {
      if (card.sessionId) return go(card.sessionId);
      if (!card.branch && card.issue)
        return go((await openIssue(card.issue.id, viewArg)).session.id);
      const b = card.branch;
      if (b?.projectId && b.branch) {
        const r = await codeApi.openBranch({
          projectId: b.projectId,
          branch: b.branch,
          ...(b.placements[0] ? { hostId: b.placements[0].hostId } : {}),
          ...viewArg,
        });
        useSyncStore.getState().upsertSessionIfMissing(r.session);
        go(r.session.id);
      }
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const move = async (card: BoardCard, column: BoardColumn) => {
    if (!canDrop(card, column, mode, tracker).ok) return;
    try {
      if (mode === "stage") {
        if (card.issue) go((await openIssue(card.issue.id, viewArg)).session.id);
        return;
      }
      if (card.issue && card.issue.board?.statusOptionId !== column.id) {
        await setIssueStatus(card.issue.id, column.label);
      }
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return {
    hydrated,
    view,
    describe,
    clearView: () => setViewId(null),
    prefs,
    setPrefs,
    mode,
    trackerBoard,
    columns,
    emptyCount,
    total: columns.reduce((n, c) => n + c.cards.length, 0),
    canDrop: (card, column) => canDrop(card, column, mode, tracker),
    activate,
    move,
  };
}
