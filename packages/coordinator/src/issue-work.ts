import {
  DiscoveredWorktree,
  type OpenIssueRequest,
  primarySession,
  type RepoIssueItem,
  type Session,
  SwitchyardError,
  type SyncedIssue,
  type TrackedIssue,
  type Workspace,
} from "@switchyard/protocol";
import { branchPlacement, openBranch } from "./branches.js";
import type { CoordinatorContext } from "./context.js";
import { assertPolicyLaunchHost, currentPolicyLaunchRequirement } from "./policies/launch.js";
import { failSession, requireConnected, resolveProfile } from "./sessions/service.js";
import type { IssueWork, Store } from "./store.js";
import { requireWorkProject } from "./work-projects.js";
import { worktreeDirOf } from "./workspaces.js";

/** Branch name for "Start work": `<number>-<slug of the title>`. */
export function issueBranch(number: number, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug ? `${number}-${slug}` : String(number);
}

export function trackedIssueLinks(store: Store, projectId: string, nodeId: string) {
  return store.issues.list("project_id = ?", [projectId]).filter((i) => i.itemId === nodeId);
}

type IssueFacts = Pick<
  SyncedIssue,
  "itemId" | "number" | "title" | "url" | "branches" | "pullRequest"
>;

export function remoteIssueBranches(issue: IssueFacts): string[] {
  const pr = issue.pullRequest;
  return [
    ...new Set([...issue.branches, ...(pr && pr.state !== "CLOSED" ? [pr.headRefName] : [])]),
  ];
}

/** GitHub wins over local evidence. Multiple candidates at the same authority are ambiguous. */
export function issueWorkBranch(
  store: Store,
  projectId: string,
  issue: IssueFacts,
  preferRecorded = false,
) {
  const work = store.getIssueWork(projectId, issue.itemId);
  const remote = remoteIssueBranches(issue);
  const locals = [
    work?.branch,
    ...trackedIssueLinks(store, projectId, issue.itemId).map((i) => i.branch),
  ];
  const choices =
    preferRecorded && work
      ? [work.branch]
      : remote.length
        ? remote
        : [...new Set(locals.filter((b): b is string => !!b))];
  const branch = choices.length === 1 ? choices[0]! : null;
  return {
    work,
    branch,
    remote:
      (branch !== null && remote.includes(branch)) || (work?.branch === branch && work.remote),
    ambiguous: choices.length > 1,
  };
}

function liveWorkspaces(store: Store, projectId: string, branch: string) {
  return store.workspaces
    .list("project_id = ? AND archived_at IS NULL", [projectId])
    .filter((w) => w.branch === branch);
}

export function pendingIssueSession(
  store: Store,
  work: IssueWork | undefined,
  branch: string | null,
) {
  if (!work?.pendingSessionId || work.branch !== branch) return null;
  const pending = store.sessions.get(work.pendingSessionId);
  return pending?.projectId === work.projectId &&
    !pending.archivedAt &&
    pending.provenance !== "subagent" &&
    pending.workspaceId === null &&
    pending.runtime === "starting"
    ? pending
    : null;
}

export function resolveIssueWork(
  store: Store,
  projectId: string,
  issue: IssueFacts,
  preferRecorded = false,
) {
  const link = issueWorkBranch(store, projectId, issue, preferRecorded);
  const workspaces = link.branch ? liveWorkspaces(store, projectId, link.branch) : [];
  const sessions = workspaces
    .flatMap((w) => store.sessions.list("workspace_id = ? AND archived_at IS NULL", [w.id]))
    .filter((s) => s.provenance !== "subagent");
  // A confirmed remote link can survive a failed preparation. A same-name local
  // worktree on its own is not proof that this particular allocation was prepared.
  const unprepared =
    link.work?.remote && link.work.branch === link.branch && !link.work.workspaceId;
  const primary = unprepared ? null : primarySession(sessions);
  const session = primary ?? pendingIssueSession(store, link.work, link.branch);
  const workspace =
    workspaces.find((w) => w.id === session?.workspaceId) ??
    workspaces.find((w) => w.id === link.work?.workspaceId) ??
    workspaces[0];
  return { ...link, session, workspace };
}

/** A locked/read-validated locator. A tracked start additionally refreshes membership before provisioning. */
interface OpenTarget {
  issue: IssueFacts & { repository: string };
  mutationHostId: string;
  mutationCheckoutId?: string;
  assertCurrent(): void;
  assertCanStart(): void;
  /** A stale tracked snapshot may navigate but cannot reconcile durable work. */
  reconcileExisting?: boolean;
  refreshForStart?: () => Promise<OpenTarget>;
}

