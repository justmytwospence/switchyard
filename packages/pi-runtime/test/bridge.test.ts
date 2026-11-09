import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import bridge from "../src/bridge/switchyard-bridge.js";
import {
  BridgeAgentResult,
  BridgeCommand,
  type BridgeConfiguration,
  BridgeHello,
  BridgeRequests,
  DeliveryAcceptArgs,
  DeliveryEvidence,
  DeliveryOffer,
  deliveryOfferHash,
  parseBridgeRecord,
  validateAgentResult,
} from "../src/bridge-wire.js";
import { JsonlReader } from "../src/jsonl.js";

function fakePi() {
  const handlers = new Map<string, ((e: any, c?: any) => void)[]>();
  return {
    handlers,
    registerTool() {},
    appendEntry() {},
    on(event: string, h: (e: any, c?: any) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), h]);
      return () => {};
    },
    fire(event: string, payload: any, ctx?: any) {
      for (const h of handlers.get(event) ?? []) h(payload, ctx);
    },
  };
}

const saved = process.env.SWITCHYARD_BRIDGE_SOCKET;
afterEach(() => {
  if (saved === undefined) delete process.env.SWITCHYARD_BRIDGE_SOCKET;
  else process.env.SWITCHYARD_BRIDGE_SOCKET = saved;
});

describe("bridge extension", () => {
  it("is a no-op without SWITCHYARD_BRIDGE_SOCKET", () => {
    delete process.env.SWITCHYARD_BRIDGE_SOCKET;
    const pi = fakePi();
    bridge(pi);
    expect(pi.handlers.size).toBe(0);
  });

  it("forwards ui_prompt_start/end as JSON lines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sy-br-"));
    const path = join(dir, "b.sock");
    const lines: any[] = [];
    const server = createServer((s) => JsonlReader.attach(s, (r) => lines.push(r)));
    await new Promise<void>((r) => server.listen(path, r));
    try {
      process.env.SWITCHYARD_BRIDGE_SOCKET = path;
      const pi = fakePi();
      bridge(pi);
      pi.fire("session_start", { type: "session_start" });
      pi.fire("ui_prompt_start", {
        type: "ui_prompt_start",
        reason: "ui_prompt",
        kind: "select",
        title: "Pick",
      });
      pi.fire("ui_prompt_end", {
        type: "ui_prompt_end",
        reason: "ui_prompt",
        kind: "select",
        title: "Pick",
      });
      pi.fire("ui_prompt_start", { type: "ui_prompt_start", reason: "ui_prompt", kind: "custom" });
      for (let i = 0; i < 50 && lines.length < 5; i++) await new Promise((r) => setTimeout(r, 10));
      expect(lines.map((l) => [l.type, l.kind ?? null, l.title])).toEqual([
        ["hello", null, null],
        ["model_state", null, null],
        ["ui_prompt_start", "select", "Pick"],
        ["ui_prompt_end", "select", "Pick"],
        ["ui_prompt_start", "custom", null],
      ]);
      expect(lines.map((l) => l.seq)).toEqual([1, 2, 3, 4, 5]);
      pi.fire("session_shutdown", {});
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("announces installed RPC policy capability and activates required protection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sy-agent-"));
    const path = join(dir, "b.sock");
    const lines: any[] = [];
    let peer: import("node:net").Socket;
    const server = createServer((s) => {
      peer = s;
      JsonlReader.attach(s, (r) => lines.push(r));
    });
    await new Promise<void>((r) => server.listen(path, r));
    const previous = process.env.SWITCHYARD_POLICY_REQUIRED;
    try {
      process.env.SWITCHYARD_BRIDGE_SOCKET = path;
      process.env.SWITCHYARD_POLICY_REQUIRED = "1";
      const pi = fakePi();
      bridge(pi);
      pi.fire(
        "session_start",
        {},
        {
          sessionManager: {
            getSessionId: () => "native",
            getSessionFile: () => null,
            getBranch: () => [],
          },
        },
      );
      for (let i = 0; i < 100 && !lines.some((l) => l.type === "agent.hello"); i++)
        await new Promise((r) => setTimeout(r, 10));
      const hello = lines.find((l) => l.type === "agent.hello");
      expect(parseBridgeRecord(hello)).toEqual(hello);
      expect(hello).toMatchObject({
        mode: "rpc",
        nativeSessionId: "native",
        capabilities: {
          agentTools: true,
          messageDelivery: true,
          editorDraftGuard: true,
          toolPolicy: true,
        },
      });
      const config = {
        version: 1,
        sessionId: "session",
        runtimeId: hello.runtimeId,
        nativeSessionId: "native",
        bindingId: "binding",
        features: ["agentRequests.v1", "policies.v1"],
        coordinatorConnected: true,
        policyRequired: false,
        sessionUrl: null,
      };
      peer!.write(
        `${JSON.stringify({ type: "bridge.command", requestId: "configure", runtimeId: hello.runtimeId, nativeSessionId: "native", bindingId: "binding", method: "configure", args: config })}\n`,
      );
      for (let i = 0; i < 100 && !lines.some((l) => l.type === "bridge.receipt"); i++)
        await new Promise((r) => setTimeout(r, 10));
      const actualReceipt = lines.find((l) => l.type === "bridge.receipt");
      expect(parseBridgeRecord(actualReceipt)).toEqual(actualReceipt);
      expect(actualReceipt).toMatchObject({
        ok: true,
        result: {
          policyRequired: true,
          policyState: "active",
          policyPhases: ["tool_call", "request"],
        },
      });
      pi.fire("session_shutdown", {});
    } finally {
      if (previous === undefined) delete process.env.SWITCHYARD_POLICY_REQUIRED;
      else process.env.SWITCHYARD_POLICY_REQUIRED = previous;
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never throws when the socket is unreachable", async () => {
    process.env.SWITCHYARD_BRIDGE_SOCKET = join(tmpdir(), "sy-missing-dir", "nope.sock");
    const pi = fakePi();
    expect(() => bridge(pi)).not.toThrow();
    expect(() => pi.fire("session_start", {})).not.toThrow();
    await new Promise((r) => setTimeout(r, 30));
    expect(() => pi.fire("ui_prompt_start", { kind: "select", title: "x" })).not.toThrow();
  });
});

