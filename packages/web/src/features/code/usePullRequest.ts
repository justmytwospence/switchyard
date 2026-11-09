import type { GitHubViewResponse } from "@switchyard/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../../sync/api";
import { codeApi } from "./api";
import { pollVisiblePullRequest } from "./githubLogic";
import type { SessionContext } from "./hooks";

/** Owned by the session layout, so discovery also happens with a collapsed inspector. */
export function usePullRequest(ctx: SessionContext, active: boolean) {
  const workspaceId = ctx.workspace?.id;
  const online = ctx.link === "connected" && !ctx.workspace?.archivedAt;
  const [result, setResult] = useState<{ id: string; value: GitHubViewResponse } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pageVisible, setPageVisible] = useState(true);
  const [uncertainWorkspace, setUncertainWorkspace] = useState<string | null>(null);
  useEffect(() => {
    const update = () => setPageVisible(document.visibilityState === "visible");
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  const request = useRef<{
    id: string;
    controller: AbortController;
    pending: Promise<GitHubViewResponse | null>;
  } | null>(null);

  const load = useCallback(
    (refresh: boolean): Promise<GitHubViewResponse | null> => {
      if (!workspaceId || !online) return Promise.resolve(null);
      const current = request.current;
      if (current?.id === workspaceId) return current.pending;
      const controller = new AbortController();
      setLoading(true);
      setError(null);
      const pending = (refresh ? codeApi.refreshPr : codeApi.pr)(workspaceId, controller.signal)
        .then((value) => {
          if (controller.signal.aborted) return null;
          setResult({ id: workspaceId, value });
          return value;
        })
        .catch((e: unknown) => {
          if (!controller.signal.aborted) setError(errorMessage(e));
          return null;
        })
        .finally(() => {
          if (request.current?.controller === controller) {
            request.current = null;
            setLoading(false);
          }
        });
      request.current = { id: workspaceId, controller, pending };
      return pending;
    },
    [workspaceId, online],
  );

  useEffect(() => {
    setError(null);
    setLoading(false);
    void load(false);
    return () => {
      request.current?.controller.abort();
      request.current = null;
    };
  }, [load]);

  const supported =
    result?.id === workspaceId && result ? result.value.github !== null : !!ctx.host?.github;
  useEffect(() => {
    if (!active || !online || !workspaceId || !supported) return;
    // Let initial discovery finish, then refresh. No overlapping host requests.
    let canceled = false;
    const refresh = () => {
      const pending = request.current?.pending;
      if (pending) {
        void pending.then(() => {
          if (!canceled && document.visibilityState === "visible") void load(true);
        });
      } else void load(true);
    };
    const stop = pollVisiblePullRequest(refresh, document);
    return () => {
      canceled = true;
      stop();
    };
  }, [active, online, workspaceId, supported, load]);

  const value = result && result.id === workspaceId ? result.value : null;
  const cached = ctx.workspace?.github;
  const snapshot =
    cached && (!value?.snapshot || cached.attemptedAt > value.snapshot.attemptedAt)
      ? cached
      : (value?.snapshot ?? cached ?? null);
  return {
    snapshot,
    mergeUncertain: !!workspaceId && uncertainWorkspace === workspaceId,
    markMergeUncertain: useCallback(
      () => setUncertainWorkspace(workspaceId ?? null),
      [workspaceId],
    ),
    pageVisible,
    github: value ? value.github : (ctx.host?.github ?? null),
    error,
    loading,
    reload: useCallback(() => load(true), [load]),
    refresh: useCallback(async () => {
      const value = await load(true);
      if (value?.snapshot?.status === "ready") setUncertainWorkspace(null);
      return value;
    }, [load]),
  };
}
export type PullRequestState = ReturnType<typeof usePullRequest>;
