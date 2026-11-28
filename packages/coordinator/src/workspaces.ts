import {
  branchSlug,
  type Checkout,
  CheckoutInfo,
  DEFAULT_WORKTREE_DIR,
  DiscoveredWorktree,
  GitState,
  newId,
  type Project,
  type Session,
  SwitchyardError,
  type Workspace,
} from "@switchyard/protocol";
import { z } from "zod";
import type { CoordinatorContext } from "./context.js";
import { githubForBranch } from "./github.js";
import { LIVE_RUNTIMES, requireConnected } from "./sessions/service.js";

/** A project's worktree folder (rows written before 0.2 have none: the default). */
export function worktreeDirOf(project: Pick<Project, "worktreeDir"> | undefined): string {
  return project?.worktreeDir || DEFAULT_WORKTREE_DIR;
}

/** Where the host creates the managed worktree for `branch` (`<checkout>/<worktreeDir>/<slug>`). */
export function predictedWorktreePath(
  checkout: Pick<Checkout, "path">,
  project: Pick<Project, "worktreeDir"> | undefined,
  branch: string,
): string {
  return `${checkout.path}/${worktreeDirOf(project)}/${branchSlug(branch)}`;
}

const ZERO_GIT: GitState = { dirty: false, changedFiles: 0, ahead: 0, behind: 0, unmerged: false };
const NO_SETUP: Workspace["setup"] = { state: "none", log: "" };
const SetupState = z.object({
  state: z.enum(["none", "running", "succeeded", "failed"]),
  log: z.string(),
});

function stripRef(branch: string | null): string | null {
  return branch?.startsWith("refs/heads/") ? branch.slice("refs/heads/".length) : branch;
}

/** `checkout.inspect` on a host. */
export async function inspectCheckout(
  ctx: CoordinatorContext,
  hostId: string,
  path: string,
): Promise<CheckoutInfo> {
  const r = await ctx.hostHub.request(hostId, { type: "checkout.inspect", path });
  return CheckoutInfo.parse(r);
}

/** Preserve the ID of a checkout already recorded at this host path. */
export function recordInspectedCheckout(
  ctx: CoordinatorContext,
  projectId: string,
  hostId: string,
  info: CheckoutInfo,
): Checkout {
  return ctx.store.tx(() => {
    const existing = ctx.store.checkouts.list("host_id = ? AND path = ?", [hostId, info.root])[0];
    if (existing && existing.projectId !== projectId) {
      throw new SwitchyardError("conflict", "This checkout belongs to another project");
    }
    if (existing?.commonDir === info.commonDir && existing.defaultBranch === info.defaultBranch)
      return existing;
    return ctx.store.putCheckout({
      id: existing?.id ?? newId("chk"),
      projectId,
      hostId,
      path: info.root,
      commonDir: info.commonDir,
      defaultBranch: info.defaultBranch,
      createdAt: existing?.createdAt ?? ctx.store.nowIso(),
    });
  });
}

/** Record (or refresh) a workspace the coordinator asked a host to create. */
export function recordCreatedWorkspace(
  ctx: CoordinatorContext,
  project: Project,
  checkout: Checkout,
  info: { path: string; branch: string; baseBranch: string; git?: unknown; setup?: unknown },
): Workspace {
  return ctx.store.tx(() => {
    const existing = ctx.store.workspaceByPath(checkout.hostId, info.path);
    const buffered = ctx.hostHub.takeBufferedWorkspace(checkout.hostId, info.path);
    const git = GitState.safeParse(buffered?.git ?? info.git);
    const setup = SetupState.safeParse(buffered?.setup ?? info.setup);
    const ws: Workspace = {
      id: existing?.id ?? newId("wsp"),
      checkoutId: checkout.id,
      projectId: project.id,
      hostId: checkout.hostId,
      path: info.path,
      branch: info.branch,
      baseBranch: info.baseBranch,
      provenance: "managed",
      git: git.success ? git.data : (existing?.git ?? ZERO_GIT),
      setup: setup.success ? setup.data : (existing?.setup ?? NO_SETUP),
      github: githubForBranch(buffered?.github ?? existing?.github, info.branch, ctx.store),
      archivedAt: null,
      updatedAt: ctx.store.nowIso(),
    };
    return ctx.store.putWorkspace(ws);
  });
}

/**
 * Move sessions the host introduced to the most specific workspace containing their folder.
 * `active` are the checkout's current workspaces. Call inside a transaction.
 */
function rehomeSessions(ctx: CoordinatorContext, checkout: Checkout, active: Workspace[]): void {
  const under = (s: Session) =>
    active
      .filter((w) => s.cwd === w.path || s.cwd.startsWith(`${w.path}/`))
      .sort((a, b) => b.path.length - a.path.length)[0];
  for (const s of ctx.store.sessions.list("host_id = ? AND archived_at IS NULL", [
    checkout.hostId,
  ])) {
    if (
      s.provenance !== "imported" ||
      s.runId ||
      s.taskId ||
      !s.cwd ||
      (s.projectId && s.projectId !== checkout.projectId)
    )
      continue;
    const local = under(s);
    if (!local || local.id === s.workspaceId) continue;
    const ws = ctx.store.workspaceContaining(checkout.hostId, s.cwd);
    if (!ws || ws.id === s.workspaceId || ws.checkoutId !== checkout.id) continue;
    ctx.store.putSession({ ...s, workspaceId: ws.id, projectId: ws.projectId });
  }
}

/**
 * `workspace.discover` for a checkout: upsert every worktree, archive the ones that vanished.
 * Accepts either an array or `{worktrees: [...]}` as the host result.
 */
