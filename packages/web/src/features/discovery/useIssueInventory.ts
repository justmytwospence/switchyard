import type { RepoIssueItem, Session } from "@switchyard/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { type Me, useAuth } from "../../app/auth";
import { useSyncStore } from "../../sync/store";
import { describeInventory, sourceNeedsRefresh } from "../scopes/describe";
import { getRepositoryIssues } from "../workboard/api";
import {
  filterInventory,
  githubRepository,
  type IssueEntry,
  type IssueInventoryItem,
  type IssueInventoryOptions,
  inventoryIntent,
  issueInventory,
  repositoryInventory,
} from "./model";

interface RepositorySnapshot {
  key: string;
  projectId: string;
  rows: RepoIssueItem[];
  next: string | null;
  seen: string[];
  partial: boolean;
  lastSuccess: string;
  failure?: { error: unknown; failed: "refresh" | "more" };
}

const authKey = (me: Me | null) => (me ? JSON.stringify([me.publicUrl, me.device.id]) : null);
const repositoryKey = (identity: string, id: string, repo: string) =>
  JSON.stringify([identity, id, repo]);
const noRows: RepoIssueItem[] = [];

// One in-memory snapshot, not a second issue store. It lets Back restore a loaded page and lets
// the palette preview already loaded rows. Nothing outside the browsing hook reads GitHub.
export const useRepositoryIssueCache = create<RepositorySnapshot | null>(() => null);
useAuth.subscribe((state, prev) => {
  if (authKey(state.me) !== authKey(prev.me) || state.status === "unauthenticated") {
    useRepositoryIssueCache.setState(null);
  }
});

export function loadedRepositoryIssues(
  snapshot: RepositorySnapshot | null,
  projects: ReturnType<typeof useSyncStore.getState>["projects"],
): RepoIssueItem[] {
  const project = projects[snapshot?.projectId ?? ""];
  const repository = project && githubRepository(project);
  const auth = useAuth.getState();
  const identity = auth.status === "authenticated" && authKey(auth.me);
  return identity && repository && snapshot?.key === repositoryKey(identity, project.id, repository)
    ? snapshot.rows
    : noRows;
}

/** Keep the pending Open affordance when navigating back before the workspace sync arrives. */
export function rememberIssueSession(item: IssueInventoryItem, session: Session) {
  const snapshot = useRepositoryIssueCache.getState();
  if (
    !snapshot ||
    !loadedRepositoryIssues(snapshot, useSyncStore.getState().projects).some(
      (r) => r.projectId === item.projectId && r.itemId === item.issue.itemId,
    )
  )
    return;
  useRepositoryIssueCache.setState({
    ...snapshot,
    rows: snapshot.rows.map((r) =>
      r.projectId === item.projectId && r.itemId === item.issue.itemId
        ? { ...r, sessionId: session.id, workspaceId: session.workspaceId ?? r.workspaceId }
        : r,
    ),
  });
}

interface ReaderState {
  key: string;
  loading: boolean;
  error: unknown;
  failed: "refresh" | "more" | null;
}

class RepeatCursorError extends Error {
  constructor() {
    super("The repository returned a repeated page cursor. Refresh to try again.");
  }
}

