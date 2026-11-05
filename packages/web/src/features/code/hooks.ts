import type {
  AdapterInfo,
  Host,
  Project,
  Run,
  Session,
  Task,
  Workspace,
} from "@switchyard/protocol";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "../../components/ui/Toast";
import { errorMessage, isApiError } from "../../sync/api";
import { useSyncStore } from "../../sync/store";
import { codeApi } from "./api";
import {
  type AutomationControl,
  automationControl,
  type HostLink,
  hostLink,
  runForSession,
} from "./model";

export interface SessionContext {
  session: Session;
  host: Host | undefined;
  hostName: string;
  link: HostLink;
  project: Project | undefined;
  workspace: Workspace | undefined;
  run: Run | null;
  task: Task | undefined;
  control: AutomationControl;
  adapters: AdapterInfo[];
}

const NO_ADAPTERS: AdapterInfo[] = [];

export type SessionLookup =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "missing" }
  | { state: "error"; error: string };

/**
 * A session the snapshot leaves out (archived) is fetched by id and kept in the sync store, so
 * its URL still opens after a reload and live events (Unarchive) update it.
 */
export function useSessionLookup(
  sessionId: string | null,
  session: Session | undefined,
  hydrated: boolean,
): SessionLookup {
  const absent = hydrated && !!sessionId && !session;
  const [result, setResult] = useState<{ id: string; lookup: SessionLookup } | null>(null);
  useEffect(() => {
    if (!absent || !sessionId) return;
    const ctrl = new AbortController();
    setResult({ id: sessionId, lookup: { state: "loading" } });
    codeApi.get(sessionId, ctrl.signal).then(
      (s) => {
        useSyncStore.getState().upsertSessionIfMissing(s);
        setResult(null);
      },
      (e) => {
        if (ctrl.signal.aborted) return;
        setResult({
          id: sessionId,
          lookup: isApiError(e, "not_found")
            ? { state: "missing" }
            : { state: "error", error: errorMessage(e) },
        });
      },
    );
    return () => ctrl.abort();
  }, [absent, sessionId]);
  if (!absent) return { state: "idle" };
  return result?.id === sessionId ? result.lookup : { state: "loading" };
}

/** Everything the session views need about one session, from the store. */
export function useSessionContext(session: Session | undefined): SessionContext | null {
  const host = useSyncStore((s) => (session ? s.hosts[session.hostId] : undefined));
  const project = useSyncStore((s) =>
    session?.projectId ? s.projects[session.projectId] : undefined,
  );
  const workspace = useSyncStore((s) =>
    session?.workspaceId ? s.workspaces[session.workspaceId] : undefined,
  );
  const runs = useSyncStore((s) => s.runs);
  const tasks = useSyncStore((s) => s.tasks);
  const adapters = useSyncStore((s) =>
    session ? (s.adapters[session.hostId] ?? NO_ADAPTERS) : NO_ADAPTERS,
  );
  return useMemo(() => {
    if (!session) return null;
    const run = runForSession(runs, session);
    const taskId = session.taskId ?? run?.taskId ?? null;
    return {
      session,
      host,
      hostName: host?.name ?? "Unknown host",
      link: hostLink(host, session),
      project,
      workspace,
      run,
      task: taskId ? tasks[taskId] : undefined,
      control: automationControl(run),
      adapters,
    };
  }, [session, host, project, workspace, runs, tasks, adapters]);
}

export interface Mutation<A extends unknown[]> {
  run: (...args: A) => Promise<boolean>;
  busy: boolean;
  error: unknown;
  reset: () => void;
}

/**
 * Wrap a REST mutation: busy state, error kept for inline display (with
 * retry), and a success toast only after the coordinator acknowledged.
 */
export function useMutation<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  opts: { success?: string | ((r: R) => string | null); errorToast?: boolean } = {},
): Mutation<A> {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = useCallback(async (...args: A) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fnRef.current(...args);
      const { success } = optsRef.current;
      const msg = typeof success === "function" ? success(r) : success;
      if (msg) toast.success(msg);
      return true;
    } catch (e) {
      if (mounted.current) setError(e);
      if (optsRef.current.errorToast) toast.error(errorMessage(e));
      return false;
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, []);
  const reset = useCallback(() => setError(null), []);
  return { run, busy, error, reset };
}

/** Re-render every `ms` while `active` (elapsed timers). */
export function useNow(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return now;
}

/** Width of an element, kept current with a ResizeObserver. */
export function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}
