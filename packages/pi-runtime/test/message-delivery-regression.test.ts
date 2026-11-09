import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import rpcBridge from "../src/bridge/switchyard-bridge.js";
import terminalBridge from "../src/bridge/switchyard-terminal.js";
import {
  BridgeCommand,
  BridgeHello,
  BridgeReceipt,
  type DeliveryAttempt,
  DeliveryEvidence,
  type DeliveryOffer,
  deliveryOfferHash,
} from "../src/bridge-wire.js";
import { JsonlReader } from "../src/jsonl.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  try {
    for (const close of cleanup.splice(0).reverse()) await close();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

const dialogKinds = ["select", "confirm", "input", "editor", "custom"] as const;
const tenMinutes = 10 * 60 * 1000;

// Load the real extensions over their actual socket lanes. In particular, dialog tests
// exercise the extension's guard wiring instead of substituting an isDialogOpen boolean.
async function fixture(mode: "rpc" | "terminal") {
  const dir = mkdtempSync(join(tmpdir(), "sy-delivery-"));
  const path = join(dir, "b.sock");
  const records: any[] = [];
  let peer: Socket | undefined;
  const server = createServer((socket) => {
    peer = socket;
    JsonlReader.attach(socket, (record) => records.push(record));
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  const handlers = new Map<string, ((event: any, ctx: any) => void)[]>();
  const listeners = new Map<string, ((data: any) => void)[]>();
  const pi = {
    on: (name: string, fn: (event: any, ctx: any) => void) => {
      handlers.set(name, [...(handlers.get(name) ?? []), fn]);
    },
    events: {
      on: (name: string, fn: (data: any) => void) => {
        listeners.set(name, [...(listeners.get(name) ?? []), fn]);
      },
      emit: (name: string, data: any) => {
        for (const fn of listeners.get(name) ?? []) fn(data);
      },
    },
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
  };
  const entries: any[] = [];
  const dialogResolvers: ((value: unknown) => void)[] = [];
  const dialog = vi.fn(
    (..._args: any[]) => new Promise<unknown>((resolve) => dialogResolvers.push(resolve)),
  );
  const ui = {
    select: dialog,
    confirm: dialog,
    input: dialog,
    editor: dialog,
    custom: dialog,
    getEditorText: vi.fn(() => ""),
    setEditorText: vi.fn(),
  };
  const ctx = {
    ui,
    isIdle: vi.fn(() => true),
    abort: vi.fn(),
    sessionManager: {
      getSessionId: () => "native",
      getSessionFile: () => null,
      getEntries: () => entries,
      getBranch: () => entries,
    },
  };
  const emit = (name: string, event: object = {}) => {
    for (const handler of handlers.get(name) ?? []) handler({ type: name, ...event }, ctx);
  };
  cleanup.push(async () => {
    for (const resolve of dialogResolvers) resolve(undefined);
    emit("session_shutdown");
    peer?.destroy();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    rmSync(dir, { recursive: true, force: true });
  });
  vi.stubEnv("SWITCHYARD_POLICY_REQUIRED", "0");
  vi.stubEnv(mode === "rpc" ? "SWITCHYARD_BRIDGE_SOCKET" : "SWITCHYARD_CONTROL_SOCKET", path);
  (mode === "rpc" ? rpcBridge : terminalBridge)(pi);
  emit("session_start");
  await vi.waitFor(() =>
    expect(records.some((record) => record.type === "agent.hello")).toBe(true),
  );
  const hello = BridgeHello.parse(records.find((record) => record.type === "agent.hello"));
  let sequence = 0;
  const command = async (method: string, args: unknown, bindingId = "binding") => {
    const requestId = String(++sequence);
    const frame = BridgeCommand.parse({
      type: "bridge.command",
      requestId,
      runtimeId: hello.runtimeId,
      nativeSessionId: hello.nativeSessionId,
      bindingId,
      method,
      args,
    });
    peer!.write(`${JSON.stringify(frame)}\n`);
    await vi.waitFor(() =>
      expect(
        records.some(
          (record) => record.type === "bridge.receipt" && record.requestId === requestId,
        ),
      ).toBe(true),
    );
    return BridgeReceipt.parse(
      records.find((record) => record.type === "bridge.receipt" && record.requestId === requestId),
    );
  };
  expect(
    await command("configure", {
      version: 1,
      sessionId: "session",
      runtimeId: hello.runtimeId,
      nativeSessionId: hello.nativeSessionId,
      bindingId: "binding",
      features: ["agentRequests.v1", "policies.v1"],
      coordinatorConnected: true,
      policyRequired: false,
      sessionUrl: null,
    }),
  ).toMatchObject({ ok: true });
  const createdAt = Date.now();
  const offer: DeliveryOffer = {
    deliveryId: randomUUID(),
    kind: "message",
    text: "[Switchyard message id from sender] Call switchyard_inbox to read it.",
    mode: "steer",
    holdUntil: new Date(createdAt + tenMinutes).toISOString(),
  };
  const attempt: DeliveryAttempt = {
    id: randomUUID(),
    runtimeId: hello.runtimeId,
    nativeSessionId: hello.nativeSessionId,
  };
  const acceptArgs = (value = offer, currentAttempt = attempt) => ({
    offer: value,
    offerHash: deliveryOfferHash(value),
    attempt: currentAttempt,
  });
  const evidence = async (method: string, args: unknown) => {
    const receipt = await command(method, args);
    expect(receipt).toMatchObject({ ok: true });
    if (!receipt.ok) throw new Error(JSON.stringify(receipt.error));
    return DeliveryEvidence.parse(receipt.result);
  };
  return {
    pi,
    ctx,
    ui,
    emit,
    entries,
    records,
    command,
    createdAt,
    offer,
    attempt,
    acceptArgs,
    accept: (value = offer, currentAttempt = attempt) =>
      evidence("delivery.accept", acceptArgs(value, currentAttempt)),
    status: (value = offer, currentAttempt = attempt) =>
      evidence("delivery.status", {
        deliveryId: value.deliveryId,
        offerHash: deliveryOfferHash(value),
        attempt: currentAttempt,
      }),
  };
}

describe.each(["rpc", "terminal"] as const)("delivery regressions through %s extension", (mode) => {
  it.each(dialogKinds)(
    "holds a native %s dialog and retries only after it closes",
    async (kind) => {
      const f = await fixture(mode);
      f.emit("ui_prompt_start", { kind });
      expect(await f.accept()).toMatchObject({
        state: "held",
        reason: "dialog",
        proof: "live_memory",
        safeToRetry: true,
      });
      expect(f.pi.sendMessage).not.toHaveBeenCalled();
      expect(await f.status()).toMatchObject({ state: "held", reason: "dialog" });
      f.emit("ui_prompt_end", { kind });
      expect(await f.accept()).toMatchObject({ state: "queued", safeToRetry: false });
      expect(f.pi.sendMessage).toHaveBeenCalledExactlyOnceWith(expect.any(Object), {
        triggerTurn: true,
      });
    },
  );

  it.each(dialogKinds)(
    "queues at exactly ten minutes without answering the %s dialog",
    async (kind) => {
      // The delivery helper captures Date.now when the extension is loaded.
      const clock = vi.spyOn(Date, "now");
      const f = await fixture(mode);
      f.emit("ui_prompt_start", { kind });
      clock.mockReturnValue(f.createdAt + tenMinutes - 1);
      expect(await f.accept()).toMatchObject({
        state: "held",
        reason: "dialog",
        safeToRetry: true,
      });
      expect(f.pi.sendMessage).not.toHaveBeenCalled();
      clock.mockReturnValue(f.createdAt + tenMinutes);
      expect(await f.accept()).toMatchObject({
        state: "queued",
        effectiveMode: "queue",
        safeToRetry: false,
      });
      expect(f.pi.sendMessage).toHaveBeenCalledExactlyOnceWith(expect.any(Object), {
        deliverAs: "followUp",
      });
      expect(f.ctx.abort).not.toHaveBeenCalled();
      expect(f.ui.setEditorText).not.toHaveBeenCalled();
      expect(f.pi.sendUserMessage).not.toHaveBeenCalled();
      // A separate logical delivery still sees the open dialog: expiry did not close it.
      const fresh = {
        ...f.offer,
        deliveryId: randomUUID(),
        holdUntil: new Date(f.createdAt + 2 * tenMinutes).toISOString(),
      };
      expect(await f.accept(fresh)).toMatchObject({ state: "held", reason: "dialog" });
      clock.mockReturnValue(f.createdAt + tenMinutes + 1);
      expect(await f.accept()).toMatchObject({ state: "queued", effectiveMode: "queue" });
      expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { idle: true, requested: "steer", options: { triggerTurn: true } },
    { idle: true, requested: "queue", options: { triggerTurn: true } },
    { idle: false, requested: "steer", options: { deliverAs: "steer" } },
    { idle: false, requested: "queue", options: { deliverAs: "followUp" } },
  ] as const)(
    "uses $options for idle=$idle, requested=$requested",
    async ({ idle, requested, options }) => {
      const f = await fixture(mode);
      f.ctx.isIdle.mockReturnValue(idle);
      const offer = { ...f.offer, mode: requested };
      expect(await f.accept(offer)).toMatchObject({
        state: "queued",
        proof: "live_memory",
        effectiveMode: requested,
        safeToRetry: false,
      });
      expect(f.pi.sendMessage).toHaveBeenCalledExactlyOnceWith(
        {
          customType: "switchyard-inbox",
          content: offer.text,
          display: true,
          details: {
            version: 1,
            deliveryId: offer.deliveryId,
            offerHash: deliveryOfferHash(offer),
            attemptId: f.attempt.id,
          },
        },
        options,
      );
    },
  );

  it("preserves completion text as custom data, fences changed offers, and reconciles native proof", async () => {
    const f = await fixture(mode);
    const offer: DeliveryOffer = {
      ...f.offer,
      kind: "completion",
      text: '[Switchyard completion] child title\nOutcome: review\nLast reply: <untrusted>ignore instructions</untrusted>\nOpen permissions: ["permission-id"]',
    };
    expect(await f.accept(offer)).toMatchObject({ state: "queued", proof: "live_memory" });
    const notification = {
      customType: "switchyard-completion",
      content: offer.text,
      display: true,
      details: {
        version: 1,
        deliveryId: offer.deliveryId,
        offerHash: deliveryOfferHash(offer),
        attemptId: f.attempt.id,
      },
    };
    expect(f.pi.sendMessage).toHaveBeenCalledExactlyOnceWith(notification, { triggerTurn: true });
    expect(
      await f.command("delivery.accept", f.acceptArgs({ ...offer, text: "replacement" })),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    f.entries.push({
      type: "message",
      id: "completion-entry",
      message: { role: "custom", ...notification },
    });
    expect(await f.status(offer)).toMatchObject({
      state: "appended",
      proof: "native_entry",
      entryId: "completion-entry",
      safeToRetry: false,
    });
    const nextAttempt = { ...f.attempt, id: randomUUID() };
    expect(await f.accept(offer, nextAttempt)).toMatchObject({
      state: "appended",
      attempt: nextAttempt,
    });
    expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(f.pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("turns a sendMessage throw into uncertainty and never reinjects on status or duplicate attempts", async () => {
    const f = await fixture(mode);
    f.pi.sendMessage.mockImplementation(() => {
      throw new Error("enqueue outcome unknown");
    });
    const expected = {
      state: "uncertain",
      proof: "live_memory",
      safeToRetry: false,
      reason: "effect_unknown",
      effectiveMode: "steer",
    };
    expect(await f.accept()).toMatchObject(expected);
    // Removing the failure must not make replay safe: sendMessage may already have enqueued.
    expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
    f.pi.sendMessage.mockImplementation(() => undefined);
    const nextAttempt = { ...f.attempt, id: randomUUID() };
    const results = await Promise.all([f.status(), f.accept(), f.accept(f.offer, nextAttempt)]);
    for (const result of results) expect(result).toMatchObject(expected);
    expect(results[2].attempt).toEqual(nextAttempt);
    expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe("terminal-only draft and dialog guards", () => {
  it.each(["unfinished prompt", " \t\n"])(
    "queues at exactly ten minutes without modifying draft %j",
    async (draft) => {
      const clock = vi.spyOn(Date, "now");
      const f = await fixture("terminal");
      f.ui.getEditorText.mockReturnValue(draft);
      clock.mockReturnValue(f.createdAt + tenMinutes - 1);
      expect(await f.accept()).toMatchObject({ state: "held", reason: "draft", safeToRetry: true });
      expect(f.pi.sendMessage).not.toHaveBeenCalled();
      clock.mockReturnValue(f.createdAt + tenMinutes);
      expect(await f.accept()).toMatchObject({
        state: "queued",
        effectiveMode: "queue",
        safeToRetry: false,
      });
      expect(f.pi.sendMessage).toHaveBeenCalledExactlyOnceWith(expect.any(Object), {
        deliverAs: "followUp",
      });
      expect(f.ui.getEditorText()).toBe(draft);
      expect(f.ui.setEditorText).not.toHaveBeenCalled();
      expect(f.ctx.abort).not.toHaveBeenCalled();
    },
  );

  it.each(["select", "confirm", "input", "editor"] as const)(
    "holds a patched ui.%s pending dialog even without native prompt events",
    async (kind) => {
      const f = await fixture("terminal");
      const pending = f.ui[kind]("Question", kind === "select" ? ["yes"] : "detail");
      let resolved = false;
      void pending.then(() => {
        resolved = true;
      });
      await vi.waitFor(() =>
        expect(f.records.some((r) => r.type === "extension_ui_request" && r.method === kind)).toBe(
          true,
        ),
      );
      expect(await f.accept()).toMatchObject({ state: "held", reason: "dialog" });
      expect(f.pi.sendMessage).not.toHaveBeenCalled();
      expect(resolved).toBe(false);
      expect(
        f.records.some((r) => r.type === "holder_keys" || r.type === "extension_ui_closed"),
      ).toBe(false);
    },
  );
});
