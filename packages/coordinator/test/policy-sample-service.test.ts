import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalPolicyJson,
  type HostPolicyBoundary,
  type HostPolicySampleRequest,
  type HostPolicySampleResult,
  type PolicyTestRequest,
  type Profile,
  type Session,
  SwitchyardError,
} from "@switchyard/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate, openDb } from "../src/db/index.js";
import { EventHub } from "../src/event-hub.js";
import type { PolicyOwner } from "../src/policies/contracts.js";
import { PolicyEvaluator } from "../src/policies/evaluator.js";
import { PolicyService, type PolicyServiceOptions } from "../src/policies/service.js";
import { Store } from "../src/store.js";

const now = "2026-01-01T00:00:00.000Z";
const owner: PolicyOwner = {
  authenticatedHostId: "hst_sample",
  sessionId: "ses_sample",
  nativeSessionId: "native-sample",
  runtimeId: "runtime-sample",
};
const boundary: HostPolicyBoundary = {
  cwd: "/repos/app",
  workspaceRoot: "/repos/app",
  cwdReal: "/real/app",
  workspaceRootReal: "/real/app",
};
const profile: Profile = {
  id: "prf_sample",
  name: "Sample",
  provider: null,
  model: null,
  thinking: null,
  projectTrust: "ask",
  extraArgs: [],
};
const safe = {
  destructiveDelete: false,
  forcePush: false,
  defaultBranchPush: false,
  uncertain: false,
  reasons: [],
};
const toolRequest = (name = "bash", args = { command: "echo hello" }): PolicyTestRequest => ({
  sessionId: owner.sessionId,
  phase: "tool_call",
  tool: { name, args },
  request: null,
});
const requestSample: PolicyTestRequest = {
  sessionId: owner.sessionId,
  phase: "request",
  tool: null,
  request: { method: "inbox.read", args: {} },
};
const trustedResult = (request: HostPolicySampleRequest): HostPolicySampleResult => ({
  sessionId: request.sessionId,
  nativeSessionId: request.nativeSessionId,
  runtimeId: request.runtimeId,
  sampleId: request.sampleId,
  toolHash: createHash("sha256").update(canonicalPolicyJson(request.tool)).digest("hex"),
  boundary,
  defaultBranch: "trunk",
  safety: safe,
});

let store: Store;
let service: PolicyService;
let classify: ReturnType<typeof vi.fn<NonNullable<PolicyServiceOptions["classifySample"]>>>;
let evaluator: NonNullable<PolicyServiceOptions["evaluator"]>;
let attention: ReturnType<typeof vi.fn>;
let events: ReturnType<typeof vi.fn>;
let directories: string[];

function updateSession(patch: Partial<Session>) {
  store.putSession({ ...store.sessions.require(owner.sessionId), ...patch });
}
function bridge(patch: Partial<NonNullable<Session["bridge"]>>) {
  updateSession({ bridge: { ...store.sessions.require(owner.sessionId).bridge!, ...patch } });
}
function dbSnapshot() {
  const tables = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as { name: string }[];
  return Object.fromEntries(
    tables.map(({ name }) => [name, store.db.prepare(`SELECT * FROM "${name}"`).all()]),
  );
}
function replaceService(options: Partial<PolicyServiceOptions> = {}) {
  // These replacements occur before asynchronous work; the original service is not started.
  service = new PolicyService({
    store,
    publicUrl: "http://localhost:7400",
    hostPolicyConnection: () => ({
      connected: true,
      features: new Set(["agentRequests.v1", "policies.v1"]),
    }),
    reconcileInputAttention: attention,
    evaluator,
    classifySample: classify,
    ...options,
  });
}

