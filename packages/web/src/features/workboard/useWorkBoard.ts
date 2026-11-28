import type { BoardStatusOption, GitHubScope, Scope } from "@switchyard/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { BACK_STATE } from "../../app/useBackTo";
import { toast } from "../../components/ui/Toast";
import { useFilter } from "../../prefs";
import { errorMessage, isApiError } from "../../sync/api";
import { useSyncStore } from "../../sync/store";
import { codeApi } from "../code/api";
import { issueAction } from "../discovery/issueAction";
import { discoveryContext, discoveryProjects, type IssueInventoryItem } from "../discovery/model";
import {
  type IssueInventory,
  rememberIssueSession,
  useIssueInventory,
} from "../discovery/useIssueInventory";
import { useScopeDescriber } from "../scopes/ScopeSelect";
import { currentScopeId, useSelectedScope } from "../scopes/selection";
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
  layout?: "columns" | "issues";
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
  projects: ReturnType<typeof useSyncStore.getState>["projects"];
  projectId: string | null;
  setProjectId: (id: string | null) => void;
  subset: "notStarted" | "all";
  setSubset: (subset: "notStarted" | "all") => void;
  sort: "number" | "priority";
  setSort: (sort: "number" | "priority") => void;
  inventory: IssueInventory;
  selectedId: string | null;
  selectedItem: IssueInventoryItem | null;
  inspect: (id: string | null) => void;
  action: (id: string) => Promise<void>;
  pending: boolean;
  actionError: string | null;
  actionDetail: (item: IssueInventoryItem) => string;
  actionProblem: (item: IssueInventoryItem) => string | null;
  cardActionDetail: (id: string) => string;
  cardActionProblem: (id: string) => string | null;
  canDrop: (card: BoardCard, column: BoardColumn) => { ok: true } | { ok: false; reason: string };
  /** Open a card: its session, or start its branch or issue. */
  activate: (card: BoardCard) => Promise<void>;
  /** Move a card to a source board column. */
  move: (card: BoardCard, column: BoardColumn) => Promise<void>;
}

