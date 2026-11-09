// biome-ignore-all lint/complexity/useLiteralKeys: Exercise private supervisor wiring without starting Pi.
import { type ChildProcess, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, symlinkSync, unlinkSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import type { ManagedSession } from "@switchyard/pi-runtime";
import { canonicalPolicyJson, type PolicyEvaluateRequest } from "@switchyard/protocol";
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
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, realpath: vi.fn(actual.realpath) };
});
vi.mock("../src/policy-context.js", async (original) => {
  const actual = await original<typeof import("../src/policy-context.js")>();
  return { ...actual, classifyToolSafety: vi.fn(actual.classifyToolSafety) };
});

type GitCallback = (error: Error | null, stdout: string, stderr: string) => void;
function gitResult(output: string, error: Error | null = null) {
  vi.mocked(execFile).mockImplementation((...args) => {
    (args.at(-1) as GitCallback)(error, output, "");
    return {} as ChildProcess;
  });
}

const cleanup: (() => void)[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  gitResult("", new Error("No origin HEAD"));
});
afterEach(() => {
  vi.mocked(realpath).mockReset();
  vi.mocked(classifyToolSafety).mockReset();
  for (const close of cleanup.splice(0).reverse()) close();
});
// Reinstall the real implementations after tests which deliberately fail/pause these operations.
beforeEach(async () => {
  const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const classifier = await vi.importActual<typeof import("../src/policy-context.js")>(
    "../src/policy-context.js",
  );
  vi.mocked(realpath).mockImplementation(fs.realpath);
  vi.mocked(classifyToolSafety).mockImplementation(classifier.classifyToolSafety);
});

