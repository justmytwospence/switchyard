import {
  type DispatchStartResult,
  type ErrorCode,
  type HostCommandOf,
  type ReconcileResult,
  SwitchyardError,
} from "@switchyard/protocol";
import type { HostDb } from "./db/index.js";
import type { Logger } from "./logger.js";
import type { SessionSupervisor } from "./supervisor.js";
import type { WorkspaceService } from "./workspaces.js";

export type DispatchState = "accepted" | "workspace_ready" | "started" | "failed";

export interface DispatchRow {
  dispatchKey: string;
  runId: string;
  sessionId: string | null;
  state: DispatchState;
  workspacePath: string | null;
  error: { code: ErrorCode; message: string; details?: Record<string, unknown> } | null;
  result: DispatchStartResult | null;
  updatedAt: string;
}

interface RawRow {
  dispatch_key: string;
  run_id: string;
  session_id: string | null;
  state: DispatchState;
  workspace_path: string | null;
  error: string | null;
  result_json: string | null;
  updated_at: string;
}

function toRow(r: RawRow): DispatchRow {
  return {
    dispatchKey: r.dispatch_key,
    runId: r.run_id,
    sessionId: r.session_id,
    state: r.state,
    workspacePath: r.workspace_path,
    error: r.error ? JSON.parse(r.error) : null,
    result: r.result_json ? JSON.parse(r.result_json) : null,
    updatedAt: r.updated_at,
  };
}

export const RESTARTED_DURING_DISPATCH = "Host agent restarted during dispatch";
/** Restarted after the workspace was ready: Pi may have started and received the prompt. */
export const RESTARTED_DURING_LAUNCH =
  "Host agent restarted during launch; Pi may have started and received the prompt";

/**
 * Idempotent dispatch: the `dispatches` row keyed by `dispatchKey` is written before any side
 * effect. A duplicate `dispatch.start` returns the stored outcome (`reused: true`) or the stored
 * failure, and never creates a second worktree or Pi process.
 */
export class Dispatcher {
  private readonly inflight = new Map<string, Promise<DispatchStartResult>>();

  constructor(
    private readonly opts: {
      db: HostDb;
      supervisor: SessionSupervisor;
      workspaces: WorkspaceService;
      log: Logger;
    },
  ) {}

  get(dispatchKey: string): DispatchRow | undefined {
    const r = this.opts.db.get<RawRow>("SELECT * FROM dispatches WHERE dispatch_key = ?", [
      dispatchKey,
    ]);
    return r ? toRow(r) : undefined;
  }

  /**
   * Dispatches interrupted by a host-agent crash are never replayed: they become `failed`
   * (the coordinator reconciles and decides). Only `accepted` ones are known not to have spawned
   * Pi (`started: false`, safe to retry); from `workspace_ready` on, Pi may have started and
   * received the prompt, so they report `started: "unknown"` with whatever handle is known.
   */
  recoverAfterRestart(): number {
    const { db, supervisor } = this.opts;
    const now = new Date().toISOString();
    const rows = db
      .all<RawRow>("SELECT * FROM dispatches WHERE state IN ('accepted', 'workspace_ready')")
      .map(toRow);
    db.tx(() => {
      for (const row of rows) {
        let error: { code: ErrorCode; message: string; details: Record<string, unknown> };
        if (row.state === "accepted") {
          error = {
            code: "internal",
            message: RESTARTED_DURING_DISPATCH,
            details: { started: false },
          };
        } else {
          const rec = row.sessionId ? supervisor.record(row.sessionId) : undefined;
          error = {
            code: "internal",
            message: RESTARTED_DURING_LAUNCH,
            details: {
              started: "unknown",
              nativeHandle: rec?.nativeHandle ?? null,
              workspacePath: row.workspacePath,
            },
          };
        }
        db.run(
          "UPDATE dispatches SET state = 'failed', error = ?, updated_at = ? WHERE dispatch_key = ?",
          [JSON.stringify(error), now, row.dispatchKey],
        );
      }
    });
    return rows.length;
  }

