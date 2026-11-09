import { randomUUID } from "node:crypto";
import {
  GitHubLogs,
  GitHubMergeResult,
  GitHubRepository,
  type GitHubViewResponse,
  GitHubViewResult,
  SwitchyardError,
  type Workspace,
  type WorkspaceGitHub,
} from "@switchyard/protocol";
import type { CoordinatorContext } from "./context.js";
import type { SessionSettled } from "./event-hub.js";
import type { Store } from "./store.js";

export const UNKNOWN_MERGE_REASON = "Merge outcome unknown. Refresh before retrying.";

function sameRepo(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a.toLowerCase() === b.toLowerCase();
}

export interface MergeFence {
  id: number;
  fence_key: string;
  pull_request_node_id: string | null;
  repository: string;
  pr_number: number;
  attempt_id: string;
}

type Reconciliation = { generation: number; live: Set<string>; identity: string; version: number };

/** Node identity wins over aliases: only node-less legacy rows match by slug/number. */
export function findMergeFence(store: Store, snapshot: WorkspaceGitHub): MergeFence | undefined {
  const pr = snapshot.pullRequest;
  if (!pr) return undefined;
  return store.db
    .prepare(`SELECT * FROM github_merge_fences WHERE hostname = 'github.com'
    AND ((pull_request_node_id IS NOT NULL AND pull_request_node_id = ?)
      OR (pull_request_node_id IS NULL AND repository = ? COLLATE NOCASE AND pr_number = ?))
    ORDER BY id LIMIT 1`)
    .get(pr.nodeId ?? null, snapshot.repository, pr.number) as MergeFence | undefined;
}

export function overlayMergeFence(store: Store, snapshot: WorkspaceGitHub): WorkspaceGitHub {
  return findMergeFence(store, snapshot)
    ? {
        ...snapshot,
        status: "error",
        reason: UNKNOWN_MERGE_REASON,
        checksComplete: false,
        threadsComplete: false,
      }
    : snapshot;
}

/** Retain display data only for the branch it was verified against. */
export function githubForBranch(
  github: WorkspaceGitHub | undefined,
  branch: string | null,
  store?: Store,
): WorkspaceGitHub | undefined {
  return github &&
    (github.branch === branch ||
      (github.branch === null && github.fetchedAt === null && github.pullRequest === null))
    ? store
      ? overlayMergeFence(store, github)
      : github
    : undefined;
}

function identity(ws: Workspace): string {
  return JSON.stringify([
    ws.hostId,
    ws.path,
    ws.checkoutId,
    ws.projectId,
    ws.branch,
    ws.archivedAt,
  ]);
}

function conflict(reason: string): never {
  throw new SwitchyardError("conflict", reason);
}

/** Coordinator-owned discovery and device actions; never runs on the host event chain. */
export class GitHubService {
  private refreshing = new Map<
    string,
    { identity: string; promise: Promise<GitHubViewResponse> }
  >();
  private merging = new Map<string, string>();
  private identities = new Map<string, string>();
  private versions = new Map<string, number>();
  private headRepositories = new Map<string, string>();
  private onEvent = (event: import("@switchyard/protocol").EventEnvelope): void => {
    if (event.type !== "workspace.updated") return;
    const ws = event.data as Workspace;
    const key = identity(ws);
    const headRepository = ws.github?.headRepository?.toLowerCase();
    const previousHeadRepository = this.headRepositories.get(ws.id);
    if (
      (this.identities.has(ws.id) && this.identities.get(ws.id) !== key) ||
      (previousHeadRepository && headRepository && previousHeadRepository !== headRepository)
    ) {
      this.versions.set(ws.id, (this.versions.get(ws.id) ?? 0) + 1);
    }
    this.identities.set(ws.id, key);
    if (headRepository) this.headRepositories.set(ws.id, headRepository);
  };
  private started = false;
  private stopped = false;
  private onSettled = ({ session }: SessionSettled): void => {
    const ws = session.workspaceId ? this.ctx.store.workspaces.get(session.workspaceId) : undefined;
    if (!ws || ws.hostId !== session.hostId || ws.archivedAt) return;
    const host = this.ctx.store.hosts.get(ws.hostId);
    if (!host?.github?.available || !this.ctx.hostHub.isConnected(ws.hostId)) return;
    void this.refresh(ws.id).catch((err) =>
      this.ctx.log.debug({ err, workspaceId: ws.id }, "GitHub idle refresh failed"),
    );
  };

