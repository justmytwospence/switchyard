import type { BoardStatusOption, GitHubScope, Scope } from "@switchyard/protocol";
import { useMemo } from "react";
import { useNavigate } from "react-router";
import { BACK_STATE } from "../../app/useBackTo";
import { toast } from "../../components/ui/Toast";
import { useFilter } from "../../prefs";
import { errorMessage } from "../../sync/api";
import { useSyncStore } from "../../sync/store";
import { codeApi } from "../code/api";
import { useScopeDescriber } from "../scopes/ScopeSelect";
import { useSelectedScope } from "../scopes/selection";
import { openIssue, setIssueStatus } from "./api";
import {
  type BoardCard,
  type BoardColumn,
  type BoardMode,
  boardMode,
  buildBoardWithEmpty,
  canDrop,
  githubBoardOf,
} from "./model";

export interface WorkBoardPrefs {
  mode: BoardMode;
  query: string;
  /** Show worktrees with no session, issue or pull request. */
  empty?: boolean;
}

export interface WorkBoard {
  hydrated: boolean;
  scope: Scope | null;
  describe: (v: Scope) => string;
  clearScope: () => void;
  prefs: WorkBoardPrefs;
  setPrefs: (p: WorkBoardPrefs) => void;
  mode: BoardMode;
  githubBoard: { scope: GitHubScope; options: BoardStatusOption[] } | null;
  columns: BoardColumn[];
  /** Worktrees in the scope with no session, issue or pull request (hidden unless `prefs.empty`). */
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
  const { scopes, describe } = useScopeDescriber();
  const [scopeId, setScopeId] = useSelectedScope();
  const scope = (scopeId ? scopes[scopeId] : null) ?? null;
  const [stored, setPrefs] = useFilter<WorkBoardPrefs>("workboard", { mode: "stage", query: "" });
  const prefs = {
    // "tracker" is how 0.20 stored the board-columns mode.
    mode: boardMode(stored.mode),
    query: stored.query ?? "",
    empty: stored.empty ?? false,
  };
  const githubBoard = useMemo(() => githubBoardOf(scope, Object.values(issues)), [scope, issues]);
  const mode: BoardMode = prefs.mode === "github" && githubBoard ? "github" : "stage";
  const github = githubBoard?.scope ?? null;
  const { columns, empty: emptyCount } = useMemo(
    () =>
      buildBoardWithEmpty(
        { projects, workspaces, sessions, hosts, attention, interactions, issues },
        { scope, query: prefs.query, mode, github, showEmpty: prefs.empty },
      ),
    [
      projects,
      workspaces,
      sessions,
      hosts,
      attention,
      interactions,
      issues,
      scope,
      prefs.query,
      prefs.empty,
      mode,
      github,
    ],
  );
  const navigate = useNavigate();
  const go = (id: string) => navigate(`/code/${encodeURIComponent(id)}`, { state: BACK_STATE });

  const activate = async (card: BoardCard) => {
    try {
      if (card.sessionId) return go(card.sessionId);
      if (!card.branch && card.issue) return go((await openIssue(card.issue.id)).session.id);
      const b = card.branch;
      if (b?.projectId && b.branch) {
        const r = await codeApi.openBranch({
          projectId: b.projectId,
          branch: b.branch,
          ...(b.placements[0] ? { hostId: b.placements[0].hostId } : {}),
        });
        useSyncStore.getState().upsertSessionIfMissing(r.session);
        go(r.session.id);
      }
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const move = async (card: BoardCard, column: BoardColumn) => {
    if (!canDrop(card, column, mode, github).ok) return;
    try {
      if (mode === "stage") {
        if (card.issue) go((await openIssue(card.issue.id)).session.id);
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
    scope,
    describe,
    clearScope: () => setScopeId(null),
    prefs,
    setPrefs,
    mode,
    githubBoard,
    columns,
    emptyCount,
    total: columns.reduce((n, c) => n + c.cards.length, 0),
    canDrop: (card, column) => canDrop(card, column, mode, github),
    activate,
    move,
  };
}
