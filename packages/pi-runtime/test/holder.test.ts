import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { holderScriptPath, terminalSupport } from "../src/terminal-process.js";

const dirs: string[] = [];
const sockets: Socket[] = [];

function startHolder(script: string): { socketPath: string; done: Promise<number | null> } {
  const dir = mkdtempSync(join(tmpdir(), "sy-holder-"));
  dirs.push(dir);
  const socketPath = join(dir, "h.sock");
  const cfg = {
    socketPath,
    piBin: "/bin/sh",
    args: ["-c", script],
    cwd: dir,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TERM: "xterm-256color" },
    cols: 80,
    rows: 24,
  };
  const child = spawn(process.execPath, [holderScriptPath()], {
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, SWITCHYARD_HOLDER_CONFIG: JSON.stringify(cfg) },
  });
  const done = new Promise<number | null>((resolve) => child.once("exit", (c) => resolve(c)));
  return { socketPath, done };
}

async function connect(path: string, hello: object) {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      const s = await new Promise<Socket>((resolve, reject) => {
        const c = createConnection(path);
        c.once("connect", () => resolve(c));
        c.once("error", reject);
      });
      sockets.push(s);
      const lines: any[] = [];
      let buf = "";
      s.setEncoding("utf8");
      s.on("data", (chunk: string) => {
        buf += chunk;
        let nl = buf.indexOf("\n");
        while (nl >= 0) {
          lines.push(JSON.parse(buf.slice(0, nl)));
          buf = buf.slice(nl + 1);
          nl = buf.indexOf("\n");
        }
      });
      s.write(`${JSON.stringify(hello)}\n`);
      return { s, lines, send: (obj: object) => s.write(`${JSON.stringify(obj)}\n`) };
    } catch {
      if (Date.now() > deadline) throw new Error("holder did not listen");
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

async function until(pred: () => boolean, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const decoded = (lines: any[]) =>
  lines
    .filter((l) => l.t === "out")
    .map((l) => Buffer.from(l.d, "base64").toString("utf8"))
    .join("");

afterEach(() => {
  for (const s of sockets.splice(0)) s.destroy();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe.skipIf(!terminalSupport().ok)("terminal holder", () => {
  it("paints the screen for a viewer, echoes input, and resizes", async () => {
    const h = startHolder("printf ready; exec cat");
    await new Promise((r) => setTimeout(r, 300));
    const v = await connect(h.socketPath, { role: "viewer", cols: 90, rows: 20 });
    await until(() => decoded(v.lines).includes("ready"));
    v.send({ t: "in", d: Buffer.from("abc\r").toString("base64") });
    await until(() => decoded(v.lines).includes("abc"));
    v.send({ t: "resize", cols: 100, rows: 30 });
    const c = await connect(h.socketPath, { role: "control" });
    await until(() => c.lines.some((l) => l.type === "holder_status"));
    c.send({ type: "holder_kill", signal: "SIGTERM" });
    await until(() => c.lines.some((l) => l.type === "holder_exit"));
    expect(c.lines.find((l) => l.type === "holder_exit")).toMatchObject({ signal: "SIGTERM" });
    await h.done;
    expect(existsSync(h.socketPath)).toBe(false);
  });

  it("buffers extension records until a control attaches, reporting a gap on overflow", async () => {
    const h = startHolder("exec cat");
    const ext = await connect(h.socketPath, { role: "extension" });
    for (let i = 0; i < 20001; i++) ext.s.write(`${JSON.stringify({ type: "n", i })}\n`);
    await new Promise((r) => setTimeout(r, 500));
    const c = await connect(h.socketPath, { role: "control" });
    await until(() => c.lines.filter((l) => l.type === "n").length === 20000, 10000);
    const kinds = c.lines.map((l) => l.type);
    expect(kinds.indexOf("holder_gap")).toBeLessThan(kinds.indexOf("n"));
    const ns = c.lines.filter((l) => l.type === "n").map((l) => l.i);
    expect(ns[0]).toBe(1);
    expect(ns.at(-1)).toBe(20000);
    // Control lines reach the extension; the extension hears that a control attached.
    await until(() => ext.lines.some((l) => l.type === "control_attached"));
    c.send({ type: "ping", id: "x" });
    await until(() => ext.lines.some((l) => l.type === "ping"));
    c.send({ type: "holder_kill", signal: "SIGKILL" });
    await until(() => c.lines.some((l) => l.type === "holder_exit"));
    await h.done;
  });
});
