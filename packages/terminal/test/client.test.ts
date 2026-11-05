import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { ApiRequestError, SwitchyardClient, wsUrlFor } from "../src/client.js";
import { event, session, syncState } from "./fixtures.js";

let wss: WebSocketServer | null = null;
let client: SwitchyardClient | null = null;

afterEach(async () => {
  client?.close();
  client = null;
  await new Promise<void>((r) => (wss ? wss.close(() => r()) : r()));
  wss = null;
});

function until(fn: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (fn()) return resolve();
      if (Date.now() - start > ms) return reject(new Error("timeout"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe("wsUrlFor", () => {
  it("maps http(s) to ws(s) with /ws/client", () => {
    expect(wsUrlFor("http://127.0.0.1:7400/")).toBe("ws://127.0.0.1:7400/ws/client");
    expect(wsUrlFor("https://sy.example.com")).toBe("wss://sy.example.com/ws/client");
  });
});

describe("SwitchyardClient", () => {
  it("authenticates with bearer, syncs from a snapshot, applies events, handles force_logout", async () => {
    const received: unknown[] = [];
    let auth: string | undefined;
    wss = new WebSocketServer({ port: 0 });
    wss.on("connection", (sock, req) => {
      auth = req.headers.authorization;
      sock.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        received.push(msg);
        if (msg.type === "hello") {
          sock.send(JSON.stringify({ type: "snapshot", seq: 5, state: syncState() }));
          sock.send(
            JSON.stringify({
              type: "event",
              event: event(6, "session.updated", session({ runtime: "running" })),
            }),
          );
        }
      });
    });
    const port = (wss.address() as AddressInfo).port;
    client = new SwitchyardClient({
      coordinatorUrl: `http://127.0.0.1:${port}`,
      credential: "cred-1",
    });
    const logouts: string[] = [];
    client.onLogout((r) => logouts.push(r));
    client.connect();
    await until(() => client!.store.getState().seq === 6);
    const st = client.store.getState();
    expect(auth).toBe("Bearer cred-1");
    expect(received[0]).toEqual({ type: "hello", cursor: null });
    expect(st.connection.state).toBe("live");
    expect(st.sessions.ses_1?.runtime).toBe("running");
    expect(received.every((m) => (m as { type: string }).type !== "presence")).toBe(true);

    for (const c of wss.clients)
      c.send(JSON.stringify({ type: "force_logout", reason: "revoked" }));
    await until(() => logouts.length === 1);
    expect(logouts).toEqual(["revoked"]);
    expect(client.store.getState().connection.state).toBe("logged_out");
  });

  it("reconnects and resumes from its cursor", async () => {
    const hellos: (number | null)[] = [];
    wss = new WebSocketServer({ port: 0 });
    wss.on("connection", (sock) => {
      sock.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type !== "hello") return;
        hellos.push(msg.cursor);
        if (hellos.length === 1) {
          sock.send(JSON.stringify({ type: "snapshot", seq: 7, state: syncState() }));
          setTimeout(() => sock.close(1001, "restart"), 20);
        } else {
          sock.send(JSON.stringify({ type: "replay", seq: 7, events: [] }));
        }
      });
    });
    const port = (wss.address() as AddressInfo).port;
    client = new SwitchyardClient({
      coordinatorUrl: `http://127.0.0.1:${port}`,
      credential: "c",
      random: () => 0,
    });
    client.connect();
    await until(() => hellos.length === 2, 5000);
    expect(hellos).toEqual([null, 7]);
  });

  it("maps API errors", async () => {
    client = new SwitchyardClient({
      coordinatorUrl: "http://coord",
      credential: "c",
      fetch: async () =>
        new Response(
          JSON.stringify({ error: { code: "host_unreachable", message: "Host offline" } }),
          {
            status: 503,
          },
        ),
    });
    await expect(
      client.api.post("/api/sessions/ses_1/prompt", { text: "x", mode: "prompt" }),
    ).rejects.toMatchObject({
      code: "host_unreachable",
      status: 503,
    });
    await expect(client.api.post("/api/sessions/ses_1/stop")).rejects.toBeInstanceOf(
      ApiRequestError,
    );
  });

  it("aborts a handshake that gets an unexpected response", async () => {
    let attempts = 0;
    let closed = 0;
    const sockets = new Set<import("node:stream").Duplex>();
    const server = createServer();
    server.on("upgrade", (_req, socket) => {
      attempts++;
      sockets.add(socket);
      // The server keeps its side half-open, so the client hanging up shows as "end".
      socket.on("end", () => {
        closed++;
        socket.destroy();
      });
      socket.write("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    try {
      const port = (server.address() as AddressInfo).port;
      client = new SwitchyardClient({
        coordinatorUrl: `http://127.0.0.1:${port}`,
        credential: "c",
        random: () => 0,
      });
      client.connect();
      await until(() => closed >= 1 && attempts >= 2, 5000);
    } finally {
      client?.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
