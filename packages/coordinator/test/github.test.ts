import type {
  GitHubLogs,
  GitHubMergeResult,
  GitHubViewResult,
  Workspace,
  WorkspaceGitHub,
} from "@switchyard/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findMergeFence, GitHubService, UNKNOWN_MERGE_REASON } from "../src/github.js";
import { requireService } from "../src/services.js";
import { recordCreatedWorkspace, refreshCheckoutWorkspaces } from "../src/workspaces.js";
import {
  enrollHost,
  FakeHost,
  hostSession,
  NO_REPLY,
  startCoordinator,
  type TestCoordinator,
  until,
} from "./helpers.js";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const AVAILABLE = { available: true, reason: null };
let t: TestCoordinator;
const hosts: FakeHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  await t?.cleanup();
});

function snapshot(over: Partial<WorkspaceGitHub> = {}): WorkspaceGitHub {
  return {
    repository: "upstream/app",
    headRepository: "fork/app",
    branch: "topic",
    fetchedAt: t.c.store.nowIso(),
    attemptedAt: t.c.store.nowIso(),
    status: "ready",
    reason: null,
    pullRequest: {
      nodeId: "PR_node_A",
      number: 23,
      url: "https://github.com/upstream/app/pull/23",
      title: "Fix",
      state: "OPEN",
      isDraft: false,
      headRefName: "topic",
      headRefOid: SHA,
      headRepository: "fork/app",
      baseRefName: "main",
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: null,
      mergeQueueEnabled: false,
      inMergeQueue: false,
      autoMergeEnabled: false,
      squashMergeAllowed: true,
    },
    checks: [],
    checksComplete: true,
    threads: [],
    threadsComplete: true,
    truncated: false,
    ...over,
  };
}

async function setup(github: unknown = AVAILABLE, deferGitHubStart = false) {
  // Legacy fixtures must exist before the FIRST compatibility pass, not by resetting its marker.
  const startup = deferGitHubStart
    ? vi.spyOn(GitHubService.prototype, "start").mockImplementationOnce(() => {})
    : undefined;
  try {
    t = await startCoordinator({
      dispatcher: { tickMs: 0 },
      schedulerTickMs: 0,
      projectScanIntervalMs: 0,
      cacheAlertTickMs: 0,
    });
  } finally {
    startup?.mockRestore();
  }
  const creds = await enrollHost(t);
  const host = new FakeHost(t.c.localUrl.replace("http", "ws"), creds.hostId, creds.credential);
  hosts.push(host);
  await host.open({ github });
  const store = t.c.store;
  const now = store.nowIso();
  store.putProject({
    id: "project",
    name: "App",
    repoIdentity: "https://github.com/upstream/app",
    defaultProfileId: null,
    defaultHostId: creds.hostId,
    maxConcurrentRuns: 1,
    automationEnabled: false,
    setupCommand: null,
    checks: [],
    workspaceSharing: "single_writer",
    worktreeDir: ".worktrees",
    createdAt: now,
    updatedAt: now,
  });
  store.putCheckout({
    id: "checkout",
    projectId: "project",
    hostId: creds.hostId,
    path: "/repo",
    commonDir: "/repo/.git",
    defaultBranch: "main",
    createdAt: now,
  });
  const ws: Workspace = {
    id: "workspace",
    hostId: creds.hostId,
    projectId: "project",
    checkoutId: "checkout",
    path: "/repo/topic",
    branch: "topic",
    baseBranch: "main",
    provenance: "managed",
    git: { dirty: false, changedFiles: 0, ahead: 1, behind: 0, unmerged: true },
    setup: { state: "none", log: "" },
    archivedAt: null,
    updatedAt: now,
  };
  store.putWorkspace(ws);
  host.handler = (command) =>
    command.type === "workspace.prView"
      ? ({ github: AVAILABLE, snapshot: snapshot() } satisfies GitHubViewResult)
      : null;
  return { host, ws, creds, service: requireService(t.c.ctx, "github") };
}

