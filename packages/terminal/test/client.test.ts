import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { ApiRequestError, SwitchyardClient, wsUrlFor } from "../src/client.js";
import { event, interaction, session, syncState } from "./fixtures.js";

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
  it("authenticates with bearer, syncs from a snapshot, applies events, sends presence, handles force_logout", async () => {
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
          sock.send(
            JSON.stringify({
              type: "stream",
              delta: { sessionId: "ses_1", itemId: "itm_s", kind: "text", delta: "hi" },
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
    await until(() => client!.store.getState().streaming.itm_s?.text === "hi");

    // Presence: a keypress makes the client foreground and reports what it views.
    client.setViewing("ses_1");
    client.noteKeypress();
    await until(() =>
      received.some(
        (m) =>
          (m as { type: string; presence?: { foreground: boolean } }).type === "presence" &&
          (m as { presence: { foreground: boolean } }).presence.foreground,
      ),
    );
    const last = received.filter((m) => (m as { type: string }).type === "presence").at(-1) as {
      presence: { viewing: { sessionId: string } | null; interactedAt: string | null };
    };
    expect(last.presence.viewing).toEqual({ sessionId: "ses_1" });
    expect(last.presence.interactedAt).not.toBeNull();

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

  it("reports 'Already answered' with the accepted resolution on 409", async () => {
    const accepted = interaction(
      { t: "text", text: "q" },
      {
        revision: 2,
        state: "resolved",
        resolution: { by: "dev_web", summary: "Apple", at: "2026-11-02T10:00:00.000Z" },
      },
    );
    const calls: { url: string; body: unknown; auth: string | null }[] = [];
    client = new SwitchyardClient({
      coordinatorUrl: "http://coord",
      credential: "c",
      fetch: async (url, init) => {
        calls.push({
          url,
          body: JSON.parse(String(init?.body)),
          auth: new Headers(init?.headers).get("authorization"),
        });
        return new Response(
          JSON.stringify({
            error: {
              code: "already_answered",
              message: "This question was already answered",
              details: { interaction: accepted },
            },
          }),
          { status: 409 },
        );
      },
    });
    const out = await client.answer(interaction({ t: "text", text: "q" }), {
      kind: "form",
      values: { q1: "Pear" },
    });
    expect(calls[0]).toEqual({
      url: "http://coord/api/interactions/int_1/answer",
      body: { revision: 1, response: { kind: "form", values: { q1: "Pear" } } },
      auth: "Bearer c",
    });
    expect(out).toMatchObject({ status: "already_answered", summary: "Apple" });
    expect(client.store.getState().interactions.int_1?.state).toBe("resolved");
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
    await expect(client.prompt("ses_1", "x", "prompt")).rejects.toMatchObject({
      code: "host_unreachable",
      status: 503,
    });
    await expect(client.stop("ses_1")).rejects.toBeInstanceOf(ApiRequestError);
  });
});
