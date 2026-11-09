import { createHash } from "node:crypto";
import {
  canonicalPolicyJson,
  DEFAULT_TASK_POLICY,
  type HostPolicyBoundary,
  type PolicyRule,
  type PolicyRuleResult,
  type Profile,
  type Run,
  type Session,
} from "@switchyard/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LATEST_MIGRATION, MIGRATIONS, migrate, openDb } from "../src/db/index.js";
import { EventHub } from "../src/event-hub.js";
import { BUDGET_ACCOUNTING_UNAVAILABLE, builtinPolicyRules } from "../src/policies/builtins.js";
import type { PolicyAuthorizeInput, PolicyOwner } from "../src/policies/contracts.js";
import { PolicyEvaluator } from "../src/policies/evaluator.js";
import { PolicyService, type PolicyServiceOptions } from "../src/policies/service.js";
import { Store } from "../src/store.js";
import { createTask } from "../src/tasks/service.js";

const now = "2026-01-01T00:00:00.000Z";
const hostPolicyConnection = () => ({
  connected: true,
  features: new Set(["agentRequests.v1", "policies.v1"]),
});
const profile: Profile = {
  id: "prf_test",
  name: "Test",
  provider: null,
  model: null,
  thinking: null,
  projectTrust: "ask",
  extraArgs: [],
};
const owner: PolicyOwner = {
  authenticatedHostId: "hst_test",
  sessionId: "ses_test",
  nativeSessionId: "native-test",
  runtimeId: "bridge-runtime",
};
const boundary: HostPolicyBoundary = {
  cwd: "/repos/app",
  workspaceRoot: "/repos/app",
  cwdReal: "/real/app",
  workspaceRootReal: "/real/app",
};
const safety = {
  destructiveDelete: false,
  forcePush: false,
  defaultBranchPush: false,
  uncertain: false,
  reasons: [],
};
let store: Store;
let service: PolicyService;
let evaluator: NonNullable<PolicyServiceOptions["evaluator"]>;
let behavior: (rule: PolicyRule) => PolicyRuleResult;
let attention: ReturnType<typeof vi.fn>;

function session(over: Partial<Session> = {}): Session {
  return {
    id: owner.sessionId,
    title: "Test",
    subtitle: null,
    hostId: owner.authenticatedHostId,
    projectId: "prj_test",
    workspaceId: null,
    cwd: boundary.cwd,
    nativeHandle: { sessionId: owner.nativeSessionId, sessionFile: "/sessions/test.jsonl" },
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
      controllerEpoch: "controller-test",
      agentTools: true,
      messageDelivery: true,
      policyState: "active",
      policyPhases: ["tool_call", "request"],
    },
    ...over,
  };
}

function toolInput(
  callId = "call-1",
  args = { command: "echo hello" },
): Extract<PolicyAuthorizeInput, { kind: "tool" }> {
  const tool = { name: "bash", args };
  return {
    kind: "tool",
    owner,
    frame: {
      type: "agent.request",
      requestId: "request-1",
      sessionId: owner.sessionId,
      nativeSessionId: owner.nativeSessionId,
      runtimeId: owner.runtimeId,
      context: { humanInputId: null, causalMessageId: null },
      toolCallId: callId,
      method: "policy.evaluate",
      args: {
        evaluationId: `pol_${createHash("sha256")
          .update(JSON.stringify([owner.sessionId, owner.nativeSessionId, "tool_call", callId]))
          .digest("hex")}`,
        toolCallId: callId,
        tool,
      },
    },
    hostContext: {
      version: 1,
      toolCallId: callId,
      toolHash: createHash("sha256").update(canonicalPolicyJson(tool)).digest("hex"),
      boundary,
      defaultBranch: "trunk",
      safety,
    },
  };
}

