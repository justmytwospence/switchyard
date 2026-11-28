import {
  GitHubRepository,
  IssueDescriptionResult,
  type OpenRepoIssueRequest,
  type RepoIssueItem,
  RepoIssueResult,
  type RepoIssuesPage,
  RepoIssuesPageResult,
  SwitchyardError,
  type SyncedIssue,
} from "@switchyard/protocol";
import type { CoordinatorContext } from "./context.js";
import { resolveIssueWork } from "./issue-work.js";
import { requireService } from "./services.js";

/** Read one project's GitHub inventory without changing scope membership. */
export class RepositoryIssuesService {
  constructor(private readonly ctx: CoordinatorContext) {}

  private locator(projectId: string) {
    const { store, hostHub } = this.ctx;
    const project = store.projects.require(projectId);
    const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)$/i.exec(project.repoIdentity);
    const parsed = GitHubRepository.safeParse(match?.[1]);
    if (!parsed.success)
      throw new SwitchyardError("invalid_request", "Project is not a GitHub repository");
    const checkouts = store.checkouts
      .list("project_id = ?", [projectId])
      .sort((a, b) => a.hostId.localeCompare(b.hostId) || a.id.localeCompare(b.id));
    const connected = checkouts.filter((c) => hostHub.isConnected(c.hostId));
    if (!connected.length)
      throw new SwitchyardError(
        "host_unreachable",
        "No connected host has a checkout of this project",
      );
    const capable = connected.filter((c) => hostHub.supportsRepositoryIssues(c.hostId));
    const checkout = capable.find((c) => c.hostId === project.defaultHostId) ?? capable[0];
    if (!checkout)
      throw new SwitchyardError(
        "unsupported_capability",
        "Connected checkout hosts do not support repository issues",
      );
    return { repository: parsed.data, hostId: checkout.hostId, checkout };
  }

  private verify(projectId: string, repository: string): void {
    const project = this.ctx.store.projects.require(projectId);
    if (project.repoIdentity.toLowerCase() !== `https://github.com/${repository}`.toLowerCase())
      throw new SwitchyardError("conflict", "Project repository changed while reading issues");
  }

  private item(projectId: string, issue: SyncedIssue): RepoIssueItem {
    const { branch, workspace, session } = resolveIssueWork(this.ctx.store, projectId, issue);
    return {
      ...issue,
      projectId,
      branch,
      workspaceId: workspace?.id ?? null,
      sessionId: session?.id ?? null,
    };
  }

  async page(projectId: string, after?: string): Promise<RepoIssuesPage> {
    const { repository, hostId } = this.locator(projectId);
    const raw = await this.ctx.hostHub.request(
      hostId,
      {
        type: "tracker.repoIssuesPage",
        repository,
        ...(after ? { after } : {}),
      },
      { timeoutMs: 30_000 },
    );
    this.verify(projectId, repository);
    const page = RepoIssuesPageResult.parse(raw);
    if (page.items.some((i) => i.repository.toLowerCase() !== repository.toLowerCase()))
      throw new SwitchyardError("conflict", "Host returned an issue from another repository");
    return {
      items: page.items.map((i) => this.item(projectId, i)),
      nextCursor: page.nextCursor,
    };
  }

  open(projectId: string, number: number, opts: OpenRepoIssueRequest) {
    const { hostHub, store } = this.ctx;
    return requireService(this.ctx, "issueWork").openIssueWork(
      projectId,
      opts.expectedNodeId,
      opts,
      "repository",
      async () => {
        const { repository, hostId, checkout } = this.locator(projectId);
        const changed = () =>
          new SwitchyardError(
            "conflict",
            "The issue changed or is no longer open; refresh the repository issues and try again",
          );
        let raw: unknown;
        try {
          raw = await hostHub.request(
            hostId,
            { type: "tracker.repoIssue", repository, number },
            { timeoutMs: 30_000 },
          );
        } catch (err) {
          if (err instanceof SwitchyardError && err.code === "not_found") throw changed();
          throw err;
        }
        const { state, issue } = RepoIssueResult.parse(raw);
        const assertCurrent = () => {
          this.verify(projectId, repository);
          if (
            issue.itemId !== opts.expectedNodeId ||
            issue.number !== number ||
            issue.repository.toLowerCase() !== repository.toLowerCase()
          )
            throw changed();
          const live = store.checkouts.get(checkout.id);
          if (
            !live ||
            live.hostId !== hostId ||
            live.projectId !== projectId ||
            live.path !== checkout.path
          ) {
            throw new SwitchyardError(
              "conflict",
              "The issue checkout changed; refresh and try again",
            );
          }
        };
        return {
          issue,
          mutationHostId: hostId,
          mutationCheckoutId: checkout.id,
          assertCurrent,
          assertCanStart: () => {
            if (state !== "OPEN" || issue.pullRequest?.state === "MERGED") throw changed();
          },
        };
      },
    );
  }

  async description(projectId: string, number: number): Promise<IssueDescriptionResult> {
    const { repository, hostId } = this.locator(projectId);
    const raw = await this.ctx.hostHub.request(
      hostId,
      { type: "tracker.describeIssue", repository, number },
      { timeoutMs: 15_000 },
    );
    this.verify(projectId, repository);
    return IssueDescriptionResult.parse(raw);
  }
}
