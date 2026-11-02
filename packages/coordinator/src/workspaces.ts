import {
  branchSlug,
  type Checkout,
  CheckoutInfo,
  DiscoveredWorktree,
  GitState,
  newId,
  type Project,
  type Workspace,
} from "@switchyard/protocol";
import { z } from "zod";
import type { CoordinatorContext } from "./context.js";

/** Default managed worktree folder, relative to the checkout root. */
export const DEFAULT_WORKTREE_DIR = ".worktrees";

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
      archivedAt: null,
      updatedAt: ctx.store.nowIso(),
    };
    return ctx.store.putWorkspace(ws);
  });
}

/**
 * `workspace.discover` for a checkout: upsert every worktree, archive the ones that vanished.
 * Accepts either an array or `{worktrees: [...]}` as the host result.
 */
export async function refreshCheckoutWorkspaces(
  ctx: CoordinatorContext,
  checkout: Checkout,
): Promise<Workspace[]> {
  const raw = await ctx.hostHub.request<unknown>(checkout.hostId, {
    type: "workspace.discover",
    checkoutPath: checkout.path,
    worktreeDir: worktreeDirOf(ctx.store.projects.get(checkout.projectId)),
  });
  const list = DiscoveredWorktree.array().parse(
    Array.isArray(raw) ? raw : ((raw as { worktrees?: unknown })?.worktrees ?? []),
  );
  return ctx.store.tx(() => {
    const now = ctx.store.nowIso();
    const seen = new Set<string>();
    const out: Workspace[] = [];
    for (const wt of list) {
      if (wt.bare || wt.prunable) continue;
      seen.add(wt.path);
      const existing = ctx.store.workspaceByPath(checkout.hostId, wt.path);
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
