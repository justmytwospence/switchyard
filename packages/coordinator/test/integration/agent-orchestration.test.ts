import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentInbox, AgentRequestFrame, AgentResultFrame } from "@switchyard/protocol";
import type { MockReply, MockRequest } from "@switchyard/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireService } from "../../src/services.js";
import { FakeHost, hostSession } from "../helpers.js";
import { DONE_TEXT, Integration, waitFor, waitForValue } from "./harness.js";

const PRIVATE_BODY = "Private ordinary message: orchestration payload 7391";
const REPLY_BODY = "Read the private payload; reply 7391";
const CHILD_OBJECTIVE = "ORCHESTRATION_CHILD: finish the delegated work";

function call(name: string, args: Record<string, unknown>, id?: string): MockReply {
  return { toolCalls: [{ name, arguments: args, ...(id ? { id } : {}) }] };
}

/** The actual text emitted by the bridge tool, as received by the installed Pi's model client. */
function toolResult<T>(request: MockRequest): T {
  return JSON.parse(request.lastText) as T;
}

function nativeEntries(env: Integration, sessionId: string) {
  const file = env.session(sessionId).nativeHandle!.sessionFile!;
  // Pi announces its native path before lazily creating the JSONL on the first turn.
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function nativeDeliveries(env: Integration, sessionId: string, deliveryId: string) {
  // Pi stores custom messages as top-level custom_message entries, not ordinary messages.
  return nativeEntries(env, sessionId).filter(
    (entry) => entry.type === "custom_message" && entry.details?.deliveryId === deliveryId,
  );
}

function nativeToolResults(env: Integration, sessionId: string, toolName: string) {
  return nativeEntries(env, sessionId)
    .filter(
      (entry) =>
        entry.type === "message" &&
        entry.message?.role === "toolResult" &&
        entry.message.toolName === toolName,
    )
    .map((entry) => entry.message);
}

// No skipRealPi fallback: these are release-gate tests, including on machines missing Pi.
describe("agent orchestration through installed Pi", { timeout: 180_000 }, () => {
  let env: Integration;
  afterEach(async () => {
    vi.restoreAllMocks();
    await env?.dispose();
  });

  it("creates a child with the real tool, reads its completion and exchanges inbox-only messages", async () => {
    let receiverId = "";
    env = await Integration.create({
      script: [
        {
          when: () => true,
          reply: (req) => {
            if (req.lastRole === "tool") {
              if (req.lastToolName === "switchyard_inbox") {
                const inbox = toolResult<AgentInbox>(req);
                const incoming = inbox.messages.find((message) => message.body === PRIVATE_BODY);
                if (incoming)
                  return call("switchyard_send", {
                    sessionId: incoming.senderSessionId,
                    body: REPLY_BODY,
                    mode: "queue",
                    replyTo: incoming.id,
                  });
                return { text: "Inbox read, including durable completion/reply data." };
              }
              return { text: DONE_TEXT };
            }
            if (
              req.lastText.includes("[Switchyard message ") ||
              req.lastText.includes("[Switchyard task completion ")
            )
              return call("switchyard_inbox", {});
            if (req.lastText.includes("ORCHESTRATION_PARENT"))
              return call("switchyard_create_task", {
                objective: CHILD_OBJECTIVE,
                acceptance: ["Return the delegated result"],
                notifyOnFinish: true,
              });
            if (req.lastText.includes("ORCHESTRATION_SEND"))
              return call("switchyard_send", {
                sessionId: receiverId,
                body: PRIVATE_BODY,
                mode: "queue",
              });
            return { text: DONE_TEXT };
          },
        },
      ],
    });
    const receiver = await env.createSession("admin", "", "Message recipient");
    receiverId = receiver.id;
    const parent = await env.createTask("admin", {
      title: "Orchestration parent",
      objective: "ORCHESTRATION_PARENT: delegate a child",
      state: "ready",
    });
    const child = await waitForValue(
      () => env.c.store.tasks.list().find((task) => task.objective === CHILD_OBJECTIVE),
      "real create-task tool persisted a child",
    );
    const parentRun = env.run(parent.id)!;
    const creatorId = parentRun.sessionId!;
    expect(child).toMatchObject({
      parentTaskId: parent.id,
      agentOrigin: { sessionId: creatorId },
      acceptanceCriteria: ["Return the delegated result"],
      origin: { kind: "manual" },
    });
    expect(child.agentOrigin?.toolCallId).toBeTruthy();
    // The default capacity gate releases only after the parent settles; no inline child launch.
    await env.waitTaskState(parent.id, "review");
    await env.waitTaskState(child.id, "review");
    const childRun = env.run(child.id)!;
    expect(childRun.sessionId).not.toBe(creatorId);
    expect(env.c.store.runs.list("task_id = ?", [child.id])).toHaveLength(1);
    expect(env.commandsOf("dispatch.start").filter((cmd) => cmd.taskId === child.id)).toHaveLength(
      1,
    );
    expect(env.session(creatorId).bridge).toMatchObject({
      agentTools: true,
      messageDelivery: true,
      policyState: "active",
      policyPhases: ["tool_call", "request"],
    });

    const inbox = async (id: string): Promise<AgentInbox> =>
      env.ok("GET", `/api/sessions/${id}/inbox`);
    const completion = await waitForValue(async () => {
      const message = (await inbox(creatorId)).messages.find((m) => m.kind === "completion");
      return message?.readAt && message.deliveryState === "appended" ? message : undefined;
    }, "completion appended in real Pi and read with switchyard_inbox");
    expect(completion).toMatchObject({
      senderSessionId: childRun.sessionId,
      recipientSessionId: creatorId,
      body: {
        version: 1,
        childTaskId: child.id,
        childSessionId: childRun.sessionId,
        outcome: "review",
        lastReply: DONE_TEXT,
        lastReplyTruncated: false,
        openPermissionRequestIds: [],
      },
    });
    expect(
      env.c.store.db
        .prepare("SELECT * FROM task_subscriptions WHERE child_task_id = ?")
        .all(child.id),
    ).toHaveLength(1);
    expect(
      env.c.store.db
        .prepare("SELECT * FROM task_completions WHERE child_task_id = ?")
        .all(child.id),
    ).toHaveLength(1);
    expect(nativeDeliveries(env, creatorId, completion.id)).toHaveLength(1);
    // Both the body and successful tool result must reach the real model, not just the API view.
    expect(
      env.mock!.requests.some(
        (req) =>
          req.lastToolName === "switchyard_inbox" &&
          toolResult<AgentInbox>(req).messages.some((message) => message.id === completion.id),
      ),
    ).toBe(true);

    await env.waitSession(creatorId, (session) => session.runtime === "idle", "creator idle");
    await env.ok("POST", `/api/sessions/${creatorId}/prompt`, {
      body: { text: "ORCHESTRATION_SEND", mode: "prompt" },
    });
    const received = await waitForValue(async () => {
      const message = (await inbox(receiverId)).messages.find((m) => m.body === PRIVATE_BODY);
      return message?.readAt && message.deliveryState === "appended" ? message : undefined;
    }, "recipient read the private ordinary body with its real inbox tool");
    const reply = await waitForValue(async () => {
      const message = (await inbox(creatorId)).messages.find((m) => m.body === REPLY_BODY);
      return message?.readAt && message.deliveryState === "appended" ? message : undefined;
    }, "creator read the real reply");
    expect(received).toMatchObject({ senderSessionId: creatorId, depth: 0, replyTo: null });
    expect(reply).toMatchObject({
      senderSessionId: receiverId,
      recipientSessionId: creatorId,
      replyTo: received.id,
      chainId: received.chainId,
      depth: 1,
    });
    const injected = nativeDeliveries(env, receiverId, received.id);
    expect(injected).toHaveLength(1);
    expect(JSON.stringify(injected[0].content)).toContain(`Call switchyard_inbox to read it.`);
    expect(JSON.stringify(injected[0])).not.toContain(PRIVATE_BODY);
    expect(nativeDeliveries(env, creatorId, reply.id)).toHaveLength(1);
    expect(
      env.c.store.db.prepare("SELECT * FROM agent_messages WHERE kind = 'message'").all(),
    ).toHaveLength(2);
    expect(
      env.c.store.db
        .prepare("SELECT * FROM agent_call_receipts WHERE method = 'message.send'")
        .all(),
    ).toHaveLength(2);
  });

  it.each([false, true])(
    "replays a real create-task call after coordinator restart (also restart host: %s)",
    async (restartHost) => {
      const objective = "RESTART_CHILD: exactly one durable task";
      const callId = "call_restart_create";
      env = await Integration.create({
        script: [
          {
            when: () => true,
            reply: (req) =>
              req.lastRole === "user" && req.lastText.includes("RESTART_CREATE")
                ? call("switchyard_create_task", { objective, notifyOnFinish: true }, callId)
                : { text: "Create acknowledged." },
          },
        ],
      });
      // Keep the created task in Ready so dispatcher effects do not obscure receipt deduplication.
      await env.ok("PATCH", `/api/projects/${env.project.id}`, {
        body: { automationEnabled: false },
      });
      const counterRules = [];
      for (const phase of ["tool_call", "request"] as const) {
        counterRules.push(
          await env.ok("POST", "/api/policies", {
            body: {
              scope: "server",
              scopeId: null,
              priority: -1000,
              enabled: true,
              phases: [phase],
              name: `Count original ${phase} authorization`,
              expression:
                '{"verdict":"ALLOW","reason":"","state_updates":{"calls":has(counters.calls) ? counters.calls + 1 : 1}}',
            },
          }),
        );
      }
      const counters = () =>
        env.c.store.db
          .prepare("SELECT * FROM policy_counters ORDER BY scope_kind, scope_id, rule_id")
          .all();
      const creator = await env.createSession("admin");
      let captured: { frame: AgentRequestFrame; result: AgentResultFrame } | undefined;
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const service = requireService(env.c.ctx, "agents");
      const handle = service.handle.bind(service);
      const interception = vi.spyOn(service, "handle").mockImplementation(async (...args) => {
        const result = await handle(...args);
        if (args[1].method === "task.create" && !captured) {
          captured = { frame: args[1], result };
          // Lose only the acknowledgement, AFTER the real mutation/receipt transaction committed.
          await held;
        }
        return result;
      });
      const prompt = env.api("POST", `/api/sessions/${creator.id}/prompt`, {
        body: { text: "RESTART_CREATE", mode: "prompt" },
      });
      try {
        await waitFor(
          () =>
            !!captured || nativeToolResults(env, creator.id, "switchyard_create_task").length > 0,
          "task persisted before its acknowledgement",
        );
        expect(
          captured,
          JSON.stringify(nativeToolResults(env, creator.id, "switchyard_create_task")),
        ).toBeDefined();
        expect(captured!.result.ok, JSON.stringify(captured!.result)).toBe(true);
        expect(
          env.mock!.requests.some((req) => req.lastToolName === "switchyard_create_task"),
        ).toBe(false);
        const task = env.c.store.tasks.list().find((t) => t.objective === objective)!;
        expect(task).toBeDefined();
        expect(task.state).toBe("ready");
        const nativeId = captured!.frame.nativeSessionId;
        const logicalCall = captured!.frame.toolCallId!;
        const originalBridge = env.session(creator.id).bridge!;
        expect(originalBridge).toMatchObject({
          runtimeId: captured!.frame.runtimeId,
          policyState: "active",
          policyPhases: ["tool_call", "request"],
        });
        expect(originalBridge.controllerEpoch).toBeTruthy();
        const originalReceipts = env.c.store.db
          .prepare("SELECT * FROM agent_call_receipts WHERE method = 'task.create'")
          .all();
        expect(originalReceipts).toHaveLength(1);
        const originalCounters = counters();
        expect(originalCounters).toHaveLength(2);
        for (const rule of counterRules) {
          expect(originalCounters).toContainEqual({
            scope_kind: "session",
            scope_id: creator.id,
            rule_id: rule.id,
            counters_json: JSON.stringify({ calls: 1 }),
            version: 1,
          });
        }
        interception.mockRestore();
        await env.stopCoordinator();
        if (restartHost) await env.agent!.stop();
        release();
        await prompt;
        await env.startCoordinator();
        const replayCalls = vi.spyOn(requireService(env.c.ctx, "agents"), "handle");
        let priorResults = 0;
        if (restartHost) {
          await env.startAgent();
          await env.waitSession(
            creator.id,
            (s) => ["stopped", "interrupted"].includes(s.runtime),
            "resumable creator",
          );
          await env.ok("POST", `/api/sessions/${creator.id}/resume`);
          await env.waitSession(
            creator.id,
            (s) => s.bridge?.policyState === "active",
            "rebound resumed Pi",
          );
          const resumedBridge = env.session(creator.id).bridge!;
          expect(resumedBridge.runtimeId).not.toBe(originalBridge.runtimeId);
          expect(resumedBridge.controllerEpoch).toBeTruthy();
          expect(resumedBridge.controllerEpoch).not.toBe(originalBridge.controllerEpoch);
          expect(env.session(creator.id).nativeHandle!.sessionFile).toBe(
            creator.nativeHandle!.sessionFile,
          );
          priorResults = nativeToolResults(env, creator.id, "switchyard_create_task").length;
          // Deliberately re-emit the same logical model call through real Pi, not AgentService.
          await env.ok("POST", `/api/sessions/${creator.id}/prompt`, {
            body: { text: "RESTART_CREATE", mode: "prompt" },
          });
        } else {
          await env.waitHostConnected();
        }
        const acknowledged = await waitForValue(() => {
          const results = nativeToolResults(env, creator.id, "switchyard_create_task");
          return results.length > priorResults ? results.at(-1) : undefined;
        }, "replayed tool result persisted by real Pi");
        expect(env.session(creator.id).nativeHandle!.sessionId).toBe(nativeId);
        expect(env.c.store.tasks.list().map((t) => t.id)).toEqual([task.id]);
        const receipts = env.c.store.db
          .prepare("SELECT * FROM agent_call_receipts WHERE method = 'task.create'")
          .all();
        expect(receipts).toEqual(originalReceipts);
        expect(receipts[0]).toMatchObject({
          caller_session_id: creator.id,
          native_session_id: nativeId,
          tool_call_id: logicalCall,
        });
        expect(env.c.store.db.prepare("SELECT * FROM task_subscriptions").all()).toMatchObject([
          { child_task_id: task.id, subscriber_session_id: creator.id },
        ]);
        expect(env.c.store.db.prepare("SELECT * FROM agent_call_receipts").all()).toHaveLength(1);
        expect(env.commandsOf("dispatch.start")).toHaveLength(0);
        // Do not accept a policy/transport error as evidence of successful receipt replay.
        expect(acknowledged, JSON.stringify(acknowledged)).toMatchObject({
          toolCallId: logicalCall,
          isError: false,
          details: { task: { id: task.id } },
        });
        if (!captured!.result.ok) throw new Error("Original task creation failed");
        expect(acknowledged.details).toEqual(captured!.result.result);
        expect(acknowledged.content).toEqual([
          { type: "text", text: JSON.stringify(captured!.result.result) },
        ]);
        if (restartHost) {
          const replay = replayCalls.mock.calls
            .map(([, frame]) => frame)
            .find((frame) => frame.method === "task.create");
          expect(replay).toMatchObject({
            sessionId: creator.id,
            nativeSessionId: nativeId,
            runtimeId: env.session(creator.id).bridge!.runtimeId,
            toolCallId: logicalCall,
            args: captured!.frame.args,
            receiptReplay: { requestHash: expect.stringMatching(/^[a-f0-9]{64}$/) },
          });
          expect(
            replayCalls.mock.calls.some(
              ([, frame]) => frame.method === "receipt.peek" && frame.toolCallId === logicalCall,
            ),
          ).toBe(true);
        }
        await env.waitSession(creator.id, (s) => s.runtime === "idle", "replay turn settled");
        expect(counters()).toEqual(originalCounters);
      } finally {
        release();
        await prompt;
      }
    },
  );

  it("a denied real bash has no filesystem effect; a fresh ASK retry runs only after device approval", async () => {
    let command = "";
    env = await Integration.create({
      script: [
        {
          when: () => true,
          reply: (req) =>
            req.lastRole === "user" && req.lastText.includes("POLICY_BASH")
              ? call("bash", { command })
              : { text: "Bash result observed." },
        },
      ],
    });
    const marker = join(env.repo!.path, "policy-effect.txt");
    command = "printf 'executed\\n' >> policy-effect.txt";
    const rule = await env.ok("POST", "/api/policies", {
      body: {
        scope: "server",
        scopeId: null,
        priority: -1000,
        enabled: true,
        phases: ["tool_call"],
        name: "Guard integration bash",
        expression:
          'tool.name == "bash" ? dyn({"verdict":"DENY","reason":"Integration denies bash"}) : null',
      },
    });
    const session = await env.createSession("admin", "POLICY_BASH denied");
    await waitFor(
      () => nativeToolResults(env, session.id, "bash").length === 1,
      "real Pi persisted a policy-denied bash result",
    );
    expect(nativeToolResults(env, session.id, "bash")[0]).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "Integration denies bash" }],
    });
    await env.waitSession(session.id, (s) => s.runtime === "idle", "denied turn settled");
    expect(existsSync(marker)).toBe(false);
    expect(
      env.c.store.db
        .prepare("SELECT * FROM policy_evaluations WHERE session_id = ? AND verdict = 'DENY'")
        .all(session.id),
    ).toHaveLength(1);
    expect(env.c.store.interactions.list("session_id = ?", [session.id])).toHaveLength(0);
    await env.ok("PATCH", `/api/policies/${rule.id}`, {
      body: {
        expectedRevision: rule.revision,
        expression:
          'tool.name == "bash" ? dyn({"verdict":"ASK","reason":"Approve integration bash"}) : null',
      },
    });
    const prompting = env.api("POST", `/api/sessions/${session.id}/prompt`, {
      body: { text: "POLICY_BASH approved retry", mode: "prompt" },
    });
    const approval = await env.pendingInteraction(session.id);
    expect(approval.permission).toMatchObject({ kind: "policy", ruleId: rule.id, ruleRevision: 2 });
    await env.waitSession(
      session.id,
      (s) => s.runtime === "waiting_input",
      "Pi waiting for policy approval",
    );
    expect(existsSync(marker)).toBe(false);
    expect(nativeToolResults(env, session.id, "bash")).toHaveLength(1);
    const device = env.devices!.terminal;
    await env.ok("POST", `/api/interactions/${approval.id}/answer`, {
      as: device,
      body: { revision: approval.revision, response: { kind: "confirm", confirmed: true } },
    });
    await prompting;
    await waitFor(() => existsSync(marker), "approved real bash wrote the marker");
    await env.waitSession(session.id, (s) => s.runtime === "idle", "approved turn settled");
    expect(readFileSync(marker, "utf8")).toBe("executed\n");
    expect(env.c.store.interactions.require(approval.id).state).toBe("resolved");
    expect(
      env.c.store.db.prepare("SELECT * FROM policy_grants WHERE rule_id = ?").all(rule.id),
    ).toMatchObject([{ approved_by_device_id: device.id, rule_revision: 2 }]);
    const results = nativeToolResults(env, session.id, "bash");
    expect(results).toHaveLength(2);
    expect(results[1].isError).toBe(false);
    expect(results[1].toolCallId).not.toBe(results[0].toolCallId);
  });

  it("keeps an old host browsable without inventing protection or sending it protected launches", async () => {
    env = await Integration.create({ withHost: false });
    const enrollment = await env.ok("POST", "/api/hosts/enrollments");
    const credentials = await env.ok("POST", "/api/hosts/enroll", {
      as: "anonymous",
      body: { token: enrollment.token, name: "Legacy host", platform: "darwin" },
    });
    const legacy = new FakeHost(
      env.url.replace("http", "ws"),
      credentials.hostId,
      credentials.credential,
    );
    try {
      const welcome = await legacy.open({
        features: undefined,
        capabilities: null,
        piVersion: "1.4.0",
      });
      expect(welcome).toMatchObject({ type: "welcome" });
      expect(welcome).not.toHaveProperty("features");
      expect(env.c.hostHub.negotiatedFeatures(credentials.hostId).size).toBe(0);
      await legacy.event("session.updated", hostSession("ses_legacy_orchestration"));
      const stored = await env.ok("GET", "/api/sessions/ses_legacy_orchestration");
      expect(stored.runtime).toBe("idle");
      expect(stored.bridge).toBeUndefined();
      expect(env.c.store.hosts.require(credentials.hostId).connectivity).toBe("connected");
      await expect(
        env.c.hostHub.request(credentials.hostId, {
          type: "session.start",
          sessionId: "ses_protected_legacy",
          title: "Protected legacy launch",
          workspacePath: "/tmp/repo",
          projectId: null,
          profile: env.c.store.profiles.list()[0]!,
          nativeHandle: null,
          initialPrompt: null,
          dispatchKey: null,
          controlRevision: 1,
          controlMode: "human",
          origin: "human",
          readOnly: false,
          policyRequired: true,
        }),
      ).rejects.toMatchObject({ code: "unsupported_capability" });
      expect(legacy.commands.some((cmd) => cmd.command.type === "session.start")).toBe(false);
      expect(env.session(stored.id).bridge).toBeUndefined();
    } finally {
      await legacy.close();
    }
  });
});
