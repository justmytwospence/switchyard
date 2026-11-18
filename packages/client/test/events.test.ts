// @module-tag slow
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { event, session, syncState } from "../../terminal/test/fixtures.js";
import { type EventNotice, SwitchyardClient } from "../src/index.js";

let server: ReturnType<typeof createServer> | undefined;
let ws: WebSocketServer | undefined;
let client: SwitchyardClient | undefined;
afterEach(async () => {
  client?.close();
  if (ws) await new Promise<void>((done) => ws?.close(() => done()));
  if (server) await new Promise<void>((done) => server?.close(() => done()));
  server = undefined;
  ws = undefined;
  client = undefined;
});
function until(predicate: () => boolean, ms = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > ms) return reject(new Error("timeout"));
      setTimeout(check, 5);
    };
    check();
  });
}
async function fixture(
  onHello: (
    socket: import("ws"),
    hello: { cursor: number | null; projectionId?: string | null },
  ) => void,
) {
  server = createServer();
  ws = new WebSocketServer({ server, path: "/ws/client" });
  ws.on("connection", (socket) =>
    socket.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "hello") onHello(socket, msg);
    }),
  );
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  client = new SwitchyardClient({
    coordinatorUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    credential: "test",
    random: () => 0,
  });
  return client;
}

describe("durable event subscriptions", () => {
  it("owns independent cursors and projections, orders replay, suppresses duplicates and advances empty batches", async () => {
    const hellos: Array<{ cursor: number | null; projectionId?: string | null }> = [];
    const c = await fixture((socket, hello) => {
      hellos.push(hello);
      if (hello.cursor === 1) {
        socket.send(
          JSON.stringify({
            type: "replay",
            seq: 6,
            projectionId: "v1:adapter.slots.v1,timeline.cards.v1",
            capabilities: ["adapter.slots.v1", "timeline.cards.v1"],
            events: [
              event(3, "session.updated", session()),
              event(2, "session.updated", session()),
              event(2, "session.updated", session()),
            ],
          }),
        );
        socket.send(
          JSON.stringify({ type: "event", event: event(4, "session.updated", session()) }),
        );
        socket.send(
          JSON.stringify({ type: "event", event: event(7, "session.updated", session()) }),
        );
      } else socket.send(JSON.stringify({ type: "snapshot", seq: 8, state: syncState() }));
    });
    const one: EventNotice[] = [];
    const two: EventNotice[] = [];
    const offOne = c.events.subscribe((notice) => one.push(notice), {
      cursor: 1,
      projectionId: "v1:old",
    });
    const offTwo = c.events.subscribe((notice) => two.push(notice), { cursor: 5 });
    await until(() => one.length === 3 && two.length === 1);
    expect(hellos).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ cursor: 1, projectionId: "v1:old" }),
        expect.objectContaining({ cursor: 5, projectionId: null }),
      ]),
    );
    expect(one.map((notice) => (notice.type === "event" ? notice.event.seq : notice.seq))).toEqual([
      2, 3, 7,
    ]);
    expect(one[0]?.projectionId).toBe("v1:adapter.slots.v1,timeline.cards.v1");
    expect(two[0]?.type).toBe("reset");
    offOne();
    offTwo();
  });

  it("advances the cursor after empty replay and retains the acknowledged projection on reconnect", async () => {
    const hellos: Array<{ cursor: number | null; projectionId?: string | null }> = [];
    const c = await fixture((socket, hello) => {
      hellos.push(hello);
      socket.send(
        JSON.stringify({
          type: "replay",
          seq: 9,
          events: [],
          projectionId: "v1:",
          capabilities: [],
        }),
      );
      if (hellos.length === 1) setTimeout(() => socket.close(1001), 10);
    });
    const notices: EventNotice[] = [];
    c.events.subscribe((notice) => notices.push(notice), { cursor: 5, projectionId: "v1:old" });
    await until(() => hellos.length === 2, 5000);
    expect(hellos[1]).toMatchObject({ cursor: 9, projectionId: "v1:" });
    expect(notices).toEqual([]);
  });

  it("isolates callback exceptions and revocation, abort and close", async () => {
    const c = await fixture((socket) => {
      socket.send(JSON.stringify({ type: "snapshot", seq: 1, state: syncState() }));
      setTimeout(
        () => socket.send(JSON.stringify({ type: "force_logout", reason: "revoked" })),
        20,
      );
    });
    const errors: string[] = [];
    const notices: EventNotice[] = [];
    c.events.subscribe(
      () => {
        throw new Error("bad callback");
      },
      { onError: (error) => errors.push(error.message) },
    );
    c.events.subscribe((notice) => notices.push(notice), {
      onError: (error) => errors.push(error.message),
    });
    await until(() => errors.length === 2);
    expect(errors).toEqual(expect.arrayContaining(["bad callback", "revoked"]));
    expect(notices).toHaveLength(1);
    const controller = new AbortController();
    c.events.subscribe(() => undefined, { signal: controller.signal });
    controller.abort();
    c.close();
  });
});