beforeEach(() => {
  const db = openDb(":memory:");
  migrate(db);
  store = new Store(db, new EventHub(), () => new Date(now));
  store.hosts.upsert(
    {
      id: owner.authenticatedHostId,
      name: "Host",
      platform: "darwin",
      agentVersion: "test",
      piVersion: "1.5.0",
      piCompatible: true,
      capabilities: null,
      connectivity: "connected",
      lastSeenAt: now,
      revokedAt: null,
      createdAt: now,
    },
    { credential_hash: "hash" },
  );
  store.profiles.upsert(profile);
  store.putSession({
    id: owner.sessionId,
    title: "Sample",
    subtitle: null,
    hostId: owner.authenticatedHostId,
    projectId: null,
    workspaceId: null,
    cwd: boundary.cwd,
    nativeHandle: { sessionId: owner.nativeSessionId, sessionFile: "/sessions/sample.jsonl" },
    profileSnapshot: profile,
    runtime: "idle",
    runtimeDetail: null,
    connectivity: "connected",
    runId: null,
    taskId: null,
    provenance: "created",
    readOnly: false,
    lastActivityAt: now,
    archivedAt: null,
    queue: { steering: [], followUp: [] },
    stats: null,
    lastAssistantText: null,
    createdAt: now,
    bridge: {
      version: 1,
      runtimeId: owner.runtimeId,
      nativeSessionId: owner.nativeSessionId,
      controllerEpoch: "controller-sample",
      agentTools: true,
      messageDelivery: true,
      policyState: "active",
      policyPhases: ["tool_call", "request"],
    },
  });
  attention = vi.fn();
  events = vi.fn();
  store.hub.on("event", events);
  classify = vi.fn(async (request) => {
    expect(store.inTransaction).toBe(false);
    return trustedResult(request);
  });
  evaluator = {
    validateRule: vi.fn(async () => ({ valid: true, returnType: "dyn" })),
    evaluateRules: vi.fn(async (rules) => {
      expect(store.inTransaction).toBe(false);
      return rules.map((r) => ({
        ruleId: r.id,
        ruleRevision: r.revision,
        result: null,
        error: null,
      }));
    }),
  };
  replaceService();
  service.bindBoundary(owner, boundary);
  directories = [];
});
afterEach(async () => {
  await service.stop();
  store.db.close();
  for (const path of directories) rmSync(path, { recursive: true, force: true });
});

async function customRule(
  expression = 'dyn({"verdict":"ASK","reason":"sample","state_updates":{"seen":2}})',
) {
  return service.createRule({
    scope: "server",
    scopeId: null,
    priority: -500,
    enabled: true,
    phases: ["tool_call", "request"],
    name: "Sample counter",
    expression,
  });
}