export class IssueWorkService {
  private readonly tails = new Map<string, Promise<unknown>>();

  constructor(private readonly ctx: CoordinatorContext) {}

  /** At startup there are no in-flight issue launches. A pre-workspace prompt was never sent. */
  recoverInterrupted(): void {
    const { store } = this.ctx;
    store.tx(() => {
      for (const work of store.pendingIssueWork()) {
        const pending = pendingIssueSession(store, work, work.branch);
        if (pending)
          failSession(
            this.ctx,
            pending.id,
            "The coordinator restarted before the issue worktree attached. Open the issue again to continue.",
          );
        store.putIssueWork({ ...work, pendingSessionId: null });
      }
    });
  }

  async serialize<T>(projectId: string, nodeId: string, run: () => T | Promise<T>): Promise<T> {
    const key = JSON.stringify([projectId, nodeId]);
    const tail = this.tails.get(key) ?? Promise.resolve();
    const next = tail.catch(() => {}).then(run);
    this.tails.set(key, next);
    try {
      return await next;
    } finally {
      if (this.tails.get(key) === next) this.tails.delete(key);
    }
  }

  /** Keep each board's membership/status untouched while projecting the same local link to each. */
  projectLink(
    projectId: string,
    nodeId: string,
    branch: string | null,
    workspaceId: string | null,
  ) {
    const { store } = this.ctx;
    for (const row of trackedIssueLinks(store, projectId, nodeId)) {
      if (row.branch !== branch || row.workspaceId !== workspaceId) {
        store.putIssue({ ...row, branch, workspaceId, updatedAt: store.nowIso() });
      }
    }
  }

  private persist(
    projectId: string,
    issue: IssueFacts,
    branch: string,
    remote: boolean,
    workspace: Workspace | undefined,
    session?: Session | null,
  ) {
    const { store } = this.ctx;
    store.tx(() => {
      store.putIssueWork({
        projectId,
        nodeId: issue.itemId,
        number: issue.number,
        title: issue.title,
        url: issue.url,
        branch,
        remote,
        workspaceId: session ? session.workspaceId : (workspace?.id ?? null),
        pendingSessionId:
          session?.workspaceId === null && session.runtime === "starting" ? session.id : null,
      });
      this.projectLink(
        projectId,
        issue.itemId,
        branch,
        session ? session.workspaceId : (workspace?.id ?? null),
      );
    });
  }

  private assertNoKnownCollision(projectId: string, branch: string) {
    const { store } = this.ctx;
    if (
      liveWorkspaces(store, projectId, branch).length ||
      store.checkouts.list("project_id = ?", [projectId]).some((c) => c.defaultBranch === branch) ||
      store.listIssueWork(projectId).some((work) => work.branch === branch) ||
      store.issues
        .list("project_id = ?", [projectId])
        .some((i) => i.branch === branch || remoteIssueBranches(i).includes(branch))
    ) {
      this.branchCollision();
    }
  }

  private branchCollision(): never {
    throw new SwitchyardError(
      "conflict",
      "The proposed issue branch already exists or is linked; link an existing worktree explicitly or choose another branch",
    );
  }

  /** Check unregistered, discoverable worktrees without publishing them as a side effect. */
  private async checkDiscoverableBranches(projectId: string, branch: string) {
    const { store, hostHub } = this.ctx;
    this.assertNoKnownCollision(projectId, branch);
    const project = store.projects.require(projectId);
    await Promise.all(
      store.checkouts
        .list("project_id = ?", [projectId])
        .filter((c) => hostHub.isConnected(c.hostId))
        .map(async (checkout) => {
          const raw = await hostHub.request(checkout.hostId, {
            type: "workspace.discover",
            checkoutPath: checkout.path,
            worktreeDir: worktreeDirOf(project),
          });
          const worktrees = DiscoveredWorktree.array().parse(
            Array.isArray(raw) ? raw : (raw as { worktrees?: unknown } | null)?.worktrees,
          );
          if (worktrees.some((w) => w.branch === branch || w.branch === `refs/heads/${branch}`))
            this.branchCollision();
        }),
    );
  }