async function rule(
  name: string,
  scope: PolicyRule["scope"] = "server",
  priority = 0,
): Promise<PolicyRule> {
  return service.createRule({
    scope,
    scopeId: scope === "session" ? owner.sessionId : scope === "profile" ? profile.id : null,
    priority,
    enabled: true,
    phases: ["tool_call", "request"],
    name,
    expression: name,
  });
}
function rows(table: string): unknown[] {
  return store.db.prepare(`SELECT * FROM ${table}`).all();
}
async function useFakeSampleClassifier() {
  await service.stop();
  const classifySample = vi.fn<NonNullable<PolicyServiceOptions["classifySample"]>>(
    async (request) => {
      expect(store.inTransaction).toBe(false);
      return {
        sessionId: request.sessionId,
        nativeSessionId: request.nativeSessionId,
        runtimeId: request.runtimeId,
        sampleId: request.sampleId,
        toolHash: createHash("sha256").update(canonicalPolicyJson(request.tool)).digest("hex"),
        boundary,
        defaultBranch: "trunk",
        safety,
      };
    },
  );
  service = new PolicyService({
    store,
    publicUrl: "http://localhost:7400",
    evaluator,
    reconcileInputAttention: attention,
    hostPolicyConnection,
    classifySample,
  });
  service.start();
  service.bindBoundary(owner, boundary);
  return classifySample;
}

async function answer(ask: Awaited<ReturnType<PolicyService["authorize"]>>, confirmed = true) {
  if (ask.verdict !== "ASK") throw new Error("Expected ASK");
  const interaction = store.interactions.require(ask.interactionId);
  return service.answer(ask.decisionId, interaction.revision, confirmed, "dev_owner");
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
  store.projects.upsert({
    id: "prj_test",
    name: "Test",
    repoIdentity: "https://github.com/test/test",
    defaultProfileId: profile.id,
    defaultHostId: owner.authenticatedHostId,
    maxConcurrentRuns: 1,
    automationEnabled: false,
    setupCommand: null,
    checks: [],
    workspaceSharing: "single_writer",
    worktreeDir: ".worktrees",
    createdAt: now,
    updatedAt: now,
  });
  store.profiles.upsert(profile);
  store.putSession(session());
  attention = vi.fn();
  behavior = () => null;
  evaluator = {
    validateRule: vi.fn(async () => ({ valid: true, returnType: "dyn" })),
    evaluateRules: vi.fn(async (rules) => {
      expect(store.inTransaction).toBe(false);
      return rules.map((r) => ({
        ruleId: r.id,
        ruleRevision: r.revision,
        result: behavior(r),
        error: null,
      }));
    }),
  };
  service = new PolicyService({
    store,
    publicUrl: "http://localhost:7400",
    evaluator,
    reconcileInputAttention: attention,
    hostPolicyConnection,
  });
  service.start();
  service.bindBoundary(owner, boundary);
});
afterEach(async () => {
  await service.stop();
  store.db.close();
});

