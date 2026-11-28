import {
  type Checkout,
  type OpenBranchRequest,
  primarySession,
  type Session,
  SwitchyardError,
} from "@switchyard/protocol";
import type { CoordinatorContext } from "./context.js";
import { createSession, pinIfOutsideScope } from "./sessions/service.js";
import { refreshCheckoutWorkspaces } from "./workspaces.js";

export interface OpenBranchInput {
  projectId: string;
  branch: string;
  hostId?: string | undefined;
  base?: string | null | undefined;
  prompt?: string | undefined;
  profileId?: string | null | undefined;
  title?: string | undefined;
  scopeId?: string | undefined;
  /** COMPAT(scopes-rename): remove after 2027-03-01. The old name of scopeId. */
  viewId?: string | undefined;
  another?: boolean | undefined;
  /** Issue work requires a known remote branch; preparation failure must not create another. */
  requireRemoteBranch?: boolean | undefined;
}

const topSessions = (ctx: CoordinatorContext, workspaceId: string) =>
  ctx.store.sessions
    .list("workspace_id = ? AND archived_at IS NULL", [workspaceId])
    .filter((s) => s.provenance !== "subagent");

interface IssueBranchOpen {
  strictRemote?: boolean;
  prepareRemote: boolean;
  freshAllocation: boolean;
  beforeProvision(checkout: Checkout): void;
  recordSession(session: Session): void;
}

/** Existing branch placements first, then the project's configured default. */
export function branchPlacement(
  ctx: CoordinatorContext,
  input: Pick<OpenBranchInput, "projectId" | "branch" | "hostId">,
) {
  const { store } = ctx;
  const project = store.projects.require(input.projectId);
  const checkouts = store.checkouts.list("project_id = ?", [project.id]);
  const matches = store.workspaces
    .list("project_id = ? AND archived_at IS NULL", [project.id])
    .filter((w) => w.branch === input.branch);
  let busiest: { hostId: string; at: string } | null = null;
  for (const w of matches) {
    const p = primarySession(topSessions(ctx, w.id));
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
  const workspace = matches.find((w) => w.hostId === hostId);
  const checkout =
    checkouts.find((c) => c.hostId === hostId && c.id === workspace?.checkoutId) ??
    checkouts.find((c) => c.hostId === hostId);
  if (!checkout) {
    const name = store.hosts.get(hostId)?.name ?? hostId;
    throw new SwitchyardError("invalid_request", `No checkout of this project on ${name}`);
  }
  return { project, checkout, workspace };
}

/**
 * Open a project's branch: return its primary session when it has one, else start a session in
 * its worktree, creating the worktree first when the branch has none on the chosen host.
 */
export async function openBranch(
  ctx: CoordinatorContext,
  input: OpenBranchInput | OpenBranchRequest,
  issue?: IssueBranchOpen,
): Promise<{ session: Session; created: boolean }> {
  const { store } = ctx;
  const scopeId = input.scopeId ?? input.viewId;
  if (scopeId) store.scopes.require(scopeId);
  const { project, checkout, workspace } = branchPlacement(ctx, input);
  const { hostId } = checkout;
  let ws = workspace;
  if (!ws && !issue?.freshAllocation) {
    try {
      await refreshCheckoutWorkspaces(ctx, checkout);
    } catch (err) {
      ctx.log.debug({ err, checkoutId: checkout.id }, "open branch: discovery failed");
    }
    ws = store.workspaces
      .list("checkout_id = ? AND archived_at IS NULL", [checkout.id])
      .find((w) => w.branch === input.branch);
  }
  if (ws && issue?.freshAllocation) {
    throw new SwitchyardError(
      "conflict",
      "A worktree appeared on the proposed issue branch; refresh before opening it",
    );
  }
  const needsPreparation = issue?.prepareRemote ?? !ws;
  const existing = () => (ws && !input.another ? primarySession(topSessions(ctx, ws.id)) : null);
  const primary = needsPreparation ? null : existing();
  if (primary) return { session: primary, created: false };
  const common = {
    projectId: project.id,
    profileId: input.profileId ?? null,
    prompt: input.prompt ?? "",
    ...(input.title ? { title: input.title } : {}),
  };
  issue?.beforeProvision(checkout);
  if (needsPreparation) {
    try {
      const preparation = await ctx.hostHub.request<{ ok?: boolean }>(
        hostId,
        {
          type: "tracker.prepareBranch",
          checkoutPath: checkout.path,
          branch: input.branch,
          ...(issue?.strictRemote ? { strict: true } : {}),
        },
        {
          timeoutMs: 60_000,
          ...(issue ? { beforeSend: () => issue.beforeProvision(checkout) } : {}),
        },
      );
      if ("requireRemoteBranch" in input && input.requireRemoteBranch && preparation?.ok !== true) {
        throw new SwitchyardError(
          "conflict",
          "The host did not confirm preparation of the linked remote branch",
        );
      }
    } catch (err) {
      if ("requireRemoteBranch" in input && input.requireRemoteBranch) throw err;
      ctx.log.debug({ err, branch: input.branch }, "open branch: prepareBranch failed");
    }
    issue?.beforeProvision(checkout);
    const preparedPrimary = existing();
    if (preparedPrimary) return { session: preparedPrimary, created: false };
  }
  const { session } = createSession(
    ctx,
    {
      ...common,
      workspace: ws
        ? { existingId: ws.id }
        : { checkoutId: checkout.id, newBranch: input.branch, base: input.base ?? null },
    },
    issue?.recordSession,
  );
  if (scopeId) pinIfOutsideScope(ctx, scopeId, session.id);
  return { session, created: true };
}
