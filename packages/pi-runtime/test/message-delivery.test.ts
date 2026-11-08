import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createAgentChannel } from "../src/bridge/agent-channel.js";
import { createMessageDelivery } from "../src/bridge/message-delivery.js";

function fixture() {
  const sent: any[] = [];
  const entries: any[] = [];
  let draft = "";
  let dialog = false;
  const ctx = {
    sessionManager: {
      getSessionId: () => "native",
      getSessionFile: () => null,
      getBranch: () => entries,
      getEntries: () => entries,
    },
    ui: { getEditorText: () => draft },
    isIdle: () => false,
  };
  const channel = createAgentChannel({
    send: (r) => {
      sent.push(r);
      return true;
    },
    getContext: () => ctx,
    appendEntry: () => {},
    mode: "terminal",
    getCapabilities: () => ({
      agentTools: true,
      messageDelivery: true,
      editorDraftGuard: true,
      toolPolicy: true,
    }),
    policyRequired: false,
  });
  channel.onConnect();
  let bindingId = "b1";
  let sequence = 0;
  const send = async (method: string, args: any) => {
    const requestId = String(++sequence);
    channel.receive({
      type: "bridge.command",
      requestId,
      runtimeId: channel.runtimeId,
      nativeSessionId: "native",
      bindingId,
      method,
      args,
    });
    await vi.waitFor(() => expect(sent.some((r) => r.requestId === requestId)).toBe(true));
    return sent.find((r) => r.requestId === requestId);
  };
  const configure = async (binding: string) => {
    bindingId = binding;
    await send("configure", {
      version: 1,
      sessionId: "session",
      runtimeId: channel.runtimeId,
      nativeSessionId: "native",
      bindingId,
      features: ["agentRequests.v1", "policies.v1"],
      coordinatorConnected: true,
      policyRequired: false,
      sessionUrl: null,
    });
  };
  const pi = { sendMessage: vi.fn() };
  const delivery = createMessageDelivery(pi, {
    channel,
    getContext: () => ctx,
    isDialogOpen: () => dialog,
    mode: "terminal",
    now: () => 0,
  });
  const offer = {
    deliveryId: "message",
    kind: "message",
    text: "header",
    mode: "steer",
    holdUntil: new Date(10000).toISOString(),
  };
  const offerHash = createHash("sha256")
    .update(
      JSON.stringify([1, offer.deliveryId, offer.kind, offer.text, offer.mode, offer.holdUntil]),
    )
    .digest("hex");
  const attempt = { id: randomUUID(), runtimeId: channel.runtimeId, nativeSessionId: "native" };
  return {
    channel,
    delivery,
    pi,
    offer,
    offerHash,
    attempt,
    send,
    configure,
    entries,
    setDraft: (v: string) => {
      draft = v;
    },
    setDialog: (v: boolean) => {
      dialog = v;
    },
  };
}

describe("message delivery", () => {
  it("holds drafts, retries once, and deduplicates after binding rotation", async () => {
    const f = fixture();
    await f.configure("b1");
    f.setDraft(" ");
    expect(
      (
        await f.send("delivery.accept", {
          offer: f.offer,
          offerHash: f.offerHash,
          attempt: f.attempt,
        })
      ).result,
    ).toMatchObject({ state: "held", reason: "draft", safeToRetry: true });
    f.setDraft("");
    await f.configure("b2");
    expect(
      (
        await f.send("delivery.accept", {
          offer: f.offer,
          offerHash: f.offerHash,
          attempt: f.attempt,
        })
      ).result,
    ).toMatchObject({ state: "queued", safeToRetry: false });
    expect(
      (
        await f.send("delivery.accept", {
          offer: f.offer,
          offerHash: f.offerHash,
          attempt: { ...f.attempt, id: randomUUID() },
        })
      ).result.state,
    ).toBe("queued");
    expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
    f.delivery.close();
    f.channel.close();
  });
  it("proves not_seen only for the same runtime and rejects changed offers", async () => {
    const f = fixture();
    await f.configure("b1");
    await f.configure("b2");
    const args = { deliveryId: f.offer.deliveryId, offerHash: f.offerHash, attempt: f.attempt };
    expect((await f.send("delivery.status", args)).result).toMatchObject({
      state: "not_seen",
      proof: "live_memory",
      safeToRetry: true,
    });
    expect(
      (await f.send("delivery.status", { ...args, attempt: { ...f.attempt, runtimeId: "old" } }))
        .result,
    ).toMatchObject({ state: "uncertain", proof: "none", safeToRetry: false });
    expect(
      (
        await f.send("delivery.accept", {
          offer: { ...f.offer, text: "changed" },
          offerHash: f.offerHash,
          attempt: f.attempt,
        })
      ).error.code,
    ).toBe("conflict");
    f.delivery.close();
    f.channel.close();
  });
  it("fences delayed accepts from an old binding", async () => {
    const f = fixture();
    await f.configure("b1");
    const accept = f.send("delivery.accept", {
      offer: f.offer,
      offerHash: f.offerHash,
      attempt: f.attempt,
    });
    await f.configure("b2");
    expect((await accept).error.code).toBe("conflict");
    expect(f.pi.sendMessage).not.toHaveBeenCalled();
    f.delivery.close();
    f.channel.close();
  });
  it("recognizes native entries outside the active branch", async () => {
    const f = fixture();
    await f.configure("b1");
    f.entries.push({
      type: "custom_message",
      id: "entry",
      message: {
        customType: "switchyard-inbox",
        details: {
          version: 1,
          deliveryId: f.offer.deliveryId,
          offerHash: f.offerHash,
          attemptId: "old",
        },
      },
    });
    expect(
      (
        await f.send("delivery.status", {
          deliveryId: f.offer.deliveryId,
          offerHash: f.offerHash,
          attempt: f.attempt,
        })
      ).result,
    ).toMatchObject({ state: "appended", proof: "native_entry", entryId: "entry" });
    f.delivery.close();
    f.channel.close();
  });
});