function putSnapshot(value = snapshot()) {
  t.c.store.putWorkspace({ ...t.c.store.workspaces.require("workspace"), github: value });
}
function route(suffix = "") {
  return `/api/workspaces/workspace/pr${suffix}`;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("coordinator GitHub discovery", () => {
  it("authenticates, discovers once, caches no-PR, and reprobes unavailable hosts only explicitly", async () => {
    const { host, creds } = await setup({ available: false, reason: "Sign in to gh" });
    expect(t.c.store.hosts.require(creds.hostId).github).toEqual({
      available: false,
      reason: "Sign in to gh",
    });
    expect((await t.api("GET", route())).status).toBe(401);
    expect((await t.admin("GET", route())).body).toEqual({
      github: { available: false, reason: "Sign in to gh" },
      snapshot: null,
    });
    expect(host.commands).toHaveLength(0);
    const noPr = snapshot({ pullRequest: null });
    host.handler = () => ({ github: AVAILABLE, snapshot: noPr });
    expect((await t.admin("POST", route("/refresh"))).body.snapshot).toEqual(noPr);
    expect(t.c.store.hosts.require(creds.hostId).github).toEqual(AVAILABLE);
    expect((await t.admin("GET", route())).body.snapshot.pullRequest).toBeNull();
    expect(host.commands).toHaveLength(1);
  });

  it("keeps legacy and offline data browsable without sending unsupported commands", async () => {
    const { host, creds } = await setup(undefined);
    // setup's default is available; a legacy replacement must clear that advertisement.
    await host.close();
    await host.open({ github: undefined });
    putSnapshot();
    expect(t.c.store.hosts.require(creds.hostId).github).toBeUndefined();
    expect((await t.admin("GET", route())).body.github).toBeNull();
    expect((await t.admin("POST", route("/refresh"))).body.error.code).toBe(
      "unsupported_capability",
    );
    await host.close();
    await host.open({ github: AVAILABLE });
    await host.close();
    await until(() => !t.c.hostHub.isConnected(creds.hostId));
    expect((await t.admin("GET", route())).body.snapshot.pullRequest.headRefOid).toBe(SHA);
    expect((await t.admin("POST", route("/refresh"))).body.error.code).toBe("host_unreachable");
    expect(host.commands).toHaveLength(0);
  });

  it("coalesces background discovery and settlement but gives explicit refresh its own fetch", async () => {
    const { host, service } = await setup();
    const gate = deferred<GitHubViewResult>();
    host.handler = () => gate.promise;
    const first = service.view("workspace");
    const second = service.refresh("workspace", true);
    await host.event(
      "session.updated",
      hostSession("session", { cwd: "/repo/topic", runtime: "running" }),
    );
    await host.event("session.updated", hostSession("session", { runtime: "idle" }));
    await until(() => host.commands.length === 1);
    gate.resolve({ github: AVAILABLE, snapshot: snapshot() });
    expect((await first).snapshot?.status).toBe("ready");
    await second;
    expect(host.commands).toHaveLength(2);
    await host.event("session.updated", hostSession("session", { runtime: "running" }));
    await host.event("session.updated", hostSession("session", { runtime: "idle" }));
    await until(() => host.commands.length === 3);
    await until(() => t.c.store.workspaces.require("workspace").github?.status === "ready");
    await host.event("session.updated", hostSession("session", { title: "Ordinary edit" }));
    expect(host.commands).toHaveLength(3);
  });

  it("rejects late results across branch identity changes, even if the branch changes back", async () => {
    const { host, service, ws } = await setup();
    const gate = deferred<GitHubViewResult>();
    host.handler = () => gate.promise;
    const pending = service.refresh(ws.id);
    const rejected = expect(pending).rejects.toMatchObject({ code: "conflict" });
    await until(() => host.commands.length === 1);
    t.c.store.putWorkspace({ ...ws, branch: "elsewhere" });
    t.c.store.putWorkspace(ws);
    gate.resolve({ github: AVAILABLE, snapshot: snapshot() });
    await rejected;
    expect(t.c.store.workspaces.require(ws.id).github).toBeUndefined();
  });

  it("validates host snapshots and does not overwrite newer head/repository observations", async () => {
    const { host, service } = await setup();
    host.handler = () => ({ github: AVAILABLE, snapshot: { ...snapshot(), injected: true } });
    await expect(service.refresh("workspace")).rejects.toMatchObject({ code: "internal" });
    const gate = deferred<GitHubViewResult>();
    host.handler = () => gate.promise;
    const pending = service.refresh("workspace");
    const rejected = expect(pending).rejects.toMatchObject({ code: "conflict" });
    await until(() => host.commands.length === 2);
    const newer = snapshot();
    newer.pullRequest!.headRefOid = OTHER;
    await host.event("workspace.updated", { path: "/repo/topic", github: newer });
    gate.resolve({ github: AVAILABLE, snapshot: snapshot() });
    await rejected;
    expect(t.c.store.workspaces.require("workspace").github?.pullRequest?.headRefOid).toBe(OTHER);
  });

  it("accepts partial/full host GitHub updates while preserving coordinator fields and reconstruction", async () => {
    const { host, ws } = await setup();
    const value = snapshot();
    await host.event("workspace.updated", {
      ...ws,
      projectId: "not-authoritative",
      checkoutId: "not-authoritative",
      provenance: "discovered",
      archivedAt: t.c.store.nowIso(),
      github: value,
    });
    expect(t.c.store.workspaces.require(ws.id)).toMatchObject({
      projectId: ws.projectId,
      checkoutId: ws.checkoutId,
      provenance: "managed",
      archivedAt: null,
      github: value,
    });
    const project = t.c.store.projects.require("project");
    const checkout = t.c.store.checkouts.require("checkout");
    expect(
      recordCreatedWorkspace(t.c.ctx, project, checkout, {
        path: ws.path,
        branch: "topic",
        baseBranch: "main",
      }).github,
    ).toEqual(value);
    host.handler = () => [
      {
        path: ws.path,
        head: SHA,
        branch: "refs/heads/topic",
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
        provenance: "discovered",
        git: null,
      },
    ];
    expect((await refreshCheckoutWorkspaces(t.c.ctx, checkout))[0]?.github).toEqual(value);
    await host.event("workspace.updated", { path: ws.path, branch: "another" });
    expect(t.c.store.workspaces.require(ws.id).github).toBeUndefined();
  });
});

function unknownResult(): GitHubMergeResult {
  return {
    status: "outcome_unknown",
    github: AVAILABLE,
    repository: "upstream/app",
    number: 23,
    url: "https://github.com/upstream/app/pull/23",
    expectedHeadOid: SHA,
    reason: "Connection lost",
    attemptedAt: t.c.store.nowIso(),
  };
}
function mergedResult(): GitHubMergeResult {
  return {
    status: "merged",
    github: AVAILABLE,
    repository: "upstream/app",
    number: 23,
    url: "https://github.com/upstream/app/pull/23",
    expectedHeadOid: SHA,
    mergeCommitOid: null,
    confirmedAt: t.c.store.nowIso(),
  };
}
function fences(): any[] {
  return t.c.store.db.prepare("SELECT * FROM github_merge_fences ORDER BY id").all();
}
/** Simulate a later durable generation without running any external mutation. */
function replaceFence(attemptId = "newer-attempt") {
  const old = fences()[0];
  t.c.store.db.prepare("DELETE FROM github_merge_fences WHERE id = ?").run(old.id);
  t.c.store.db
    .prepare(`INSERT INTO github_merge_fences
    (fence_key, hostname, pull_request_node_id, repository, pr_number, attempt_id,
     command_id, expected_head_oid, workspace_id, host_id, head_repository, head_ref_name,
     state, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', ?, ?)`)
    .run(
      old.fence_key,
      old.hostname,
      old.pull_request_node_id,
      old.repository,
      old.pr_number,
      attemptId,
      `merge_${attemptId}`,
      old.expected_head_oid,
      old.workspace_id,
      old.host_id,
      old.head_repository,
      old.head_ref_name,
      old.started_at,
      old.updated_at,
    );
  return fences()[0];
}

async function makeUnknown() {
  const ctx = await setup();
  putSnapshot();
  ctx.host.handler = () => unknownResult();
  expect((await ctx.service.merge("workspace", SHA)).status).toBe("outcome_unknown");
  return ctx;
}

describe("durable PR identity merge fences", () => {
  it("reserves the immutable attempt before write and treats every post-insert error as unknown", async () => {
    const { host, service, creds } = await setup();
    putSnapshot();
    let atWrite: any[] = [];
    host.handler = () => {
      atWrite = fences();
      return { __error: { code: "conflict", message: "No receipt is not proof of no write" } };
    };
    expect((await service.merge("workspace", SHA)).status).toBe("outcome_unknown");
    expect(host.commands[0]?.command).toMatchObject({
      type: "workspace.prMerge",
      expectedPullRequestNodeId: "PR_node_A",
    });
    expect(atWrite).toEqual([
      expect.objectContaining({
        fence_key: "github.com:PR_node_A",
        pull_request_node_id: "PR_node_A",
        state: "pending",
        command_id: host.commands[0]?.commandId,
        repository: "upstream/app",
        pr_number: 23,
        expected_head_oid: SHA,
        workspace_id: "workspace",
        host_id: creds.hostId,
        head_repository: "fork/app",
        head_ref_name: "topic",
      }),
    ]);
    expect(host.commands[0]?.commandId).toBe(`merge_${atWrite[0].attempt_id}`);
    expect(atWrite[0].attempt_id).toMatch(/^[\da-f-]{36}$/);
    expect(fences()[0].state).toBe("unknown");
    putSnapshot(); // Even a caller bypassing display overlays cannot grant eligibility.
    await expect(service.merge("workspace", SHA)).rejects.toMatchObject({ code: "conflict" });
    expect(host.commands).toHaveLength(1);
  });

  it.each(["malformed", "wrong-association"])(
    "preserves uncertainty on %s host results",
    async (kind) => {
      const { host, service } = await setup();
      putSnapshot();
      host.handler = () =>
        kind === "malformed" ? { status: "merged" } : { ...mergedResult(), expectedHeadOid: OTHER };
      expect((await service.merge("workspace", SHA)).status).toBe("outcome_unknown");
      expect(fences()[0].state).toBe("unknown");
    },
  );

  it("requires verified node identity and creates no fence for pre-send failures or branch ABA", async () => {
    const { host, service } = await setup();
    const legacy = snapshot();
    delete legacy.pullRequest!.nodeId;
    putSnapshot(legacy);
    await expect(service.merge("workspace", SHA)).rejects.toMatchObject({ code: "conflict" });
    putSnapshot();
    const request = t.c.hostHub.request.bind(t.c.hostHub);
    const spy = vi.spyOn(t.c.hostHub, "request").mockImplementationOnce((hostId, cmd, opts) => {
      const ws = t.c.store.workspaces.require("workspace");
      t.c.store.putWorkspace({ ...ws, branch: "other" });
      t.c.store.putWorkspace(ws);
      return request(hostId, cmd, opts);
    });
    await expect(service.merge("workspace", SHA)).rejects.toMatchObject({ code: "conflict" });
    spy.mockRestore();
    expect(fences()).toHaveLength(0);
    expect(host.commands).toHaveLength(0);
  });

  it("survives A to B to A and unsolicited ready snapshots, without fencing a different PR", async () => {
    const { host, service } = await makeUnknown();
    const b = snapshot({ branch: "other" });
    b.pullRequest = {
      ...b.pullRequest!,
      nodeId: "PR_node_B",
      number: 24,
      headRefName: "other",
      url: "https://github.com/upstream/app/pull/24",
    };
    await host.event("workspace.updated", { path: "/repo/topic", branch: "other", github: b });
    expect((await service.view("workspace")).snapshot?.status).toBe("ready");
    expect(findMergeFence(t.c.store, b)).toBeUndefined();
    await host.event("workspace.updated", {
      path: "/repo/topic",
      branch: "topic",
      github: snapshot(),
    });
    expect((await service.view("workspace")).snapshot?.reason).toBe(UNKNOWN_MERGE_REASON);
    await expect(service.merge("workspace", SHA)).rejects.toMatchObject({ code: "conflict" });
    expect(fences()).toHaveLength(1);
    expect(host.commands).toHaveLength(1);
  });

  it("shares a node fence across workspace/host deletion, cache removal, repo rename and case", async () => {
    const { ws, creds } = await makeUnknown();
    const store = t.c.store;
    store.putWorkspace({ ...ws, github: undefined, archivedAt: store.nowIso() });
    store.putHost({ ...store.hosts.require(creds.hostId), revokedAt: store.nowIso() });
    store.workspaces.delete(ws.id);
    store.hosts.delete(creds.hostId);
    expect(fences()).toHaveLength(1);
    const newCreds = await enrollHost(t);
    const replacement = new FakeHost(
      t.c.localUrl.replace("http", "ws"),
      newCreds.hostId,
      newCreds.credential,
    );
    hosts.push(replacement);
    await replacement.open({ github: AVAILABLE });
    store.putCheckout({
      ...store.checkouts.require("checkout"),
      id: "new-checkout",
      hostId: newCreds.hostId,
    });
    const renamed = snapshot({ repository: "NEW-owner/Renamed" });
    renamed.pullRequest!.url = "https://github.com/NEW-owner/Renamed/pull/23";
    store.putWorkspace({
      ...ws,
      id: "new-workspace",
      hostId: newCreds.hostId,
      checkoutId: "new-checkout",
      github: renamed,
    });
    const service = requireService(t.c.ctx, "github");
    expect((await service.view("new-workspace")).snapshot?.reason).toBe(UNKNOWN_MERGE_REASON);
    await expect(service.merge("new-workspace", SHA)).rejects.toMatchObject({ code: "conflict" });
    expect(replacement.commands).toHaveLength(0);
    replacement.handler = () => ({ github: AVAILABLE, snapshot: renamed });
    expect((await service.refresh("new-workspace", true)).snapshot?.status).toBe("ready");
    expect(fences()).toHaveLength(0);
  });

  it("reapplies the durable overlay to reconstructed, buffered and full new workspaces", async () => {
    const { host, ws } = await makeUnknown();
    const store = t.c.store;
    store.putWorkspace({ ...ws, github: snapshot() }); // A display cache may be independently rebuilt.
    expect(
      recordCreatedWorkspace(
        t.c.ctx,
        store.projects.require("project"),
        store.checkouts.require("checkout"),
        {
          path: ws.path,
          branch: ws.branch!,
          baseBranch: "main",
        },
      ).github?.reason,
    ).toBe(UNKNOWN_MERGE_REASON);
    store.workspaces.delete(ws.id);
    await host.event("workspace.updated", { path: "/repo/buffered", github: snapshot() });
    expect(
      recordCreatedWorkspace(
        t.c.ctx,
        store.projects.require("project"),
        store.checkouts.require("checkout"),
        {
          path: "/repo/buffered",
          branch: ws.branch!,
          baseBranch: "main",
        },
      ).github?.reason,
    ).toBe(UNKNOWN_MERGE_REASON);
    await host.event("workspace.updated", {
      ...ws,
      id: "full",
      path: "/repo/full",
      github: snapshot(),
    });
    expect(store.workspaces.require("full").github?.reason).toBe(UNKNOWN_MERGE_REASON);
    host.handler = () => [
      {
        path: "/repo/full",
        branch: "refs/heads/topic",
        head: SHA,
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
        provenance: "discovered",
        git: null,
      },
    ];
    expect(
      (await refreshCheckoutWorkspaces(t.c.ctx, store.checkouts.require("checkout")))[0]?.github
        ?.reason,
    ).toBe(UNKNOWN_MERGE_REASON);
    expect(fences()).toHaveLength(1);
  });

  it("converts orphaned pending fences to unknown on coordinator restart even without any display cache", async () => {
    const { creds, ws } = await makeUnknown();
    const original = fences()[0];
    t.c.store.db.exec("UPDATE github_merge_fences SET state = 'pending'");
    t.c.store.workspaces.delete(ws.id);
    const dir = t.dir;
    await t.stop();
    t = await startCoordinator({
      dir,
      dispatcher: { tickMs: 0 },
      schedulerTickMs: 0,
      projectScanIntervalMs: 0,
    });
    expect(fences()).toEqual([
      expect.objectContaining({
        id: original.id,
        attempt_id: original.attempt_id,
        state: "unknown",
      }),
    ]);
    const host = new FakeHost(t.c.localUrl.replace("http", "ws"), creds.hostId, creds.credential);
    hosts.push(host);
    await host.open({ github: AVAILABLE });
    t.c.store.putWorkspace({ ...ws, id: "recreated", github: snapshot() });
    const service = requireService(t.c.ctx, "github");
    await expect(service.merge("recreated", SHA)).rejects.toMatchObject({ code: "conflict" });
    expect(host.commands).toHaveLength(0);
  });

  it("failed transport or malformed explicit refresh cannot remove an existing fence", async () => {
    const { host, service } = await makeUnknown();
    for (const response of [
      { __error: { code: "timeout", message: "Network failed" } },
      { snapshot: {} },
    ]) {
      host.handler = () => response;
      await expect(service.refresh("workspace", true)).rejects.toBeDefined();
      expect(fences()).toHaveLength(1);
      expect((await service.view("workspace")).snapshot?.reason).toBe(UNKNOWN_MERGE_REASON);
    }
  });

  it("does not clear a verified different node when the slug and PR number are reused", async () => {
    const { host, service } = await makeUnknown();
    const other = snapshot();
    other.pullRequest!.nodeId = "PR_node_different";
    host.handler = () => ({ github: AVAILABLE, snapshot: other });
    expect((await service.refresh("workspace", true)).snapshot?.status).toBe("ready");
    expect(fences()).toHaveLength(1);
    host.handler = () => ({ ...unknownResult() });
    expect((await service.merge("workspace", SHA)).status).toBe("outcome_unknown");
    expect(fences()).toHaveLength(2);
  });

  it.each(["OPEN", "CLOSED", "MERGED"] as const)(
    "only a fresh explicit complete same-node %s observation reconciles",
    async (state) => {
      const { host, service } = await makeUnknown();
      const observed = snapshot();
      observed.pullRequest!.state = state;
      host.handler = () => ({ github: AVAILABLE, snapshot: observed });
      expect((await service.refresh("workspace")).snapshot?.reason).toBe(UNKNOWN_MERGE_REASON);
      expect(fences()).toHaveLength(1);
      expect((await service.refresh("workspace", true)).snapshot?.status).toBe("ready");
      expect(fences()).toHaveLength(0);
      expect(host.commands.filter((c) => c.command.type === "workspace.prMerge")).toHaveLength(1);
    },
  );

  it.each([
    "no-pr",
    "different-pr",
    "partial-checks",
    "partial-threads",
    "truncated",
    "error",
    "missing-node",
  ])("does not reconcile a %s explicit refresh", async (kind) => {
    const { host, service } = await makeUnknown();
    const observed = snapshot();
    if (kind === "no-pr") observed.pullRequest = null;
    if (kind === "different-pr") observed.pullRequest!.nodeId = "PR_node_B";
    if (kind === "missing-node") delete observed.pullRequest!.nodeId;
    if (kind === "partial-checks") observed.checksComplete = false;
    if (kind === "partial-threads") observed.threadsComplete = false;
    if (kind === "truncated") observed.truncated = true;
    if (kind === "error")
      Object.assign(observed, {
        status: "error",
        reason: "Network failed",
        checksComplete: false,
        threadsComplete: false,
      });
    host.handler = () => ({ github: AVAILABLE, snapshot: observed });
    await service.refresh("workspace", true);
    expect(fences()).toHaveLength(1);
    putSnapshot();
    await expect(service.merge("workspace", SHA)).rejects.toMatchObject({ code: "conflict" });
  });

  it("imports node-less legacy snapshots on service startup and only reconciles their exact canonical target", async () => {
    const { host, service } = await setup(AVAILABLE, true);
    const legacy = snapshot({
      status: "error",
      reason: UNKNOWN_MERGE_REASON,
      checksComplete: false,
      threadsComplete: false,
    });
    delete legacy.pullRequest!.nodeId;
    putSnapshot(legacy);
    service.start();
    expect(fences()[0]).toMatchObject({
      fence_key: "legacy:github.com:upstream/app:23",
      pull_request_node_id: null,
      expected_head_oid: SHA,
    });
    const renamed = snapshot({ repository: "other/repo" });
    renamed.pullRequest!.url = "https://github.com/other/repo/pull/23";
    host.handler = () => ({ github: AVAILABLE, snapshot: renamed });
    await service.refresh("workspace", true);
    expect(fences()).toHaveLength(1);
    await host.event("workspace.updated", { path: "/repo/topic", github: snapshot() });
    expect(fences()[0].pull_request_node_id).toBeNull();
    await expect(service.merge("workspace", SHA)).rejects.toMatchObject({ code: "conflict" });
    host.handler = () => ({
      github: AVAILABLE,
      snapshot: snapshot({ repository: "UPSTREAM/App" }),
    });
    await service.refresh("workspace", true);
    expect(fences()).toHaveLength(0);
  });

  it("fails closed on a corrupt unknown marker even after its display and workspace are removed", async () => {
    const { service, ws } = await setup(AVAILABLE, true);
    putSnapshot(
      snapshot({
        status: "error",
        reason: UNKNOWN_MERGE_REASON,
        pullRequest: null,
        repository: null,
        checksComplete: false,
        threadsComplete: false,
      }),
    );
    service.start();
    t.c.store.workspaces.delete(ws.id);
    t.c.store.putWorkspace({ ...ws, github: snapshot() });
    await expect(service.merge("workspace", SHA)).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("Manual reconciliation"),
    });
    expect(fences()).toHaveLength(0);
  });

  it("runs an explicit fetch after any earlier background fetch instead of borrowing its result", async () => {
    const { host, service } = await makeUnknown();
    const background = deferred<GitHubViewResult>();
    const fresh = deferred<GitHubViewResult>();
    host.handler = () => (host.commands.length === 2 ? background.promise : fresh.promise);
    const first = service.refresh("workspace");
    await until(() => host.commands.length === 2);
    const explicit = service.refresh("workspace", true);
    background.resolve({ github: AVAILABLE, snapshot: snapshot() });
    await first;
    await until(() => host.commands.length === 3);
    expect(fences()).toHaveLength(1);
    fresh.resolve({ github: AVAILABLE, snapshot: snapshot() });
    await explicit;
    expect(fences()).toHaveLength(0);
  });

  it("a refresh started before an attempt cannot clear the newer generation", async () => {
    const { host, service } = await setup();
    putSnapshot();
    const gate = deferred<GitHubViewResult>();
    host.handler = (cmd) => (cmd.type === "workspace.prView" ? gate.promise : unknownResult());
    const refresh = service.refresh("workspace", true);
    await until(() => host.commands.length === 1);
    await service.merge("workspace", SHA);
    gate.resolve({ github: AVAILABLE, snapshot: snapshot() });
    expect((await refresh).snapshot?.reason).toBe(UNKNOWN_MERGE_REASON);
    expect(fences()).toHaveLength(1);
  });

  it("an active-at-start attempt cannot be cleared even after it settles before the refresh", async () => {
    const { host, service } = await setup();
    putSnapshot();
    const mergeGate = deferred<GitHubMergeResult>();
    const refreshGate = deferred<GitHubViewResult>();
    host.handler = (cmd) =>
      cmd.type === "workspace.prMerge" ? mergeGate.promise : refreshGate.promise;
    const merge = service.merge("workspace", SHA);
    await until(() => host.commands.length === 1);
    const refresh = service.refresh("workspace", true);
    await until(() => host.commands.length === 2);
    mergeGate.resolve(unknownResult());
    await merge;
    refreshGate.resolve({ github: AVAILABLE, snapshot: snapshot() });
    expect((await refresh).snapshot?.reason).toBe(UNKNOWN_MERGE_REASON);
    expect(fences()).toHaveLength(1);
  });

  it("a fence replaced while a refresh is in flight survives its older generation", async () => {
    const { host, service } = await makeUnknown();
    const old = fences()[0];
    const gate = deferred<GitHubViewResult>();
    host.handler = () => gate.promise;
    const refresh = service.refresh("workspace", true);
    await until(() => host.commands.length === 2);
    const newer = replaceFence();
    expect(newer.id).toBeGreaterThan(old.id);
    gate.resolve({ github: AVAILABLE, snapshot: snapshot() });
    await refresh;
    expect(fences()).toEqual([newer]);
  });

  it("a late old confirmed merge cannot clear a newer attempt, and stays success across branch changes", async () => {
    const { host, service, ws } = await setup();
    putSnapshot();
    const gate = deferred<GitHubMergeResult>();
    host.handler = (cmd) =>
      cmd.type === "workspace.prMerge"
        ? gate.promise
        : { __error: { code: "timeout", message: "Refresh failed" } };
    const merge = service.merge("workspace", SHA);
    await until(() => host.commands.length === 1);
    const b = cacheOtherWorkspace(ws);
    const newer = replaceFence();
    t.c.store.putWorkspace({ ...ws, branch: "other", github: undefined });
    gate.resolve(mergedResult());
    expect((await merge).status).toBe("merged");
    expect(fences()).toEqual([newer]);
    expect(t.c.store.workspaces.require(b.id)).toEqual(b);
  });

  it("cannot clear a fence with a response spanning a branch ABA race", async () => {
    const { host, service } = await makeUnknown();
    const gate = deferred<GitHubViewResult>();
    host.handler = () => gate.promise;
    const refresh = service.refresh("workspace", true);
    const rejected = expect(refresh).rejects.toMatchObject({ code: "conflict" });
    await until(() => host.commands.length === 2);
    const ws = t.c.store.workspaces.require("workspace");
    t.c.store.putWorkspace({ ...ws, branch: "other", github: undefined });
    t.c.store.putWorkspace(ws);
    gate.resolve({ github: AVAILABLE, snapshot: snapshot() });
    await rejected;
    expect(fences()).toHaveLength(1);
  });

  it("does not retransmit a fenced mutation to a replacement connection", async () => {
    const { host, service, creds } = await setup();
    putSnapshot();
    host.handler = () => NO_REPLY;
    const pending = service.merge("workspace", SHA);
    await until(() => host.commands.length === 1);
    const replacement = new FakeHost(
      t.c.localUrl.replace("http", "ws"),
      creds.hostId,
      creds.credential,
    );
    hosts.push(replacement);
    await replacement.open({ github: AVAILABLE });
    expect((await pending).status).toBe("outcome_unknown");
    expect(replacement.commands).toHaveLength(0);
    expect(fences()[0].state).toBe("unknown");
    await expect(service.merge("workspace", SHA)).rejects.toMatchObject({ code: "conflict" });
  });
});

