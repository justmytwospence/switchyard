import { describe, expect, it, vi } from "vitest";
import { createAgentChannel } from "../src/bridge/agent-channel.js";
import { registerAgentTools } from "../src/bridge/agent-tools.js";

function fixture() {
  const sent: any[] = [];
  const entries: any[] = [];
  const channel = createAgentChannel({
    send: (r) => {
      sent.push(r);
      return true;
    },
    getContext: () => ({
      sessionManager: {
        getSessionId: () => "native",
        getSessionFile: () => null,
        getBranch: () => entries,
      },
    }),
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
    mode: "rpc",
    getCapabilities: () => ({
      agentTools: true,
      messageDelivery: true,
      editorDraftGuard: true,
      toolPolicy: true,
    }),
    policyRequired: false,
  });
  channel.onConnect();
  const configure = (
    features = ["agentRequests.v1", "policies.v1"],
    bindingId = "binding",
    policyRequired = false,
  ) =>
    channel.receive({
      type: "bridge.command",
      method: "configure",
      requestId: "configure",
      runtimeId: channel.runtimeId,
      nativeSessionId: "native",
      bindingId,
      args: {
        version: 1,
        sessionId: "session",
        runtimeId: channel.runtimeId,
        nativeSessionId: "native",
        bindingId,
        features,
        coordinatorConnected: true,
        policyRequired,
        sessionUrl: null,
      },
    });
  return { channel, sent, entries, configure };
}

describe("agent tools and channel", () => {
  it("registers synchronously and correlates fenced results with causal context", async () => {
    const { channel, sent, entries, configure } = fixture();
    const tools: any[] = [];
    registerAgentTools({ registerTool: (t: any) => tools.push(t) }, channel);
    expect(tools.map((t) => t.name)).toEqual([
      "switchyard_create_task",
      "switchyard_send",
      "switchyard_inbox",
    ]);
    configure();
    channel.noteHumanInput("human");
    entries.push({
      type: "custom_message",
      message: { customType: "switchyard-inbox", details: { deliveryId: "msg" } },
    });
    const result = tools[0].execute("call", { objective: "work" });
    await vi.waitFor(() => expect(sent.some((r) => r.type === "agent.request")).toBe(true));
    const request = sent.find((r) => r.type === "agent.request");
    expect(request).toMatchObject({
      method: "task.create",
      toolCallId: "call",
      bindingId: "binding",
      context: { humanInputId: "human", causalMessageId: "msg" },
    });
    channel.receive({
      type: "agent.result",
      requestId: request.requestId,
      runtimeId: "old",
      bindingId: "binding",
      ok: true,
      result: "wrong",
    });
    channel.receive({
      type: "agent.result",
      requestId: request.requestId,
      runtimeId: channel.runtimeId,
      bindingId: "binding",
      ok: true,
      result: { taskId: "task" },
    });
    await expect(result).resolves.toMatchObject({ details: { taskId: "task" } });
    channel.close();
  });
  it("disables old coordinators and latches required policy", async () => {
    const { channel, sent, configure } = fixture();
    configure([], "binding", true);
    expect(sent.at(-1).result).toMatchObject({
      configured: true,
      agentTools: false,
      messageDelivery: false,
      policyState: "unsupported",
      policyRequired: true,
    });
    configure([], "binding2", false);
    expect(channel.snapshot().policyRequired).toBe(true);
    await expect(channel.waitReady({ require: "agentRequests" })).rejects.toMatchObject({
      code: "unsupported_capability",
    });
    channel.close();
  });
  it("uses one deadline across repeated disconnects", async () => {
    vi.useFakeTimers();
    try {
      const { channel, configure } = fixture();
      configure();
      const pending = channel.request("inbox.read", {}, { timeoutMs: 100 });
      const rejected = expect(pending).rejects.toMatchObject({ code: "timeout" });
      await vi.advanceTimersByTimeAsync(40);
      channel.onDisconnect();
      channel.onConnect();
      configure();
      await vi.advanceTimersByTimeAsync(60);
      await rejected;
      channel.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