function useRepositoryPages(projectId: string | null, key: string | null) {
  const cache = useRepositoryIssueCache();
  const [reader, setReader] = useState<ReaderState | null>(null);
  const inFlight = useRef<AbortController | null>(null);
  const activeKey = useRef(key);
  activeKey.current = key;

  async function read(id: string, key: string, after: string | null) {
    if (activeKey.current !== key || inFlight.current) return;
    const auth = useAuth.getState();
    const identity = authKey(auth.me);
    const currentRepository = () => {
      const project = useSyncStore.getState().projects[id];
      return project && githubRepository(project);
    };
    const validProject = () => {
      const repo = currentRepository();
      return !!identity && !!repo && repositoryKey(identity, id, repo) === key;
    };
    if (!validProject() || auth.status !== "authenticated") return;
    const ctrl = new AbortController();
    const unsubscribe = useAuth.subscribe((state) => {
      if (authKey(state.me) !== identity || state.status !== "authenticated") ctrl.abort();
    });
    inFlight.current = ctrl;
    setReader({ key, loading: true, error: null, failed: null });
    const sessionCache = () => {
      const snapshot = useRepositoryIssueCache.getState();
      return snapshot?.key === key ? snapshot : null;
    };
    const live = () =>
      !ctrl.signal.aborted &&
      activeKey.current === key &&
      validProject() &&
      authKey(useAuth.getState().me) === identity &&
      useAuth.getState().status === "authenticated";
    try {
      const page = await getRepositoryIssues(id, after, ctrl.signal);
      if (!live()) return;
      const seen = after ? [...(sessionCache()?.seen ?? []), after] : [];
      if (page.nextCursor && seen.includes(page.nextCursor)) throw new RepeatCursorError();
      const repository = currentRepository()?.toLowerCase();
      if (
        page.items.some(
          (row) => row.projectId !== id || row.repository.toLowerCase() !== repository,
        )
      )
        throw new Error("The repository returned issues for another project.");
      useRepositoryIssueCache.setState({
        key,
        projectId: id,
        rows: [...(after ? (sessionCache()?.rows ?? []) : []), ...page.items],
        next: page.nextCursor,
        seen,
        partial: page.nextCursor !== null,
        lastSuccess: new Date().toISOString(),
        failure: undefined,
      });
      setReader({ key, loading: false, error: null, failed: null });
    } catch (error) {
      if (!live()) return;
      const snapshot = sessionCache();
      const failure = { error, failed: after ? "more" : "refresh" } as const;
      if (snapshot)
        useRepositoryIssueCache.setState({
          ...snapshot,
          next: error instanceof RepeatCursorError ? null : snapshot.next,
          failure,
        });
      setReader({ key, loading: false, ...failure });
    } finally {
      unsubscribe();
      if (inFlight.current === ctrl) inFlight.current = null;
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: repo identity is the read boundary, not filters or other renders
  useEffect(() => {
    if (!key || !projectId) return;
    if (useRepositoryIssueCache.getState()?.key !== key) {
      useRepositoryIssueCache.setState(null);
      void read(projectId, key, null);
    } else {
      setReader(null);
    }
    return () => {
      inFlight.current?.abort();
      inFlight.current = null;
    };
  }, [key, projectId]);

  const snapshot = key && cache?.key === key ? cache : null;
  const current = key && reader?.key === key ? reader : null;
  return {
    snapshot,
    loading: !!key && (current?.loading ?? !snapshot),
    error: current ? current.error : (snapshot?.failure?.error ?? null),
    failed: current ? current.failed : (snapshot?.failure?.failed ?? null),
    refresh:
      key && projectId
        ? () => {
            if (activeKey.current !== key) return;
            inFlight.current?.abort();
            inFlight.current = null;
            void read(projectId, key, null);
          }
        : null,
    loadMore:
      key && projectId && snapshot?.next
        ? () => {
            const current = useRepositoryIssueCache.getState();
            if (current?.key === key && current.next) void read(projectId, key, current.next);
          }
        : null,
  };
}

export function useIssueInventory(
  options: IssueInventoryOptions & { enabled: boolean; entry?: IssueEntry; forceTracked?: boolean },
) {
  const { scope, projectId, query, subset, sort, enabled, forceTracked } = options;
  const entryKind = options.entry?.kind ?? "contextual";
  const entryProjectId = options.entry?.kind === "repository" ? options.entry.projectId : null;
  const entry = useMemo<IssueEntry>(
    () =>
      entryKind === "repository" && entryProjectId
        ? { kind: "repository", projectId: entryProjectId }
        : { kind: "contextual" },
    [entryKind, entryProjectId],
  );
  const projects = useSyncStore((s) => s.projects);
  const issues = useSyncStore((s) => s.issues);
  const workspaces = useSyncStore((s) => s.workspaces);
  const sessions = useSyncStore((s) => s.sessions);
  const scopes = useSyncStore((s) => s.scopes);
  const intent = useMemo(
    () => inventoryIntent(scope, entry, projectId, projects),
    [scope, entry, projectId, projects],
  );
  const kind = forceTracked && intent.kind === "repository" ? "tracked" : intent.kind;
  const coverage = forceTracked && intent.kind === "repository" ? "known" : intent.coverage;
  const identity = useAuth((s) => (s.status === "authenticated" ? authKey(s.me) : null));
  const repoKey =
    enabled && identity && !forceTracked && intent.kind === "repository" && intent.repository
      ? repositoryKey(identity, intent.project.id, intent.repository)
      : null;
  const repo = useRepositoryPages(repoKey ? (intent.project?.id ?? null) : null, repoKey);
  const cache = useRepositoryIssueCache();
  const key = repoKey ?? JSON.stringify([kind, scope?.id, intent.project?.id]);
  const description = describeInventory(
    forceTracked && intent.kind === "repository"
      ? { kind: "tracked", coverage: "known", project: intent.project }
      : intent,
    scope,
    scopes,
  );
  const cachedWork = loadedRepositoryIssues(cache, projects);
  const repoRows = repo.snapshot?.rows ?? noRows;
  const refinedProjectId = intent.project?.id ?? projectId;
  const allItems = useMemo(() => {
    if (!enabled || kind === "pins") return [];
    const input = { projects, issues, workspaces, sessions, scopes };
    const all = { scope, projectId: refinedProjectId, query: "", subset: "all", sort } as const;
    return kind === "repository"
      ? repositoryInventory(input, all, repoRows)
      : issueInventory(input, all, cachedWork);
  }, [
    enabled,
    kind,
    projects,
    issues,
    workspaces,
    sessions,
    scopes,
    scope,
    refinedProjectId,
    sort,
    repoRows,
    cachedWork,
  ]);
  const items = useMemo(() => filterInventory(allItems, query, subset), [allItems, query, subset]);
  const relevantSources = description.sources;
  const staleSources = relevantSources.filter((s) =>
    sourceNeedsRefresh({ ...s, enabled: !s.paused }),
  );
  const error = kind === "repository" ? repo.error : staleSources.length > 0 ? staleSources : null;
  const sourceSuccess =
    relevantSources
      .flatMap((s) => (s.lastSyncedAt ? [s.lastSyncedAt] : []))
      .sort()
      .at(-1) ?? null;
  const partial =
    kind === "repository" ? (repo.snapshot?.partial ?? false) : staleSources.length > 0;
  const lastSuccess = kind === "repository" ? (repo.snapshot?.lastSuccess ?? null) : sourceSuccess;

  return {
    key,
    kind,
    coverage,
    description,
    allItems,
    items,
    loading: repo.loading,
    partial,
    error,
    lastSuccess,
    readerFailed: repo.failed,
    loadMore: repo.loadMore,
    refresh: repo.refresh,
    /** Resolve against current project identity, source membership and session facts, not the rendered row. */
    currentItem(
      id: string,
      freshScope: IssueInventoryOptions["scope"],
    ): IssueInventoryItem | undefined {
      if (!enabled) return;
      const fresh = useSyncStore.getState();
      const current = inventoryIntent(freshScope, entry, projectId, fresh.projects);
      const all = {
        ...options,
        scope: freshScope,
        projectId: current.project?.id ?? projectId,
        query: "",
        subset: "all",
      } as const;
      if (kind === "repository") {
        if (
          !identity ||
          authKey(useAuth.getState().me) !== identity ||
          current.kind !== "repository" ||
          !current.repository ||
          repositoryKey(identity, current.project.id, current.repository) !== repoKey
        )
          return;
        const snapshot = useRepositoryIssueCache.getState();
        if (!snapshot || snapshot.key !== repoKey) return;
        return repositoryInventory(fresh, all, snapshot.rows).find((item) => item.id === id);
      }
      if (
        kind === "tracked" &&
        (current.kind === "tracked" || (forceTracked && current.kind === "repository"))
      )
        return issueInventory(
          fresh,
          all,
          loadedRepositoryIssues(useRepositoryIssueCache.getState(), fresh.projects),
        ).find((item) => item.id === id);
    },
  };
}

export type IssueInventory = ReturnType<typeof useIssueInventory>;
