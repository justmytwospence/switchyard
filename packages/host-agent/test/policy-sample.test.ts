// biome-ignore-all lint/complexity/useLiteralKeys: Exercise private supervisor wiring without starting Pi.
import { type ChildProcess, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import type { ManagedSession } from "@switchyard/pi-runtime";
import { canonicalPolicyJson, type HostPolicySampleRequest } from "@switchyard/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterCatalog } from "../src/adapters.js";
import type { AgentBroker, AgentBrokerSession } from "../src/agent-broker.js";
import { HostDb } from "../src/db/index.js";
import type { CoordinatorLink } from "../src/link.js";
import { silentLogger } from "../src/logger.js";
import { classifyToolSafety } from "../src/policy-context.js";
import { type HostSessionRecord, SessionSupervisor } from "../src/supervisor.js";
import { mockProfile, tempDir } from "./helpers.js";

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFile: vi.fn(),
}));
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  realpath: vi.fn(),
}));
vi.mock("../src/policy-context.js", async (original) => ({
  ...(await original<typeof import("../src/policy-context.js")>()),
  classifyToolSafety: vi.fn(),
}));

type GitCallback = (error: Error | null, stdout: string, stderr: string) => void;
const cleanup: (() => void)[] = [];
beforeEach(async () => {
  const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const classifier = await vi.importActual<typeof import("../src/policy-context.js")>(
    "../src/policy-context.js",
  );
  vi.mocked(realpath).mockReset().mockImplementation(fs.realpath);
  vi.mocked(classifyToolSafety).mockReset().mockImplementation(classifier.classifyToolSafety);
  vi.mocked(execFile)
    .mockReset()
    .mockImplementation((...args) => {
      (args.at(-1) as GitCallback)(null, "origin/trunk\n", "");
      return {} as ChildProcess;
    });
});
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});

function sample(command = "git status"): HostPolicySampleRequest {
  return {
    sessionId: "session",
    nativeSessionId: "native",
    runtimeId: "runtime",
    sampleId: randomUUID(),
    tool: { name: "bash", args: { command } },
  };
}

