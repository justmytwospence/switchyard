import {
  ERROR_CODES,
  type GitHubMergeResult,
  type GitHubViewResult,
  type WorkspaceGitHub,
} from "@switchyard/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UNKNOWN_MERGE_REASON } from "../src/github.js";
import { requireService } from "../src/services.js";
import {
  enrollHost,
  FakeHost,
  NO_REPLY,
  startCoordinator,
  type TestCoordinator,
  until,
} from "./helpers.js";

const SHA = "a".repeat(40);
const NEW_SHA = "b".repeat(40);
const AVAILABLE = { available: true, reason: null };
const ROUTE = "/api/workspaces/workspace/pr";
let t: TestCoordinator;
let host: FakeHost;
afterEach(async () => {
  vi.restoreAllMocks();
  await host?.close();
  await t?.cleanup();
});

function snapshot(headRefOid = SHA, nodeId = "PR_transport"): WorkspaceGitHub {
  return {
    repository: "upstream/app",
    headRepository: "fork/app",
    branch: "topic",
    fetchedAt: t.c.store.nowIso(),
    attemptedAt: t.c.store.nowIso(),
    status: "ready",
    reason: null,
    pullRequest: {
      nodeId,
      number: 23,
      url: "https://github.com/upstream/app/pull/23",
      title: "Fix",
      state: "OPEN",
      isDraft: false,
      headRefName: "topic",
      headRefOid,
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
  };
}

function cache(value = snapshot()) {
  t.c.store.putWorkspace({ ...t.c.store.workspaces.require("workspace"), github: value });
}

function fences() {
  return t.c.store.db.prepare("SELECT * FROM github_merge_fences ORDER BY id").all();
}

function confirm(expectedHeadOid = SHA) {
  return t.admin("POST", `${ROUTE}/merge`, { expectedHeadOid });
}

function unknownResult(): GitHubMergeResult {
  return {
    status: "outcome_unknown",
    github: AVAILABLE,
    repository: "upstream/app",
    number: 23,
    url: "https://github.com/upstream/app/pull/23",
    expectedHeadOid: SHA,
    attemptedAt: t.c.store.nowIso(),
    reason: "Host-specific uncertainty is not safe-retry guidance",
  };
}

async function setup() {
  t = await startCoordinator({
    dispatcher: { tickMs: 0 },
    schedulerTickMs: 0,
    projectScanIntervalMs: 0,
    cacheAlertTickMs: 0,
  });
  const creds = await enrollHost(t);
  host = new FakeHost(t.c.localUrl.replace("http", "ws"), creds.hostId, creds.credential);
  await host.open({ github: AVAILABLE });
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
  store.putWorkspace({
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
    github: snapshot(),
  });
}

function expectUnknown(response: { status: number; body: unknown }) {
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ ...unknownResult(), reason: UNKNOWN_MERGE_REASON });
  expect(fences()).toEqual([
    expect.objectContaining({
      state: "unknown",
      pull_request_node_id: "PR_transport",
      expected_head_oid: SHA,
    }),
  ]);
  expect(t.c.store.workspaces.require("workspace").github).toMatchObject({
    status: "error",
    reason: UNKNOWN_MERGE_REASON,
    checksComplete: false,
    threadsComplete: false,
  });
}

