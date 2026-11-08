import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentChannel } from "../src/bridge/agent-channel.js";
import { createMessageDelivery } from "../src/bridge/message-delivery.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

function fixture() {
  const sent: any[] = [];
  const entries: any[] = [];
  const ctx = {
    sessionManager: {
      getSessionId: () => "native",
      getEntries: () => entries,
      getBranch: () => entries,
    },
    ui: { getEditorText: vi.fn(() => "") },
    isIdle: vi.fn(() => true),
  };
  const channel = createAgentChannel({
    send: (record) => {
      sent.push(record);
      return true;
    },
    getContext: () => ctx,
    appendEntry: () => {},
    mode: "terminal",
    getCapabilities: () => ({
      agentTools: true,
      messageDelivery: true,
      editorDraftGuard: true,
      toolPolicy: false,
    }),
    policyRequired: false,
  });
  channel.onConnect();
  let sequence = 0;
  const command = (method: string, args: unknown) => {
    const requestId = String(++sequence);
    channel.receive({
      type: "bridge.command",
      requestId,
      runtimeId: channel.runtimeId,
      nativeSessionId: "native",
      bindingId: "binding",
      method,
      args,
    });
    return requestId;
  };
  const receipt = async (requestId: string) => {
    await vi.waitFor(() => expect(sent.some((r) => r.requestId === requestId)).toBe(true));
    return sent.find((r) => r.requestId === requestId);
  };
  const configure = (coordinatorConnected = true) =>
    command("configure", {
      version: 1,
      sessionId: "session",
      runtimeId: channel.runtimeId,
      nativeSessionId: "native",
      bindingId: "binding",
      features: ["agentRequests.v1"],
      coordinatorConnected,
      policyRequired: false,
      sessionUrl: null,
    });
  const connection = (connected: boolean) => command("connection.update", { connected });
  const pi = { sendMessage: vi.fn() };
  const delivery = createMessageDelivery(pi, {
    channel,
    getContext: () => ctx,
    isDialogOpen: () => false,
    mode: "terminal",
    now: () => 0,
  });
  cleanup.push(() => {
    delivery.close();
    channel.close();
  });
  const offer = {
    deliveryId: "message",
    kind: "message",
    text: "notification",
    mode: "steer",
    holdUntil: new Date(10000).toISOString(),
  };
  const offerHash = createHash("sha256")
    .update(
      JSON.stringify([1, offer.deliveryId, offer.kind, offer.text, offer.mode, offer.holdUntil]),
    )
    .digest("hex");
  const attempt = { id: randomUUID(), runtimeId: channel.runtimeId, nativeSessionId: "native" };
  const accept = () => command("delivery.accept", { offer, offerHash, attempt });
  const status = () =>
    command("delivery.status", { deliveryId: offer.deliveryId, offerHash, attempt });
  return {
    ctx,
    pi,
    entries,
    configure,
    connection,
    accept,
    status,
    receipt,
    offer,
    offerHash,
    attempt,
  };
}

describe("delivery coordinator readiness fence", () => {
  it("rejects a first-safe accept configured offline but answers local status", async () => {
    const f = fixture();
    f.configure(false);
    expect(await f.receipt(f.accept())).toMatchObject({
      ok: false,
      error: { code: "host_unreachable" },
    });
    expect(f.pi.sendMessage).not.toHaveBeenCalled();
    expect(await f.receipt(f.status())).toMatchObject({
      ok: true,
      result: { state: "not_seen", proof: "live_memory", safeToRetry: true },
    });
    f.connection(true);
    expect(await f.receipt(f.accept())).toMatchObject({ ok: true, result: { state: "queued" } });
    expect(f.pi.sendMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ customType: "switchyard-inbox" }),
      { triggerTurn: true },
    );
  });

  it("rechecks readiness after an accept is scheduled and connection.update turns false", async () => {
    const f = fixture();
    f.configure();
    const acceptId = f.accept();
    f.connection(false);
    expect(await f.receipt(acceptId)).toMatchObject({
      ok: false,
      error: { code: "host_unreachable" },
    });
    expect(f.pi.sendMessage).not.toHaveBeenCalled();
    expect(await f.receipt(f.status())).toMatchObject({
      ok: true,
      result: { state: "not_seen", safeToRetry: true },
    });
  });

  it.each(["draft", "idle"])(
    "fences a disconnect during the final %s guard read",
    async (guard) => {
      const f = fixture();
      f.configure();
      if (guard === "draft") {
        f.ctx.ui.getEditorText.mockImplementationOnce(() => {
          f.connection(false);
          return "";
        });
      } else {
        f.ctx.isIdle.mockImplementationOnce(() => {
          f.connection(false);
          return true;
        });
      }
      expect(await f.receipt(f.accept())).toMatchObject({
        ok: false,
        error: { code: "host_unreachable" },
      });
      expect(f.pi.sendMessage).not.toHaveBeenCalled();
      expect(await f.receipt(f.status())).toMatchObject({
        ok: true,
        result: { state: "not_seen", safeToRetry: true },
      });
    },
  );

  it("does not yield between final guard checks and the send invocation", async () => {
    const f = fixture();
    f.configure();
    let disconnected = false;
    let disconnectedAtSend: boolean | undefined;
    f.ctx.ui.getEditorText.mockImplementationOnce(() => {
      queueMicrotask(() => {
        disconnected = true;
        f.connection(false);
      });
      return "";
    });
    f.pi.sendMessage.mockImplementation(() => {
      disconnectedAtSend = disconnected;
    });
    expect(await f.receipt(f.accept())).toMatchObject({ ok: true, result: { state: "queued" } });
    expect(disconnectedAtSend).toBe(false);
    expect(disconnected).toBe(true);
    expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("keeps held evidence available offline without allowing a retry effect", async () => {
    const f = fixture();
    f.configure();
    f.ctx.ui.getEditorText.mockReturnValue("draft");
    expect(await f.receipt(f.accept())).toMatchObject({
      ok: true,
      result: { state: "held", reason: "draft" },
    });
    f.ctx.ui.getEditorText.mockReturnValue("");
    f.connection(false);
    expect(await f.receipt(f.accept())).toMatchObject({
      ok: false,
      error: { code: "host_unreachable" },
    });
    expect(await f.receipt(f.status())).toMatchObject({
      ok: true,
      result: { state: "held", reason: "draft", safeToRetry: true },
    });
    expect(f.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("keeps queued and native evidence available offline without redelivery", async () => {
    const f = fixture();
    f.configure();
    expect(await f.receipt(f.accept())).toMatchObject({ ok: true, result: { state: "queued" } });
    f.connection(false);
    expect(await f.receipt(f.status())).toMatchObject({
      ok: true,
      result: { state: "queued", safeToRetry: false },
    });
    expect(await f.receipt(f.accept())).toMatchObject({ ok: true, result: { state: "queued" } });
    expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
    f.entries.push({
      type: "custom_message",
      id: "entry",
      customType: "switchyard-inbox",
      details: {
        version: 1,
        deliveryId: f.offer.deliveryId,
        offerHash: f.offerHash,
        attemptId: f.attempt.id,
      },
    });
    expect(await f.receipt(f.status())).toMatchObject({
      ok: true,
      result: { state: "appended", proof: "native_entry", entryId: "entry" },
    });
    expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
  });
});