function setup() {
  const dir = tempDir("switchyard-policy-sample-");
  cleanup.push(dir.cleanup);
  const root = join(dir.path, "workspace");
  const cwd = join(root, "nested");
  mkdirSync(cwd, { recursive: true });
  const db = new HostDb(":memory:");
  db.migrate();
  cleanup.push(() => db.close());
  const rec: HostSessionRecord = {
    id: "session",
    title: "Session",
    subtitle: null,
    cwd,
    workspaceRoot: root,
    projectId: "project",
    workspaceId: "workspace",
    runId: null,
    taskId: null,
    dispatchKey: null,
    profile: mockProfile,
    nativeHandle: { sessionId: "native", sessionFile: join(cwd, "native.jsonl") },
    runtime: "running",
    runtimeDetail: null,
    controlRevision: 1,
    controlMode: "human",
    origin: "human",
    readOnly: false,
    provenance: "created",
    nextOrder: 0,
    queue: { steering: [], followUp: [] },
    stats: null,
    lastAssistantText: null,
    lastActivityAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
  db.run("INSERT INTO sessions (id, json) VALUES (?, ?)", [rec.id, JSON.stringify(rec)]);
  let adapter!: AgentBrokerSession;
  const configuration = {
    version: 1 as const,
    sessionId: rec.id,
    nativeSessionId: "native",
    runtimeId: "runtime",
    bindingId: "binding",
    features: ["policies.v1"],
    coordinatorConnected: true,
    policyRequired: false,
    sessionUrl: null,
  };
  const bridge = {
    version: 1 as const,
    runtimeId: "runtime",
    nativeSessionId: "native",
    agentTools: true,
    messageDelivery: true,
    policyState: "active",
    policyPhases: ["tool_call", "request"],
  };
  const handle = {
    hello: vi.fn().mockResolvedValue(undefined),
    lost: vi.fn(),
    close: vi.fn(),
    request: vi.fn(),
    snapshot: vi.fn(() => structuredClone({ configuration, bridge })),
  };
  const emit = vi.fn();
  const supervisor = new SessionSupervisor({
    db,
    link: { emit } as unknown as CoordinatorLink,
    hostId: "host",
    catalog: {} as AdapterCatalog,
    log: silentLogger(),
    pi: () => ({ compatible: true, reason: null }),
    broker: {
      attach: (session: AgentBrokerSession) => {
        adapter = session;
        return handle;
      },
    } as unknown as AgentBroker,
  });
  const loaded = supervisor.record(rec.id)!;
  const process = Object.assign(new EventEmitter(), {
    isAlive: true,
    transport: "rpc",
    prompt: vi.fn(),
    configureAgent: vi.fn(),
    bridgeRequest: vi.fn(),
    replyAgent: vi.fn(),
    setPolicyWaiting: vi.fn(),
  });
  const ms = process as unknown as ManagedSession;
  const live = supervisor["newLive"](loaded);
  live.ms = ms;
  // Prove classification never waits behind prompt/event processing.
  live.chain = new Promise(() => {});
  supervisor["live"].set(rec.id, live);
  supervisor["wire"](live, ms);
  const hello = () =>
    process.emit("bridge_features", { runtimeId: "runtime", nativeSessionId: "native" });
  hello();
  const tables = () =>
    db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .map(({ name }) => [name, db.all(`SELECT * FROM "${name}"`)]);
  return {
    dir: dir.path,
    root,
    cwd,
    db,
    rec: loaded,
    supervisor,
    adapter,
    configuration,
    bridge,
    handle,
    process,
    emit,
    tables,
    hello,
    live,
  };
}

describe("read-only host policy samples", () => {
  it("classifies destructive inert text without executing commands, deleting files, or invoking Pi", async () => {
    const h = setup();
    await h.adapter.getPolicyBoundary();
    const sentinel = join(h.dir, "must-not-be-created");
    const outside = join(h.dir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep"), "untouched");
    const request = sample(`touch ${sentinel}; rm -rf ${outside}`);
    const before = h.tables();
    const result = await h.supervisor.classifyPolicySample(request);
    expect(result).toMatchObject({
      sessionId: request.sessionId,
      nativeSessionId: request.nativeSessionId,
      runtimeId: request.runtimeId,
      sampleId: request.sampleId,
      defaultBranch: "trunk",
      safety: { destructiveDelete: true, uncertain: false },
      toolHash: createHash("sha256").update(canonicalPolicyJson(request.tool)).digest("hex"),
    });
    expect(result).not.toHaveProperty("toolCallId");
    expect(result).not.toHaveProperty("evaluationId");
    expect(existsSync(sentinel)).toBe(false);
    expect(readFileSync(join(outside, "keep"), "utf8")).toBe("untouched");
    expect(h.tables()).toEqual(before);
    for (const name of [
      "prompt",
      "configureAgent",
      "bridgeRequest",
      "replyAgent",
      "setPolicyWaiting",
    ] as const)
      expect(h.process[name]).not.toHaveBeenCalled();
    expect(h.handle.request).not.toHaveBeenCalled();
    expect(h.emit).not.toHaveBeenCalled();
    expect(execFile).toHaveBeenCalledExactlyOnceWith(
      "git",
      ["-C", h.cwd, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
      expect.objectContaining({
        timeout: 2000,
        maxBuffer: 8192,
        env: expect.objectContaining({ GIT_TERMINAL_PROMPT: "0" }),
      }),
      expect.any(Function),
    );
  });

  it.each([
    ["git status", { uncertain: false, destructiveDelete: false }],
    ["rm -rf /outside", { destructiveDelete: true }],
    ["rm -rf $TARGET", { uncertain: true }],
    ["rm -rf $(touch SENTINEL)", { uncertain: true }],
    ["(rm -rf /outside)", { uncertain: true }],
    ["git push origin trunk", { defaultBranchPush: true }],
    ["git push --force origin topic", { forcePush: true }],
  ] as const)("uses precisely the real-tool classifier for %s", async (command, safety) => {
    const h = setup();
    await h.adapter.getPolicyBoundary();
    const request = sample(command.replace("SENTINEL", join(h.dir, "sentinel")));
    const result = await h.supervisor.classifyPolicySample(request);
    const real = await h.adapter.getToolPolicyContext({
      evaluationId: "evaluation",
      toolCallId: "call",
      tool: request.tool,
    });
    expect(result.safety).toMatchObject(safety);
    const { version: _version, toolCallId: _call, ...proof } = real;
    const {
      sessionId: _session,
      nativeSessionId: _native,
      runtimeId: _runtime,
      sampleId: _sample,
      ...sampleProof
    } = result;
    expect(sampleProof).toEqual(proof);
    expect(existsSync(join(h.dir, "sentinel"))).toBe(false);
  });

  it("returns trusted non-bash safety and fresh identities/hashes without cached samples", async () => {
    const h = setup();
    await h.adapter.getPolicyBoundary();
    const request = { ...sample(), tool: { name: "read", args: { path: "/outside" } } };
    const result = await h.supervisor.classifyPolicySample(request);
    const next = sample("rm -rf /outside");
    const nextResult = await h.supervisor.classifyPolicySample(next);
    expect(result.safety).toEqual({
      destructiveDelete: false,
      forcePush: false,
      defaultBranchPush: false,
      uncertain: false,
      reasons: [],
    });
    expect(nextResult.sampleId).toBe(next.sampleId);
    expect(nextResult.sampleId).not.toBe(result.sampleId);
    expect(nextResult.toolHash).not.toBe(result.toolHash);
  });

  it.each(["nativeSessionId", "runtimeId"] as const)("rejects a mismatched %s", async (field) => {
    const h = setup();
    await h.adapter.getPolicyBoundary();
    await expect(
      h.supervisor.classifyPolicySample({ ...sample(), [field]: "other" }),
    ).rejects.toMatchObject({ code: "stale_control" });
    expect(execFile).not.toHaveBeenCalled();
  });

  it.each(["missing", "stopped", "old", "unbound", "unsupported", "offline"])(
    "reports %s sessions as unavailable, not a verdict",
    async (kind) => {
      const h = setup();
      if (kind === "missing") h.supervisor["live"].delete("session");
      if (kind === "stopped") h.process.isAlive = false;
      if (kind === "old") h.live.broker = null;
      if (kind === "unbound") h.handle.snapshot.mockReturnValue(null as never);
      if (kind === "unsupported") h.bridge.policyState = "unsupported";
      if (kind === "offline") h.configuration.coordinatorConnected = false;
      await expect(h.supervisor.classifyPolicySample(sample())).rejects.toMatchObject({
        code: "unsupported_capability",
      });
      expect(execFile).not.toHaveBeenCalled();
    },
  );

  it("never pins a new boundary for a sample", async () => {
    const h = setup();
    await expect(h.supervisor.classifyPolicySample(sample())).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(execFile).not.toHaveBeenCalled();
  });

  it.each(["retarget", "missing"])("fails closed for a %s pinned boundary", async (change) => {
    const h = setup();
    const alias = join(h.root, "alias");
    symlinkSync(h.cwd, alias);
    h.rec.cwd = alias;
    await h.adapter.getPolicyBoundary();
    unlinkSync(alias);
    if (change === "retarget") symlinkSync(h.root, alias);
    await expect(h.supervisor.classifyPolicySample(sample())).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(execFile).not.toHaveBeenCalled();
  });

  it.each(["binding", "hello", "native", "lost", "exit", "replacement", "abort", "path"])(
    "fences %s changes while metadata is pending",
    async (change) => {
      const h = setup();
      await h.adapter.getPolicyBoundary();
      const controller = new AbortController();
      let finish!: GitCallback;
      vi.mocked(execFile).mockImplementation((...args) => {
        finish = args.at(-1) as GitCallback;
        return {} as ChildProcess;
      });
      const pending = h.supervisor.classifyPolicySample(sample(), controller.signal);
      await vi.waitFor(() => expect(finish).toBeDefined());
      if (change === "binding") h.configuration.bindingId = "replacement";
      if (change === "hello") h.hello();
      if (change === "native")
        h.process.emit("native", { sessionId: "other", sessionFile: "/other.jsonl" });
      if (change === "lost") h.process.emit("bridge_lost");
      if (change === "exit") h.process.emit("exit");
      if (change === "replacement") h.supervisor["live"].delete("session");
      if (change === "abort") controller.abort(new Error("Canceled"));
      if (change === "path") h.rec.workspaceRoot = h.dir;
      finish(null, "origin/trunk\n", "");
      await expect(pending).rejects.toMatchObject(
        change === "abort" ? { message: "Canceled" } : { code: "stale_control" },
      );
      expect(classifyToolSafety).not.toHaveBeenCalled();
    },
  );

  it("checks binding immediately after asynchronous realpath", async () => {
    const h = setup();
    await h.adapter.getPolicyBoundary();
    let finish!: (value: string) => void;
    vi.mocked(realpath).mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = h.supervisor.classifyPolicySample(sample());
    h.configuration.bindingId = "replacement";
    finish(h.cwd);
    await expect(pending).rejects.toMatchObject({ code: "stale_control" });
    expect(execFile).not.toHaveBeenCalled();
  });

  it("rejects caller-written safety, hashes and boundaries rather than trusting them", async () => {
    const h = setup();
    await h.adapter.getPolicyBoundary();
    for (const forged of [
      { safety: { destructiveDelete: false } },
      { toolHash: "0".repeat(64) },
      { boundary: { cwdReal: "/" } },
      { toolCallId: "not-a-real-tool" },
    ])
      await expect(
        h.supervisor.classifyPolicySample({ ...sample(), ...forged }),
      ).rejects.toMatchObject({ name: "ZodError" });
    expect(execFile).not.toHaveBeenCalled();
  });

  it("rechecks pinned realpaths after Git, not only before the await", async () => {
    const h = setup();
    const alias = join(h.root, "alias");
    symlinkSync(h.cwd, alias);
    h.rec.cwd = alias;
    await h.adapter.getPolicyBoundary();
    vi.mocked(execFile).mockImplementation((...args) => {
      unlinkSync(alias);
      symlinkSync(h.root, alias);
      (args.at(-1) as GitCallback)(null, "origin/trunk\n", "");
      return {} as ChildProcess;
    });
    await expect(h.supervisor.classifyPolicySample(sample())).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(classifyToolSafety).not.toHaveBeenCalled();
  });

  it("honors pre-cancellation without filesystem or Git work", async () => {
    const h = setup();
    const controller = new AbortController();
    controller.abort(new Error("Canceled"));
    vi.mocked(realpath).mockClear();
    await expect(h.supervisor.classifyPolicySample(sample(), controller.signal)).rejects.toThrow(
      "Canceled",
    );
    expect(realpath).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
  });

  it.each([null, "main\n", "origin/\n", "origin/main\norigin/other\n", "origin/bad.lock\n"])(
    "never guesses a default branch from %j",
    async (output) => {
      const h = setup();
      await h.adapter.getPolicyBoundary();
      vi.mocked(execFile).mockImplementation((...args) => {
        (args.at(-1) as GitCallback)(
          output === null ? new Error("missing") : null,
          output ?? "",
          "",
        );
        return {} as ChildProcess;
      });
      expect(await h.supervisor.classifyPolicySample(sample("git push origin main"))).toMatchObject(
        { defaultBranch: null, safety: { defaultBranchPush: false, uncertain: true } },
      );
    },
  );

  it("fails classifier errors closed instead of returning all-false safety", async () => {
    const h = setup();
    await h.adapter.getPolicyBoundary();
    vi.mocked(classifyToolSafety).mockImplementationOnce(() => {
      throw new Error("unavailable");
    });
    await expect(h.supervisor.classifyPolicySample(sample())).rejects.toMatchObject({
      code: "host_unreachable",
    });
  });
});