export async function refreshCheckoutWorkspaces(
  ctx: CoordinatorContext,
  checkout: Checkout,
  opts: { beforeRecord?: () => void; requiredWorktreePath?: string } = {},
): Promise<Workspace[]> {
  const raw = await ctx.hostHub.request<unknown>(checkout.hostId, {
    type: "workspace.discover",
    checkoutPath: checkout.path,
    worktreeDir: worktreeDirOf(ctx.store.projects.get(checkout.projectId)),
  });
  const list = DiscoveredWorktree.array().parse(
    Array.isArray(raw) ? raw : ((raw as { worktrees?: unknown })?.worktrees ?? []),
  );
  if (
    opts.requiredWorktreePath !== undefined &&
    !list.some((wt) => wt.path === opts.requiredWorktreePath && !wt.bare && !wt.prunable)
  ) {
    throw new SwitchyardError("conflict", "The worktree changed before discovery completed");
  }
  return ctx.store.tx(() => {
    opts.beforeRecord?.();
    if (opts.requiredWorktreePath !== undefined) {
      const existing = ctx.store.workspaceByPath(checkout.hostId, opts.requiredWorktreePath);
      if (existing && existing.checkoutId !== checkout.id) {
        throw new SwitchyardError("conflict", "This workspace belongs to another checkout");
      }
    }
    const now = ctx.store.nowIso();
    const seen = new Set<string>();
    const out: Workspace[] = [];
    for (const wt of list) {
      if (wt.bare || wt.prunable) continue;
      seen.add(wt.path);
      const existing = ctx.store.workspaceByPath(checkout.hostId, wt.path);
      if (existing && existing.checkoutId !== checkout.id) continue;
      const next: Workspace = {
        id: existing?.id ?? newId("wsp"),
        checkoutId: checkout.id,
        projectId: checkout.projectId,
        hostId: checkout.hostId,
        path: wt.path,
        branch: stripRef(wt.branch),
        baseBranch:
          existing?.baseBranch ?? (wt.provenance === "main" ? null : checkout.defaultBranch),
        provenance: existing?.provenance === "managed" ? "managed" : wt.provenance,
        git: wt.git ?? existing?.git ?? ZERO_GIT,
        setup: existing?.setup ?? NO_SETUP,
        github: githubForBranch(existing?.github, stripRef(wt.branch), ctx.store),
        archivedAt: null,
        updatedAt: existing?.updatedAt ?? now,
      };
      const changed =
        !existing ||
        JSON.stringify({ ...existing, updatedAt: "" }) !==
          JSON.stringify({ ...next, updatedAt: "" });
      out.push(changed ? ctx.store.putWorkspace({ ...next, updatedAt: now }) : existing!);
    }
    for (const ws of ctx.store.workspaces.list("checkout_id = ? AND archived_at IS NULL", [
      checkout.id,
    ])) {
      if (!seen.has(ws.path)) ctx.store.putWorkspace({ ...ws, archivedAt: now, updatedAt: now });
    }
    rehomeSessions(ctx, checkout, out);
    return out;
  });
}

/** `workspace.status` for one workspace and store the git state. */
export async function refreshWorkspaceStatus(
  ctx: CoordinatorContext,
  ws: Workspace,
): Promise<Workspace> {
  const raw = await ctx.hostHub.request<unknown>(ws.hostId, {
    type: "workspace.status",
    path: ws.path,
    base: ws.baseBranch,
  });
  const git = GitState.parse((raw as { git?: unknown })?.git ?? raw);
  return ctx.store.tx(() => {
    const cur = ctx.store.workspaces.require(ws.id);
    if (JSON.stringify(cur.git) === JSON.stringify(git)) return cur;
    return ctx.store.putWorkspace({ ...cur, git, updatedAt: ctx.store.nowIso() });
  });
}

/** Base branch for diff/status: the workspace's, else its checkout default. */
export function baseFor(ctx: CoordinatorContext, ws: Workspace): string | null {
  return ws.baseBranch ?? ctx.store.checkouts.get(ws.checkoutId)?.defaultBranch ?? null;
}

/**
 * Remove a worktree. Dirty/unmerged need explicit force flags; the branch is kept unless
 * `deleteBranch`. The main checkout and workspaces with live sessions are refused.
 */
export async function removeWorkspace(
  ctx: CoordinatorContext,
  id: string,
  opts: {
    force: { dirty: boolean; unmerged: boolean };
    deleteBranch?: boolean;
    beforeSend?: () => void;
  },
): Promise<void> {
  const ws = ctx.store.workspaces.require(id);
  if (ws.provenance === "main") {
    throw new SwitchyardError("forbidden", "The main checkout cannot be removed");
  }
  const live = ctx.store.sessions
    .list("workspace_id = ? AND archived_at IS NULL", [id])
    .filter((s) => LIVE_RUNTIMES.includes(s.runtime));
  if (live.length > 0) {
    throw new SwitchyardError(
      "workspace_active_sessions",
      "Stop the sessions in this workspace before removing it",
      { sessionIds: live.map((s) => s.id) },
    );
  }
  requireConnected(ctx, ws.hostId);
  const checkout = ctx.store.checkouts.require(ws.checkoutId);
  await ctx.hostHub.request(
    ws.hostId,
    {
      type: "workspace.remove",
      path: ws.path,
      checkoutPath: checkout.path,
      base: baseFor(ctx, ws),
      force: opts.force,
      ...(opts.deleteBranch ? { deleteBranch: true } : {}),
    },
    opts.beforeSend ? { beforeSend: opts.beforeSend } : {},
  );
  ctx.store.archiveWorkspace(ws);
}