function record(cwd: string, workspaceRoot?: string): HostSessionRecord {
  return {
    id: "session",
    title: "Session",
    subtitle: null,
    cwd,
    ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
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
}

function setup(options: { cwd?: string; workspaceRoot?: string; legacy?: boolean } = {}) {
  const dir = tempDir("switchyard-policy-boundary-");
  cleanup.push(dir.cleanup);
  const root = join(dir.path, "workspace");
  const cwd = join(root, "nested");
  mkdirSync(cwd, { recursive: true });
  const db = new HostDb(":memory:");
  db.migrate();
  cleanup.push(() => db.close());
  const rec = record(
    options.cwd ?? cwd,
    options.legacy ? undefined : (options.workspaceRoot ?? root),
  );
  db.run("INSERT INTO sessions (id, json) VALUES (?, ?)", [rec.id, JSON.stringify(rec)]);
  let adapter!: AgentBrokerSession;
  const handle = {
    hello: vi.fn().mockResolvedValue(undefined),
    lost: vi.fn(),
    close: vi.fn(),
    request: vi.fn(),
    snapshot: vi.fn(),
  };
  const broker = {
    attach: vi.fn((session: AgentBrokerSession) => {
      adapter = session;
      return handle;
    }),
  };
  const makeSupervisor = () =>
    new SessionSupervisor({
      db,
      link: { emit: vi.fn() } as unknown as CoordinatorLink,
      hostId: "host",
      catalog: {} as AdapterCatalog,
      log: silentLogger(),
      broker: broker as unknown as AgentBroker,
      pi: () => ({ compatible: true, reason: null }),
    });
  const supervisor = makeSupervisor();
  const loaded = supervisor.record(rec.id)!;
  const process = Object.assign(new EventEmitter(), {
    isAlive: true,
    transport: "rpc",
    setPolicyWaiting: vi.fn(),
  });
  const ms = process as unknown as ManagedSession;
  const live = supervisor["newLive"](loaded);
  live.ms = ms;
  supervisor["live"].set(rec.id, live);
  supervisor["wire"](live, ms);
  const hello = (runtimeId = "runtime", nativeSessionId = "native") =>
    process.emit("bridge_features", { runtimeId, nativeSessionId });
  hello();
  return {
    dir: dir.path,
    root,
    cwd,
    rec: loaded,
    db,
    adapter,
    process,
    live,
    supervisor,
    hello,
    makeSupervisor,
  };
}

function evaluation(
  name = "bash",
  args: Record<string, string> = { command: "git push origin main" },
): PolicyEvaluateRequest {
  return { evaluationId: "evaluation", toolCallId: "call", tool: { name, args } };
}
const forbidden = {
  code: "forbidden",
  message: "Cannot verify workspace boundary for policy enforcement.",
};

describe("supervisor trusted policy boundary", () => {
  it("attests the launch record, hashes canonical full args and runs outside the event chain", async () => {
    const h = setup();
    h.live.chain = new Promise(() => {});
    const boundary = await h.adapter.getPolicyBoundary();
    expect(boundary).toEqual({
      cwd: h.cwd,
      workspaceRoot: h.root,
      cwdReal: h.cwd,
      workspaceRootReal: h.root,
    });
    gitResult("origin/trunk\n");
    const request = evaluation("bash", {
      z: "x".repeat(2000),
      command: "git push origin trunk",
      a: "first",
    });
    const context = await h.adapter.getToolPolicyContext(request);
    expect(context).toEqual({
      version: 1,
      toolCallId: "call",
      boundary,
      defaultBranch: "trunk",
      toolHash: createHash("sha256").update(canonicalPolicyJson(request.tool)).digest("hex"),
      safety: {
        destructiveDelete: false,
        forcePush: false,
        defaultBranchPush: true,
        uncertain: false,
        reasons: ["Push targets the default branch."],
      },
    });
    expect(classifyToolSafety).toHaveBeenCalledWith(
      "bash",
      request.tool.args,
      h.cwd,
      h.root,
      "trunk",
    );
    expect(execFile).toHaveBeenCalledWith(
      "git",
      ["-C", h.cwd, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
      expect.objectContaining({
        timeout: 2000,
        maxBuffer: 8192,
        encoding: "utf8",
        env: expect.objectContaining({ GIT_TERMINAL_PROMPT: "0" }),
      }),
      expect.any(Function),
    );
  });

  it("persists the raw root (not its realpath) across supervisor restarts", async () => {
    const h = setup();
    const alias = join(h.dir, "alias");
    symlinkSync(h.root, alias);
    h.rec.workspaceRoot = alias;
    h.supervisor["saveRecord"](h.rec);
    const boundary = await h.adapter.getPolicyBoundary();
    expect(boundary.workspaceRoot).toBe(alias);
    expect(boundary.workspaceRootReal).toBe(h.root);
    expect(h.makeSupervisor().record(h.rec.id)?.workspaceRoot).toBe(alias);
  });

  it.each(["new", "resume", "legacy-resume"])(
    "persists the original launch boundary on %s",
    async (kind) => {
      const h = setup({ legacy: kind === "legacy-resume" });
      h.supervisor["live"].delete(h.rec.id);
      const sessionId = kind === "new" ? "new-session" : h.rec.id;
      // An aborted launch still writes its record, without needing a Pi process.
      await h.supervisor["startNew"](
        {
          sessionId,
          title: "Launch",
          workspacePath: h.dir,
          projectId: "project",
          profile: mockProfile,
          nativeHandle: null,
          initialPrompt: null,
          dispatchKey: null,
          controlRevision: 1,
          controlMode: "human",
          origin: "human",
        },
        AbortSignal.abort(),
      );
      const expected = kind === "new" ? h.dir : kind === "legacy-resume" ? h.cwd : h.root;
      expect(h.makeSupervisor().record(sessionId)?.workspaceRoot).toBe(expected);
    },
  );

  it.each(["running", "stopped"] as const)(
    "initializes a legacy %s record from its original cwd, not a repo parent",
    (runtime) => {
      const h = setup({ legacy: true });
      expect(h.rec.workspaceRoot).toBe(h.cwd);
      const persisted = h.db.getJson<HostSessionRecord>("SELECT json FROM sessions WHERE id = ?", [
        h.rec.id,
      ])!;
      delete persisted.workspaceRoot;
      persisted.runtime = runtime;
      h.db.run("UPDATE sessions SET json = ? WHERE id = ?", [JSON.stringify(persisted), h.rec.id]);
      expect(h.makeSupervisor().record(h.rec.id)?.workspaceRoot).toBe(h.cwd);
      expect(
        h.db.getJson<HostSessionRecord>("SELECT json FROM sessions WHERE id = ?", [h.rec.id])
          ?.workspaceRoot,
      ).toBe(h.cwd);
    },
  );

  it.each(["relative", "missing", "sibling", "nul"])(
    "fails a protected bind for a %s boundary",
    async (kind) => {
      const h = setup();
      if (kind === "relative") h.rec.workspaceRoot = "relative/path";
      if (kind === "missing") h.rec.workspaceRoot = join(h.dir, "missing");
      if (kind === "sibling") {
        h.rec.workspaceRoot = join(h.dir, "work");
        mkdirSync(h.rec.workspaceRoot);
      }
      if (kind === "nul") h.rec.cwd += "\0";
      await expect(h.adapter.getPolicyBoundary()).rejects.toMatchObject(forbidden);
    },
  );

  it("uses path-relative containment, not a common string prefix", async () => {
    const h = setup();
    h.rec.cwd = `${h.root}-outside`;
    mkdirSync(h.rec.cwd);
    await expect(h.adapter.getPolicyBoundary()).rejects.toMatchObject(forbidden);
  });

  it("normalizes dot/trailing separators without confusing lexical paths with realpaths", async () => {
    const h = setup();
    h.rec.cwd += "/./";
    h.rec.workspaceRoot += "/nested/../";
    expect(await h.adapter.getPolicyBoundary()).toEqual({
      cwd: h.cwd,
      workspaceRoot: h.root,
      cwdReal: h.cwd,
      workspaceRootReal: h.root,
    });
  });

  it("does not establish a boundary during a tool action", async () => {
    const h = setup();
    await expect(h.adapter.getToolPolicyContext(evaluation())).rejects.toMatchObject(forbidden);
    expect(execFile).not.toHaveBeenCalled();
  });

  it.each(["cwd", "root"])(
    "detects same-text %s symlink retargeting on every tool and repeated bind",
    async (target) => {
      const h = setup();
      const alias = join(h.dir, "alias");
      const other = join(h.dir, "other");
      mkdirSync(other);
      if (target === "cwd") {
        symlinkSync(h.cwd, alias);
        h.rec.cwd = alias;
        // Both targets remain inside the root: changing realpaths alone must still reject.
        const nested = join(h.root, "other");
        mkdirSync(nested);
        await h.adapter.getPolicyBoundary();
        unlinkSync(alias);
        symlinkSync(nested, alias);
      } else {
        symlinkSync(h.root, alias);
        h.rec.workspaceRoot = alias;
        h.rec.cwd = alias;
        await h.adapter.getPolicyBoundary();
        unlinkSync(alias);
        symlinkSync(other, alias);
      }
      await expect(h.adapter.getToolPolicyContext(evaluation())).rejects.toMatchObject(forbidden);
      h.hello();
      await expect(h.adapter.getPolicyBoundary()).rejects.toMatchObject(forbidden);
      h.hello("new-runtime");
      await expect(h.adapter.getPolicyBoundary()).resolves.toBeDefined();
    },
  );

  it("fails closed when a previously bound path disappears", async () => {
    const h = setup();
    const alias = join(h.dir, "alias");
    symlinkSync(h.cwd, alias);
    h.rec.cwd = alias;
    await h.adapter.getPolicyBoundary();
    unlinkSync(alias);
    await expect(h.adapter.getToolPolicyContext(evaluation())).rejects.toMatchObject(forbidden);
  });

  it.each(["bind", "tool"])(
    "fences an in-flight %s realpath across a same-runtime hello",
    async (operation) => {
      const h = setup();
      if (operation === "tool") await h.adapter.getPolicyBoundary();
      let release!: (path: string) => void;
      vi.mocked(realpath).mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            release = resolve;
          }),
      );
      const pending =
        operation === "bind"
          ? h.adapter.getPolicyBoundary()
          : h.adapter.getToolPolicyContext(evaluation());
      h.hello();
      release(h.cwd);
      await expect(pending).rejects.toMatchObject({ code: "stale_control" });
    },
  );
});

