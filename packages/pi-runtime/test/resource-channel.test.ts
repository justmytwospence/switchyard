import { describe, expect, it, vi } from "vitest";
import { createAgentChannel } from "../src/bridge/agent-channel.js";
import { BridgeCommand, ResourceSnapshotData } from "../src/bridge-wire.js";

const snapshot = {
  cwd: "/project",
  projectTrusted: null,
  reportedExtensionPaths: ["/plugin/index.ts"],
  hasEditorDraft: true,
  pendingDialogs: 2,
};
function fixture() {
  let nativeSessionId = "native";
  const sent: any[] = [];
  const channel = createAgentChannel({
    send: (record) => {
      sent.push(record);
      return true;
    },
    getContext: () => ({
      sessionManager: { getSessionId: () => nativeSessionId, getBranch: () => [] },
    }),
    appendEntry: vi.fn(),
    mode: "terminal",
    policyRequired: true,
    getCapabilities: () => ({
      agentTools: false,
      messageDelivery: false,
      editorDraftGuard: false,
      toolPolicy: false,
      resourceSnapshot: true,
    }),
  });
  channel.onConnect();
  const envelope = {
    type: "bridge.command",
    runtimeId: channel.runtimeId,
    nativeSessionId,
    bindingId: "binding",
  };
  const configure = (bindingId = "binding") =>
    channel.receive({
      ...envelope,
      bindingId,
      requestId: `configure-${bindingId}`,
      method: "configure",
      args: {
        version: 1,
        sessionId: "session",
        runtimeId: channel.runtimeId,
        nativeSessionId,
        bindingId,
        features: [],
        coordinatorConnected: false,
        policyRequired: true,
        sessionUrl: null,
      },
    });
  configure();
  return {
    channel,
    sent,
    envelope,
    configure,
    replaceNative: () => {
      nativeSessionId = "new-native";
    },
  };
}
const drain = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("read-only resource bridge command", () => {
  it("requires strict empty args and validates bounded snapshot shape", () => {
    const header = {
      type: "bridge.command",
      requestId: "request",
      runtimeId: "runtime",
      nativeSessionId: "native",
      bindingId: "binding",
      method: "resources.snapshot",
    };
    expect(BridgeCommand.safeParse({ ...header, args: {} }).success).toBe(true);
    for (const args of [null, [], { cwd: "/other" }])
      expect(BridgeCommand.safeParse({ ...header, args }).success).toBe(false);
    expect(ResourceSnapshotData.safeParse(snapshot).success).toBe(true);
    for (const patch of [
      { reportedExtensionPaths: Array(2049).fill("/p") },
      { reportedExtensionPaths: [`/${"p".repeat(4096)}`] },
      { pendingDialogs: -1 },
      { projectTrusted: "true" },
      { draft: "private" },
    ])
      expect(ResourceSnapshotData.safeParse({ ...snapshot, ...patch }).success).toBe(false);
  });
  it("works without delivery/editor/policy/coordinator features and never activates policy", async () => {
    const f = fixture();
    f.channel.registerCommand("resources.snapshot", () => snapshot);
    f.channel.receive({ ...f.envelope, requestId: "read", method: "resources.snapshot", args: {} });
    await drain();
    expect(f.sent.find((r) => r.requestId === "read")).toMatchObject({
      ok: true,
      result: snapshot,
    });
    expect(f.channel.snapshot().policyState).toBe("unsupported");
    const delivery = vi.fn();
    f.channel.registerCommand("delivery.accept", delivery);
    f.channel.receive({
      ...f.envelope,
      requestId: "delivery",
      method: "delivery.accept",
      args: {},
    });
    await drain();
    expect(f.sent.find((r) => r.requestId === "delivery")).toMatchObject({
      ok: false,
      error: { code: "unsupported_capability" },
    });
    expect(delivery).not.toHaveBeenCalled();
    f.channel.close();
  });
  it("enforces runtime, native and binding fences before invoking the read handler", async () => {
    const f = fixture();
    const handler = vi.fn(() => snapshot);
    f.channel.registerCommand("resources.snapshot", handler);
    for (const key of ["runtimeId", "nativeSessionId", "bindingId"]) {
      f.channel.receive({
        ...f.envelope,
        [key]: "substituted",
        requestId: key,
        method: "resources.snapshot",
        args: {},
      });
    }
    await drain();
    expect(handler).not.toHaveBeenCalled();
    f.channel.close();
  });
  it.each([null, [], { hidden: true }])("rejects nonempty/invalid args (%s)", async (args) => {
    const f = fixture();
    const handler = vi.fn();
    f.channel.registerCommand("resources.snapshot", handler);
    f.channel.receive({ ...f.envelope, requestId: "bad", method: "resources.snapshot", args });
    await drain();
    expect(handler).not.toHaveBeenCalled();
    expect(f.sent.find((r) => r.requestId === "bad")).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    f.channel.close();
  });
  it.each(["binding", "native"])(
    "rejects a %s change during an asynchronous read",
    async (change) => {
      const f = fixture();
      const result = Promise.withResolvers<unknown>();
      f.channel.registerCommand("resources.snapshot", () => result.promise);
      f.channel.receive({
        ...f.envelope,
        requestId: "read",
        method: "resources.snapshot",
        args: {},
      });
      if (change === "binding") f.configure("new-binding");
      else f.replaceNative();
      result.resolve(snapshot);
      await drain();
      expect(f.sent.find((r) => r.requestId === "read")).toMatchObject({
        ok: false,
        error: { code: "conflict" },
      });
      f.channel.close();
    },
  );
  it("enforces the frame cap and unregisters handlers", async () => {
    const f = fixture();
    const remove = f.channel.registerCommand("resources.snapshot", () => ({
      ...snapshot,
      reportedExtensionPaths: Array(64).fill(`/${"p".repeat(4095)}`),
    }));
    f.channel.receive({
      ...f.envelope,
      requestId: "large",
      method: "resources.snapshot",
      args: {},
    });
    await drain();
    expect(f.sent.find((r) => r.requestId === "large")).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    remove();
    f.channel.receive({
      ...f.envelope,
      requestId: "removed",
      method: "resources.snapshot",
      args: {},
    });
    await drain();
    expect(f.sent.find((r) => r.requestId === "removed")).toMatchObject({
      ok: false,
      error: { code: "unsupported_capability" },
    });
    f.channel.close();
  });
});