describe("E.4 coordinator merge HTTP attempt boundary", () => {
  it("returns 409 for a locally known stale reviewed SHA without a command or fence", async () => {
    await setup();
    cache(snapshot(NEW_SHA));
    const response = await confirm();
    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: { code: "conflict", message: "PR head changed. Refresh and confirm the new SHA." },
    });
    expect(host.commands).toEqual([]);
    expect(fences()).toEqual([]);
  });

  it("does not clear an unrelated previous fence on local stale-SHA rejection", async () => {
    await setup();
    cache(snapshot(SHA, "PR_previous"));
    host.handler = () => unknownResult();
    expect((await confirm()).status).toBe(200);
    const previous = fences();
    cache(snapshot(NEW_SHA));
    expect((await confirm()).status).toBe(409);
    expect(fences()).toEqual(previous);
    expect(host.commands).toHaveLength(1);
  });

  it("rechecks a changed SHA at beforeSend and returns 409 without inserting a fence", async () => {
    await setup();
    const request = t.c.hostHub.request.bind(t.c.hostHub);
    vi.spyOn(t.c.hostHub, "request").mockImplementationOnce((hostId, command, opts) => {
      cache(snapshot(NEW_SHA));
      return request(hostId, command, opts);
    });
    expect((await confirm()).status).toBe(409);
    expect(host.commands).toEqual([]);
    expect(fences()).toEqual([]);
  });

  it("uses committed insertion, not a rolled-back reservation, as the boundary", async () => {
    await setup();
    vi.spyOn(t.c.store, "putWorkspace").mockImplementationOnce(() => {
      throw new Error("Rollback the write-ahead transaction after INSERT");
    });
    const warn = vi.spyOn(t.c.ctx.log, "warn");
    const response = await confirm();
    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe("internal");
    expect(fences()).toEqual([]);
    expect(host.commands).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps a no-fence offline failure non-2xx instead of fabricating an attempt result", async () => {
    await setup();
    await host.close();
    await until(() => !t.c.hostHub.isConnected(host.hostId));
    const response = await confirm();
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("host_unreachable");
    expect(fences()).toEqual([]);
    expect(host.commands).toEqual([]);
  });

  // ErrorBody has no no-effect/stage attestation: even a host preflight conflict is unknown.
  it.each(ERROR_CODES)("returns typed HTTP 200 after a fenced host %s receipt", async (code) => {
    await setup();
    const message = `Host preflight/transport rejected with ${code}`;
    host.handler = () => {
      expect(fences()).toEqual([expect.objectContaining({ state: "pending" })]);
      return {
        __error: { code, message, details: { expectedHeadOid: SHA, actualHeadOid: NEW_SHA } },
      };
    };
    const warn = vi.spyOn(t.c.ctx.log, "warn");
    expectUnknown(await confirm());
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.objectContaining({ code, message }),
        workspaceId: "workspace",
        commandId: host.commands[0]?.commandId,
        fenceId: expect.any(Number),
        attemptId: expect.any(String),
      }),
      "Merge outcome unknown after fenced attempt",
    );
    expect(host.commands).toHaveLength(1);
    const unknownFence = fences();
    // Neither a background read nor another confirmation can authorize automatic retry.
    host.handler = () => ({ github: AVAILABLE, snapshot: snapshot(NEW_SHA) });
    await requireService(t.c.ctx, "github").refresh("workspace");
    expect((await confirm(NEW_SHA)).status).toBe(409);
    expect(fences()).toEqual(unknownFence);
    expect(
      host.commands.filter(({ command }) => command.type === "workspace.prMerge"),
    ).toHaveLength(1);
  });

  it.each(["malformed", "wrong-association", "typed-unknown"])(
    "retains the fence and exact public reason for a %s response",
    async (kind) => {
      await setup();
      host.handler = () => {
        if (kind === "malformed") return { status: "merged" };
        if (kind === "wrong-association") return { ...unknownResult(), expectedHeadOid: NEW_SHA };
        return unknownResult();
      };
      expectUnknown(await confirm());
      expect(host.commands).toHaveLength(1);
    },
  );

  it("returns unknown for a non-protocol exception after committed insertion", async () => {
    await setup();
    vi.spyOn(t.c.hostHub, "request").mockImplementationOnce(async (_hostId, _command, opts) => {
      opts?.beforeSend?.();
      throw new Error("Unclassified transport exception");
    });
    expectUnknown(await confirm());
  });

  it("returns unknown on timeout after sending, with no automatic retransmission", async () => {
    await setup();
    host.handler = () => NO_REPLY;
    const request = t.c.hostHub.request.bind(t.c.hostHub);
    vi.spyOn(t.c.hostHub, "request").mockImplementationOnce((hostId, command, opts) =>
      request(hostId, command, { ...opts, timeoutMs: 50 }),
    );
    expectUnknown(await confirm());
    expect(host.commands).toHaveLength(1);
    expect((await confirm()).status).toBe(409);
    expect(host.commands).toHaveLength(1);
  });

  it("returns unknown on disconnect after sending and does not replay on reconnect", async () => {
    await setup();
    host.handler = () => NO_REPLY;
    const pending = confirm();
    await until(() => host.commands.length === 1);
    await host.close();
    expectUnknown(await pending);
    await host.open({ github: AVAILABLE });
    expect((await confirm()).status).toBe(409);
    expect(host.commands).toHaveLength(1);
  });

  it("requires explicit complete reconciliation and fresh confirmation after a host stale-head race", async () => {
    await setup();
    // This fake host models only a preflight receipt; no GitHub process or PUT is ever run.
    host.handler = () => ({
      __error: { code: "conflict", message: "PR head changed on the host" },
    });
    expectUnknown(await confirm());
    host.handler = () =>
      ({ github: AVAILABLE, snapshot: snapshot(NEW_SHA) }) satisfies GitHubViewResult;
    const refreshed = await t.admin("POST", `${ROUTE}/refresh`, {});
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.snapshot.pullRequest.headRefOid).toBe(NEW_SHA);
    expect(fences()).toEqual([]);
    expect(
      host.commands.filter(({ command }) => command.type === "workspace.prMerge"),
    ).toHaveLength(1);
    expect((await confirm()).status).toBe(409);
    host.handler = (command) =>
      command.type === "workspace.prView"
        ? { github: AVAILABLE, snapshot: snapshot(NEW_SHA) }
        : {
            status: "merged",
            github: AVAILABLE,
            repository: "upstream/app",
            number: 23,
            url: "https://github.com/upstream/app/pull/23",
            expectedHeadOid: NEW_SHA,
            mergeCommitOid: null,
            confirmedAt: t.c.store.nowIso(),
          };
    const response = await confirm(NEW_SHA);
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("merged");
    expect(fences()).toEqual([]);
    const merges = host.commands.filter(({ command }) => command.type === "workspace.prMerge");
    expect(merges).toHaveLength(2);
    expect(merges[1]?.commandId).not.toBe(merges[0]?.commandId);
    expect(t.c.store.tasks.list()).toEqual([]);
  });
});