  openIssueWork(
    projectId: string,
    nodeId: string,
    opts: OpenIssueRequest,
    context: "repository" | "tracked",
    read: () => OpenTarget | Promise<OpenTarget>,
  ): Promise<{ session: Session; created: boolean }> {
    return this.serialize(projectId, nodeId, async () => {
      const { store, hostHub } = this.ctx;
      requireWorkProject(this.ctx, projectId);
      const scopeId = opts.scopeId ?? opts.viewId;
      if (scopeId) store.scopes.require(scopeId);
      if (
        opts.hostId &&
        !store.checkouts.list("project_id = ?", [projectId]).some((c) => c.hostId === opts.hostId)
      ) {
        throw new SwitchyardError("conflict", "Prepare a checkout on this host", {
          hostId: opts.hostId,
        });
      }
      let target = await read();
      const current = () => {
        requireWorkProject(this.ctx, projectId);
        if (target.issue.itemId !== nodeId)
          throw new SwitchyardError("conflict", "The issue changed; refresh and try again");
        target.assertCurrent();
        if (scopeId) store.scopes.require(scopeId);
      };
      const resolve = (preferRecorded = false) => {
        current();
        return resolveIssueWork(store, projectId, target.issue, preferRecorded);
      };
      let link = resolve();
      if (target.refreshForStart && link.work && link.branch !== link.work.branch) {
        // A board snapshot can predate an authoritative repo open. Don't let it undo that
        // reconciliation. A stale board may still navigate the already-recorded work.
        if (target.reconcileExisting === false) {
          link = resolve(true);
        } else {
          target = await target.refreshForStart();
          link = resolve();
        }
      }
      const reuse = () => {
        if (link.ambiguous) {
          throw new SwitchyardError(
            "conflict",
            "This issue has conflicting branch links; resolve them before opening work",
          );
        }
        if (!link.session || !link.branch) return null;
        // In particular, never send the new request's prompt to a reused session.
        if (target.reconcileExisting !== false) {
          this.persist(
            projectId,
            target.issue,
            link.branch,
            link.remote,
            link.workspace,
            link.session,
          );
        }
        return { session: link.session, created: false };
      };
      const existing = reuse();
      if (existing) return existing;
      target.assertCanStart();
      if (target.refreshForStart) {
        target = await target.refreshForStart();
        link = resolve();
        const refreshed = reuse();
        if (refreshed) return refreshed;
        target.assertCanStart();
      }
      const issue = target.issue;
      const branch = link.branch ?? issueBranch(issue.number, issue.title);
      const placement = () => branchPlacement(this.ctx, { projectId, branch, hostId: opts.hostId });
      const capable = (hostId: string) => {
        if (context === "repository" && !hostHub.supportsStrictIssueBranches(hostId)) {
          throw new SwitchyardError(
            "unsupported_capability",
            "Upgrade the checkout host before starting repository issue work",
          );
        }
      };
      const beforeProvision = (checkout: ReturnType<typeof placement>["checkout"]) => {
        current();
        target.assertCanStart();
        const latest = store.checkouts.require(checkout.id);
        if (
          latest.projectId !== projectId ||
          latest.hostId !== checkout.hostId ||
          latest.path !== checkout.path
        ) {
          throw new SwitchyardError("conflict", "The work checkout changed; refresh and try again");
        }
        requireConnected(this.ctx, checkout.hostId);
        capable(checkout.hostId);
        const project = store.projects.require(projectId);
        const profile = resolveProfile(this.ctx, opts.profileId, project);
        assertPolicyLaunchHost(
          this.ctx,
          checkout.hostId,
          currentPolicyLaunchRequirement(this.ctx, {
            sessionId: null,
            profileId: profile.id,
            continuation: { enabled: false },
          }),
        );
      };
      let { checkout: workCheckout } = placement();
      beforeProvision(workCheckout);
      let remote = link.remote;
      if (!link.branch) {
        await this.checkDiscoverableBranches(projectId, branch);
        workCheckout = placement().checkout;
        beforeProvision(workCheckout);
        this.assertNoKnownCollision(projectId, branch);
        const sourceCheckout = store.checkouts
          .list("project_id = ?", [projectId])
          .find(
            (c) =>
              c.hostId === target.mutationHostId &&
              (!target.mutationCheckoutId || c.id === target.mutationCheckoutId),
          );
        if (sourceCheckout) {
          const { hostId } = sourceCheckout;
          requireConnected(this.ctx, hostId);
          capable(hostId);
          let sent = false;
          // Do not resend a possibly applied mutation on reconnect. A subsequent open must read
          // remote links through its own locator and recheck local work before attempting allocation.
          const confirmation = await hostHub.request<{ branch?: string }>(
            hostId,
            {
              type: "tracker.startIssue",
              checkoutPath: sourceCheckout.path,
              repository: issue.repository,
              number: issue.number,
              branch,
              base: sourceCheckout.defaultBranch,
              ...(hostHub.supportsStrictIssueBranches(hostId) ? { strict: true } : {}),
            },
            {
              timeoutMs: 60_000,
              beforeSend: () => {
                if (sent)
                  throw new SwitchyardError(
                    "conflict",
                    "The issue branch may have been created; refresh before retrying",
                  );
                beforeProvision(workCheckout);
                capable(hostId);
                this.assertNoKnownCollision(projectId, branch);
                sent = true;
              },
            },
          );
          if (confirmation?.branch !== branch)
            throw new SwitchyardError(
              "conflict",
              "The host did not confirm the issue branch; refresh before retrying",
            );
          if (!projectMatchesIssue(store, { projectId, repository: issue.repository })) {
            throw new SwitchyardError(
              "conflict",
              "The project repository changed while creating the linked branch",
            );
          }
          remote = true;
        } else if (context === "repository") {
          throw new SwitchyardError(
            "conflict",
            "The issue host no longer has a checkout of this repository",
          );
        }
      }
      const provenPlacement =
        !!link.workspace &&
        link.work?.remote &&
        link.work.workspaceId === link.workspace.id &&
        link.workspace.checkoutId === workCheckout.id;
      // Persist a confirmed remote branch even if preparation fails, but don't treat an
      // unprepared destination workspace as confirmed. A local allocation is recorded with its session.
      if (link.branch || remote) {
        this.persist(
          projectId,
          issue,
          branch,
          remote,
          !remote || provenPlacement ? link.workspace : undefined,
        );
      }
      let recordedId: string | undefined;
      const result = await openBranch(
        this.ctx,
        {
          ...opts,
          projectId,
          branch,
          hostId: workCheckout.hostId,
          scopeId,
          title: `#${issue.number} ${issue.title}`.slice(0, 120),
          requireRemoteBranch: remote,
        },
        {
          strictRemote: remote && hostHub.supportsStrictIssueBranches(workCheckout.hostId),
          prepareRemote: remote && !provenPlacement,
          freshAllocation: !link.branch,
          beforeProvision,
          recordSession: (session) => {
            // The attachment can arrive after an explicit unlink or remote relink. Don't resurrect it.
            if (recordedId) {
              const row = store.getIssueWork(projectId, nodeId);
              if (row?.pendingSessionId !== session.id || row.branch !== branch) return;
              store.putIssueWork({
                ...row,
                workspaceId: session.workspaceId,
                pendingSessionId: null,
              });
              this.projectLink(projectId, nodeId, branch, session.workspaceId);
            } else {
              this.persist(projectId, issue, branch, remote, undefined, session);
              recordedId = session.id;
            }
          },
        },
      );
      if (!result.created) {
        current();
        this.persist(projectId, issue, branch, remote, undefined, result.session);
      }
      return result;
    });
  }

