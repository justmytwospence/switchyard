import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import {
  type ContinuationPolicy,
  canonicalPolicyJson,
  type PolicyRule,
} from "@switchyard/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCoordinator, createLogger } from "../src/index.js";
import { builtinPolicyRules } from "../src/policies/builtins.js";
import { PolicyEvaluator } from "../src/policies/evaluator.js";
import {
  assertPolicyLaunchHost,
  currentPolicyLaunchRequirement,
  type PolicyLaunchInput,
  policyLaunchRequirement,
} from "../src/policies/launch.js";
import { requireService } from "../src/services.js";
import { createSession, startOnHost } from "../src/sessions/service.js";
import { hostSession, NO_REPLY, tempDir, until } from "./helpers.js";
import {
  cleanupHarness,
  commandsOf,
  createTask,
  dispatcherOf,
  type Harness,
  settle,
  setupHarness,
  startRun,
  untilRun,
} from "./task-helpers.js";

const now = "2026-01-01T00:00:00.000Z";
const defaults = builtinPolicyRules(now);
const budgets = defaults.filter((r) => r.id !== "destructive-shell");
const input: PolicyLaunchInput = {
  sessionId: null,
  profileId: "prf_test",
  continuation: { enabled: false },
};
const continuation = (
  over: Partial<Extract<ContinuationPolicy, { enabled: true }>> = {},
): ContinuationPolicy => ({
  enabled: true,
  objective: "Finish",
  maxContinuations: 3,
  maxElapsedMinutes: 10,
  maxTokens: null,
  maxCostUsd: null,
  ...over,
});
const requirement = (rules: PolicyRule[] = defaults, over: Partial<PolicyLaunchInput> = {}) =>
  policyLaunchRequirement({ ...input, ...over }, rules, 1);

let h: Harness | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupHarness(h);
  h = undefined;
});

async function disableRules() {
  const policies = requireService(h!.t.c.ctx, "policies");
  for (const rule of policies.listRules())
    await policies.updateRule(rule.id, {
      expectedRevision: rule.revision,
      enabled: false,
    });
}
async function legacyHost() {
  await h!.host.close();
  await h!.host.open({ features: [], capabilities: null, piVersion: "1.4.0" });
}

/** A trusted current binding fixture; an active badge alone is deliberately insufficient. */
function protectSession(id: string) {
  const store = h!.t.c.store;
  const session = store.sessions.require(id);
  const nativeSessionId = session.nativeHandle!.sessionId;
  store.putSession({
    ...session,
    connectivity: "connected",
    runtime: "idle",
    bridge: {
      version: 1,
      runtimeId: "runtime",
      controllerEpoch: "controller-epoch",
      nativeSessionId,
      agentTools: true,
      messageDelivery: true,
      policyState: "active",
      policyPhases: ["tool_call", "request"],
    },
  });
  requireService(h!.t.c.ctx, "policies").bindBoundary(
    {
      authenticatedHostId: session.hostId,
      sessionId: id,
      nativeSessionId,
      runtimeId: "runtime",
    },
    {
      cwd: session.cwd,
      cwdReal: session.cwd,
      workspaceRoot: session.cwd,
      workspaceRootReal: session.cwd,
    },
  );
}

