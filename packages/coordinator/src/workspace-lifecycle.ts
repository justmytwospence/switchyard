import { basename } from "node:path";
import type { Project, Session, Workspace } from "@switchyard/protocol";
import type { CoordinatorContext } from "./context.js";
import { requireService } from "./services.js";
import { archiveSession } from "./sessions/control.js";
import { createSession } from "./sessions/service.js";
import {
  refreshCheckoutWorkspaces,
  refreshWorkspaceStatus,
  removeWorkspace,
} from "./workspaces.js";

/** A merged worktree must look landed this long before it is removed. */
export const LANDED_GRACE_MS = 10 * 60_000;

const BUSY: Session["runtime"][] = ["starting", "running", "waiting_input"];

const ensuredKey = (id: string) => `ensuredSession:${id}`;
const landedKey = (id: string) => `landedAt:${id}`;

/**
 * Per-project workspace rules: keep one session in every worktree (`ensureSessions`) and remove
 * worktrees whose pull request has merged (`removeLanded`). Both are off unless a project opts in.
 */
export class WorkspaceLifecycleService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly ctx: CoordinatorContext,
    private readonly opts: { tickMs: number },
  ) {}

  start(): void {
    if (this.opts.tickMs <= 0) return;
    this.timer = setInterval(() => void this.tick(), this.opts.tickMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = this.ctx.store.now().getTime()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const { store } = this.ctx;
      for (const p of store.projects.list()) {
        if (!p.ensureSessions && !p.removeLanded) continue;
        for (const checkout of store.checkouts.list("project_id = ?", [p.id])) {
          if (!this.ctx.hostHub.isConnected(checkout.hostId)) continue;
          try {
            await refreshCheckoutWorkspaces(this.ctx, checkout);
          } catch (err) {
            this.ctx.log.warn({ err, checkoutId: checkout.id }, "workspace discovery failed");
            continue;
          }
          const workspaces = () =>
            store.workspaces
              .list("checkout_id = ? AND archived_at IS NULL", [checkout.id])
              .filter((w) => w.provenance !== "main");
          if (p.removeLanded) {
            for (const w of workspaces()) await this.removeIfLanded(w, now);
          }
          if (p.ensureSessions) {
            for (const w of workspaces()) await this.ensureSession(p, w, now);
          }
        }
      }
    } finally {
      this.running = false;
    }
  }

  private sessionsOf(w: Workspace): Session[] {
    return this.ctx.store.sessions
      .list("archived_at IS NULL", [])
      .filter((s) => s.workspaceId === w.id || s.cwd === w.path);
  }

  private async removeIfLanded(w: Workspace, now: number): Promise<void> {
    const { store, log } = this.ctx;
    if (!w.branch) return;
    const sessions = this.sessionsOf(w);
    if (sessions.some((s) => BUSY.includes(s.runtime))) return;
    const notLanded = () => store.deleteSetting(landedKey(w.id));
    let snapshot: Workspace["github"] | null = null;
    try {
      snapshot = (await requireService(this.ctx, "github").refresh(w.id)).snapshot;
    } catch (err) {
      log.debug({ err, workspaceId: w.id }, "landed check: GitHub unavailable");
      return notLanded();
    }
    const pr = snapshot?.status === "ready" ? snapshot.pullRequest : null;
    if (pr?.state !== "MERGED") return notLanded();
    let head: string | undefined;
    let dirty = true;
    try {
      const fresh = await refreshWorkspaceStatus(this.ctx, w);
      head = fresh.git.head;
      dirty = fresh.git.dirty;
    } catch (err) {
      log.warn({ err, workspaceId: w.id }, "landed check: status failed");
      return notLanded();
    }
    if (dirty || !head || head !== pr.headRefOid) return notLanded();
    const seen = store.getSetting<number | null>(landedKey(w.id), null);
    if (seen === null) {
      store.setSetting(landedKey(w.id), now);
      return;
    }
    if (now - seen < LANDED_GRACE_MS) return;
    try {
      for (const s of sessions) await archiveSession(this.ctx, s.id);
      await removeWorkspace(this.ctx, w.id, {
        force: { dirty: false, unmerged: true },
        deleteBranch: true,
      });
      log.info({ workspaceId: w.id, branch: w.branch, pr: pr.number }, "removed landed workspace");
    } catch (err) {
      // The herdr worktree reaper (or a person) may have removed it first.
      const gone = (err as { code?: string }).code === "not_found";
      log[gone ? "debug" : "warn"]({ err, workspaceId: w.id }, "could not remove landed workspace");
    }
  }

  private async ensureSession(p: Project, w: Workspace, now: number): Promise<void> {
    const { store, log } = this.ctx;
    const current = store.workspaces.get(w.id);
    if (!current || current.archivedAt) return;
    if (store.getSetting<number | null>(ensuredKey(w.id), null) !== null) return;
    if (current.github?.pullRequest?.state === "MERGED") return;
    if (this.sessionsOf(current).length > 0) {
      store.setSetting(ensuredKey(w.id), now);
      return;
    }
    try {
      createSession(this.ctx, {
        projectId: p.id,
        workspace: { existingId: current.id },
        prompt: "",
        title: current.branch ?? basename(current.path),
      });
      store.setSetting(ensuredKey(w.id), now);
    } catch (err) {
      log.warn({ err, workspaceId: w.id }, "could not start a session for the worktree");
    }
  }
}
