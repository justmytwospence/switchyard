import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  enrollDevice,
  enrollHost,
  FakeHost,
  hostSession,
  startCoordinator,
  type TestCoordinator,
  until,
} from "./helpers.js";
import { fullCapabilities } from "./task-helpers.js";

let t: TestCoordinator | undefined;
const hosts: FakeHost[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) {
    s.on("error", () => {});
    if (s.readyState !== WebSocket.CONNECTING) s.terminate();
  }
  for (const h of hosts.splice(0)) await h.close();
  await t?.cleanup();
  t = undefined;
});

async function setup(terminal: boolean) {
  t = await startCoordinator();
  const creds = await enrollHost(t);
  const h = new FakeHost(t.c.localUrl.replace("http", "ws"), creds.hostId, creds.credential);
  hosts.push(h);
  await h.open({ capabilities: fullCapabilities({ terminal }) });
  await h.event("session.updated", hostSession("ses_term", { terminal }), { hostSeq: 1 });
  const device = await enrollDevice(t);
  return { t, h, device };
}

function viewer(tc: TestCoordinator, token: string | null, query = "?cols=90&rows=20") {
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  const ws = new WebSocket(`${tc.c.localUrl.replace("http", "ws")}/ws/terminal/ses_term${query}`, {
    headers,
  });
  sockets.push(ws);
  ws.on("error", () => {});
  const messages: any[] = [];
  let closed = false;
  ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
  ws.on("close", () => {
    closed = true;
  });
  return { ws, messages, isClosed: () => closed };
}

const termFrames = (h: FakeHost) => h.inbox.messages.filter((m: any) => m.type === "term") as any[];

describe("terminal relay", () => {
  it("relays a viewer's stream to the host and back", async () => {
    const { t, h, device } = await setup(true);
    expect(t.c.store.sessions.require("ses_term").terminal).toBe(true);
    const v = viewer(t, device.credential);
    await until(() => termFrames(h).length > 0);
    const open = termFrames(h)[0];
    expect(open.msg).toEqual({ t: "open", sessionId: "ses_term", cols: 90, rows: 20 });
    const streamId = open.streamId as string;
    expect(streamId).toMatch(/^trm_/);

    h.sendRaw({
      type: "term",
      streamId,
      msg: { t: "out", d: Buffer.from("hi").toString("base64") },
    });
    await until(() => v.messages.length > 0);
    expect(v.messages[0]).toEqual({ t: "out", d: Buffer.from("hi").toString("base64") });

    v.ws.send(JSON.stringify({ t: "in", d: "eA==" }));
    v.ws.send(JSON.stringify({ t: "bogus" }));
    v.ws.send(JSON.stringify({ t: "resize", cols: 120, rows: 40 }));
    await until(() => termFrames(h).length >= 3);
    expect(termFrames(h).map((f) => f.msg)).toEqual([
      open.msg,
      { t: "in", d: "eA==" },
      { t: "resize", cols: 120, rows: 40 },
    ]);

    // The host ends the stream.
    h.sendRaw({ type: "term", streamId, msg: { t: "closed", reason: "Pi exited" } });
    await until(() => v.isClosed());
    expect(v.messages.at(-1)).toEqual({ t: "closed", reason: "Pi exited" });
  });

  it("closes viewers when the host disconnects, and tells the host when a viewer leaves", async () => {
    const { t, h, device } = await setup(true);
    const a = viewer(t, device.credential);
    await until(() => termFrames(h).length === 1);
    a.ws.close();
    await until(() => termFrames(h).some((f) => f.msg.t === "close"));

    const b = viewer(t, device.credential);
    await until(() => termFrames(h).filter((f) => f.msg.t === "open").length === 2);
    await h.close();
    await until(() => b.isClosed());
    expect(b.messages.at(-1)).toEqual({ t: "closed", reason: "Host disconnected" });
  });

  it("refuses hosts without terminal sessions and unknown sessions", async () => {
    const { t, h, device } = await setup(false);
    const v = viewer(t, device.credential);
    await until(() => v.isClosed());
    expect(v.messages).toEqual([
      { t: "closed", reason: "This session's host does not run terminal sessions" },
    ]);
    expect(termFrames(h)).toEqual([]);
  });

  it("needs a device credential", async () => {
    const { t } = await setup(true);
    const v = viewer(t, null);
    const status = await new Promise<number>((resolve) => {
      v.ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      v.ws.once("open", () => resolve(101));
    });
    expect(status).toBe(401);
  });
});