describe("read-only host-classified policy samples", () => {
  it("sends fresh sample identities for every tool and only uses trusted real paths and safety", async () => {
    await customRule();
    for (const name of ["bash", "read"]) await service.test(toolRequest(name));
    expect(classify).toHaveBeenCalledTimes(2);
    const requests = classify.mock.calls.map(([request]) => request);
    expect(requests[0]).toMatchObject({
      sessionId: owner.sessionId,
      nativeSessionId: owner.nativeSessionId,
      runtimeId: owner.runtimeId,
      tool: { name: "bash", args: { command: "echo hello" } },
    });
    expect(requests[0]!.sampleId).toMatch(/^[0-9a-f-]{36}$/);
    expect(requests[0]!.sampleId).not.toBe(requests[1]!.sampleId);
    expect(Object.keys(requests[0]!).sort()).toEqual([
      "nativeSessionId",
      "runtimeId",
      "sampleId",
      "sessionId",
      "tool",
    ]);
    expect(evaluator.evaluateRules).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        session: expect.objectContaining({
          cwd: boundary.cwdReal,
          workspaceRoot: boundary.workspaceRootReal,
          defaultBranch: "trunk",
        }),
        tool: expect.objectContaining({ safety: safe }),
      }),
      expect.any(Object),
    );
  });

  it("uses host safety rather than sample arguments for safe/destructive/uncertain verdicts", async () => {
    replaceService({ evaluator: new PolicyEvaluator() });
    service.start();
    for (const [command, safety, verdict] of [
      ["echo hello", safe, "ALLOW"],
      ["rm -rf /outside", { ...safe, destructiveDelete: true }, "ASK"],
      ["git push --force", { ...safe, forcePush: true }, "ASK"],
      ["rm -rf $(echo /outside)", { ...safe, uncertain: true }, "ASK"],
    ] as const) {
      classify.mockImplementationOnce(async (request) => ({ ...trustedResult(request), safety }));
      expect(await service.test(toolRequest("bash", { command }))).toMatchObject({ verdict });
    }
  });

  it("returns a real CEL ASK and proposed counters without any database/event/permission or command effects", async () => {
    replaceService({ evaluator: new PolicyEvaluator() });
    // Seed built-ins, then use the real destructive-shell expression and an independent counter rule.
    service.start();
    const counter = await customRule(
      'dyn({"verdict":"ASK","reason":"sample","state_updates":{"seen":counters.seen + 1}})',
    );
    store.db
      .prepare("INSERT INTO policy_counters VALUES ('session',?,?,?,1)")
      .run(owner.sessionId, counter.id, '{"seen":1}');
    const dir = mkdtempSync(join(tmpdir(), "policy-sample-"));
    directories.push(dir);
    const sentinel = join(dir, "sentinel");
    const preserved = join(dir, "preserved");
    writeFileSync(preserved, "keep");
    const command = `touch ${sentinel}; rm -rf /outside ${preserved}`;
    // Explicit fake trusted host classification; this callback never executes the sample.
    classify.mockImplementation(async (request) => ({
      ...trustedResult(request),
      safety: { ...safe, destructiveDelete: true, reasons: ["outside workspace"] },
    }));
    const before = dbSnapshot();
    events.mockClear();
    const authorize = vi.spyOn(service, "authorize");
    const answer = vi.spyOn(service, "answer");
    const bind = vi.spyOn(service, "bindBoundary");
    const result = await service.test(toolRequest("bash", { command }));
    expect(result.verdict).toBe("ASK");
    expect(result.proposedStateUpdates[counter.id]).toEqual({ seen: 2 });
    expect(dbSnapshot()).toEqual(before);
    expect(events).not.toHaveBeenCalled();
    expect(attention).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
    expect(answer).not.toHaveBeenCalled();
    expect(bind).not.toHaveBeenCalled();
    expect(existsSync(sentinel)).toBe(false);
    expect(existsSync(preserved)).toBe(true);
    // Exercise the actual built-in too, rather than only the early custom ASK.
    await service.updateRule(counter.id, { expectedRevision: 1, enabled: false });
    const beforeBuiltin = dbSnapshot();
    expect(await service.test(toolRequest("bash", { command }))).toMatchObject({
      verdict: "ASK",
      trace: [expect.objectContaining({ ruleId: "destructive-shell", granted: false })],
    });
    expect(dbSnapshot()).toEqual(beforeBuiltin);
  });

  it("never materializes absent settings during a successful request test", async () => {
    const before = dbSnapshot();
    expect(await service.test(requestSample)).toMatchObject({ verdict: "ALLOW" });
    expect(classify).not.toHaveBeenCalled();
    expect(dbSnapshot()).toEqual(before);
  });

  it.each(["sessionId", "nativeSessionId", "runtimeId", "sampleId", "toolHash"] as const)(
    "rejects a mismatched %s before invoking CEL",
    async (field) => {
      await customRule();
      classify.mockImplementation(async (request) => ({
        ...trustedResult(request),
        [field]: field === "toolHash" ? "a".repeat(64) : "different-identity",
      }));
      await expect(service.test(toolRequest())).rejects.toMatchObject({ code: "forbidden" });
      expect(evaluator.evaluateRules).not.toHaveBeenCalled();
    },
  );

  it("rejects a changed canonical boundary instead of repinning it", async () => {
    await customRule();
    classify.mockImplementation(async (request) => ({
      ...trustedResult(request),
      boundary: { ...boundary, cwdReal: "/other/app", workspaceRootReal: "/other/app" },
    }));
    const before = dbSnapshot();
    await expect(service.test(toolRequest())).rejects.toMatchObject({ code: "stale_control" });
    expect(evaluator.evaluateRules).not.toHaveBeenCalled();
    expect(dbSnapshot()).toEqual(before);
  });

  it("rejects malformed trusted responses rather than manufacturing a verdict", async () => {
    classify.mockResolvedValue({ safety: safe } as HostPolicySampleResult);
    await expect(service.test(toolRequest())).rejects.toMatchObject({ code: "invalid_request" });
  });

  it.each(["host_unreachable", "timeout", "unsupported_capability"] as const)(
    "preserves host availability error %s",
    async (code) => {
      const error = new SwitchyardError(code, "unavailable");
      classify.mockRejectedValue(error);
      await expect(service.test(toolRequest())).rejects.toBe(error);
    },
  );

  it("rejects device-supplied safety/path/identity fields", async () => {
    for (const extra of [{ safety: safe }, { boundary }, { hostId: "another-host" }]) {
      await expect(service.test({ ...toolRequest(), ...extra })).rejects.toMatchObject({
        code: "invalid_request",
      });
    }
    expect(classify).not.toHaveBeenCalled();
  });
});

