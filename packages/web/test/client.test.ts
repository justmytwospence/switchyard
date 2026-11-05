import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONNECT_TIMEOUT_MS, RESUME_PONG_TIMEOUT_MS, SyncClient } from "../src/sync/client";
import { useSyncStore } from "../src/sync/store";
import { snapshot } from "./fixtures";

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  /** Like a dead TCP connection: records the close but never calls onclose. */
  close(code?: number, reason?: string) {
    this.readyState = 3;
    this.closed = { code, reason };
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  lastSent(): { type: string } | undefined {
    const raw = this.sent.at(-1);
    return raw ? JSON.parse(raw) : undefined;
  }
}

const win = new EventTarget();
const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });

let client: SyncClient;

async function started(): Promise<FakeWebSocket> {
  client = new SyncClient("ws://t/ws/client");
  client.start();
  await vi.advanceTimersByTimeAsync(0);
  return FakeWebSocket.instances[0]!;
}

async function live(): Promise<FakeWebSocket> {
  const ws = await started();
  ws.open();
  ws.receive({ type: "snapshot", seq: 1, state: snapshot() });
  return ws;
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("no network"))),
  );
  vi.spyOn(Math, "random").mockReturnValue(1);
  doc.visibilityState = "visible";
  useSyncStore.getState().reset();
});

afterEach(() => {
  client.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SyncClient connect timeout", () => {
  it("drops a socket that opens but never syncs and reconnects", async () => {
    const ws = await started();
    ws.open();
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
    expect(ws.closed?.code).toBe(4000);
    expect(useSyncStore.getState().connection.state).toBe("connecting");
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});

describe("SyncClient foreground", () => {
  it("reconnects at once when the page becomes visible after a missed close", async () => {
    const ws = await started();
    ws.onclose?.({ code: 1006, reason: "" });
    expect(FakeWebSocket.instances).toHaveLength(1);
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(FakeWebSocket.instances).toHaveLength(2);
    win.dispatchEvent(new Event("pageshow"));
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("pings a stale live socket on focus and drops it when no pong arrives", async () => {
    const ws = await live();
    expect(client.isLive).toBe(true);
    await vi.advanceTimersByTimeAsync(6000);
    win.dispatchEvent(new Event("focus"));
    expect(ws.lastSent()).toEqual({ type: "ping" });
    await vi.advanceTimersByTimeAsync(RESUME_PONG_TIMEOUT_MS);
    expect(ws.closed?.code).toBe(4000);
    expect(useSyncStore.getState().connection.state).toBe("reconnecting");
  });

  it("stays live when the resume ping is answered", async () => {
    const ws = await live();
    await vi.advanceTimersByTimeAsync(6000);
    win.dispatchEvent(new Event("focus"));
    ws.receive({ type: "pong" });
    await vi.advanceTimersByTimeAsync(RESUME_PONG_TIMEOUT_MS + 1000);
    expect(ws.closed).toBeNull();
    expect(useSyncStore.getState().connection.state).toBe("live");
    expect(useSyncStore.getState().lastSyncedAt).not.toBeNull();
  });

  it("does not ping when a frame arrived recently", async () => {
    const ws = await live();
    const before = ws.sent.length;
    await vi.advanceTimersByTimeAsync(1000);
    win.dispatchEvent(new Event("focus"));
    expect(ws.sent).toHaveLength(before);
  });
});
