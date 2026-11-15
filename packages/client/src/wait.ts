import type { Session, Task } from "@switchyard/protocol";
import { ApiRequestError } from "./api.js";
import type { ClientConnection } from "./connection.js";

type Entity = Session | Task;
export interface WaitOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}
export type WaitCode =
  | "session_failed"
  | "session_interrupted"
  | "session_stopped"
  | "task_canceled"
  | "not_found"
  | "unauthorized"
  | "timeout"
  | "aborted"
  | "closed"
  | "invalid_request";
export class WaitError extends Error {
  constructor(
    readonly code: WaitCode,
    message: string,
    readonly lastEntity: Entity | null = null,
  ) {
    super(message);
    this.name = "WaitError";
  }
}

/** A single entity waiter; global events do not invalidate an in-flight REST read. */
export function waitForEntity<T extends Entity>(
  connection: ClientConnection,
  kind: "sessions" | "tasks",
  id: string,
  decide: (entity: T) => { done?: boolean; error?: WaitCode },
  options: WaitOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 300_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new RangeError("timeoutMs must be a positive finite integer");
  return new Promise<T>((resolve, reject) => {
    let finished = false;
    let reading = false;
    let rerun = false;
    let last: T | null = null;
    let poll: NodeJS.Timeout | undefined;
    const pending = new Set<AbortController>();
    const unsub: Array<() => void> = [];
    const cleanup = () => {
      if (poll) clearTimeout(poll);
      clearTimeout(deadline);
      options.signal?.removeEventListener("abort", abort);
      for (const fn of unsub) fn();
      for (const controller of pending) controller.abort();
      pending.clear();
    };
    const fail = (code: WaitCode, message: string) => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(new WaitError(code, message, last));
    };
    const succeed = (entity: T) => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(entity);
    };
    const evaluate = (entity: T | undefined) => {
      if (finished || !entity) return;
      last = entity;
      const result = decide(entity);
      if (result.error) fail(result.error, `${kind} ${id} entered ${result.error}`);
      else if (result.done) succeed(entity);
    };
    const fromStore = () => {
      const state = connection.store.getState();
      const entity = state[kind][id] as T | undefined;
      if (!state.synced) return;
      // Snapshots omit archived sessions and may precede a just-created entity's
      // event. Only an explicit deletion event or a REST 404 proves absence.
      evaluate(entity);
    };
    const schedule = () => {
      if (finished) return;
      poll = setTimeout(() => {
        poll = undefined;
        void refresh();
      }, 2_000);
      poll.unref?.();
    };
    const refresh = async () => {
      if (finished) return;
      if (poll) {
        clearTimeout(poll);
        poll = undefined;
      }
      if (reading) {
        rerun = true;
        return;
      }
      reading = true;
      const revision = connection.store.revision(kind, id);
      const controller = new AbortController();
      pending.add(controller);
      try {
        const entity = await connection.api.get<T>(`/api/${kind}/${encodeURIComponent(id)}`, {
          signal: controller.signal,
        });
        if (!finished) {
          if (revision !== connection.store.revision(kind, id)) {
            fromStore();
            if (!finished) rerun = true;
          } else evaluate(entity);
        }
      } catch (error) {
        if (!finished && error instanceof ApiRequestError) {
          if (error.status === 404) {
            if (revision !== connection.store.revision(kind, id)) {
              fromStore();
              if (!finished) rerun = true;
            } else fail("not_found", error.message);
          } else if (error.status === 401 || error.status === 403)
            fail("unauthorized", error.message);
          else if (error.status >= 400 && error.status < 500)
            fail("invalid_request", error.message);
        }
      } finally {
        pending.delete(controller);
        reading = false;
        if (!finished) {
          if (rerun) {
            rerun = false;
            void refresh();
          } else schedule();
        }
      }
    };
    const abort = () => fail("aborted", "Wait aborted");
    const deadline = setTimeout(
      () => fail("timeout", `Wait timed out after ${timeoutMs} ms`),
      timeoutMs,
    );
    unsub.push(connection.store.subscribe(fromStore));
    unsub.push(
      connection.onNotice((notice) => {
        if (
          notice.type === "event" &&
          notice.event.type === "task.deleted" &&
          kind === "tasks" &&
          (notice.event.data as { id?: string }).id === id
        ) {
          fail("not_found", `tasks ${id} was removed`);
        }
      }),
    );
    unsub.push(
      connection.onLive(() => {
        void refresh();
      }),
    );
    unsub.push(connection.onLogout((reason) => fail("unauthorized", reason)));
    unsub.push(connection.onClose(() => fail("closed", "Client closed")));
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    if (!finished) {
      fromStore();
      if (!finished) {
        connection.connect();
        void refresh();
      }
    }
  });
}