describe("policy migration and trusted runtime boundaries", () => {
  it("appends migrations 011 and 012 without changing previous applied rows", () => {
    const db = openDb(":memory:");
    for (const migration of MIGRATIONS.filter((m) => m.version < 11)) db.exec(migration.sql);
    db.exec(
      "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT,applied_at TEXT)",
    );
    db.prepare("INSERT INTO schema_migrations VALUES (10,'010_task_notifications',?)").run(now);
    db.prepare("INSERT INTO settings(key,value) VALUES ('preserved','123')").run();
    expect(migrate(db)).toBe(LATEST_MIGRATION);
    expect(db.prepare("SELECT value FROM settings WHERE key='preserved'").get()).toEqual({
      value: "123",
    });
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name='policy_runtime_boundaries'").get(),
    ).toBeTruthy();
    db.close();
  });

  it("authorizes a fileless session with its pinned bridge identity", async () => {
    store.putSession({ ...store.sessions.require(owner.sessionId), nativeHandle: null });
    expect(await service.authorize(toolInput())).toEqual({ verdict: "ALLOW" });
  });

  it("pins authenticated host attestations idempotently and rejects repinning", () => {
    service.bindBoundary(owner, boundary);
    expect(rows("policy_runtime_boundaries")).toHaveLength(1);
    expect(() =>
      service.bindBoundary(owner, {
        ...boundary,
        cwdReal: "/real/other",
        workspaceRootReal: "/real/other",
      }),
    ).toThrow(/repinned/);
    expect(() =>
      service.bindBoundary({ ...owner, authenticatedHostId: "other" }, boundary),
    ).toThrow();
    expect(() =>
      service.bindBoundary({ ...owner, runtimeId: "new" }, { ...boundary, cwd: "/elsewhere" }),
    ).toThrow(/boundary/);
    expect(() =>
      service.bindBoundary({ ...owner, runtimeId: "new" }, { ...boundary, cwdReal: "/outside" }),
    ).toThrow();
    service.bindBoundary(
      { ...owner, runtimeId: "new" },
      { ...boundary, cwdReal: "/new", workspaceRootReal: "/new" },
    );
    expect(rows("policy_runtime_boundaries")).toHaveLength(2);
  });

  it("fails closed for changed realpaths, missing proof, hashes and substituted runtime", async () => {
    const input = toolInput();
    await expect(service.authorize({ ...input, hostContext: undefined! })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(
      service.authorize({
        ...input,
        hostContext: { ...input.hostContext, toolHash: "0".repeat(64) },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      service.authorize({
        ...input,
        hostContext: {
          ...input.hostContext,
          boundary: { ...boundary, cwdReal: "/changed", workspaceRootReal: "/changed" },
        },
      }),
    ).rejects.toMatchObject({ code: "stale_control" });
    await expect(
      service.authorize({ ...input, owner: { ...owner, runtimeId: "forged" } }),
    ).rejects.toMatchObject({ code: "stale_control" });
    expect(evaluator.evaluateRules).not.toHaveBeenCalled();
  });
});

describe("whole logical authorization", () => {
  it("never commits updates after cancellation during post-approval worker evaluation", async () => {
    await rule("ask");
    behavior = (r) =>
      r.name === "ask" ? { verdict: "ASK", reason: "ask", state_updates: { n: 1 } } : null;
    const input = toolInput();
    const pending = await service.authorize(input);
    if (pending.verdict !== "ASK") throw new Error("Expected ASK");
    const original = evaluator.evaluateRules;
    let begin!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      begin = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    evaluator.evaluateRules = async (...args) => {
      begin();
      await held;
      return original(...args);
    };
    const answering = answer(pending);
    await started;
    service.cancel(owner, { decisionId: pending.decisionId });
    release();
    await expect(answering).rejects.toMatchObject({ code: "stale_control" });
    expect(rows("policy_counters")).toHaveLength(0);
    expect(
      await service.status(owner, { decisionId: pending.decisionId, waitMs: 25000 }),
    ).toMatchObject({ state: "canceled" });
  });
  it("commits provisional updates once when a human denies and replays the denial", async () => {
    await rule("ask");
    behavior = (r) =>
      r.name === "ask" ? { verdict: "ASK", reason: "ask", state_updates: { count: 1 } } : null;
    const input = toolInput();
    const pending = await service.authorize(input);
    expect(rows("policy_counters")).toHaveLength(0);
    await answer(pending, false);
    expect(await service.authorize(input)).toEqual({
      verdict: "DENY",
      reason: "The policy action was denied.",
    });
    expect(rows("policy_counters")).toMatchObject([{ version: 1 }]);
    expect((await answer(pending, false)).status).toBe("already_answered");
    expect(rows("policy_counters")).toMatchObject([{ version: 1 }]);
  });

  it("recovers a crash after durable grant but before authorization reevaluation", async () => {
    const asking = await rule("ask");
    behavior = (r) => (r.name === "ask" ? { verdict: "ASK", reason: "ask" } : null);
    const input = toolInput();
    const pending = await service.authorize(input);
    if (pending.verdict !== "ASK") throw new Error("Expected ASK");
    const interaction = store.interactions.require(pending.interactionId);
    store.db
      .prepare(`INSERT INTO policy_grants(id,scope_kind,scope_id,rule_id,rule_revision,
      fingerprint,approved_by_device_id,approved_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(
        "pgr_crash",
        "session",
        owner.sessionId,
        asking.id,
        asking.revision,
        interaction.permission!.fingerprint,
        "dev_owner",
        now,
      );
    store.putInteraction({
      ...interaction,
      revision: interaction.revision + 1,
      state: "resolved",
      resolution: { by: "dev_owner", summary: "Allowed matching action", at: now },
    });
    await service.stop();
    service = new PolicyService({
      store,
      publicUrl: "http://localhost:7400",
      evaluator,
      reconcileInputAttention: attention,
      hostPolicyConnection,
    });
    service.start();
    expect(await service.authorize(input)).toEqual({ verdict: "ALLOW" });
    expect(store.interactions.list()).toHaveLength(1);
    expect(await service.status(owner, { decisionId: pending.decisionId, waitMs: 25000 })).toEqual({
      state: "allowed",
    });
  });

  it("keeps grants on the root tree and invalidates both roots on reparenting", async () => {
    const firstRoot = createTask(
      { store },
      { projectId: "prj_test", title: "First" },
      { kind: "manual" },
    );
    const secondRoot = createTask(
      { store },
      { projectId: "prj_test", title: "Second" },
      { kind: "manual" },
    );
    const child = createTask(
      { store },
      { projectId: "prj_test", title: "Child", parentTaskId: firstRoot.id },
      { kind: "manual" },
    );
    store.putSession(session({ taskId: child.id }));
    await rule("ask");
    behavior = (r) => (r.name === "ask" ? { verdict: "ASK", reason: "ask" } : null);
    const pending = await service.authorize(toolInput());
    await answer(pending);
    expect(rows("policy_grants")).toMatchObject([{ scope_kind: "task", scope_id: firstRoot.id }]);
    expect(await service.authorize(toolInput("call-2"))).toEqual({ verdict: "ALLOW" });
    store.putTask({ ...child, parentTaskId: secondRoot.id });
    expect(rows("policy_grants")).toHaveLength(0);
    expect((await service.authorize(toolInput("call-3"))).verdict).toBe("ASK");
  });
  it("keeps one decision pending across sequential ASK interactions, then allows", async () => {
    await rule("first", "session");
    await rule("second", "server");
    behavior = (r) =>
      ["first", "second"].includes(r.name) ? { verdict: "ASK", reason: r.name } : null;
    const input = toolInput();
    const first = await service.authorize(input);
    expect(first.verdict).toBe("ASK");
    if (first.verdict !== "ASK") return;
    const firstRevision = store.interactions.require(first.interactionId).revision;
    await answer(first);
    const second = await service.authorize(input);
    expect(second.verdict).toBe("ASK");
    if (second.verdict !== "ASK") return;
    expect(second.decisionId).toBe(first.decisionId);
    expect(second.interactionId).not.toBe(first.interactionId);
    expect(rows("policy_grants")).toHaveLength(1);
    const duplicate = await service.answer(first.decisionId, firstRevision, true, "dev_other");
    expect(duplicate.status).toBe("already_answered");
    expect(rows("policy_grants")).toHaveLength(1);
    await answer(second);
    expect(await service.status(owner, { decisionId: first.decisionId, waitMs: 25000 })).toEqual({
      state: "allowed",
    });
    expect(await service.authorize(input)).toEqual({ verdict: "ALLOW" });
    expect(rows("policy_evaluations")).toHaveLength(1);
    expect(attention.mock.calls.map(([i]) => i.state)).toEqual([
      "pending",
      "resolved",
      "pending",
      "resolved",
    ]);
  });

  it("does not report allowed after ASK when a later rule denies", async () => {
    await rule("first", "session");
    await rule("last", "server");
    behavior = (r) =>
      r.name === "first"
        ? { verdict: "ASK", reason: "confirm" }
        : r.name === "last"
          ? { verdict: "DENY", reason: "server denied" }
          : null;
    const first = await service.authorize(toolInput());
    await answer(first);
    if (first.verdict !== "ASK") return;
    expect(await service.status(owner, { decisionId: first.decisionId, waitMs: 25000 })).toEqual({
      state: "denied",
      reason: "server denied",
    });
  });

  it("explicit session ALLOW suppresses profile ASK only", async () => {
    await rule("session", "session");
    await rule("profile", "profile");
    await rule("server", "server");
    behavior = (r) =>
      r.name === "session"
        ? { verdict: "ALLOW", reason: "" }
        : r.name === "profile"
          ? { verdict: "ASK", reason: "profile" }
          : r.name === "server"
            ? { verdict: "DENY", reason: "server" }
            : null;
    expect(await service.authorize(toolInput())).toEqual({ verdict: "DENY", reason: "server" });
    behavior = (r) =>
      r.name === "session"
        ? { verdict: "ALLOW", reason: "" }
        : r.name === "profile"
          ? { verdict: "DENY", reason: "profile denies" }
          : null;
    expect(await service.authorize(toolInput("call-2"))).toEqual({
      verdict: "DENY",
      reason: "profile denies",
    });
    behavior = (r) =>
      r.name === "profile" ? { verdict: "ASK", reason: "no explicit session allow" } : null;
    expect((await service.authorize(toolInput("call-3"))).verdict).toBe("ASK");
  });

  it("persists denial/cancel, enforces full decision ownership and cancels stale control", async () => {
    await rule("ask");
    behavior = (r) => (r.name === "ask" ? { verdict: "ASK", reason: "ask" } : null);
    const first = await service.authorize(toolInput());
    if (first.verdict !== "ASK") throw new Error("Expected ASK");
    await expect(
      service.status(
        { ...owner, nativeSessionId: "other" },
        { decisionId: first.decisionId, waitMs: 25000 },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(() =>
      service.cancel({ ...owner, authenticatedHostId: "other" }, { decisionId: first.decisionId }),
    ).toThrow();
    expect(service.cancel(owner, { decisionId: first.decisionId })).toEqual({ state: "canceled" });
    expect(
      await service.status(owner, { decisionId: first.decisionId, waitMs: 25000 }),
    ).toMatchObject({ state: "canceled" });
    const second = await service.authorize(toolInput("call-2"));
    store.putSession({ ...store.sessions.require(owner.sessionId), readOnly: true });
    await expect(answer(second)).rejects.toMatchObject({ code: "conflict" });
    expect(rows("policy_grants")).toHaveLength(0);
  });

  it("survives service restart without recreating questions or granting early", async () => {
    await rule("ask");
    behavior = (r) => (r.name === "ask" ? { verdict: "ASK", reason: "ask" } : null);
    const first = await service.authorize(toolInput());
    await service.stop();
    service = new PolicyService({
      store,
      publicUrl: "http://localhost:7400",
      evaluator,
      reconcileInputAttention: attention,
      hostPolicyConnection,
    });
    service.start();
    expect(await service.authorize(toolInput())).toEqual(first);
    expect(store.interactions.list()).toHaveLength(1);
    await answer(first);
    if (first.verdict !== "ASK") return;
    expect(await service.status(owner, { decisionId: first.decisionId, waitMs: 25000 })).toEqual({
      state: "allowed",
    });
  });

  it("final post-ASK proof refresh checks metadata and does not duplicate counter commits", async () => {
    await rule("ask");
    behavior = (r) =>
      r.name === "ask" ? { verdict: "ASK", reason: "confirm", state_updates: { count: 1 } } : null;
    const input = toolInput();
    const first = await service.authorize(input);
    expect(rows("policy_counters")).toHaveLength(0);
    await answer(first);
    expect(await service.authorize(input)).toEqual({ verdict: "ALLOW" });
    expect(rows("policy_counters")).toMatchObject([{ counters_json: '{"count":1}', version: 1 }]);
    await expect(
      service.authorize({
        ...input,
        hostContext: { ...input.hostContext, defaultBranch: "changed" },
      }),
    ).rejects.toMatchObject({ code: "stale_control" });
    expect(rows("policy_counters")).toMatchObject([{ version: 1 }]);
  });
});

describe("counters, worker fences and administrative operations", () => {
  it("does not fabricate host classification for a sample shell command", async () => {
    await expect(
      service.test({
        sessionId: owner.sessionId,
        phase: "tool_call",
        tool: { name: "bash", args: { command: "echo hello" } },
        request: null,
      }),
    ).rejects.toMatchObject({ code: "unsupported_capability" });
    expect(rows("policy_evaluations")).toHaveLength(0);
  });

  it("does not materialize settings or other writes from the tester", async () => {
    const classifySample = await useFakeSampleClassifier();
    store.db.prepare("DELETE FROM settings WHERE key='policySettings'").run();
    const before = rows("settings");
    await service.test({
      sessionId: owner.sessionId,
      phase: "tool_call",
      tool: { name: "read", args: {} },
      request: null,
    });
    expect(classifySample).toHaveBeenCalledOnce();
    expect(rows("settings")).toEqual(before);
    expect(rows("policy_evaluations")).toHaveLength(0);
  });
  it("commits isolated patches once and rejects changed logical input", async () => {
    const a = await rule("a");
    const b = await rule("b");
    behavior = (r) =>
      ["a", "b"].includes(r.name)
        ? { verdict: "ALLOW", reason: "", state_updates: { n: r.name === "a" ? 2 : 3 } }
        : null;
    const input = toolInput();
    await service.authorize(input);
    await service.authorize(input);
    expect(rows("policy_counters")).toHaveLength(2);
    expect(rows("policy_counters")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule_id: a.id, counters_json: '{"n":2}', version: 1 }),
        expect.objectContaining({ rule_id: b.id, counters_json: '{"n":3}', version: 1 }),
      ]),
    );
    await expect(
      service.authorize(toolInput("call-1", { command: "different" })),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("worker failures commit no updates from earlier matching rules", async () => {
    await rule("a", "session");
    const bad = await rule("bad");
    behavior = (r) =>
      r.name === "a" ? { verdict: "ALLOW", reason: "", state_updates: { n: 1 } } : null;
    const original = evaluator.evaluateRules;
    evaluator.evaluateRules = async (rules, context, counters) =>
      rules[0]?.id === bad.id
        ? [
            {
              ruleId: bad.id,
              ruleRevision: bad.revision,
              result: null,
              error: { kind: "runtime", message: "bad", range: null },
            },
          ]
        : original(rules, context, counters);
    expect((await service.authorize(toolInput())).verdict).toBe("DENY");
    expect(rows("policy_counters")).toHaveLength(0);
  });

  it("retries changed versions without keeping a transaction across worker awaits", async () => {
    const r = await rule("change");
    let changed = false;
    evaluator.evaluateRules = vi.fn(async (rules) => {
      expect(store.inTransaction).toBe(false);
      if (!changed) {
        changed = true;
        store.db.prepare("UPDATE policy_rules SET revision=revision+1 WHERE id=?").run(r.id);
      }
      return rules.map((rule) => ({
        ruleId: rule.id,
        ruleRevision: rule.revision,
        result: null,
        error: null,
      }));
    });
    expect(await service.authorize(toolInput())).toEqual({ verdict: "ALLOW" });
    expect(rows("policy_evaluations")).toHaveLength(1);
  });

  it("validates worker compilation before writes, CAS revisions and classification pairs", async () => {
    evaluator.validateRule = async () => ({
      valid: false,
      error: { kind: "parse", message: "bad CEL", range: { start: 2, end: 3 } },
    });
    await expect(rule("broken")).rejects.toMatchObject({
      code: "invalid_request",
      details: { range: { start: 2, end: 3 } },
    });
    evaluator.validateRule = async () => ({ valid: true, returnType: "dyn" });
    const r = await rule("good");
    expect((await service.updateRule(r.id, { expectedRevision: 1, name: "edited" })).revision).toBe(
      2,
    );
    await expect(
      service.updateRule(r.id, { expectedRevision: 1, enabled: false }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(() => service.deleteRule(r.id, 1)).toThrow();
    service.deleteRule(r.id, 2);
    expect(service.settings()).toMatchObject({ revision: 1, modelClassifications: [] });
    const classification = { provider: "provider", modelId: "model", classification: "cheap" };
    expect(() =>
      service.updateSettings({
        expectedRevision: 1,
        modelClassifications: [classification, classification],
      }),
    ).toThrow();
    expect(
      service.updateSettings({ expectedRevision: 1, modelClassifications: [classification] })
        .revision,
    ).toBe(2);
    await expect(service.createRule({ phases: ["model_request"] })).rejects.toThrow(/Pre-provider/);
  });

  it("tester creates no approvals, grants, counters or executions, including run.continue", async () => {
    const classifySample = await useFakeSampleClassifier();
    await rule("ask");
    behavior = (r) =>
      r.name === "ask" ? { verdict: "ASK", reason: "sample", state_updates: { sample: 1 } } : null;
    const result = await service.test({
      sessionId: owner.sessionId,
      phase: "tool_call",
      tool: { name: "read", args: { path: "file" } },
      request: null,
    });
    expect(result).toMatchObject({ verdict: "ASK", enforcement: { modelRequest: false } });
    expect(result.trace.find((t) => t.reason === "sample")?.proposedStateUpdates).toEqual({
      sample: 1,
    });
    expect(
      await service.test({
        sessionId: owner.sessionId,
        phase: "request",
        tool: null,
        request: { method: "run.continue", args: {} },
      }),
    ).toMatchObject({ verdict: "ASK" });
    expect(classifySample).toHaveBeenCalledOnce();
    expect(rows("policy_evaluations")).toHaveLength(0);
    expect(rows("policy_counters")).toHaveLength(0);
    expect(rows("policy_grants")).toHaveLength(0);
    expect(store.interactions.list()).toHaveLength(0);
  });

  it("seeds stable builtins once, preserving edits and explicit deletion on restart", async () => {
    await service.updateRule("destructive-shell", { expectedRevision: 1, enabled: false });
    service.deleteRule("continuation-soft-budget", 1);
    await service.stop();
    service.start();
    expect(service.getRule("destructive-shell")?.enabled).toBe(false);
    expect(service.getRule("continuation-soft-budget")).toBeUndefined();
  });
});

function continuation(maxTokens: number | null = 1000, maxCostUsd: number | null = null) {
  const task = createTask({ store }, { projectId: "prj_test", title: "Task" }, { kind: "manual" });
  const run: Run = {
    id: "run_test",
    taskId: task.id,
    sessionId: owner.sessionId,
    hostId: owner.authenticatedHostId,
    dispatchKey: "test",
    attempt: 1,
    state: "running",
    controlMode: "automation",
    controlRevision: 1,
    continuationsUsed: 0,
    infraRetries: 0,
    nextAttemptAt: null,
    startedAt: now,
    endedAt: null,
    outcome: null,
    limits: {
      enabled: true,
      objective: "Finish",
      maxContinuations: 5,
      maxElapsedMinutes: 60,
      maxTokens,
      maxCostUsd,
    },
    usage: { tokens: 850, costUsd: 8.5, accounting: "available", note: null },
    checks: [],
    createdAt: now,
    updatedAt: now,
  };
  store.putRun(run);
  store.putTask({
    ...task,
    policy: { ...DEFAULT_TASK_POLICY, continuation: run.limits },
    currentRunId: run.id,
    sessionId: owner.sessionId,
  });
  store.putSession(
    session({
      runId: run.id,
      taskId: task.id,
      stats: {
        tokens: 850,
        costUsd: 8.5,
        watermark: { runtimeId: "accounting-epoch-not-bridge", settleSeq: 7 },
      },
    }),
  );
  store.noteRunSettle(run.id);
  return {
    kind: "continuation" as const,
    runId: run.id,
    expectedControlRevision: 1,
    nextContinuationNumber: 1,
    expectedSettleCount: 1,
    expectedWatermark: { runtimeId: "accounting-epoch-not-bridge", settleSeq: 7 },
  };
}

describe("continuation fences and completed accounting", () => {
  it("uses accounting epoch, not the unrelated bridge runtime", async () => {
    const input = continuation();
    expect(await service.authorize(input)).toEqual({ verdict: "ALLOW" });
    expect(await service.authorize(input)).toEqual({ verdict: "ALLOW" });
  });
  it("allows missing watermark only without configured accounting caps", async () => {
    const input = continuation(null, null);
    expect(await service.authorize({ ...input, expectedWatermark: null })).toEqual({
      verdict: "ALLOW",
    });
    const run = store.runs.require(input.runId);
    store.putRun({
      ...run,
      limits: {
        ...run.limits,
        enabled: true,
        objective: "Finish",
        maxContinuations: 5,
        maxElapsedMinutes: 60,
        maxTokens: 1000,
        maxCostUsd: null,
      },
    });
    await expect(service.authorize({ ...input, expectedWatermark: null })).rejects.toMatchObject({
      code: "stale_control",
    });
  });
  it("denies absent cap metrics instead of treating them as zero", async () => {
    const input = continuation();
    store.putSession({
      ...store.sessions.require(owner.sessionId),
      stats: { tokens: null, costUsd: null },
    });
    expect(await service.authorize({ ...input, expectedWatermark: null })).toEqual({
      verdict: "DENY",
      reason: BUDGET_ACCOUNTING_UNAVAILABLE,
    });
  });
  it("denies a missing current watermark even when the caller retained the old tuple", async () => {
    const input = continuation();
    store.putSession({
      ...store.sessions.require(owner.sessionId),
      stats: { tokens: 850, costUsd: 8.5 },
    });
    expect(await service.authorize(input)).toEqual({
      verdict: "DENY",
      reason: BUDGET_ACCOUNTING_UNAVAILABLE,
    });
  });
  it.each(["epoch", "sequence", "settlement", "control", "model", "limit"])(
    "invalidates pending continuation on %s change",
    async (change) => {
      const input = continuation();
      await rule("ask");
      behavior = (r) => (r.name === "ask" ? { verdict: "ASK", reason: "continue?" } : null);
      const pending = await service.authorize(input);
      const current = store.sessions.require(owner.sessionId);
      const run = store.runs.require(input.runId);
      if (change === "epoch" || change === "sequence")
        store.putSession({
          ...current,
          stats: {
            tokens: 850,
            costUsd: 8.5,
            watermark: {
              runtimeId: change === "epoch" ? "new-epoch" : input.expectedWatermark.runtimeId,
              settleSeq: change === "sequence" ? 8 : 7,
            },
          },
        });
      if (change === "settlement") store.noteRunSettle(run.id);
      if (change === "control") store.putRun({ ...run, controlMode: "human", controlRevision: 2 });
      if (change === "model")
        store.putSession({ ...current, profileSnapshot: { ...profile, model: "changed" } });
      if (change === "limit" && run.limits.enabled)
        store.putRun({ ...run, limits: { ...run.limits, maxTokens: 2000 } });
      await expect(answer(pending)).rejects.toMatchObject({ code: "conflict" });
      expect(store.runs.require(run.id).continuationsUsed).toBe(0);
    },
  );
});

async function useRealEvaluator() {
  await service.stop();
  service = new PolicyService({
    store,
    publicUrl: "http://localhost:7400",
    hostPolicyConnection,
    reconcileInputAttention: attention,
  });
  service.start();
}

describe("builtin policies on the real bounded CEL evaluator", () => {
  it("evaluates an owner-edited soft builtin normally, even with no budget caps", async () => {
    const input = continuation(null, null);
    await useRealEvaluator();
    await service.updateRule("continuation-soft-budget", {
      expectedRevision: 1,
      expression: '{"verdict":"ASK", "reason":"Owner rule"}',
    });
    expect((await service.authorize(input)).verdict).toBe("ASK");
  });

  it("invalidates soft grants when a configured limit changes, including changing it back", async () => {
    const input = continuation();
    await useRealEvaluator();
    const pending = await service.authorize(input);
    await answer(pending);
    expect(rows("policy_grants")).toHaveLength(1);
    const run = store.runs.require(input.runId);
    if (!run.limits.enabled) throw new Error("Expected enabled limits");
    store.putRun({ ...run, limits: { ...run.limits, maxTokens: 2000 } });
    store.putRun(run);
    expect(rows("policy_grants")).toHaveLength(0);
    store.noteRunSettle(run.id);
    expect((await service.authorize({ ...input, expectedSettleCount: 2 })).verdict).toBe("ASK");
  });
  it("compiles every seeded builtin off the main thread", async () => {
    const real = new PolicyEvaluator();
    try {
      for (const builtin of builtinPolicyRules(now))
        expect(await real.validateRule(builtin)).toMatchObject({ valid: true });
    } finally {
      await real.close();
    }
  });
  it("asks only for host-classified shell risk", async () => {
    await useRealEvaluator();
    expect(await service.authorize(toolInput())).toEqual({ verdict: "ALLOW" });
    const input = toolInput("danger");
    expect(
      (
        await service.authorize({
          ...input,
          hostContext: { ...input.hostContext, safety: { ...safety, forcePush: true } },
        })
      ).verdict,
    ).toBe("ASK");
  });
  it("asks tokens before USD under one decision and acknowledges each configured metric", async () => {
    const input = continuation(1000, 10);
    await useRealEvaluator();
    const first = await service.authorize(input);
    expect(first.verdict).toBe("ASK");
    if (first.verdict !== "ASK") return;
    await answer(first);
    const second = await service.authorize(input);
    expect(second.verdict).toBe("ASK");
    if (second.verdict !== "ASK") return;
    expect(second.decisionId).toBe(first.decisionId);
    await answer(second);
    expect(await service.authorize(input)).toEqual({ verdict: "ALLOW" });
    expect(rows("policy_grants")).toHaveLength(2);
  });
  it("hard-denies unknown/expensive models before soft ASK and exempts only classified cheap models", async () => {
    const input = continuation();
    const current = store.sessions.require(owner.sessionId);
    store.putSession({
      ...current,
      stats: { ...current.stats!, tokens: 1100 },
      profileSnapshot: { ...profile, provider: "test", model: "cheap" },
    });
    await useRealEvaluator();
    expect((await service.authorize(input)).verdict).toBe("DENY");
    service.updateSettings({
      expectedRevision: 1,
      modelClassifications: [{ provider: "test", modelId: "cheap", classification: "cheap" }],
    });
    // A different settlement is a new execution identity, not permission to replay old DENY.
    store.noteRunSettle(input.runId);
    const next = { ...input, expectedSettleCount: 2 };
    const ask = await service.authorize(next);
    expect(ask.verdict).toBe("ASK");
    await answer(ask);
    expect(await service.authorize(next)).toEqual({ verdict: "ALLOW" });
  });
});