const BACKFILL_VERSION = "githubMergeFenceLegacyBackfillVersion";

function unknownSnapshot(): WorkspaceGitHub {
  return snapshot({
    status: "error",
    reason: UNKNOWN_MERGE_REASON,
    checksComplete: false,
    threadsComplete: false,
  });
}

function cacheOtherWorkspace(ws: Workspace, github = unknownSnapshot(), id = "other-workspace") {
  return t.c.store.putWorkspace({ ...ws, id, path: `/repo/${id}`, github });
}

describe("one-time legacy import and stale overlay cleanup", () => {
  it("atomically rolls back imports, quarantine and completion, then deduplicates on retry", async () => {
    const { service, ws, host } = await setup(AVAILABLE, true);
    const store = t.c.store;
    const legacy = unknownSnapshot();
    delete legacy.pullRequest!.nodeId;
    putSnapshot(legacy);
    cacheOtherWorkspace(ws, { ...legacy, repository: "UPSTREAM/App" });
    const corrupt = cacheOtherWorkspace(
      ws,
      { ...unknownSnapshot(), repository: null, pullRequest: null },
      "corrupt",
    );
    expect(store.getSetting(BACKFILL_VERSION, null)).toBeNull();
    store.db.exec(`CREATE TRIGGER fail_backfill_completion BEFORE INSERT ON settings
      WHEN NEW.key = '${BACKFILL_VERSION}' BEGIN SELECT RAISE(ABORT, 'backfill failed'); END`);
    expect(() => service.start()).toThrow("backfill failed");
    expect(fences()).toHaveLength(0);
    expect(store.getSetting(`githubCorruptedMergeMarker:${corrupt.id}`, null)).toBeNull();
    expect(store.getSetting(BACKFILL_VERSION, null)).toBeNull();
    store.db.exec("DROP TRIGGER fail_backfill_completion");
    service.start();
    expect(fences()).toEqual([
      expect.objectContaining({
        fence_key: "legacy:github.com:upstream/app:23",
        pull_request_node_id: null,
        expected_head_oid: SHA,
        workspace_id: ws.id,
        host_id: ws.hostId,
      }),
    ]);
    expect(store.getSetting(`githubCorruptedMergeMarker:${corrupt.id}`, null)).toEqual(corrupt);
    expect(store.getSetting(BACKFILL_VERSION, null)).toBe(1);
    const imported = fences();
    const listeners = t.c.ctx.hub.listenerCount("event");
    service.start();
    expect(t.c.ctx.hub.listenerCount("event")).toBe(listeners);
    service.stop();
    service.start();
    expect(fences()).toEqual(imported);
    expect(store.getSetting(BACKFILL_VERSION, null)).toBe(1);
    store.workspaces.delete(corrupt.id);
    putSnapshot();
    await expect(service.merge(ws.id, SHA)).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("Manual reconciliation"),
    });
    expect(host.commands).toHaveLength(0);
  });

  it.each([-1, 0.5, "1", null, true, {}, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid backfill version %j without importing or overwriting it",
    async (version) => {
      const { service } = await setup(AVAILABLE, true);
      putSnapshot(unknownSnapshot());
      t.c.store.setSetting(BACKFILL_VERSION, version);
      expect(() => service.start()).toThrow("Invalid GitHub merge fence legacy backfill version");
      expect(fences()).toHaveLength(0);
      expect(t.c.store.getSetting(BACKFILL_VERSION, undefined)).toEqual(version);
    },
  );

  it("rejects malformed JSON version data and skips import for future completed versions", async () => {
    const { service } = await setup(AVAILABLE, true);
    putSnapshot(unknownSnapshot());
    t.c.store.db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?)")
      .run(BACKFILL_VERSION, "{");
    expect(() => service.start()).toThrow();
    expect(fences()).toHaveLength(0);
    t.c.store.setSetting(BACKFILL_VERSION, 2);
    service.start();
    expect(fences()).toHaveLength(0);
    expect(t.c.store.getSetting(BACKFILL_VERSION, null)).toBe(2);
  });

  it("evicts all matching stale caches atomically while retaining A's own verified response, without resurrection", async () => {
    const { host, service, ws, creds } = await makeUnknown();
    const store = t.c.store;
    const stale = store.workspaces.require(ws.id).github!;
    const b = cacheOtherWorkspace(ws, stale);
    const freshCache = cacheOtherWorkspace(ws, snapshot(), "already-fresh");
    const different = unknownSnapshot();
    different.pullRequest!.nodeId = "PR_different_at_same_alias";
    const unrelated = cacheOtherWorkspace(ws, different, "different-node");
    const renamed = unknownSnapshot();
    renamed.repository = "renamed/repo";
    renamed.pullRequest!.url = "https://github.com/renamed/repo/pull/23";
    const archived = store.putWorkspace({
      ...cacheOtherWorkspace(ws, renamed, "archived"),
      archivedAt: store.nowIso(),
      setup: { state: "succeeded", log: "preserve me" },
    });
    const updates: Workspace[] = [];
    const observe = (event: import("@switchyard/protocol").EventEnvelope) => {
      if (event.type !== "workspace.updated") return;
      const value = event.data as Workspace;
      updates.push(value);
      // Published only after the entire clear/cache transaction commits.
      expect(fences()).toHaveLength(0);
      expect(store.workspaces.require(ws.id).github?.status).toBe("ready");
      expect(store.workspaces.require(b.id).github).toBeUndefined();
    };
    t.c.ctx.hub.on("event", observe);
    const listenerError = vi.fn();
    const previousListenerError = t.c.ctx.hub.onListenerError;
    t.c.ctx.hub.onListenerError = listenerError;
    t.clock.advance(1000);
    const verified = snapshot();
    host.handler = () => ({ github: AVAILABLE, snapshot: verified });
    expect((await service.refresh(ws.id, true)).snapshot).toEqual(verified);
    t.c.ctx.hub.off("event", observe);
    t.c.ctx.hub.onListenerError = previousListenerError;
    expect(listenerError).not.toHaveBeenCalled();
    expect(updates.map((w) => w.id).sort()).toEqual([ws.id, b.id, archived.id].sort());
    expect(store.workspaces.require(b.id)).toEqual({ ...b, github: undefined });
    expect(Object.hasOwn(store.workspaces.require(b.id), "github")).toBe(false);
    expect(store.workspaces.require(archived.id)).toEqual({ ...archived, github: undefined });
    expect(store.workspaces.require(freshCache.id)).toEqual(freshCache);
    expect(store.workspaces.require(unrelated.id)).toEqual(unrelated);
    expect(store.workspaces.require(ws.id).github).toEqual(verified);
    expect(store.getSetting(BACKFILL_VERSION, null)).toBe(1);

    // An old host overlay and even a corrupt post-import display cannot create safety state.
    await host.event("workspace.updated", { path: b.path, github: stale });
    expect((await service.view(b.id)).snapshot?.reason).toBe(UNKNOWN_MERGE_REASON);
    await expect(service.merge(b.id, SHA)).rejects.toMatchObject({ code: "conflict" });
    cacheOtherWorkspace(ws, { ...stale, repository: null, pullRequest: null }, "late-corrupt");
    expect(fences()).toHaveLength(0);
    service.stop();
    service.start();
    service.start();
    expect(fences()).toHaveLength(0);
    expect(store.getSetting("githubCorruptedMergeMarker:late-corrupt", null)).toBeNull();

    const dir = t.dir;
    await t.stop();
    t = await startCoordinator({
      dir,
      dispatcher: { tickMs: 0 },
      schedulerTickMs: 0,
      projectScanIntervalMs: 0,
      cacheAlertTickMs: 0,
    });
    expect(fences()).toHaveLength(0);
    expect(t.c.store.getSetting(BACKFILL_VERSION, null)).toBe(1);
    const replacement = new FakeHost(
      t.c.localUrl.replace("http", "ws"),
      creds.hostId,
      creds.credential,
    );
    hosts.push(replacement);
    await replacement.open({ github: AVAILABLE });
    const restarted = requireService(t.c.ctx, "github");
    replacement.handler = (cmd) =>
      cmd.type === "workspace.prMerge"
        ? mergedResult()
        : { github: AVAILABLE, snapshot: snapshot() };
    expect((await restarted.refresh(b.id)).snapshot?.status).toBe("ready");
    expect(fences()).toHaveLength(0);
    expect((await restarted.merge(b.id, SHA)).status).toBe("merged");
    expect(fences()).toHaveLength(0);
    expect(t.c.store.getSetting("githubCorruptedMergeMarker:late-corrupt", null)).toBeNull();
    expect(t.c.store.getSetting(BACKFILL_VERSION, null)).toBe(1);
  });

  it("rolls back fence deletion and every cache eviction if cache persistence fails", async () => {
    const { host, service, ws } = await makeUnknown();
    const store = t.c.store;
    const before = fences();
    const b = cacheOtherWorkspace(ws);
    store.db.exec(`CREATE TRIGGER fail_overlay_cleanup BEFORE UPDATE ON workspaces
      WHEN NEW.id = '${b.id}' BEGIN SELECT RAISE(ABORT, 'cleanup failed'); END`);
    host.handler = () => ({ github: AVAILABLE, snapshot: snapshot() });
    await expect(service.refresh(ws.id, true)).rejects.toThrow("cleanup failed");
    expect(fences()).toEqual(before);
    expect(store.workspaces.require(b.id)).toEqual(b);
    expect(store.workspaces.require(ws.id).github?.reason).toBe(UNKNOWN_MERGE_REASON);
    store.db.exec("DROP TRIGGER fail_overlay_cleanup");
    await service.refresh(ws.id, true);
    expect(fences()).toHaveLength(0);
    expect(store.workspaces.require(b.id).github).toBeUndefined();
  });

  it("legacy cleanup evicts exact aliases but never another verified node at a reused slug", async () => {
    const { host, service, ws } = await setup(AVAILABLE, true);
    const legacy = unknownSnapshot();
    delete legacy.pullRequest!.nodeId;
    putSnapshot(legacy);
    const b = cacheOtherWorkspace(ws, { ...legacy, repository: "UPSTREAM/App" });
    service.start();
    const sameNode = cacheOtherWorkspace(ws, unknownSnapshot(), "verified-node");
    const other = unknownSnapshot();
    other.pullRequest!.nodeId = "PR_other";
    const differentNode = cacheOtherWorkspace(ws, other, "different-node");
    const alias = {
      ...legacy,
      repository: "other/repo",
      pullRequest: { ...legacy.pullRequest!, url: "https://github.com/other/repo/pull/23" },
    };
    const otherAlias = cacheOtherWorkspace(ws, alias, "other-alias");
    host.handler = () => ({ github: AVAILABLE, snapshot: snapshot() });
    await service.refresh(ws.id, true);
    expect(fences()).toHaveLength(0);
    expect(t.c.store.workspaces.require(b.id).github).toBeUndefined();
    expect(t.c.store.workspaces.require(sameNode.id).github).toBeUndefined();
    expect(t.c.store.workspaces.require(differentNode.id)).toEqual(differentNode);
    expect(t.c.store.workspaces.require(otherAlias.id)).toEqual(otherAlias);
    service.stop();
    service.start();
    expect(fences()).toHaveLength(0);
  });

  it("clears an old legacy generation without evicting a newer node fence's overlays", async () => {
    const { host, service, ws } = await setup(AVAILABLE, true);
    const legacy = unknownSnapshot();
    delete legacy.pullRequest!.nodeId;
    putSnapshot(legacy);
    const b = cacheOtherWorkspace(ws);
    service.start();
    const old = fences()[0];
    const gate = deferred<GitHubViewResult>();
    host.handler = () => gate.promise;
    const pending = service.refresh(ws.id, true);
    await until(() => host.commands.length === 1);
    t.c.store.db
      .prepare(`INSERT INTO github_merge_fences
        (fence_key, hostname, pull_request_node_id, repository, pr_number, attempt_id,
         command_id, expected_head_oid, workspace_id, host_id, head_repository, head_ref_name,
         state, started_at, updated_at)
        SELECT 'github.com:PR_node_A', hostname, 'PR_node_A', repository, pr_number, 'newer',
          'merge_newer', expected_head_oid, workspace_id, host_id, head_repository, head_ref_name,
          'unknown', started_at, updated_at FROM github_merge_fences WHERE id = ?`)
      .run(old.id);
    const newer = fences()[1];
    expect(newer.id).toBeGreaterThan(old.id);
    gate.resolve({ github: AVAILABLE, snapshot: snapshot() });
    expect((await pending).snapshot?.reason).toBe(UNKNOWN_MERGE_REASON);
    expect(fences()).toEqual([newer]);
    expect(t.c.store.workspaces.require(b.id)).toEqual(b);
    expect((await service.view(b.id)).snapshot?.reason).toBe(UNKNOWN_MERGE_REASON);
    await expect(service.merge(b.id, SHA)).rejects.toMatchObject({ code: "conflict" });
  });

  it("confirmed success evicts other overlays even when the follow-up read fails", async () => {
    const { host, service, ws } = await setup();
    putSnapshot();
    const b = cacheOtherWorkspace(ws);
    host.handler = (cmd) =>
      cmd.type === "workspace.prMerge"
        ? mergedResult()
        : { __error: { code: "timeout", message: "read failed" } };
    expect((await service.merge(ws.id, SHA)).status).toBe("merged");
    expect(fences()).toHaveLength(0);
    expect(t.c.store.workspaces.require(b.id).github).toBeUndefined();
    service.stop();
    service.start();
    expect(fences()).toHaveLength(0);
    expect(t.c.store.getSetting(BACKFILL_VERSION, null)).toBe(1);
  });

  it.each(["path", "checkoutId", "archivedAt"] as const)(
    "a workspace %s ABA cannot clear the row or evict another workspace's overlay",
    async (field) => {
      const { host, service, ws } = await makeUnknown();
      const b = cacheOtherWorkspace(ws);
      const gate = deferred<GitHubViewResult>();
      host.handler = () => gate.promise;
      const pending = service.refresh(ws.id, true);
      const rejected = expect(pending).rejects.toMatchObject({ code: "conflict" });
      await until(() => host.commands.length === 2);
      const original = t.c.store.workspaces.require(ws.id);
      t.c.store.putWorkspace({ ...original, [field]: "changed" });
      t.c.store.putWorkspace(original);
      gate.resolve({ github: AVAILABLE, snapshot: snapshot() });
      await rejected;
      expect(fences()).toHaveLength(1);
      expect(t.c.store.workspaces.require(b.id)).toEqual(b);
    },
  );
});

