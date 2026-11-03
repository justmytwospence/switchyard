import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { runRawTerminal, TERMINAL_RESET, terminalWsUrl } from "../src/raw-terminal.js";

let wss: WebSocketServer | null = null;
afterEach(async () => {
  await new Promise<void>((r) => (wss ? wss.close(() => r()) : r()));
  wss = null;
});

function fakeTty() {
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    raw: false,
    setRawMode(v: boolean) {
      stdin.raw = v;
      return stdin;
    },
  });
  let written = "";
  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 30 });
  stdout.on("data", (c: Buffer) => {
    written += c.toString("utf8");
  });
  return {
    stdin: stdin as unknown as NodeJS.ReadStream & { raw: boolean },
    stdout: stdout as unknown as NodeJS.WriteStream,
    written: () => written,
  };
}

async function server() {
  wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => wss!.once("listening", () => r()));
  return `http://127.0.0.1:${(wss.address() as AddressInfo).port}`;
}

describe("terminalWsUrl", () => {
  it("maps http(s) and keeps path prefixes", () => {
    expect(terminalWsUrl("http://h:7400", "ses_1", 80, 24)).toBe(
      "ws://h:7400/ws/terminal/ses_1?cols=80&rows=24",
    );
    expect(terminalWsUrl("https://x.example.com/sy/", "a b", 120, 40)).toBe(
      "wss://x.example.com/sy/ws/terminal/a%20b?cols=120&rows=40",
    );
  });
});

describe("runRawTerminal", () => {
  it("sends keystrokes, writes output, and detaches on Ctrl+]", async () => {
    const url = await server();
    const received: any[] = [];
    let auth: string | undefined;
    let path: string | undefined;
    wss!.on("connection", (ws, req) => {
      auth = req.headers.authorization;
      path = req.url;
      ws.on("message", (raw) => received.push(JSON.parse(raw.toString())));
      ws.send(JSON.stringify({ t: "out", d: Buffer.from("pi screen").toString("base64") }));
    });
    const tty = fakeTty();
    const done = runRawTerminal({
      coordinatorUrl: url,
      credential: "tok",
      sessionId: "ses_1",
      stdin: tty.stdin,
      stdout: tty.stdout,
    });
    while (!tty.written().includes("pi screen")) await new Promise((r) => setTimeout(r, 10));
    expect(tty.stdin.raw).toBe(true);
    tty.stdin.write("ab");
    while (received.length === 0) await new Promise((r) => setTimeout(r, 10));
    expect(received[0]).toEqual({ t: "in", d: Buffer.from("ab").toString("base64") });
    tty.stdin.write(Buffer.from([0x1d]));
    expect(await done).toEqual({ reason: "detached" });
    expect(tty.stdin.raw).toBe(false);
    expect(tty.written()).toContain(TERMINAL_RESET);
    expect(auth).toBe("Bearer tok");
    expect(path).toBe("/ws/terminal/ses_1?cols=100&rows=30");
  });

  it("returns the reason when the server closes the terminal", async () => {
    const url = await server();
    wss!.on("connection", (ws) => ws.send(JSON.stringify({ t: "closed", reason: "Pi exited" })));
    const tty = fakeTty();
    const result = await runRawTerminal({
      coordinatorUrl: url,
      credential: null,
      sessionId: "s",
      stdin: tty.stdin,
      stdout: tty.stdout,
    });
    expect(result).toEqual({ reason: "closed", message: "Pi exited" });
  });

  it("refuses a stdin that is not a terminal", async () => {
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    await expect(
      runRawTerminal({ coordinatorUrl: "http://x", credential: null, sessionId: "s", stdin }),
    ).rejects.toThrow("interactive terminal");
  });
});
