import {
  type OpenBranchRequest,
  primarySession,
  type Session,
  SwitchyardError,
} from "@switchyard/protocol";
import type { CoordinatorContext } from "./context.js";
import { createSession, pinIfOutsideView } from "./sessions/service.js";
import { refreshCheckoutWorkspaces } from "./workspaces.js";

export interface OpenBranchInput {
  projectId: string;
  branch: string;
  hostId?: string | undefined;
  base?: string | null | undefined;
  prompt?: string | undefined;
  profileId?: string | null | undefined;
  title?: string | undefined;
  viewId?: string | undefined;
  another?: boolean | undefined;
}

/**
 * Open a project's branch: return its primary session when it has one, else start a session in
 * its worktree, creating the worktree first when the branch has none on the chosen host.
 */
export async function openBranch(
  ctx: CoordinatorContext,
  input: OpenBranchInput | OpenBranchRequest,
): Promise<{ session: Session; created: boolean }> {
  const { store } = ctx;
  const project = store.projects.require(input.projectId);
  if (input.viewId) store.views.require(input.viewId);
  const checkouts = store.checkouts.list("project_id = ?", [project.id]);
  const matches = store.workspaces
    .list("project_id = ? AND archived_at IS NULL", [project.id])
    .filter((w) => w.branch === input.branch);
  const top = (wsId: string) =>
    store.sessions
      .list("workspace_id = ? AND archived_at IS NULL", [wsId])
      .filter((s) => s.provenance !== "subagent");
  let busiest: { hostId: string; at: string } | null = null;
  for (const w of matches) {
    const p = primarySession(top(w.id));
    if (p && (!busiest || p.lastActivityAt > busiest.at))
      busiest = { hostId: w.hostId, at: p.lastActivityAt };
  }
  const defaultHost =
    project.defaultHostId && checkouts.some((c) => c.hostId === project.defaultHostId)
      ? project.defaultHostId
      : undefined;
  const hostId =
    input.hostId ?? busiest?.hostId ?? matches[0]?.hostId ?? defaultHost ?? checkouts[0]?.hostId;
  if (!hostId) throw new SwitchyardError("invalid_request", "This project has no checkout");
  const checkout = checkouts.find((c) => c.hostId === hostId);
  if (!checkout) {
    const name = store.hosts.get(hostId)?.name ?? hostId;
    throw new SwitchyardError("invalid_request", `No checkout of this project on ${name}`);
  }
  let ws = matches.find((w) => w.hostId === hostId);
  if (!ws) {
    try {
      await refreshCheckoutWorkspaces(ctx, checkout);
    } catch (err) {
      ctx.log.debug({ err, checkoutId: checkout.id }, "open branch: discovery failed");
    }
    ws = store.workspaces
      .list("checkout_id = ? AND archived_at IS NULL", [checkout.id])
      .find((w) => w.branch === input.branch);
  }
  if (ws && !input.another) {
    const p = primarySession(top(ws.id));
    if (p) return { session: p, created: false };
  }
  const common = {
    projectId: project.id,
    profileId: input.profileId ?? null,
    prompt: input.prompt ?? "",
    ...(input.title ? { title: input.title } : {}),
  };
  let session: Session;
  if (ws) {
    session = createSession(ctx, { ...common, workspace: { existingId: ws.id } }).session;
  } else {
    try {
      await ctx.hostHub.request(
        hostId,
        { type: "tracker.prepareBranch", checkoutPath: checkout.path, branch: input.branch },
        { timeoutMs: 60_000 },
      );
    } catch (err) {
      ctx.log.debug({ err, branch: input.branch }, "open branch: prepareBranch failed");
    }
    session = createSession(ctx, {
      ...common,
      workspace: { checkoutId: checkout.id, newBranch: input.branch, base: input.base ?? null },
    }).session;
  }
  if (input.viewId) pinIfOutsideView(ctx, input.viewId, session.id);
  return { session, created: true };
}