describe("supervisor trusted tool context", () => {
  it.each([
    null,
    "main\n",
    "origin/\n",
    "origin/main\norigin/other\n",
    "origin/../bad\n",
    "origin/bad.lock\n",
    "origin/bad branch\n",
  ])("does not guess main for unknown/invalid remote HEAD %j", async (output) => {
    const h = setup();
    await h.adapter.getPolicyBoundary();
    if (output !== null) gitResult(output);
    const context = await h.adapter.getToolPolicyContext(evaluation());
    expect(context.defaultBranch).toBeNull();
    expect(context.safety).toMatchObject({ defaultBranchPush: false, uncertain: true });
  });

  it("treats a synchronous git failure as an unknown default branch", async () => {
    const h = setup();
    await h.adapter.getPolicyBoundary();
    vi.mocked(execFile).mockImplementationOnce(() => {
      throw new Error("Cannot spawn git");
    });
    expect(await h.adapter.getToolPolicyContext(evaluation())).toMatchObject({
      defaultBranch: null,
      safety: { uncertain: true },
    });
  });

  it("reports all-false non-bash safety and does not swallow classifier exceptions", async () => {
    const h = setup();
    await h.adapter.getPolicyBoundary();
    const context = await h.adapter.getToolPolicyContext(
      evaluation("read", { path: "../outside" }),
    );
    expect(context.safety).toEqual({
      destructiveDelete: false,
      forcePush: false,
      defaultBranchPush: false,
      uncertain: false,
      reasons: [],
    });
    vi.mocked(classifyToolSafety).mockImplementationOnce(() => {
      throw new Error("Classifier unavailable");
    });
    await expect(h.adapter.getToolPolicyContext(evaluation())).rejects.toMatchObject({
      code: "host_unreachable",
    });
  });

  it.each(["hello", "native", "lost", "exit", "replacement", "path", "abort"])(
    "does not return stale tool proof after %s changes during git",
    async (change) => {
      const h = setup();
      await h.adapter.getPolicyBoundary();
      const controller = new AbortController();
      let finish!: GitCallback;
      vi.mocked(execFile).mockImplementation((...args) => {
        finish = args.at(-1) as GitCallback;
        return {} as ChildProcess;
      });
      const pending = h.adapter.getToolPolicyContext(evaluation(), controller.signal);
      // Wait for the asynchronous realpath checks to reach the mocked git call.
      await vi.waitFor(() => expect(finish).toBeDefined());
      if (change === "hello") h.hello();
      if (change === "native")
        h.process.emit("native", { sessionId: "other", sessionFile: "/other.jsonl" });
      if (change === "lost") h.process.emit("bridge_lost");
      if (change === "exit") h.process.emit("exit");
      if (change === "replacement") h.supervisor["live"].delete(h.rec.id);
      if (change === "path") h.rec.workspaceRoot = h.dir;
      if (change === "abort") controller.abort(new Error("Canceled"));
      finish(null, "origin/main\n", "");
      await expect(pending).rejects.toMatchObject(
        change === "abort" ? { message: "Canceled" } : { code: "stale_control" },
      );
      expect(classifyToolSafety).not.toHaveBeenCalled();
    },
  );

  it("rechecks realpaths if symlinks change during git", async () => {
    const h = setup();
    const alias = join(h.dir, "alias");
    symlinkSync(h.cwd, alias);
    h.rec.cwd = alias;
    await h.adapter.getPolicyBoundary();
    vi.mocked(execFile).mockImplementation((...args) => {
      unlinkSync(alias);
      symlinkSync(h.root, alias);
      (args.at(-1) as GitCallback)(null, "origin/main\n", "");
      return {} as ChildProcess;
    });
    await expect(h.adapter.getToolPolicyContext(evaluation())).rejects.toMatchObject(forbidden);
  });
});
