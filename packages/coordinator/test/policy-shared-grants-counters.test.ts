import { createHash } from "node:crypto";
import {
  canonicalPolicyJson,
  type HostPolicyBoundary,
  type PolicyRule,
  type Profile,
  type Session,
} from "@switchyard/protocol";
import { afterEach, beforeEach, expect, it } from "vitest";
import { migrate, openDb } from "../src/db/index.js";
import { EventHub } from "../src/event-hub.js";
import type { PolicyAuthorizeInput, PolicyOwner } from "../src/policies/contracts.js";
import { PolicyService, type PolicyServiceOptions } from "../src/policies/service.js";
import { Store } from "../src/store.js";
import { createTask } from "../src/tasks/service.js";

const now = "2026-01-01T00:00:00.000Z";
const profile: Profile = {
  id: "prf_shared",
  name: "Test",
  provider: null,
  model: null,
  thinking: null,
  projectTrust: "ask",
  extraArgs: [],
};
const boundary: HostPolicyBoundary = {
  cwd: "/repo",
  workspaceRoot: "/repo",
  cwdReal: "/real/repo",
  workspaceRootReal: "/real/repo",
};
const safety = {
  destructiveDelete: false,
  forcePush: false,
  defaultBranchPush: false,
  uncertain: false,
  reasons: [],
};
let store: Store;
let services: PolicyService[];
let owners: PolicyOwner[];

function makeService(evaluator: NonNullable<PolicyServiceOptions["evaluator"]>) {
  const service = new PolicyService({
    store,
    publicUrl: "http://localhost:7400",
    evaluator,
    reconcileInputAttention: () => {},
    hostPolicyConnection: () => ({
      connected: true,
      features: new Set(["agentRequests.v1", "policies.v1"]),
    }),
  });
  service.start();
  services.push(service);
  return service;
}
function input(
  owner: PolicyOwner,
  call: string,
  name = "bash",
  args: Record<string, unknown> = { command: "echo hello" },
  b = boundary,
): Extract<PolicyAuthorizeInput, { kind: "tool" }> {
  const tool = { name, args };
  return {
    kind: "tool",
    owner,
    frame: {
      type: "agent.request",
      requestId: call,
      sessionId: owner.sessionId,
      nativeSessionId: owner.nativeSessionId,
      runtimeId: owner.runtimeId,
      context: { humanInputId: null, causalMessageId: null },
      toolCallId: call,
      method: "policy.evaluate",
      args: {
        evaluationId: `pol_${createHash("sha256")
          .update(JSON.stringify([owner.sessionId, owner.nativeSessionId, "tool_call", call]))
          .digest("hex")}`,
        toolCallId: call,
        tool,
      },
    },
    hostContext: {
      version: 1,
      toolCallId: call,
      toolHash: createHash("sha256").update(canonicalPolicyJson(tool)).digest("hex"),
      boundary: b,
      defaultBranch: "main",
      safety,
    },
  };
}
async function addRule(service: PolicyService) {
  return service.createRule({
    scope: "server",
    scopeId: null,
    priority: 0,
    enabled: true,
    phases: ["tool_call"],
    name: "shared",
    expression: "shared",
  });
}
async function approve(
  service: PolicyService,
  result: Awaited<ReturnType<PolicyService["authorize"]>>,
) {
  if (result.verdict !== "ASK") throw new Error(`Expected ASK, got ${result.verdict}`);
  const interaction = store.interactions.require(result.interactionId);
  await service.answer(result.decisionId, interaction.revision, true, "dev_owner");
}