  forSession(id: string): RepoIssueItem | null {
    const { store } = this.ctx;
    const session = store.sessions.require(id);
    if (!session.projectId) return null;
    const project = store.projects.require(session.projectId);
    const repository = /^https:\/\/github\.com\/([^/]+\/[^/]+)$/i.exec(project.repoIdentity)?.[1];
    if (!repository) return null;
    const ws = session.workspaceId ? store.workspaces.get(session.workspaceId) : undefined;
    const rows = store
      .listIssueWork(project.id)
      .filter((row) =>
        ws
          ? ws.projectId === project.id &&
            row.branch === ws.branch &&
            (!row.remote || !!row.workspaceId)
          : pendingIssueSession(store, row, row.branch)?.id === id,
      );
    const work =
      rows.find((row) => row.pendingSessionId === id) ??
      rows.find((row) => ws && row.workspaceId === ws.id) ??
      rows[0];
    if (!work) return null;
    return {
      projectId: project.id,
      itemId: work.nodeId,
      repository,
      number: work.number,
      title: work.title,
      url: work.url,
      branch: work.branch,
      workspaceId: ws?.id ?? null,
      sessionId: id,
      branches: [],
      assignees: [],
      pullRequest: null,
      board: null,
    };
  }
}

export function projectMatchesIssue(
  store: Store,
  issue: Pick<TrackedIssue, "projectId" | "repository">,
) {
  return (
    store.projects.require(issue.projectId).repoIdentity.toLowerCase() ===
    `https://github.com/${issue.repository}`.toLowerCase()
  );
}
