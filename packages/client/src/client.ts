import type {
  CreateSessionRequest,
  CreateTaskRequest,
  PromptRequest,
  Session,
  Task,
  TaskState,
  TranscriptPage,
} from "@switchyard/protocol";
import type { z } from "zod";
import type { RequestOptions } from "./api.js";
import { ClientConnection, type ClientOptions, type EventNotice } from "./connection.js";
import { WaitError, type WaitOptions, waitForEntity } from "./wait.js";

export type CreateSessionInput = z.input<typeof CreateSessionRequest>;
export type CreateTaskInput = z.input<typeof CreateTaskRequest>;
export type PromptInput = z.input<typeof PromptRequest>;
export interface PromptResponse {
  ok: true;
  clientMessageId: string | null;
  result: unknown;
  automationActive: boolean;
}
export interface TranscriptQuery {
  limit?: number;
  before?: number;
  afterRev?: number;
  epoch?: number;
}
export interface TaskListQuery {
  projectId?: string;
  state?: TaskState[];
  includeHidden?: boolean;
}
export interface EventSubscribeOptions {
  cursor?: number;
  projectionId?: string | null;
  signal?: AbortSignal;
  onError?: (error: Error) => void;
}

function queryPath(
  path: string,
  values: Record<string, string | number | boolean | undefined>,
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value !== undefined) query.set(key, String(value));
  const suffix = query.toString();
  return suffix ? `${path}?${suffix}` : path;
}
const entityPath = (kind: string, id: string) => `/api/${kind}/${encodeURIComponent(id)}`;

/** Node-only REST facade with an optional live connection, and independent subscription cursors. */
export class SwitchyardClient {
  readonly connection: ClientConnection;
  private readonly opts: ClientOptions;
  private closed = false;
  private subscriptions = new Set<() => void>();

  constructor(options: ClientOptions) {
    this.opts = options;
    this.connection = new ClientConnection(options);
  }

  connect(): void {
    if (this.closed) throw new Error("Client closed");
    this.connection.connect();
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const unsubscribe of [...this.subscriptions]) unsubscribe();
    this.connection.close();
  }

  readonly sessions = {
    create: (input: CreateSessionInput, options?: RequestOptions): Promise<Session> =>
      this.connection.api.post("/api/sessions", input, options),
    send: (id: string, input: PromptInput, options?: RequestOptions): Promise<PromptResponse> =>
      this.connection.api.post(`${entityPath("sessions", id)}/prompt`, input, options),
    transcript: (
      id: string,
      query: TranscriptQuery = {},
      options?: RequestOptions,
    ): Promise<TranscriptPage> => {
      if (query.before !== undefined && query.afterRev !== undefined)
        throw new TypeError("before and afterRev are mutually exclusive");
      if (query.afterRev !== undefined && query.epoch === undefined)
        throw new TypeError("epoch is required with afterRev");
      return this.connection.api.get(
        queryPath(`${entityPath("sessions", id)}/transcript`, {
          limit: query.limit,
          before: query.before,
          afterRev: query.afterRev,
          epoch: query.epoch,
        }),
        options,
      );
    },
    waitForFinish: (id: string, options?: WaitOptions): Promise<Session> =>
      this.closed
        ? Promise.reject(new WaitError("closed", "Client closed"))
        : waitForEntity<Session>(
            this.connection,
            "sessions",
            id,
            (s) => {
              if (s.runtime === "failed" || s.runtime === "interrupted" || s.runtime === "stopped")
                return { error: `session_${s.runtime}` };
              return {
                done:
                  s.runtime === "idle" &&
                  s.queue.steering.length === 0 &&
                  s.queue.followUp.length === 0,
              };
            },
            options,
          ),
  };

  readonly tasks = {
    create: (input: CreateTaskInput, options?: RequestOptions): Promise<Task> =>
      this.connection.api.post("/api/tasks", input, options),
    list: (query: TaskListQuery = {}, options?: RequestOptions): Promise<Task[]> =>
      this.connection.api.get(
        queryPath("/api/tasks", {
          projectId: query.projectId,
          state: query.state?.join(","),
          includeHidden: query.includeHidden,
        }),
        options,
      ),
    waitForState: (
      id: string,
      states: TaskState | TaskState[],
      options?: WaitOptions,
    ): Promise<Task> => {
      const wanted = Array.isArray(states) ? states : [states];
      if (!wanted.length) throw new TypeError("states must not be empty");
      if (this.closed) return Promise.reject(new WaitError("closed", "Client closed"));
      return waitForEntity<Task>(
        this.connection,
        "tasks",
        id,
        (task) => ({
          done: wanted.includes(task.state),
          error:
            task.state === "canceled" && !wanted.includes("canceled") ? "task_canceled" : undefined,
        }),
        options,
      );
    },
  };

  readonly events = {
    subscribe: (
      listener: (notice: EventNotice) => void,
      options: EventSubscribeOptions = {},
    ): (() => void) => {
      if (this.closed) throw new Error("Client closed");
      const connection = new ClientConnection({
        ...this.opts,
        initialCursor: options.cursor,
        projectionId: options.projectionId ?? null,
      });
      let active = true;
      const unsubscribe = () => {
        if (!active) return;
        active = false;
        this.subscriptions.delete(unsubscribe);
        options.signal?.removeEventListener("abort", unsubscribe);
        connection.close();
      };
      const error = (reason: Error) => {
        if (!active) return;
        try {
          options.onError?.(reason);
        } finally {
          unsubscribe();
        }
      };
      connection.onNotice((notice) => {
        if (!active) return;
        try {
          listener(notice);
        } catch (cause) {
          error(cause instanceof Error ? cause : new Error(String(cause)));
        }
      });
      connection.onLogout((reason) => error(new Error(reason)));
      this.subscriptions.add(unsubscribe);
      options.signal?.addEventListener("abort", unsubscribe, { once: true });
      if (options.signal?.aborted) unsubscribe();
      else connection.connect();
      return unsubscribe;
    },
  };
}