/** Shared state of the Board (desktop and mobile). */
export function useWorkBoard(): WorkBoard {
  const hydrated = useSyncStore((s) => s.hydrated);
  const projects = useSyncStore((s) => s.projects);
  const workspaces = useSyncStore((s) => s.workspaces);
  const sessions = useSyncStore((s) => s.sessions);
  const hosts = useSyncStore((s) => s.hosts);
  const checkouts = useSyncStore((s) => s.checkouts);
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
    layout: stored.layout ?? "columns",
  };
  const [local, setLocal] = useFilter<{ projectId: string | null; subset: "notStarted" | "all" }>(
    `workboard-scope:${scopeId ?? "all"}`,
    { projectId: null, subset: "notStarted" },
  );
  const [sort, setSort] = useFilter<"number" | "priority">("discovery-sort", "number");
  const projectList = Object.values(projects);
  const context = discoveryContext(scope, projectList);
  const projectId = context.fixedProjectId
    ? null
    : discoveryProjects(scope, projectList).some((p) => p.id === local.projectId)
      ? local.projectId
      : null;
  const subset = local.subset ?? "notStarted";
  const inventory = useIssueInventory({
    enabled: hydrated,
    forceTracked: prefs.layout !== "issues",
    scope,
    projectId,
    query: prefs.query,
    subset,
    sort,
  });
  const selectionKey = JSON.stringify([scopeId, prefs.layout, inventory.key]);
  const [selection, setSelection] = useState<{ key: string; id: string } | null>(null);
  const selectedId = selection?.key === selectionKey ? selection.id : null;
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const actionError = failure?.key === selectionKey ? failure.message : null;
  const busy = useRef(false);
  const allItems = inventory.allItems;
  const selectedExists =
    !selectedId || inventory.loading || allItems.some((item) => item.id === selectedId);
  useEffect(() => {
    if (!selectedExists) {
      setSelection(null);
      toast.error("This issue is no longer available in this scope.");
    }
  }, [selectedExists]);
  useEffect(() => {
    if (selection && selection.key !== selectionKey) setSelection(null);
  }, [selectionKey, selection]);
  const githubBoard = useMemo(() => githubBoardOf(scope, Object.values(issues)), [scope, issues]);
  const mode: BoardMode = prefs.mode === "github" && githubBoard ? "github" : "stage";
  const github = githubBoard?.scope ?? null;
  const { columns, empty: emptyCount } = useMemo(
    () =>
      buildBoardWithEmpty(
        { projects, workspaces, sessions, hosts, attention, interactions, issues },
        { scope, query: prefs.query, mode, github, showEmpty: prefs.empty, projectId },
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
      projectId,
      mode,
      github,
    ],
  );
  const navigate = useNavigate();
  const go = (id: string) => navigate(`/code/${encodeURIComponent(id)}`, { state: BACK_STATE });

  const activate = async (card: BoardCard) => {
    if (card.sessionId) return go(card.sessionId);
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    try {
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
    } finally {
      busy.current = false;
      setPending(false);
    }
  };

  const action = async (id: string) => {
    if (busy.current) return;
    const fresh = useSyncStore.getState();
    if (currentScopeId() !== scopeId || (scopeId && !fresh.scopes[scopeId])) return;
    const item = inventory.currentItem(id, scopeId ? fresh.scopes[scopeId]! : null);
    if (!item) return;
    const intent = issueAction(item, fresh);
    if (intent.kind === "open") return go(intent.sessionId);
    if (intent.kind !== "start" || (item.locator.kind === "repository" && inventory.loading))
      return;
    busy.current = true;
    setPending(true);
    setFailure(null);
    try {
      const { session } = await openIssue(intent.locator, intent.request);
      rememberIssueSession(item, session);
      go(session.id);
    } catch (e) {
      setFailure({ key: selectionKey, message: errorMessage(e) });
      if (
        item.locator.kind === "repository" &&
        isApiError(e) &&
        (e.status === 409 || e.status === 404)
      ) {
        inventory.refresh?.();
      }
    } finally {
      busy.current = false;
      setPending(false);
    }
  };

  const move = async (card: BoardCard, column: BoardColumn) => {
    if (!canDrop(card, column, mode, github).ok) return;
    try {
      if (mode === "stage") return;
      if (card.issue && card.issue.board?.statusOptionId !== column.id) {
        await setIssueStatus(card.issue.id, column.label);
      }
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const actionProblem = (item: IssueInventoryItem) => {
    const intent = issueAction(item, { hosts, checkouts, scopes });
    if (intent.kind === "none") return intent.label;
    return intent.kind === "start" && item.locator.kind === "repository" && inventory.loading
      ? "Refreshing repository issues…"
      : null;
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
    projects,
    projectId,
    setProjectId: (id) => {
      setLocal({ ...local, projectId: id });
      setSelection(null);
    },
    subset,
    setSubset: (value) => {
      setLocal({ ...local, subset: value });
      setSelection(null);
    },
    sort,
    setSort,
    inventory,
    selectedId,
    selectedItem: allItems.find((item) => item.id === selectedId) ?? null,
    inspect: (id) => {
      setSelection(id ? { key: selectionKey, id } : null);
      setFailure(null);
    },
    action,
    pending,
    actionError,
    actionDetail: (item) =>
      issueAction(item, { hosts, checkouts, scopes }).consequences.join(" · "),
    actionProblem,
    cardActionProblem: (id) => {
      const item = allItems.find((candidate) => candidate.id === id);
      return item ? actionProblem(item) : null;
    },
    cardActionDetail: (id) => {
      const item = allItems.find((candidate) => candidate.id === id);
      return item ? issueAction(item, { hosts, checkouts, scopes }).consequences.join(" · ") : "";
    },
    total: columns.reduce((n, c) => n + c.cards.length, 0),
    canDrop: (card, column) => canDrop(card, column, mode, github),
    activate,
    move,
  };
}