describe("host-side bridge wire validation", () => {
  const request = {
    type: "agent.request",
    requestId: "request",
    bindingId: "binding",
    sessionId: "ses_a",
    nativeSessionId: "native",
    runtimeId: "runtime",
    context: { humanInputId: null, causalMessageId: null },
    method: "inbox.read",
    args: {},
  };

  it("validates agent records with the shared protocol schemas", () => {
    expect(parseBridgeRecord(request)).toEqual(request);
    expect(() => parseBridgeRecord({ ...request, method: "unknown" })).toThrow();
    expect(() => parseBridgeRecord({ ...request, runtimeId: "" })).toThrow();
    expect(() => parseBridgeRecord({ ...request, args: "x".repeat(128 * 1024) })).toThrow();
    expect(() =>
      validateAgentResult({
        type: "agent.result",
        requestId: "request",
        runtimeId: "runtime",
        bindingId: "binding",
        ok: true,
        result: "x".repeat(128 * 1024),
      }),
    ).toThrow();
    expect(parseBridgeRecord({ type: "response", id: "sy-1", data: {} })).toBeNull();
  });

  const hello = {
    type: "agent.hello" as const,
    version: 1 as const,
    runtimeId: "runtime",
    nativeSessionId: "native",
    sessionFile: null,
    pid: 123,
    mode: "rpc" as const,
    capabilities: {
      agentTools: true,
      messageDelivery: true,
      editorDraftGuard: true,
      toolPolicy: true,
    },
    context: request.context,
  };
  const config: BridgeConfiguration = {
    version: 1,
    sessionId: "ses_a",
    runtimeId: "runtime",
    nativeSessionId: "native",
    bindingId: "binding",
    features: ["agentRequests.v1", "policies.v1"],
    coordinatorConnected: true,
    policyRequired: true,
    sessionUrl: null,
  };
  const header = {
    type: "bridge.command" as const,
    requestId: "r",
    runtimeId: "runtime",
    nativeSessionId: "native",
    bindingId: "binding",
  };
  const offer = {
    deliveryId: "delivery",
    kind: "message" as const,
    text: "header",
    mode: "steer" as const,
    holdUntil: "2026-11-01T00:00:00.000Z",
  };
  const attempt = {
    id: "a2d81a40-55cb-4665-a094-39ff3fdc1835",
    runtimeId: "runtime",
    nativeSessionId: "native",
  };
  const accept = { offer, offerHash: deliveryOfferHash(offer), attempt };

  it("requires actual versioned hellos and identity-fenced receipts", () => {
    expect(parseBridgeRecord(JSON.parse(JSON.stringify(hello)))).toEqual(hello);
    expect(BridgeHello.safeParse({ ...hello, version: 2 }).success).toBe(false);
    expect(() => parseBridgeRecord({ ...hello, nativeSessionId: "" })).toThrow();
    const receipt = {
      ...header,
      type: "bridge.receipt",
      ok: false,
      error: { code: "conflict", message: "denied" },
    };
    expect(parseBridgeRecord(receipt)).toEqual(receipt);
    expect(() => parseBridgeRecord({ ...receipt, bindingId: undefined })).toThrow();
    expect(() =>
      parseBridgeRecord({ ...receipt, error: { code: "made_up", message: "no" } }),
    ).toThrow();
    expect(() => parseBridgeRecord({ ...request, bindingId: undefined })).toThrow();
    const result = {
      type: "agent.result" as const,
      requestId: "r",
      runtimeId: "runtime",
      bindingId: "binding",
      ok: true as const,
      result: {},
    };
    expect(validateAgentResult(JSON.parse(JSON.stringify(result)))).toEqual(result);
    expect(BridgeAgentResult.safeParse({ ...result, bindingId: undefined }).success).toBe(false);
    expect(parseBridgeRecord({ type: "bridge.features" })).toBeNull();
  });

  it("round trips every local command and delivery evidence without changing envelopes", () => {
    const commands = [
      { ...header, method: "configure", args: config },
      { ...header, method: "connection.update", args: { connected: false } },
      { ...header, method: "input.human", args: { humanInputId: "human" } },
      { ...header, method: "delivery.accept", args: accept },
      {
        ...header,
        method: "delivery.status",
        args: { deliveryId: offer.deliveryId, offerHash: accept.offerHash, attempt },
      },
    ];
    for (const command of commands)
      expect(BridgeCommand.parse(JSON.parse(JSON.stringify(command)))).toEqual(command);
    expect(BridgeCommand.safeParse({ ...commands[0], bindingId: "old" }).success).toBe(false);
    expect(BridgeCommand.safeParse({ ...header, method: "unknown", args: {} }).success).toBe(false);
    for (const state of ["not_seen", "held", "queued", "appended", "uncertain"] as const) {
      const evidence = {
        deliveryId: offer.deliveryId,
        attempt,
        state,
        proof: "live_memory",
        safeToRetry: state === "not_seen" || state === "held",
        reason: null,
        effectiveMode: null,
        entryId: null,
      };
      expect(DeliveryEvidence.parse(JSON.parse(JSON.stringify(evidence)))).toEqual(evidence);
    }
  });

  it("validates canonical delivery offers, hashes and UTF-8/serialized size limits", () => {
    expect(accept.offerHash).toBe(
      "8d863436930434b9cd68dda440a2ca14525420c0f74b22debb2d40060bb48214",
    );
    expect(DeliveryAcceptArgs.safeParse({ ...accept, offerHash: "0".repeat(64) }).success).toBe(
      false,
    );
    expect(
      DeliveryAcceptArgs.safeParse({ ...accept, attempt: { ...attempt, id: "not-a-uuid" } })
        .success,
    ).toBe(false);
    expect(DeliveryOffer.safeParse({ ...offer, holdUntil: "2026-11-01T00:00:00Z" }).success).toBe(
      false,
    );
    expect(DeliveryOffer.safeParse({ ...offer, text: "é".repeat(32768) }).success).toBe(true);
    expect(DeliveryOffer.safeParse({ ...offer, text: "é".repeat(32769) }).success).toBe(false);
    expect(DeliveryOffer.safeParse({ ...offer, text: "\u0000".repeat(20000) }).success).toBe(false);
  });

  it("fences receipts and agent frames across configuration and same-runtime binding rotation", async () => {
    const requests = new BridgeRequests();
    const sent: any[] = [];
    const send = async (frame: unknown) => {
      sent.push(frame);
    };
    requests.setHello(hello);
    expect(requests.accepts(request)).toBe(false);
    const configuring = requests.request("configure", config, send);
    const command = sent.at(-1);
    const reply = {
      ...header,
      type: "bridge.receipt" as const,
      requestId: command.requestId,
      ok: true as const,
      result: { configured: true },
    };
    requests.receive({ ...reply, nativeSessionId: "stale" });
    expect(requests.accepts(request)).toBe(false);
    requests.receive(reply);
    await configuring;
    expect(requests.accepts(request)).toBe(true);
    const pending = requests.request("input.human", { humanInputId: "human" }, send);
    const rejected = expect(pending).rejects.toMatchObject({ code: "host_unreachable" });
    const rotated = requests.request("configure", { ...config, bindingId: "binding-new" }, send);
    await rejected;
    expect(requests.accepts(request)).toBe(false);
    requests.receive({ ...reply, requestId: sent.at(-1).requestId, bindingId: "binding-new" });
    await rotated;
    expect(requests.accepts(request)).toBe(false);
    expect(requests.accepts({ ...request, bindingId: "binding-new" })).toBe(true);
    requests.setHello({ ...hello, nativeSessionId: "native-new" });
    expect(requests.accepts({ ...request, bindingId: "binding-new" })).toBe(false);
    await expect(requests.request("configure", config, send)).rejects.toMatchObject({
      code: "conflict",
    });
    requests.cancel("done");
  });

  it("bounds pending commands and cleans up abort/disconnect waits without sending aborted commands", async () => {
    const requests = new BridgeRequests();
    requests.setHello(hello);
    const sent: any[] = [];
    const send = async (frame: unknown) => {
      sent.push(frame);
    };
    const ac = new AbortController();
    ac.abort();
    await expect(
      requests.request("configure", config, send, { signal: ac.signal }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(sent).toEqual([]);
    const configuring = requests.request("configure", config, send);
    requests.receive({ ...sent[0], type: "bridge.receipt", ok: true, result: {} });
    await configuring;
    const waits = Array.from({ length: 256 }, () => {
      const pending = requests.request("input.human", { humanInputId: "human" }, send);
      return expect(pending).rejects.toMatchObject({ code: "host_unreachable" });
    });
    await expect(
      requests.request("input.human", { humanInputId: "human" }, send),
    ).rejects.toMatchObject({ code: "rate_limited" });
    requests.cancel("Disconnected");
    await Promise.all(waits);
    requests.setHello(hello);
    const fresh = requests.request("configure", config, send);
    requests.receive({ ...sent.at(-1), type: "bridge.receipt", ok: true, result: {} });
    await fresh;
    requests.cancel("done");
  });

  it("defaults local deadlines to five seconds, allows thirty seconds and never resets on stale receipts", async () => {
    vi.useFakeTimers();
    const requests = new BridgeRequests();
    try {
      requests.setHello(hello);
      let command: any;
      const pending = requests.request("configure", config, async (frame) => {
        command = frame;
      });
      const timeout = expect(pending).rejects.toMatchObject({ code: "timeout" });
      await vi.advanceTimersByTimeAsync(4999);
      requests.receive({
        ...command,
        type: "bridge.receipt",
        bindingId: "stale",
        ok: true,
        result: {},
      });
      await vi.advanceTimersByTimeAsync(1);
      await timeout;
      const longer = requests.request("configure", config, async () => {}, { timeoutMs: 30000 });
      const longerTimeout = expect(longer).rejects.toMatchObject({ code: "timeout" });
      await vi.advanceTimersByTimeAsync(30000);
      await longerTimeout;
      for (const timeoutMs of [0, -1, Infinity, NaN, 30001])
        await expect(
          requests.request("configure", config, async () => {}, { timeoutMs }),
        ).rejects.toMatchObject({ code: "invalid_request" });
    } finally {
      requests.cancel("done");
      vi.useRealTimers();
    }
  });
});