describe("coordinator GitHub actions", () => {
  it("preserves and marks the last snapshot stale on transport or malformed refresh errors", async () => {
    const { host, service } = await setup();
    const previous = snapshot();
    putSnapshot(previous);
    host.handler = () => ({ __error: { code: "timeout", message: "network unavailable" } });
    await expect(service.refresh("workspace", true)).rejects.toMatchObject({ code: "timeout" });
    const stale = t.c.store.workspaces.require("workspace").github!;
    expect(stale).toMatchObject({
      status: "error",
      pullRequest: previous.pullRequest,
      fetchedAt: previous.fetchedAt,
      checksComplete: false,
      threadsComplete: false,
    });
    host.handler = () => ({ github: AVAILABLE, snapshot: snapshot({ branch: "wrong" }) });
    await expect(service.refresh("workspace", true)).rejects.toMatchObject({ code: "conflict" });
    expect(t.c.store.workspaces.require("workspace").github?.pullRequest).toEqual(
      previous.pullRequest,
    );
  });

  it("accepts a refresh published by the host before its receipt and preserves unrelated workspace writes", async () => {
    const { host, service } = await setup();
    host.handler = async () => {
      await host.event("workspace.updated", { path: "/repo/topic", github: snapshot() });
      const ws = t.c.store.workspaces.require("workspace");
      t.c.store.putWorkspace({ ...ws, setup: { state: "succeeded", log: "setup complete" } });
      return { github: AVAILABLE, snapshot: snapshot() };
    };
    expect((await service.refresh("workspace", true)).snapshot?.status).toBe("ready");
    expect(t.c.store.workspaces.require("workspace").setup.log).toBe("setup complete");
  });

  it("keeps the uncertain merge fence across coordinator restart", async () => {
    const { host, service, creds } = await setup();
    putSnapshot();
    host.handler = () => NO_REPLY;
    const pending = service.merge("workspace", SHA);
    await until(() => host.commands.length === 1);
    const dir = t.dir;
    await t.stop();
    expect((await pending).status).toBe("outcome_unknown");
    t = await startCoordinator({
      dir,
      dispatcher: { tickMs: 0 },
      schedulerTickMs: 0,
      projectScanIntervalMs: 0,
    });
    const replacement = new FakeHost(
      t.c.localUrl.replace("http", "ws"),
      creds.hostId,
      creds.credential,
    );
    hosts.push(replacement);
    await replacement.open({ github: AVAILABLE });
    expect(t.c.store.workspaces.require("workspace").github?.reason).toBe(UNKNOWN_MERGE_REASON);
    expect((await t.admin("POST", route("/merge"), { expectedHeadOid: SHA })).body.error.code).toBe(
      "conflict",
    );
    expect(replacement.commands).toHaveLength(0);
  });
  it("resolves logs only from stored association and validates returned PR/head", async () => {
    const { host } = await setup();
    putSnapshot();
    const logs: GitHubLogs = {
      github: AVAILABLE,
      repository: "upstream/app",
      number: 23,
      headOid: SHA,
      fetchedAt: t.c.store.nowIso(),
      status: "ready",
      reason: null,
      jobs: [],
      complete: true,
      truncated: false,
      omittedJobs: 0,
    };
    host.handler = () => logs;
    expect(
      (await t.admin("POST", route("/failed-logs"), { expectedHeadOid: SHA, path: "/other" }))
        .status,
    ).toBe(400);
    expect((await t.admin("POST", route("/failed-logs"), { expectedHeadOid: OTHER })).status).toBe(
      409,
    );
    expect(host.commands).toHaveLength(0);
    expect((await t.admin("POST", route("/failed-logs"), { expectedHeadOid: SHA })).body).toEqual(
      logs,
    );
    expect(host.commands[0]?.command).toEqual({
      type: "workspace.prFailedLogs",
      path: "/repo/topic",
      repository: "upstream/app",
      number: 23,
      expectedHeadOid: SHA,
    });
    host.handler = () => ({ ...logs, headOid: OTHER });
    expect((await t.admin("POST", route("/failed-logs"), { expectedHeadOid: SHA })).status).toBe(
      409,
    );
    expect(JSON.stringify(t.c.store.workspaces.require("workspace"))).not.toContain("outputTail");
  });

  it("requires exact SHA, freshness, complete checks/threads and safe merge state", async () => {
    const { host } = await setup();
    for (const data of [
      snapshot({ checksComplete: false }),
      snapshot({ threadsComplete: false }),
      snapshot({ truncated: true }),
      snapshot({ fetchedAt: new Date(t.clock.now - 60_001).toISOString() }),
      ...["isDraft", "autoMergeEnabled", "mergeQueueEnabled", "inMergeQueue"].map((field) => {
        const s = snapshot();
        (s.pullRequest as any)[field] = true;
        return s;
      }),
      ...["mergeable", "mergeStateStatus", "reviewDecision"].map((field) => {
        const s = snapshot();
        (s.pullRequest as any)[field] = field === "reviewDecision" ? "REVIEW_REQUIRED" : "UNKNOWN";
        return s;
      }),
      (() => {
        const s = snapshot();
        s.pullRequest!.headRepository = null;
        return s;
      })(),
    ]) {
      putSnapshot(data);
      expect((await t.admin("POST", route("/merge"), { expectedHeadOid: SHA })).status).toBe(409);
    }
    putSnapshot();
    expect((await t.admin("POST", route("/merge"), { expectedHeadOid: OTHER })).status).toBe(409);
    expect(
      (await t.admin("POST", route("/merge"), { expectedHeadOid: SHA, strategy: "squash" })).status,
    ).toBe(400);
    expect((await t.admin("POST", route("/merge"), { expectedHeadOid: "abc" })).status).toBe(400);
    expect(host.commands).toHaveLength(0);
  });

  it("merges a fork PR once, keeps confirmed success if refresh fails, never accepts tasks", async () => {
    const { host, service } = await setup();
    putSnapshot();
    const before = t.c.store.tasks.list();
    host.handler = (cmd) =>
      cmd.type === "workspace.prMerge"
        ? ({
            status: "merged",
            github: AVAILABLE,
            repository: "upstream/app",
            number: 23,
            url: "https://github.com/upstream/app/pull/23",
            expectedHeadOid: SHA,
            mergeCommitOid: null,
            confirmedAt: t.c.store.nowIso(),
          } satisfies GitHubMergeResult)
        : { __error: { code: "timeout", message: "refresh timed out" } };
    expect((await service.merge("workspace", SHA)).status).toBe("merged");
    expect(host.commands.filter((c) => c.command.type === "workspace.prMerge")).toHaveLength(1);
    // The cleared attempt's stale overlay is evicted even if the follow-up fetch fails.
    expect(t.c.store.workspaces.require("workspace").github).toBeUndefined();
    expect(t.c.store.tasks.list()).toEqual(before);
    await expect(service.merge("workspace", SHA)).rejects.toMatchObject({ code: "conflict" });
  });

  it("durably fences a merge before send, never replays disconnects, and only explicit refresh unlocks unknown", async () => {
    const { host, service, creds } = await setup();
    putSnapshot();
    host.handler = () => NO_REPLY;
    const pending = service.merge("workspace", SHA);
    await until(() => host.commands.length === 1);
    expect(t.c.store.workspaces.require("workspace").github?.reason).toBe(UNKNOWN_MERGE_REASON);
    await expect(service.merge("workspace", SHA)).rejects.toMatchObject({ code: "conflict" });
    await host.close();
    expect((await pending).status).toBe("outcome_unknown");
    host.handler = () => ({ github: AVAILABLE, snapshot: snapshot() });
    await host.open({ github: AVAILABLE });
    expect(t.c.hostHub.isConnected(creds.hostId)).toBe(true);
    expect(host.commands).toHaveLength(1);
    await host.event("workspace.updated", { path: "/repo/topic", github: snapshot() });
    await service.refresh("workspace");
    expect(t.c.store.workspaces.require("workspace").github?.reason).toBe(UNKNOWN_MERGE_REASON);
    expect(host.commands.filter((c) => c.command.type === "workspace.prMerge")).toHaveLength(1);
    host.handler = () => ({
      github: AVAILABLE,
      snapshot: snapshot({
        status: "error",
        reason: "Network failed",
        checksComplete: false,
        threadsComplete: false,
      }),
    });
    await service.refresh("workspace", true);
    expect(t.c.store.workspaces.require("workspace").github?.reason).toBe(UNKNOWN_MERGE_REASON);
    host.handler = () => ({ github: AVAILABLE, snapshot: snapshot() });
    await service.refresh("workspace", true);
    expect(t.c.store.workspaces.require("workspace").github?.status).toBe("ready");
  });

  it("rejects archived workspaces and checkout ownership mismatches", async () => {
    const { ws } = await setup();
    putSnapshot();
    t.c.store.putWorkspace({ ...ws, archivedAt: t.c.store.nowIso() });
    expect((await t.admin("GET", route())).status).toBe(403);
    t.c.store.putWorkspace({ ...ws, projectId: "wrong" });
    expect((await t.admin("POST", route("/refresh"))).status).toBe(403);
  });
});
