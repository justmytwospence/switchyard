import { PROTOCOL_VERSION, SwitchyardError } from "@switchyard/protocol";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { sha256 } from "../src/auth.js";
import { HostHub } from "../src/host-hub.js";

const prompt = {
  type: "session.prompt" as const,
  sessionId: "session",
  text: "continue",
  images: [],
  mode: "prompt" as const,
  origin: "automation" as const,
  controlRevision: 1,
};

function setup() {
  const host = { id: "host", name: "host", revokedAt: null };
  const store = {
    hosts: { get: () => host },
    hostCredentialHash: () => sha256("secret"),
    tx: (fn: () => void) => fn(),
    putHost: vi.fn(),
    nowIso: () => "2026-01-01T00:00:00.000Z",
    sessions: { list: () => [] },
    ackedHostSeq: () => 0,
    activeRunsOnHost: () => [],
  };
  const log = { info: vi.fn(), warn: vi.fn() };
  const hub = new HostHub(store as never, { emit: vi.fn() } as never, {} as never, log as never, {
    unreachableAfterMs: 1000,
    commandTimeoutMs: 10000,
  });
  const internals = hub as unknown as {
    conns: Map<string, { socket: WebSocket; alive: boolean; features: Set<string> }>;
    onHello: (socket: WebSocket, hello: unknown) => string | null;
  };
  function socket() {
    return { readyState: 1, send: vi.fn(), close: vi.fn() };
  }
  const first = socket();
  internals.conns.set("host", {
    socket: first as unknown as WebSocket,
    alive: true,
    features: new Set(),
  });
  function reconnect() {
    const next = socket();
    internals.onHello(next as unknown as WebSocket, {
      type: "hello",
      hostId: "host",
      credential: "secret",
      protocolVersion: PROTOCOL_VERSION,
      name: "host",
      platform: "test",
      agentVersion: "1",
      piVersion: null,
      piCompatible: false,
      capabilities: {},
    });
    return next;
  }
  return { hub, first, reconnect };
}

describe("HostHub continuation beforeSend", () => {
  it("requires a guard for continuation prompts and leaves ordinary commands unchanged", async () => {
    const { hub, first } = setup();
    await expect(
      hub.send("host", prompt, { commandId: "cont_run_with_parts_1" }),
    ).rejects.toMatchObject({ code: "stale_control" });
    expect(first.send).not.toHaveBeenCalled();
    const result = hub.send("host", prompt, { commandId: "ordinary" });
    expect(first.send).toHaveBeenCalledOnce();
    hub.stop();
    await expect(result).rejects.toMatchObject({ code: "host_unreachable" });
  });

  it("runs synchronously immediately before each send without serializing the guard", async () => {
    const { hub, first, reconnect } = setup();
    const order: string[] = [];
    first.send.mockImplementation(() => order.push("send"));
    const guard = vi.fn(() => order.push("guard"));
    const result = hub.send("host", prompt, { commandId: "cont_run_1", beforeSend: guard });
    expect(order).toEqual(["guard", "send"]);
    const next = reconnect();
    expect(guard).toHaveBeenCalledTimes(2);
    const frame = JSON.parse(
      next.send.mock.calls.find(([raw]) => JSON.parse(raw).type === "command")![0],
    );
    expect(frame).toEqual({ type: "command", commandId: "cont_run_1", command: prompt });
    hub.stop();
    await expect(result).rejects.toMatchObject({ code: "host_unreachable" });
  });

  it("propagates a failed initial guard and never replays it", async () => {
    const { hub, first, reconnect } = setup();
    const stale = new SwitchyardError("stale_control", "stale");
    await expect(
      hub.request("host", prompt, {
        commandId: "cont_run_1",
        beforeSend: () => {
          throw stale;
        },
      }),
    ).rejects.toBe(stale);
    expect(first.send).not.toHaveBeenCalled();
    expect(reconnect().send.mock.calls.map(([raw]) => JSON.parse(raw).type)).toEqual(["welcome"]);
    hub.stop();
  });

  it("rejects every waiter on stale reconnect and cannot replay on another reconnect", async () => {
    const { hub, reconnect } = setup();
    const stale = new SwitchyardError("stale_control", "changed");
    const guard = vi
      .fn()
      .mockImplementationOnce(() => {})
      .mockImplementation(() => {
        throw stale;
      });
    const first = hub.send("host", prompt, { commandId: "cont_run_2", beforeSend: guard });
    const joined = hub.send("host", prompt, { commandId: "cont_run_2", beforeSend: guard });
    const next = reconnect();
    await expect(first).rejects.toBe(stale);
    await expect(joined).rejects.toBe(stale);
    expect(next.send.mock.calls.map(([raw]) => JSON.parse(raw).type)).toEqual(["welcome"]);
    expect(reconnect().send.mock.calls.map(([raw]) => JSON.parse(raw).type)).toEqual(["welcome"]);
    expect(guard).toHaveBeenCalledTimes(2);
    hub.stop();
  });
});