beforeEach(() => {
  const db = openDb(":memory:");
  migrate(db);
  store = new Store(db, new EventHub(), () => new Date(now));
  services = [];
  store.hosts.upsert(
    {
      id: "hst_shared",
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
  store.projects.upsert({
    id: "prj_shared",
    name: "Project",
    repoIdentity: "https://github.com/test/test",
    defaultProfileId: profile.id,
    defaultHostId: "hst_shared",
    maxConcurrentRuns: 2,
    automationEnabled: false,
    setupCommand: null,
    checks: [],
    workspaceSharing: "single_writer",
    worktreeDir: ".worktrees",
    createdAt: now,
    updatedAt: now,
  });
  const root = createTask(
    { store },
    { projectId: "prj_shared", title: "Root" },
    { kind: "manual" },
  );
  owners = ["one", "two", "othercwd"].map((id) => {
    const child = createTask(
      { store },
      { projectId: "prj_shared", title: id, parentTaskId: root.id },
      { kind: "manual" },
    );
    const owner = {
      authenticatedHostId: "hst_shared",
      sessionId: `ses_${id}`,
      nativeSessionId: `native-${id}`,
      runtimeId: `runtime-${id}`,
    };
    const cwd = id === "othercwd" ? "/elsewhere" : boundary.cwd;
    const session: Session = {
      id: owner.sessionId,
      title: id,
      subtitle: null,
      hostId: owner.authenticatedHostId,
      projectId: "prj_shared",
      workspaceId: null,
      cwd,
      nativeHandle: null,
      profileSnapshot: profile,
      runtime: "idle",
      runtimeDetail: null,
      connectivity: "connected",
      runId: null,
      taskId: child.id,
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
        controllerEpoch: `controller-${id}`,
        agentTools: true,
        messageDelivery: true,
        policyState: "active",
        policyPhases: ["tool_call", "request"],
      },
    };
    store.putSession(session);
    return owner;
  });
});
afterEach(async () => {
  for (const service of services) await service.stop();
  store.db.close();
});

it("shares only exact root-scoped grants between sibling sessions", async () => {
  const evaluator: NonNullable<PolicyServiceOptions["evaluator"]> = {
    validateRule: async () => ({ valid: true, returnType: "dyn" }),
    evaluateRules: async (rules) =>
      rules.map((r) => ({
        ruleId: r.id,
        ruleRevision: r.revision,
        result: r.name === "shared" ? { verdict: "ASK", reason: "approve" } : null,
        error: null,
      })),
  };
  const service = makeService(evaluator);
  const otherBoundary = {
    cwd: "/elsewhere",
    workspaceRoot: "/elsewhere",
    cwdReal: "/real/elsewhere",
    workspaceRootReal: "/real/elsewhere",
  };
  for (const [i, owner] of owners.entries())
    service.bindBoundary(owner, i === 2 ? otherBoundary : boundary);
  const rule = await addRule(service);
  await approve(service, await service.authorize(input(owners[0]!, "first")));
  const rootId = store.tasks.require(
    store.sessions.require(owners[0]!.sessionId).taskId!,
  ).parentTaskId;
  expect(
    store.db.prepare("SELECT scope_kind,scope_id,rule_revision FROM policy_grants").all(),
  ).toEqual([{ scope_kind: "task", scope_id: rootId, rule_revision: 1 }]);
  expect(await service.authorize(input(owners[1]!, "same"))).toEqual({ verdict: "ALLOW" });
  const differentArgs = await service.authorize(
    input(owners[1]!, "args", "bash", { command: "echo different" }),
  );
  expect(differentArgs.verdict).toBe("ASK");
  await approve(service, differentArgs);
  const differentAction = await service.authorize(
    input(owners[1]!, "action", "read", { command: "echo hello" }),
  );
  expect(differentAction.verdict).toBe("ASK");
  await approve(service, differentAction);
  const differentCwd = await service.authorize(
    input(owners[2]!, "cwd", "bash", { command: "echo hello" }, otherBoundary),
  );
  expect(differentCwd.verdict).toBe("ASK");
  await approve(service, differentCwd);
  expect(store.db.prepare("SELECT * FROM policy_grants").all()).toHaveLength(4);
  await service.updateRule(rule.id, { expectedRevision: rule.revision, name: "shared revised" });
  // Keep the fake's behavior unchanged across the edit.
  evaluator.evaluateRules = async (rules: PolicyRule[]) =>
    rules.map((r) => ({
      ruleId: r.id,
      ruleRevision: r.revision,
      result: r.id === rule.id ? { verdict: "ASK", reason: "approve" } : null,
      error: null,
    }));
  const revised = await service.authorize(input(owners[1]!, "revision"));
  expect(revised.verdict).toBe("ASK");
  await approve(service, revised);
  expect(
    store.db.prepare("SELECT rule_revision FROM policy_grants WHERE rule_id=?").all(rule.id),
  ).toContainEqual({ rule_revision: 2 });
});

it("persists both concurrent independent increments after a stale counter snapshot", async () => {
  let release!: () => void;
  let bothStarted!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    bothStarted = resolve;
  });
  let arrivals = 0;
  const seen: number[] = [];
  const evaluator: NonNullable<PolicyServiceOptions["evaluator"]> = {
    validateRule: async () => ({ valid: true, returnType: "dyn" }),
    evaluateRules: async (rules, _context, counters) => {
      const r = rules[0]!;
      if (r.name !== "shared")
        return [{ ruleId: r.id, ruleRevision: r.revision, result: null, error: null }];
      const n = Number(counters[r.id]?.count ?? 0);
      seen.push(n);
      if (++arrivals <= 2) {
        if (arrivals === 2) bothStarted();
        await gate;
      }
      return [
        {
          ruleId: r.id,
          ruleRevision: r.revision,
          result: { verdict: "ALLOW", reason: "count", state_updates: { count: n + 1 } },
          error: null,
        },
      ];
    },
  };
  const first = makeService(evaluator);
  const second = makeService(evaluator);
  for (const owner of owners.slice(0, 2)) first.bindBoundary(owner, boundary);
  const rule = await addRule(first);
  const a = first.authorize(input(owners[0]!, "concurrent-one"));
  const b = second.authorize(input(owners[1]!, "concurrent-two"));
  await started;
  release();
  expect(seen).toEqual([0, 0]);
  expect(await Promise.all([a, b])).toEqual([{ verdict: "ALLOW" }, { verdict: "ALLOW" }]);
  const row = store.db
    .prepare(
      "SELECT scope_kind,scope_id,counters_json,version FROM policy_counters WHERE rule_id=?",
    )
    .get(rule.id) as {
    scope_kind: string;
    scope_id: string;
    counters_json: string;
    version: number;
  };
  expect(row).toMatchObject({ scope_kind: "task", version: 2 });
  expect(row.scope_id).toBe(
    store.tasks.require(store.sessions.require(owners[0]!.sessionId).taskId!).parentTaskId,
  );
  expect(JSON.parse(row.counters_json)).toEqual({ count: 2 });
  expect(seen).toContain(1);
});
