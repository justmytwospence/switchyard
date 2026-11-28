import type { BoardStatusOption, GitHubScope, Scope } from "@switchyard/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { BACK_STATE } from "../../app/useBackTo";
import { toast } from "../../components/ui/Toast";
import { useFilter } from "../../prefs";
import { errorMessage } from "../../sync/api";
import { useSyncStore } from "../../sync/store";
import { codeApi } from "../code/api";
import { issueAction } from "../discovery/issueAction";
import {
  discoveryContext,
  discoveryProjects,
  type IssueInventoryItem,
  issueInventory,
} from "../discovery/model";
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
  scopes: Record<string, Scope>;
  projectId: string | null;
  setProjectId: (id: string | null) => void;
  subset: "notStarted" | "all";
  setSubset: (subset: "notStarted" | "all") => void;
  sort: "number" | "priority";
  setSort: (sort: "number" | "priority") => void;
  items: IssueInventoryItem[];
  hasTrackedIssues: boolean;
  selectedId: string | null;
  selectedItem: IssueInventoryItem | null;
  inspect: (id: string | null) => void;
  action: (id: string) => Promise<void>;
  pending: boolean;
  actionError: string | null;
  actionDetail: (item: IssueInventoryItem) => string;
  cardActionDetail: (id: string) => string;
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
  const [selection, setSelection] = useState<{ scopeId: string | null; id: string } | null>(null);
  const selectedId = selection?.scopeId === scopeId ? selection.id : null;
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const busy = useRef(false);
  const items = useMemo(
    () =>
      issueInventory(
        { projects, workspaces, sessions, issues, scopes },
        { scope, projectId, query: prefs.query, subset, sort },
      ),
    [projects, workspaces, sessions, issues, scopes, scope, projectId, prefs.query, subset, sort],
  );
  const allItems = useMemo(
    () =>
      issueInventory(
        { projects, workspaces, sessions, issues, scopes },
        { scope, projectId, query: "", subset: "all", sort },
      ),
    [projects, workspaces, sessions, issues, scopes, scope, projectId, sort],
  );
  const selectedExists = !selectedId || allItems.some((item) => item.id === selectedId);
  useEffect(() => {
    if (!selectedExists) {
      setSelection(null);
      toast.error("This issue is no longer available in this scope.");
    }
  }, [selectedExists]);
  useEffect(() => {
    if (selection && selection.scopeId !== scopeId) setSelection(null);
  }, [scopeId, selection]);
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
    if (scopeId && !fresh.scopes[scopeId]) return;
    const item = issueInventory(fresh, {
      scope: scopeId ? (fresh.scopes[scopeId] ?? null) : null,
      projectId,
      query: "",
      subset: "all",
      sort,
    }).find((candidate) => candidate.id === id);
    if (!item || (item.merged && !item.sessionId)) return;
    if (item.sessionId) return go(item.sessionId);
    busy.current = true;
    setPending(true);
    setActionError(null);
    try {
      go((await openIssue(id)).session.id);
    } catch (e) {
      setActionError(errorMessage(e));
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
    scopes,
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
    items,
    hasTrackedIssues: allItems.length > 0,
    selectedId,
    selectedItem: allItems.find((item) => item.id === selectedId) ?? null,
    inspect: (id) => setSelection(id ? { scopeId, id } : null),
    action,
    pending,
    actionError,
    actionDetail: (item) =>
      issueAction(item, { hosts, checkouts, scopes }).consequences.join(" · "),
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
