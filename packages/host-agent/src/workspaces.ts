import type { GitState } from "@switchyard/protocol";
import type { HostDb } from "./db/index.js";
import { createWorktree, removeWorktree, runSetup, worktreeStatus } from "./git.js";
import type { CoordinatorLink } from "./link.js";
import type { Logger } from "./logger.js";

export type SetupState = { state: "none" | "running" | "succeeded" | "failed"; log: string };

export interface CreatedWorkspace {
  path: string;
  branch: string;
  baseBranch: string;
  provenance: "managed";
  git: GitState | null;
  setup: SetupState;
  /** Resolves when the setup command finished (immediately when there is none). */
  setupDone: Promise<SetupState>;
}

export interface WorkspaceServiceOptions {
  db: HostDb;
  link: CoordinatorLink;
  log: Logger;
  hasActiveSession: (path: string) => boolean;
  /** Environment for setup commands. */
  env?: Record<string, string | undefined>;
}

/**
 * Workspace mutations that produce host events: managed worktree creation with durable setup
 * state changes (`workspace.updated`: running, then the outcome with the last 64 KB of output),
 * and removal (`workspace.deleted`).
 */
export class WorkspaceService {
  constructor(private readonly opts: WorkspaceServiceOptions) {}

  async create(
    checkoutPath: string,
    branch: string,
    base: string,
    setupCommand: string | null,
    worktreeDir?: string,
  ): Promise<CreatedWorkspace> {
    const wt = await createWorktree(checkoutPath, branch, base, worktreeDir);
    const initial: SetupState = setupCommand
      ? { state: "running", log: "" }
      : { state: "none", log: "" };
    this.emitUpdate(wt.path, { branch: wt.branch, baseBranch: wt.baseBranch, setup: initial });
    // Status is not needed to start a session: it follows as an update.
    void worktreeStatus(wt.path, wt.baseBranch).then(
      (git) => this.emitLate(wt.path, { git }),
      () => {},
    );
    let setupDone: Promise<SetupState> = Promise.resolve(initial);
    if (setupCommand) {
      setupDone = runSetup(wt.path, setupCommand, {
        env: { ...process.env, ...(this.opts.env ?? {}) } as NodeJS.ProcessEnv,
      }).then(
        (final) => {
          this.emitLate(wt.path, { setup: final });
          return final;
        },
        (err: unknown) => {
          const failed: SetupState = {
            state: "failed",
            log: `Setup could not run: ${(err as Error).message}`,
          };
          this.emitLate(wt.path, { setup: failed });
          return failed;
        },
      );
    }
    return {
      path: wt.path,
      branch: wt.branch,
      baseBranch: wt.baseBranch,
      provenance: "managed",
      git: null,
      setup: initial,
      setupDone,
    };
  }

  async remove(
    path: string,
    checkoutPath: string,
    base: string | null,
    force: { dirty: boolean; unmerged: boolean },
    deleteBranch = false,
  ): Promise<{ ok: true; path: string }> {
    await removeWorktree({
      path,
      checkoutPath,
      base,
      force,
      hasActiveSession: this.opts.hasActiveSession,
      deleteBranch,
    });
    this.opts.db.tx(() =>
      this.opts.link.emit({ type: "workspace.deleted", data: { id: path, path } }),
    );
    return { ok: true, path };
  }

  /**
   * An update from work that outlives the request (git status, the setup command). The host may
   * have stopped meanwhile: with its database closed there is nowhere to record the update, and
   * throwing from a promise callback would take the process down.
   */
  private emitLate(path: string, patch: Record<string, unknown>): void {
    if (!this.opts.db.isOpen) {
      this.opts.log.debug({ path }, "workspace update after shutdown dropped");
      return;
    }
    this.emitUpdate(path, patch);
  }

  /** Durable partial workspace update keyed by path (the coordinator merges it). */
  emitUpdate(path: string, patch: Record<string, unknown>): void {
    this.opts.db.tx(() =>
      this.opts.link.emit({
        type: "workspace.updated",
        data: { path, ...patch, updatedAt: new Date().toISOString() },
      }),
    );
  }
}