describe("static policy launch predicate", () => {
  it("requires defaults without budgets, but excludes only pristine seeded budget rules", () => {
    expect(requirement()).toMatchObject({
      required: true,
      budgetAccountingRequired: false,
      ruleIds: ["destructive-shell"],
    });
    expect(requirement(budgets)).toMatchObject({
      required: false,
      ruleIds: [],
    });
    expect(
      requirement(
        budgets.map((r) => ({
          ...r,
          name: "renamed",
          revision: 12,
          priority: 999,
        })),
      ),
    ).toMatchObject({ required: false });
    for (const patch of [
      { expression: "null" },
      { phases: ["tool_call"] as PolicyRule["phases"] },
      { phases: ["request", "tool_call"] as PolicyRule["phases"] },
      { builtIn: false },
      { scope: "profile" as const, scopeId: input.profileId },
    ])
      expect(requirement([{ ...budgets[0]!, ...patch }]).required).toBe(true);
    expect(
      requirement([
        {
          ...defaults[0]!,
          expression: 'action == "run.continue" ? null : null',
        },
      ]).required,
    ).toBe(true);
  });

  it("matches only enabled server/profile/exact existing-session scopes", () => {
    const rule = defaults[0]!;
    const rules: PolicyRule[] = [
      { ...rule, id: "disabled", enabled: false },
      { ...rule, id: "profile", scope: "profile", scopeId: "prf_test" },
      { ...rule, id: "other-profile", scope: "profile", scopeId: "prf_other" },
      { ...rule, id: "session", scope: "session", scopeId: "ses_test" },
    ];
    expect(requirement(rules).ruleIds).toEqual(["profile"]);
    expect(requirement(rules, { sessionId: "ses_test" }).ruleIds).toEqual(["profile", "session"]);
    expect(requirement(rules, { profileId: "prf_other", sessionId: "ses_new" }).ruleIds).toEqual([
      "other-profile",
    ]);
    expect(requirement([{ ...rule, enabled: false }]).required).toBe(false);
  });

  it("count/time-only continuation is exempt, token/USD caps always require accounting", () => {
    expect(requirement(budgets, { continuation: continuation() })).toMatchObject({
      required: false,
      budgetAccountingRequired: false,
    });
    for (const cap of [{ maxTokens: 1 }, { maxCostUsd: 0.1 }]) {
      for (const rules of [[], budgets.map((r) => ({ ...r, enabled: false }))])
        expect(requirement(rules, { continuation: continuation(cap) })).toMatchObject({
          required: true,
          budgetAccountingRequired: true,
        });
    }
  });

  it("stamps the canonical complete applicable snapshot BEFORE budget exclusion", () => {
    const result = requirement(budgets);
    expect(result.policyStamp).toBe(
      createHash("sha256")
        .update(
          canonicalPolicyJson({
            ...input,
            settingsRevision: 1,
            rules: [...budgets]
              .sort((a, b) => a.id.localeCompare(b.id))
              .map(({ id, revision, scope, scopeId, enabled, phases, expression }) => ({
                id,
                revision,
                scope,
                scopeId,
                enabled,
                phases,
                expression,
              })),
          }),
        )
        .digest("hex"),
    );
    expect(requirement([...budgets].reverse()).policyStamp).toBe(result.policyStamp);
    expect(requirement(budgets.map((r) => ({ ...r, revision: 2 }))).policyStamp).not.toBe(
      result.policyStamp,
    );
    expect(policyLaunchRequirement(input, budgets, 2).policyStamp).not.toBe(result.policyStamp);
    expect(requirement(budgets, { sessionId: "new" }).policyStamp).not.toBe(result.policyStamp);
  });
});