  constructor(private readonly ctx: CoordinatorContext) {}

  start(): void {
    if (this.started) return;
    this.ctx.store.tx(() => {
      const version = this.ctx.store.getSetting<unknown>(
        "githubMergeFenceLegacyBackfillVersion",
        0,
      );
      if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0)
        throw new Error("Invalid GitHub merge fence legacy backfill version");
      if (version < 1) {
        for (const ws of this.ctx.store.workspaces.list()) this.backfillMarker(ws);
        this.ctx.store.setSetting("githubMergeFenceLegacyBackfillVersion", 1);
      }
      this.ctx.store.db
        .prepare(
          "UPDATE github_merge_fences SET state = 'unknown', updated_at = ? WHERE state = 'pending'",
        )
        .run(this.ctx.store.nowIso());
      for (const ws of this.ctx.store.workspaces.list()) {
        if (!ws.github) continue;
        const github = overlayMergeFence(this.ctx.store, ws.github);
        if (JSON.stringify(github) !== JSON.stringify(ws.github))
          this.ctx.store.putWorkspace({ ...ws, github, updatedAt: this.ctx.store.nowIso() });
      }
    });
    this.stopped = false;
    this.started = true;
    this.merging.clear();
    this.refreshing.clear();
    for (const ws of this.ctx.store.workspaces.list()) {
      this.identities.set(ws.id, identity(ws));
      if (ws.github?.headRepository)
        this.headRepositories.set(ws.id, ws.github.headRepository.toLowerCase());
    }
    this.ctx.hub.on("event", this.onEvent);
    this.ctx.hub.on("session.settled", this.onSettled);
  }

  stop(): void {
    this.started = false;
    this.stopped = true;
    this.ctx.hub.off("event", this.onEvent);
    this.ctx.hub.off("session.settled", this.onSettled);
  }

  private workspace(id: string): Workspace {
    const ws = this.ctx.store.workspaces.require(id);
    if (ws.archivedAt) throw new SwitchyardError("forbidden", "Workspace is archived");
    const checkout = this.ctx.store.checkouts.require(ws.checkoutId);
    if (checkout.hostId !== ws.hostId || checkout.projectId !== ws.projectId) {
      throw new SwitchyardError("forbidden", "Workspace checkout ownership changed");
    }
    return ws;
  }

  private capable(ws: Workspace, reprobe = false): void {
    const host = this.ctx.store.hosts.require(ws.hostId);
    if (host.revokedAt) throw new SwitchyardError("forbidden", "Host is revoked");
    if (!host.github || (!reprobe && !host.github.available)) {
      throw new SwitchyardError(
        "unsupported_capability",
        host.github?.reason ?? "This host does not support GitHub integration",
      );
    }
    if (!this.ctx.hostHub.isConnected(ws.hostId)) {
      throw new SwitchyardError("host_unreachable", "Workspace host is not connected");
    }
  }

  private cached(ws: Workspace): GitHubViewResponse {
    return {
      github: this.ctx.store.hosts.require(ws.hostId).github ?? null,
      snapshot: ws.github ? overlayMergeFence(this.ctx.store, ws.github) : null,
    };
  }

  async view(id: string): Promise<GitHubViewResponse> {
    const ws = this.workspace(id);
    const cached = this.cached(ws);
    if (cached.snapshot || !cached.github?.available || !this.ctx.hostHub.isConnected(ws.hostId))
      return cached;
    return this.refresh(id);
  }

  refresh(id: string, explicit = false): Promise<GitHubViewResponse> {
    const ws = this.workspace(id);
    const reconciliation = explicit
      ? {
          identity: identity(ws),
          version: this.versions.get(id) ?? 0,
          generation: (
            this.ctx.store.db
              .prepare("SELECT COALESCE(MAX(id), 0) AS id FROM github_merge_fences")
              .get() as { id: number }
          ).id,
          live: new Set(this.merging.values()),
        }
      : undefined;
    return this.refreshCaptured(id, reconciliation);
  }

  private refreshCaptured(
    id: string,
    reconciliation?: Reconciliation,
  ): Promise<GitHubViewResponse> {
    const explicit = reconciliation !== undefined;
    const ws = this.workspace(id);
    if (
      reconciliation &&
      (identity(ws) !== reconciliation.identity ||
        (this.versions.get(id) ?? 0) !== reconciliation.version)
    )
      conflict("Workspace identity changed during explicit refresh");
    this.capable(ws, explicit);
    const key = JSON.stringify([
      identity(ws),
      this.versions.get(id) ?? 0,
      ws.github?.headRepository?.toLowerCase() ?? null,
    ]);
    const pending = this.refreshing.get(id);
    if (pending?.identity === key) {
      // An explicit refresh must really reconcile an unknown merge, not borrow a background read.
      if (explicit) {
        return pending.promise.then(
          () => this.refreshCaptured(id, reconciliation),
          () => this.refreshCaptured(id, reconciliation),
        );
      }
      return pending.promise;
    }
    const promise = this.fetch(ws, reconciliation)
      .catch((err: unknown) => {
        const current = this.ctx.store.workspaces.get(id);
        if (
          !this.stopped &&
          current &&
          identity(current) === identity(ws) &&
          JSON.stringify(current.github) === JSON.stringify(ws.github)
        ) {
          this.stale(
            ws,
            current.github?.reason === UNKNOWN_MERGE_REASON
              ? UNKNOWN_MERGE_REASON
              : "GitHub refresh failed. Refresh before retrying.",
          );
        }
        throw err;
      })
      .finally(() => {
        if (this.refreshing.get(id)?.promise === promise) this.refreshing.delete(id);
      });
    this.refreshing.set(id, { identity: key, promise });
    return promise;
  }

  private current(ws: Workspace): Workspace {
    if (this.stopped) throw new SwitchyardError("host_unreachable", "Coordinator is stopping");
    const current = this.workspace(ws.id);
    if (identity(current) !== identity(ws))
      conflict("Workspace identity changed. Refresh before retrying.");
    return current;
  }

  private async fetch(ws: Workspace, reconciliation?: Reconciliation): Promise<GitHubViewResponse> {
    const version = this.versions.get(ws.id) ?? 0;
    const raw = await this.ctx.hostHub.request(
      ws.hostId,
      { type: "workspace.prView", path: ws.path },
      { timeoutMs: 60_000 },
    );
    const parsed = GitHubViewResult.safeParse(raw);
    if (!parsed.success) throw new SwitchyardError("internal", "Invalid GitHub snapshot from host");
    const result = parsed.data;
    const current = this.current(ws);
    this.capable(current, true);
    if ((this.versions.get(ws.id) ?? 0) !== version)
      conflict("Workspace identity changed during refresh");
    if (result.snapshot.branch !== null && result.snapshot.branch !== current.branch)
      conflict("GitHub snapshot belongs to another branch");
    const pr = result.snapshot.pullRequest;
    if (
      pr &&
      (pr.headRefName !== result.snapshot.branch ||
        (pr.headRepository !== null &&
          !sameRepo(pr.headRepository, result.snapshot.headRepository)))
    ) {
      conflict("GitHub snapshot head association is inconsistent");
    }
    // A host event may publish this very refresh before its receipt. Anything else newer wins.
    if (
      JSON.stringify(current.github) !== JSON.stringify(ws.github) &&
      JSON.stringify(current.github) !== JSON.stringify(result.snapshot) &&
      JSON.stringify(current.github) !==
        JSON.stringify(overlayMergeFence(this.ctx.store, result.snapshot))
    ) {
      conflict("GitHub association changed during refresh. Refresh again.");
    }
    let snapshot = result.snapshot;
    this.ctx.store.tx(() => {
      if (reconciliation) this.reconcileFence(snapshot, reconciliation, ws.id);
      snapshot = overlayMergeFence(this.ctx.store, snapshot);
      this.saveCapability(ws.hostId, result.github);
      this.ctx.store.putWorkspace({
        ...current,
        github: snapshot,
        updatedAt: this.ctx.store.nowIso(),
      });
    });
    return { github: result.github, snapshot };
  }

  private saveCapability(hostId: string, github: GitHubViewResult["github"]): void {
    const host = this.ctx.store.hosts.get(hostId);
    if (host && host.github !== undefined && JSON.stringify(host.github) !== JSON.stringify(github))
      this.ctx.store.putHost({ ...host, github });
  }

  private association(
    ws: Workspace,
    expectedHeadOid: string,
  ): NonNullable<WorkspaceGitHub["pullRequest"]> {
    const snapshot = ws.github;
    const pr = snapshot?.pullRequest;
    if (
      snapshot?.status !== "ready" ||
      !pr ||
      !snapshot.repository ||
      snapshot.branch !== ws.branch ||
      snapshot.branch !== pr.headRefName ||
      !sameRepo(snapshot.headRepository, pr.headRepository)
    ) {
      conflict("Refresh this workspace's verified PR association before retrying.");
    }
    if (pr.headRefOid !== expectedHeadOid)
      conflict("PR head changed. Refresh and confirm the new SHA.");
    return pr;
  }

  async failedLogs(id: string, expectedHeadOid: string): Promise<GitHubLogs> {
    const ws = this.workspace(id);
    this.capable(ws);
    const pr = this.association(ws, expectedHeadOid);
    const raw = await this.ctx.hostHub.request(
      ws.hostId,
      {
        type: "workspace.prFailedLogs",
        path: ws.path,
        repository: ws.github!.repository!,
        number: pr.number,
        expectedHeadOid,
      },
      { timeoutMs: 130_000 },
    );
    const parsed = GitHubLogs.safeParse(raw);
    if (!parsed.success) throw new SwitchyardError("internal", "Invalid GitHub logs from host");
    const result = parsed.data;
    const current = this.current(ws);
    this.association(current, expectedHeadOid);
    if (
      !sameRepo(result.repository, ws.github!.repository) ||
      result.number !== pr.number ||
      result.headOid !== expectedHeadOid ||
      current.github?.repository?.toLowerCase() !== ws.github!.repository!.toLowerCase() ||
      current.github.pullRequest?.number !== pr.number ||
      !sameRepo(current.github.headRepository, ws.github!.headRepository)
    )
      conflict("GitHub logs association changed");
    this.saveCapability(ws.hostId, result.github);
    return result;
  }

  /** Startup compatibility only: runtime display text is never mutation evidence. */
  private backfillMarker(ws: Workspace): void {
    const snapshot = ws.github;
    if (snapshot?.reason !== UNKNOWN_MERGE_REASON) return;
    const pr = snapshot.pullRequest;
    if (
      !GitHubRepository.safeParse(snapshot.repository).success ||
      !pr ||
      !Number.isSafeInteger(pr.number) ||
      pr.number <= 0
    ) {
      this.ctx.store.setSetting(`githubCorruptedMergeMarker:${ws.id}`, ws);
      return;
    }
    if (findMergeFence(this.ctx.store, snapshot)) return;
    const repository = snapshot.repository!;
    const key = `legacy:github.com:${repository.toLowerCase()}:${pr.number}`;
    this.ctx.store.db
      .prepare(`INSERT OR IGNORE INTO github_merge_fences
      (fence_key, hostname, repository, pr_number, attempt_id, command_id, expected_head_oid,
       workspace_id, host_id, head_repository, head_ref_name, state, started_at, updated_at)
      VALUES (?, 'github.com', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', ?, ?)`)
      .run(
        key,
        repository,
        pr.number,
        `legacy:${randomUUID()}`,
        `legacy:${ws.id}`,
        typeof pr.headRefOid === "string" ? pr.headRefOid : "",
        ws.id,
        ws.hostId,
        snapshot.headRepository ?? null,
        snapshot.branch ?? null,
        snapshot.attemptedAt ?? this.ctx.store.nowIso(),
        this.ctx.store.nowIso(),
      );
  }

  /** All completion/reconciliation writes compare BOTH immutable generation and attempt. */
  private finishFence(
    fence: MergeFence,
    clear: boolean,
    refreshed?: { workspaceId: string; nodeId: string },
  ): void {
    this.ctx.store.tx(() => {
      if (clear) {
        const deleted = this.ctx.store.db
          .prepare("DELETE FROM github_merge_fences WHERE id = ? AND attempt_id = ?")
          .run(fence.id, fence.attempt_id);
        if (Number(deleted.changes) === 0) return;
        for (const ws of this.ctx.store.workspaces.list()) {
          const snapshot = ws.github;
          const pr = snapshot?.pullRequest;
          if (ws.id === refreshed?.workspaceId || snapshot?.reason !== UNKNOWN_MERGE_REASON || !pr)
            continue;
          const matches = fence.pull_request_node_id
            ? pr.nodeId === fence.pull_request_node_id
            : sameRepo(snapshot.repository, fence.repository) &&
              pr.number === fence.pr_number &&
              (!pr.nodeId || pr.nodeId === refreshed?.nodeId);
          if (!matches) continue;
          // Clearing one generation never removes another attempt's display protection.
          const github = overlayMergeFence(this.ctx.store, snapshot);
          if (findMergeFence(this.ctx.store, snapshot)) {
            if (JSON.stringify(github) !== JSON.stringify(snapshot))
              this.ctx.store.putWorkspace({ ...ws, github });
          } else {
            const next = { ...ws };
            delete next.github;
            this.ctx.store.putWorkspace(next);
          }
        }
      } else
        this.ctx.store.db
          .prepare(
            "UPDATE github_merge_fences SET state = 'unknown', updated_at = ? WHERE id = ? AND attempt_id = ?",
          )
          .run(this.ctx.store.nowIso(), fence.id, fence.attempt_id);
    });
  }

  private reconcileFence(
    snapshot: WorkspaceGitHub,
    captured: Reconciliation,
    workspaceId: string,
  ): void {
    const pr = snapshot.pullRequest;
    if (
      snapshot.status !== "ready" ||
      !pr?.nodeId?.trim() ||
      !snapshot.repository ||
      !snapshot.headRepository ||
      !sameRepo(snapshot.headRepository, pr.headRepository) ||
      snapshot.branch !== pr.headRefName ||
      !snapshot.checksComplete ||
      !snapshot.threadsComplete ||
      snapshot.truncated ||
      this.merging.has(`github.com:${pr.nodeId}`)
    )
      return;
    // There can be both an imported legacy alias and a node fence. Neither can clear a
    // different verified node just because a slug/number was later reused.
    const fences = this.ctx.store.db
      .prepare(`SELECT * FROM github_merge_fences
      WHERE hostname = 'github.com' AND id <= ? AND
        (pull_request_node_id = ? OR (pull_request_node_id IS NULL AND repository = ? COLLATE NOCASE AND pr_number = ?))`)
      .all(
        captured.generation,
        pr.nodeId,
        snapshot.repository,
        pr.number,
      ) as unknown as MergeFence[];
    for (const fence of fences) {
      if (
        !captured.live.has(fence.attempt_id) &&
        ![...this.merging.values()].includes(fence.attempt_id)
      ) {
        // Association of legacy aliases is proven by this response alone, never an event.
        if (fence.pull_request_node_id === null)
          this.ctx.store.db
            .prepare(`UPDATE github_merge_fences
          SET pull_request_node_id = ? WHERE id = ? AND attempt_id = ? AND pull_request_node_id IS NULL
            AND repository = ? COLLATE NOCASE AND pr_number = ?`)
            .run(pr.nodeId, fence.id, fence.attempt_id, snapshot.repository, pr.number);
        this.finishFence(fence, true, { workspaceId, nodeId: pr.nodeId });
      }
    }
  }

  private mergeEligible(ws: Workspace, expectedHeadOid: string): void {
    if (
      this.ctx.store.db
        .prepare("SELECT 1 FROM settings WHERE key GLOB 'githubCorruptedMergeMarker:*' LIMIT 1")
        .get()
    )
      conflict("Manual reconciliation of the corrupted unknown merge marker is required.");
    if (ws.github && findMergeFence(this.ctx.store, ws.github)) conflict(UNKNOWN_MERGE_REASON);
    this.capable(ws);
    const pr = this.association(ws, expectedHeadOid);
    const snapshot = ws.github!;
    if (!pr.nodeId?.trim()) conflict("Refresh to verify the PR node identity before merging.");
    const age = this.ctx.store.now().getTime() - Date.parse(snapshot.fetchedAt!);
    if (age < 0 || age > 60_000) conflict("PR snapshot is stale. Refresh before merging.");
    if (pr.mergeQueueEnabled || pr.inMergeQueue)
      conflict("Merge queues are not supported by this action; merge on GitHub.");
    if (!snapshot.checksComplete || !snapshot.threadsComplete || snapshot.truncated)
      conflict("PR data is incomplete. Refresh before merging.");
    if (
      pr.state !== "OPEN" ||
      pr.isDraft ||
      pr.mergeable !== "MERGEABLE" ||
      pr.mergeStateStatus !== "CLEAN" ||
      (pr.reviewDecision !== null && pr.reviewDecision !== "APPROVED") ||
      !pr.squashMergeAllowed ||
      pr.autoMergeEnabled ||
      snapshot.checks.some((check) => check.bucket !== "pass" && check.bucket !== "skipping")
    )
      conflict("PR is not eligible for a guarded squash merge. Refresh or merge on GitHub.");
  }

  private stale(ws: Workspace, reason: string): void {
    const current = this.ctx.store.workspaces.get(ws.id);
    if (!current || identity(current) !== identity(ws) || !current.github) return;
    if (
      ws.github &&
      (current.github.headRepository?.toLowerCase() !== ws.github.headRepository?.toLowerCase() ||
        current.github.repository?.toLowerCase() !== ws.github.repository?.toLowerCase() ||
        current.github.pullRequest?.number !== ws.github.pullRequest?.number ||
        current.github.pullRequest?.nodeId !== ws.github.pullRequest?.nodeId ||
        current.github.pullRequest?.headRefOid !== ws.github.pullRequest?.headRefOid)
    )
      return;
    this.ctx.store.putWorkspace({
      ...current,
      github: overlayMergeFence(this.ctx.store, {
        ...current.github,
        status: "error",
        reason,
        checksComplete: false,
        threadsComplete: false,
      }),
      updatedAt: this.ctx.store.nowIso(),
    });
  }

  async merge(id: string, expectedHeadOid: string): Promise<GitHubMergeResult> {
    const ws = this.workspace(id);
    this.mergeEligible(ws, expectedHeadOid);
    const pr = ws.github!.pullRequest!;
    const key = `github.com:${pr.nodeId!}`;
    const version = this.versions.get(id) ?? 0;
    if (this.merging.has(key)) conflict("A merge is already in progress. Refresh before retrying.");
    const attemptId = randomUUID();
    const commandId = `merge_${attemptId}`;
    this.merging.set(key, attemptId);
    let fence: MergeFence | undefined;
    try {
      let result: GitHubMergeResult;
      try {
        const raw = await this.ctx.hostHub.request(
          ws.hostId,
          {
            type: "workspace.prMerge",
            path: ws.path,
            repository: ws.github!.repository!,
            number: pr.number,
            expectedHeadOid,
            expectedPullRequestNodeId: pr.nodeId!,
          },
          {
            commandId,
            timeoutMs: 60_000,
            beforeSend: () => {
              fence = this.ctx.store.tx(() => {
                const current = this.current(ws);
                if ((this.versions.get(id) ?? 0) !== version)
                  conflict("Workspace identity changed before merge");
                this.mergeEligible(current, expectedHeadOid);
                if (
                  current.github!.pullRequest!.nodeId !== pr.nodeId ||
                  !sameRepo(current.github!.repository, ws.github!.repository) ||
                  current.github!.pullRequest!.number !== pr.number
                )
                  conflict("PR association changed");
                // Same-attempt fences also reject reconnect replay: no receipt is not
                // evidence of no external effect. No await between reservation and send.
                const now = this.ctx.store.nowIso();
                const inserted = this.ctx.store.db
                  .prepare(`INSERT INTO github_merge_fences
                  (fence_key, hostname, pull_request_node_id, repository, pr_number,
                   attempt_id, command_id, expected_head_oid, workspace_id, host_id,
                   head_repository, head_ref_name, state, started_at, updated_at)
                  VALUES (?, 'github.com', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
                  .run(
                    key,
                    pr.nodeId!,
                    ws.github!.repository!,
                    pr.number,
                    attemptId,
                    commandId,
                    expectedHeadOid,
                    ws.id,
                    ws.hostId,
                    ws.github!.headRepository,
                    ws.github!.branch,
                    now,
                    now,
                  );
                this.stale(ws, UNKNOWN_MERGE_REASON);
                return {
                  id: Number(inserted.lastInsertRowid),
                  fence_key: key,
                  pull_request_node_id: pr.nodeId!,
                  repository: ws.github!.repository!,
                  pr_number: pr.number,
                  attempt_id: attemptId,
                };
              });
            },
          },
        );
        const parsed = GitHubMergeResult.safeParse(raw);
        if (!parsed.success)
          throw new SwitchyardError("internal", "Invalid merge response from host");
        result = parsed.data;
        if (
          !sameRepo(result.repository, ws.github!.repository) ||
          result.number !== pr.number ||
          result.expectedHeadOid !== expectedHeadOid ||
          result.url.toLowerCase() !== pr.url.toLowerCase()
        )
          throw new SwitchyardError("internal", "Invalid merge association from host");
      } catch (err) {
        if (fence) {
          result = {
            status: "outcome_unknown",
            github: this.ctx.store.hosts.get(ws.hostId)?.github ?? {
              available: false,
              reason: "Host GitHub support changed",
            },
            repository: ws.github!.repository!,
            number: pr.number,
            url: pr.url,
            expectedHeadOid,
            reason: UNKNOWN_MERGE_REASON,
            attemptedAt: this.ctx.store.nowIso(),
          };
        } else {
          this.stale(ws, "Merge was not completed. Refresh before retrying.");
          throw err;
        }
      }
      if (fence) this.finishFence(fence, result.status === "merged");
      if (!this.stopped) {
        this.saveCapability(ws.hostId, result.github);
        if (result.status === "outcome_unknown") this.stale(ws, UNKNOWN_MERGE_REASON);
        else {
          this.stale(ws, "PR merged. Refreshing GitHub snapshot.");
          if (this.merging.get(key) === attemptId) this.merging.delete(key);
          // A failed follow-up read must not erase a confirmed external mutation.
          try {
            await this.refresh(id);
          } catch (err) {
            this.ctx.log.debug({ err, workspaceId: id }, "Post-merge refresh failed");
          }
        }
      }
      return result;
    } finally {
      if (this.merging.get(key) === attemptId) this.merging.delete(key);
    }
  }
}