  async start(cmd: HostCommandOf<"dispatch.start">): Promise<DispatchStartResult> {
    const running = this.inflight.get(cmd.dispatchKey);
    if (running) return { ...(await running), reused: true };
    const existing = this.get(cmd.dispatchKey);
    if (existing) return this.storedOutcome(existing);
    const p = this.run(cmd);
    this.inflight.set(cmd.dispatchKey, p);
    try {
      return await p;
    } finally {
      this.inflight.delete(cmd.dispatchKey);
    }
  }

  reconcile(dispatchKey: string): ReconcileResult {
    const row = this.get(dispatchKey);
    if (!row) return { known: false };
    const rec = row.sessionId ? this.opts.supervisor.record(row.sessionId) : undefined;
    return {
      known: true,
      sessionId: row.sessionId,
      state: row.state,
      runtime: rec?.runtime ?? null,
      workspacePath: row.workspacePath,
      nativeHandle: rec?.nativeHandle ?? row.result?.nativeHandle ?? null,
      error: row.error?.message ?? null,
      errorDetails: row.error?.details ?? null,
    };
  }

  private storedOutcome(row: DispatchRow): DispatchStartResult {
    if (row.state === "started" && row.result) return { ...row.result, reused: true };
    if (row.state === "failed") {
      throw new SwitchyardError(
        row.error?.code ?? "internal",
        row.error?.message ?? "Dispatch failed",
        { ...(row.error?.details ?? {}), dispatchKey: row.dispatchKey, reused: true },
      );
    }
    throw new SwitchyardError("conflict", `Dispatch ${row.dispatchKey} is still ${row.state}`, {
      dispatchKey: row.dispatchKey,
      state: row.state,
    });
  }

  private update(key: string, fields: Partial<Record<keyof RawRow, string | null>>): void {
    const cols = Object.keys(fields);
    this.opts.db.run(
      `UPDATE dispatches SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE dispatch_key = ?`,
      [...cols.map((c) => fields[c as keyof RawRow] ?? null), new Date().toISOString(), key],
    );
  }

  private async run(cmd: HostCommandOf<"dispatch.start">): Promise<DispatchStartResult> {
    const { db, supervisor, workspaces, log } = this.opts;
    const key = cmd.dispatchKey;
    db.tx(() =>
      db.run(
        `INSERT INTO dispatches (dispatch_key, run_id, session_id, state, updated_at)
         VALUES (?, ?, ?, 'accepted', ?)`,
        [key, cmd.runId, cmd.sessionId, new Date().toISOString()],
      ),
    );
    try {
      let workspacePath: string;
      if ("path" in cmd.workspace) {
        workspacePath = cmd.workspace.path;
      } else {
        const c = cmd.workspace.createFrom;
        const created = await workspaces.create(c.checkoutPath, c.branch, c.base, c.setupCommand);
        workspacePath = created.path;
        db.tx(() => this.update(key, { workspace_path: workspacePath }));
        const setup = await created.setupDone;
        if (setup.state === "failed") {
          throw new SwitchyardError("internal", `Workspace setup failed for ${workspacePath}`, {
            setupLogTail: setup.log.slice(-2000),
          });
        }
      }
      db.tx(() => this.update(key, { state: "workspace_ready", workspace_path: workspacePath }));
      const started = await supervisor.start({
        sessionId: cmd.sessionId,
        title: cmd.title,
        workspacePath,
        projectId: cmd.projectId,
        profile: cmd.profile,
        nativeHandle: cmd.nativeHandle,
        initialPrompt: cmd.prompt,
        dispatchKey: key,
        controlRevision: cmd.controlRevision,
        controlMode: cmd.controlMode,
        origin: "automation",
        runId: cmd.runId,
        taskId: cmd.taskId,
      });
      const result: DispatchStartResult = {
        sessionId: started.sessionId,
        workspacePath,
        nativeHandle: started.nativeHandle,
        reused: false,
      };
      db.tx(() => this.update(key, { state: "started", result_json: JSON.stringify(result) }));
      return result;
    } catch (err) {
      const body =
        err instanceof SwitchyardError
          ? { code: err.code, message: err.message }
          : { code: "internal" as const, message: (err as Error).message };
      log.warn({ dispatchKey: key, error: body }, "dispatch failed");
      db.tx(() => this.update(key, { state: "failed", error: JSON.stringify(body) }));
      throw err instanceof SwitchyardError ? err : new SwitchyardError("internal", body.message);
    }
  }
}