describe("policy launch rollout and integration gates", () => {
  it("initializes once with the FACTORY rule, preserves owner edits, and advertises only afterward", async () => {
    const dir = tempDir();
    const c = createCoordinator({
      dataDir: dir,
      listen: { host: "127.0.0.1", port: 0 },
      logger: createLogger({ level: "silent" }),
      setupHint: false,
    });
    const policies = requireService(c.ctx, "policies");
    const available = vi.spyOn(c.hostHub, "setAvailableAgentFeatures");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const validate = vi
      .spyOn(PolicyEvaluator.prototype, "validateRule")
      .mockImplementation(async (rule) => {
        expect(rule.expression).toBe(defaults[0]!.expression);
        await gate;
        return { valid: true, returnType: "dyn" };
      });
    try {
      policies.start();
      c.store.db
        .prepare(
          "UPDATE policy_rules SET expression='owner invalid edit', enabled=0 WHERE id='destructive-shell'",
        )
        .run();
      expect(policies.ready).toBe(false);
      expect(() => policies.launchRequirement(input)).toThrow("not initialized");
      const initialization = policies.initialize();
      expect(policies.initialize()).toBe(initialization);
      const started = c.start();
      expect(c.port).toBe(0);
      expect(policies.ready).toBe(false);
      expect(available).not.toHaveBeenCalled();
      release();
      await started;
      expect(validate).toHaveBeenCalledTimes(1);
      expect(policies.ready).toBe(true);
      expect(available).toHaveBeenCalledExactlyOnceWith(
        new Set(["agentRequests.v1", "policies.v1"]),
      );
      expect(policies.getRule("destructive-shell")!.expression).toBe("owner invalid edit");
      expect(policies.launchRequirement(input).required).toBe(false);
    } finally {
      release();
      await c.stop();
      expect(policies.ready).toBe(false);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails startup when evaluator bootstrap fails", async () => {
    const dir = tempDir();
    const c = createCoordinator({
      dataDir: dir,
      listen: { port: 0 },
      logger: createLogger({ level: "silent" }),
      setupHint: false,
    });
    vi.spyOn(PolicyEvaluator.prototype, "validateRule").mockResolvedValue({
      valid: false,
      error: { kind: "worker", message: "unavailable", range: null },
    });
    try {
      await expect(c.start()).rejects.toThrow("initialization failed");
      expect(c.port).toBe(0);
      expect(requireService(c.ctx, "policies").ready).toBe(false);
    } finally {
      await c.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("advertises initialized implementation even when ALL rules are disabled", async () => {
    h = await setupHarness();
    await disableRules();
    await h.host.close();
    const welcome = await h.host.open();
    expect(welcome).toMatchObject({
      type: "welcome",
      features: ["agentRequests.v1", "policies.v1"],
    });
    expect(requireService(h.t.c.ctx, "policies").ready).toBe(true);
  });

  it("availability changes only future hellos and cannot advertise policies without agent requests", async () => {
    h = await setupHarness();
    expect(() => h!.t.c.hostHub.setAvailableAgentFeatures(new Set(["policies.v1"]))).toThrow(
      "requires agentRequests",
    );
    h.t.c.hostHub.setAvailableAgentFeatures(new Set());
    expect([...h.t.c.hostHub.negotiatedFeatures(h.creds.hostId)]).toEqual([
      "agentRequests.v1",
      "policies.v1",
    ]);
    await h.host.close();
    expect(await h.host.open()).toMatchObject({
      type: "welcome",
      features: [],
    });
  });

  it("rejects old-host preflight without a session/workspace/Pi side effect; manual dispatch cannot bypass", async () => {
    h = await setupHarness();
    await legacyHost();
    const count = h.host.commands.length;
    const sessions = h.t.c.store.sessions.list().length;
    const result = await h.t.admin("POST", "/api/sessions", {
      projectId: h.project.id,
      workspace: {
        checkoutId: h.project.checkouts[0]!.id,
        newBranch: "blocked",
      },
      prompt: "go",
    });
    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe("unsupported_capability");
    expect(h.host.commands).toHaveLength(count);
    expect(h.t.c.store.sessions.list()).toHaveLength(sessions);
    const tk = await createTask(h);
    expect(dispatcherOf(h).eligibility({ ...tk, state: "ready" }, { manual: true })).toMatchObject({
      eligible: false,
      wait: "invalid_configuration",
      message: expect.stringContaining("Pi 1.5"),
    });
    expect(h.t.c.store.runs.list()).toHaveLength(0);
  });

  it("allows an old host only without applicable protection, omitting the optional field", async () => {
    h = await setupHarness();
    await legacyHost();
    await disableRules();
    const { run } = await startRun(h);
    expect(commandsOf(h.host, "dispatch.start")[0]).not.toHaveProperty("policyRequired");
    const policies = requireService(h.t.c.ctx, "policies");
    policies.updateSettings({
      expectedRevision: policies.settings().revision,
      modelClassifications: [{ provider: "test", modelId: "cheap", classification: "cheap" }],
    });
    const profile = h.t.c.store.profiles.list()[0]!;
    h.t.c.store.profiles.upsert({
      ...profile,
      provider: "test",
      model: "cheap",
    });
    const capped = await createTask(h, {
      policy: { continuation: continuation({ maxTokens: 1 }) },
    });
    expect(
      dispatcherOf(h).eligibility({ ...capped, state: "ready" }, { manual: true }),
    ).toMatchObject({ eligible: false, wait: "invalid_configuration" });
    expect(run.state).toBe("running");
  });

  it("requires an actual current bridge AND boundary for automated live reuse, not for human live control", async () => {
    h = await setupHarness();
    const { run } = await startRun(h);
    const s = h.t.c.store.sessions.require(run.sessionId!);
    await h.host.event("session.updated", hostSession(s.id, { runtime: "idle", cwd: s.cwd }));
    const required = requireService(h.t.c.ctx, "policies").launchRequirement({
      sessionId: s.id,
      profileId: s.profileSnapshot.id,
      continuation: { enabled: false },
    });
    expect(() => assertPolicyLaunchHost(h!.t.c.ctx, s.hostId, required, s.id)).toThrow(
      "Existing sessions",
    );
    const human = await h.t.admin("POST", `/api/sessions/${s.id}/prompt`, {
      text: "manual",
      mode: "prompt",
      images: [],
    });
    expect(human.status).toBe(200);
    const current = h.t.c.store.sessions.require(s.id);
    h.t.c.store.putSession({
      ...current,
      bridge: {
        version: 1,
        runtimeId: "runtime",
        controllerEpoch: "controller-epoch",
        nativeSessionId: current.nativeHandle!.sessionId,
        agentTools: true,
        messageDelivery: true,
        policyState: "active",
        policyPhases: ["tool_call", "request"],
      },
    });
    expect(() => assertPolicyLaunchHost(h!.t.c.ctx, s.hostId, required, s.id)).toThrow(
      "Existing sessions",
    );
    protectSession(s.id);
    expect(() => assertPolicyLaunchHost(h!.t.c.ctx, s.hostId, required, s.id)).not.toThrow();
    const active = h.t.c.store.sessions.require(s.id);
    h.t.c.store.putSession({ ...active, nativeHandle: null });
    expect(() => assertPolicyLaunchHost(h!.t.c.ctx, s.hostId, required, s.id)).not.toThrow();
    h.t.c.store.putSession(active);
    h.t.c.store.putSession({
      ...active,
      bridge: { ...active.bridge!, policyPhases: ["tool_call"] },
    });
    expect(() => assertPolicyLaunchHost(h!.t.c.ctx, s.hostId, required, s.id)).toThrow(
      "Existing sessions",
    );
    h.t.c.store.putSession(active);
    h.t.c.store.putSession({
      ...h.t.c.store.sessions.require(s.id),
      nativeHandle: { sessionId: "changed", sessionFile: "/new" },
    });
    expect(() => assertPolicyLaunchHost(h!.t.c.ctx, s.hostId, required, s.id)).toThrow();
  });

  it("rechecks current rules at startOnHost after workspace preparation and uses run limits", async () => {
    h = await setupHarness();
    await disableRules();
    const { run } = await startRun(h);
    const s = h.t.c.store.sessions.require(run.sessionId!);
    await legacyHost();
    const policies = requireService(h.t.c.ctx, "policies");
    const destructive = policies.getRule("destructive-shell")!;
    await policies.updateRule(destructive.id, {
      expectedRevision: destructive.revision,
      enabled: true,
    });
    const before = h.host.commands.length;
    await expect(
      startOnHost(h.t.c.ctx, s, {
        initialPrompt: "new",
        nativeHandle: s.nativeHandle,
      }),
    ).rejects.toThrow("Pi 1.5");
    expect(h.host.commands).toHaveLength(before);
    await disableRules();
    h.t.c.store.putRun({ ...run, limits: continuation({ maxCostUsd: 1 }) });
    await expect(
      startOnHost(h.t.c.ctx, s, {
        initialPrompt: null,
        nativeHandle: s.nativeHandle,
      }),
    ).rejects.toThrow("Pi 1.5");
  });

  it("fails closed on missing or unready policy service", async () => {
    h = await setupHarness();
    const policies = requireService(h.t.c.ctx, "policies");
    h.t.c.ctx.services.delete("policies");
    expect(() => currentPolicyLaunchRequirement(h!.t.c.ctx, input)).toThrow("unavailable");
    expect(() =>
      createSession(h!.t.c.ctx, {
        projectId: h!.project.id,
        workspace: { checkoutId: h!.project.checkouts[0]!.id, newBranch: "no" },
        prompt: "go",
      }),
    ).toThrow("unavailable");
    h.t.c.ctx.services.set("policies", policies);
    await policies.stop();
    expect(() => currentPolicyLaunchRequirement(h!.t.c.ctx, input)).toThrow("not initialized");
  });

  it("rechecks a rule added while workspace creation is in flight, before any Pi launch", async () => {
    h = await setupHarness();
    await disableRules();
    await legacyHost();
    let release!: (value: unknown) => void;
    h.override = (cmd) =>
      cmd.type === "workspace.create"
        ? new Promise((resolve) => {
            release = resolve;
          })
        : undefined;
    const created = createSession(h.t.c.ctx, {
      projectId: h.project.id,
      workspace: { checkoutId: h.project.checkouts[0]!.id, newBranch: "race" },
      prompt: "go",
    });
    await until(() => !!release);
    const policies = requireService(h.t.c.ctx, "policies");
    const rule = policies.getRule("destructive-shell")!;
    await policies.updateRule(rule.id, {
      expectedRevision: rule.revision,
      enabled: true,
    });
    release({ path: created.session.cwd });
    await created.started;
    expect(h.t.c.store.sessions.require(created.session.id).runtime).toBe("failed");
    expect(commandsOf(h.host, "session.start")).toHaveLength(0);
  });

  it("rechecks a new rule after dispatch control acknowledgement and before its first automated prompt", async () => {
    h = await setupHarness();
    await disableRules();
    const { task, run } = await startRun(h);
    await settle(h, run.sessionId!, "SWITCHYARD: DONE");
    await until(() => h!.t.c.store.tasks.require(task.id).state === "review");
    let release!: () => void;
    h.override = (cmd) =>
      cmd.type === "session.setControl"
        ? new Promise((resolve) => {
            release = () => resolve(null);
          })
        : undefined;
    const next = await h.t.admin("POST", `/api/tasks/${task.id}/new-attempt`);
    expect(next.status).toBe(200);
    await until(() => !!release);
    const policies = requireService(h.t.c.ctx, "policies");
    const rule = policies.getRule("destructive-shell")!;
    await policies.updateRule(rule.id, {
      expectedRevision: rule.revision,
      enabled: true,
    });
    release();
    await until(() => h!.t.c.store.tasks.require(task.id).blocked !== null);
    expect(commandsOf(h.host, "session.prompt")).toHaveLength(0);
  });

  it("lets a legacy live turn settle but blocks its next protected automated continuation", async () => {
    h = await setupHarness();
    const { task, run } = await startRun(h, {
      policy: { continuation: continuation() },
    });
    await settle(h, run.sessionId!, "partial");
    await until(() => h!.t.c.store.tasks.require(task.id).blocked !== null);
    expect(h.t.c.store.tasks.require(task.id).blocked!.reason).toContain("Existing sessions");
    expect(h.t.c.store.runs.require(run.id).continuationsUsed).toBe(0);
    expect(commandsOf(h.host, "session.prompt")).toHaveLength(0);
  });

  it("bind recomputes current requirements, returns the approval URL, and refuses unsupported potential", async () => {
    h = await setupHarness();
    const { run } = await startRun(h);
    const s = h.t.c.store.sessions.require(run.sessionId!);
    const frame = {
      type: "agent.request" as const,
      requestId: "bind",
      sessionId: s.id,
      nativeSessionId: s.nativeHandle!.sessionId,
      runtimeId: "new-runtime",
      context: { humanInputId: null, causalMessageId: null },
      method: "session.bind" as const,
      args: {
        version: 1,
        sessionFile: s.nativeHandle!.sessionFile,
        mode: "rpc",
        policyRequired: false,
        controllerEpoch: "controller-epoch",
        capabilities: {
          agentTools: true,
          messageDelivery: true,
          editorDraftGuard: true,
          toolPolicy: true,
        },
        policyBoundary: {
          cwd: s.cwd,
          cwdReal: s.cwd,
          workspaceRoot: s.cwd,
          workspaceRootReal: s.cwd,
        },
      },
    };
    const agents = requireService(h.t.c.ctx, "agents");
    expect(await agents.handle(s.hostId, frame)).toMatchObject({
      ok: true,
      result: {
        policyRequired: true,
        features: ["agentRequests.v1", "policies.v1"],
        sessionUrl: `${h.t.c.config.publicUrl}/code/${s.id}`,
      },
    });
    const host = h.t.c.store.hosts.require(s.hostId);
    h.t.c.store.putHost({
      ...host,
      capabilities: { ...host.capabilities!, policies: false },
    });
    expect(await agents.handle(s.hostId, { ...frame, requestId: "unsupported" })).toMatchObject({
      ok: false,
      error: { code: "unsupported_capability" },
    });
    await disableRules();
    expect(await agents.handle(s.hostId, { ...frame, requestId: "optional" })).toMatchObject({
      ok: true,
      result: {
        policyRequired: false,
        features: ["agentRequests.v1"],
        sessionUrl: null,
      },
    });
  });

  it("freezes the first outbound launch and never mutates policyRequired on reconnect replay", async () => {
    h = await setupHarness({
      coordinator: { dispatcher: { tickMs: 0, startTimeoutMs: 100 } },
    });
    await disableRules();
    let swallow = true;
    h.override = (cmd) => (cmd.type === "dispatch.start" && swallow ? NO_REPLY : undefined);
    const tk = await createTask(h, { state: "ready" });
    const run = await untilRun(h, tk.id, "uncertain");
    const original = commandsOf(h.host, "dispatch.start")[0]!;
    expect(original.policyRequired).toBe(false);
    const policies = requireService(h.t.c.ctx, "policies");
    const rule = policies.getRule("destructive-shell")!;
    await policies.updateRule(rule.id, {
      expectedRevision: rule.revision,
      enabled: true,
    });
    expect(dispatcherOf(h).buildCommand(h.t.c.store.runs.require(run.id))).toEqual(original);
    swallow = false;
    await h.host.close();
    await h.host.open();
    await untilRun(h, tk.id, "running");
    const replay = commandsOf(h.host, "dispatch.start");
    expect(replay.length).toBeGreaterThan(1);
    expect(replay.every((cmd) => canonicalPolicyJson(cmd) === canonicalPolicyJson(original))).toBe(
      true,
    );
  });
});
