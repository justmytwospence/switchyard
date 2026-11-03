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
 * Workspace mutations that produce host events: managed worktree creation with streamed setup
 * output (`workspace.updated`), and removal (`workspace.removed`).
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
      (git) => this.emitUpdate(wt.path, { git }),
      () => {},
    );
    let setupDone: Promise<SetupState> = Promise.resolve(initial);
    if (setupCommand) {
      setupDone = runSetup(wt.path, setupCommand, (setup) => this.emitUpdate(wt.path, { setup }), {
        env: { ...process.env, ...(this.opts.env ?? {}) } as NodeJS.ProcessEnv,
      }).then(
        (final) => {
          this.emitUpdate(wt.path, { setup: final });
          return final;
        },
        (err: unknown) => {
          const failed: SetupState = {
            state: "failed",
            log: `Setup could not run: ${(err as Error).message}`,
          };
          this.emitUpdate(wt.path, { setup: failed });
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
  ): Promise<{ ok: true; path: string }> {
    await removeWorktree({
      path,
      checkoutPath,
      base,
      force,
      hasActiveSession: this.opts.hasActiveSession,
    });
    this.opts.db.tx(() =>
      this.opts.link.emit({ type: "workspace.removed", data: { id: path, path } }),
    );
    return { ok: true, path };
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