describe("sample availability and pinned snapshots", () => {
  it.each(["bash", "read"])("requires a classifier callback even for %s", async (name) => {
    replaceService({ classifySample: undefined });
    await expect(service.test(toolRequest(name))).rejects.toMatchObject({
      code: "unsupported_capability",
    });
  });

  it.each([toolRequest(), requestSample])(
    "does not invent real paths without a pinned boundary ($phase)",
    async (request) => {
      store.db.prepare("DELETE FROM policy_runtime_boundaries").run();
      const before = dbSnapshot();
      await expect(service.test(request)).rejects.toMatchObject({
        code: "unsupported_capability",
        message: "Select a session with policy support to test this rule.",
      });
      expect(dbSnapshot()).toEqual(before);
      expect(classify).not.toHaveBeenCalled();
    },
  );

  it.each([
    { bridge: undefined },
    { nativeHandle: { sessionId: "different-native", sessionFile: "/sessions/sample.jsonl" } },
    { runtime: "stopped" as const },
    { archivedAt: now },
  ])("rejects unavailable session state %j", async (patch) => {
    updateSession(patch);
    await expect(service.test(requestSample)).rejects.toMatchObject({
      code: "unsupported_capability",
    });
    expect(classify).not.toHaveBeenCalled();
  });

  it("accepts a fileless session with its pinned bridge identity", async () => {
    updateSession({ nativeHandle: null });
    expect(await service.test(toolRequest())).toMatchObject({ verdict: "ALLOW" });
    expect(await service.test(requestSample)).toMatchObject({ verdict: "ALLOW" });
  });

  it.each(["unsupported", "initializing", "lost"] as const)(
    "rejects bridge policy state %s",
    async (policyState) => {
      bridge({ policyState });
      await expect(service.test(toolRequest())).rejects.toMatchObject({
        code: "unsupported_capability",
      });
    },
  );

  it("requires the current phase's support", async () => {
    bridge({ policyPhases: ["request"] });
    await expect(service.test(toolRequest())).rejects.toMatchObject({
      code: "unsupported_capability",
    });
    expect(await service.test(requestSample)).toMatchObject({ verdict: "ALLOW" });
  });

  it("allows offline request what-ifs from a pinned snapshot but not tool samples", async () => {
    const host = store.hosts.require(owner.authenticatedHostId);
    store.hosts.upsert({ ...host, connectivity: "unreachable" });
    updateSession({ connectivity: "unreachable" });
    await expect(service.test(toolRequest())).rejects.toMatchObject({ code: "host_unreachable" });
    expect(await service.test(requestSample)).toMatchObject({ verdict: "ALLOW" });
    expect(classify).not.toHaveBeenCalled();
  });

  it("rejects raw cwd changes instead of copying them into canonical paths", async () => {
    updateSession({ cwd: "/changed/app" });
    await expect(service.test(requestSample)).rejects.toMatchObject({ code: "stale_control" });
  });

  it("resolves message targets from stored identity and rejects an unknown recipient", async () => {
    await expect(
      service.test({
        ...requestSample,
        request: {
          method: "message.send",
          args: { sessionId: "ses_missing", body: "sample", mode: "queue" },
        },
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(classify).not.toHaveBeenCalled();
  });
});

describe("sample await fences and cancellation", () => {
  describe.each(["host", "worker"] as const)("after the %s await", (stage) => {
    it.each(["runtime", "native", "host", "task", "rule", "settings", "counter"])(
      "rechecks the %s fence",
      async (fence) => {
        const rule = await customRule();
        const changes: Record<string, () => unknown> = {
          runtime: () => bridge({ runtimeId: "new-runtime" }),
          native: () => bridge({ nativeSessionId: "new-native" }),
          host: () => updateSession({ hostId: "hst_other" }),
          task: () => updateSession({ taskId: "tsk_missing" }),
          rule: () =>
            store.db.prepare("UPDATE policy_rules SET revision=revision+1 WHERE id=?").run(rule.id),
          settings: () =>
            store.setSetting("policySettings", {
              revision: 2,
              modelClassifications: [],
              updatedAt: now,
            }),
          counter: () =>
            store.db
              .prepare("INSERT OR REPLACE INTO policy_counters VALUES ('session',?,?,?,2)")
              .run(owner.sessionId, rule.id, '{"seen":2}'),
        };
        const change = changes[fence]!;
        if (stage === "host") {
          classify.mockImplementation(async (request) => {
            change();
            return trustedResult(request);
          });
        } else {
          vi.mocked(evaluator.evaluateRules).mockImplementationOnce(async (rules) => {
            change();
            return rules.map((r) => ({
              ruleId: r.id,
              ruleRevision: r.revision,
              result: null,
              error: null,
            }));
          });
        }
        await expect(service.test(toolRequest())).rejects.toMatchObject({ code: "stale_control" });
      },
    );
  });

  it.each(["host", "worker"] as const)(
    "ignores incidental activity and native file metadata after the %s await",
    async (stage) => {
      await customRule();
      const change = () =>
        updateSession({
          lastActivityAt: "2026-01-02T00:00:00.000Z",
          nativeHandle: {
            sessionId: owner.nativeSessionId,
            sessionFile: "/sessions/renamed.jsonl",
          },
        });
      if (stage === "host") {
        classify.mockImplementation(async (request) => {
          change();
          return trustedResult(request);
        });
      } else {
        vi.mocked(evaluator.evaluateRules).mockImplementationOnce(async (rules) => {
          change();
          return rules.map((r) => ({
            ruleId: r.id,
            ruleRevision: r.revision,
            result: null,
            error: null,
          }));
        });
      }
      expect(await service.test(toolRequest())).toMatchObject({ verdict: "ALLOW" });
    },
  );

  it("passes cancellation to host classification and ignores a late response", async () => {
    await customRule();
    const controller = new AbortController();
    const error = new Error("disconnected");
    let finish!: (result: HostPolicySampleResult) => void;
    classify.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const before = dbSnapshot();
    const pending = service.test(toolRequest(), { signal: controller.signal });
    expect(classify.mock.calls[0]![1].signal).toBe(controller.signal);
    controller.abort(error);
    await expect(pending).rejects.toBe(error);
    finish(trustedResult(classify.mock.calls[0]![0]));
    await Promise.resolve();
    expect(evaluator.evaluateRules).not.toHaveBeenCalled();
    expect(dbSnapshot()).toEqual(before);
  });

  it("cancels a worker wait and prevents more rule evaluations", async () => {
    await customRule();
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.mocked(evaluator.evaluateRules).mockImplementation(() => {
      started();
      return new Promise(() => {});
    });
    const controller = new AbortController();
    const pending = service.test(requestSample, { signal: controller.signal });
    await entered;
    controller.abort(new Error("cancel worker"));
    await expect(pending).rejects.toThrow("cancel worker");
    expect(evaluator.evaluateRules).toHaveBeenCalledOnce();
  });

  it("does not begin a pre-canceled test", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancel before host"));
    await expect(service.test(toolRequest(), { signal: controller.signal })).rejects.toThrow(
      "cancel before host",
    );
    expect(classify).not.toHaveBeenCalled();
  });
});
