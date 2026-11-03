import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import type { TranscriptItem } from "@switchyard/protocol";
import { when } from "@switchyard/test-fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PiUiRequest } from "../src/index.js";
import { ManagedSession } from "../src/session-runtime.js";
import { PiTerminalProcess, terminalSupport } from "../src/terminal-process.js";
import { type PiHarness, record, setupPi, skipRealPi, waitFor } from "./helpers.js";

const callTool = (name: string) => ({ toolCalls: [{ name, arguments: {} }] });

/** Connect to the holder as a viewer; returns a writer for keystrokes and the collected output. */
function viewer(socketPath: string) {
  const s = createConnection(socketPath);
  let out = "";
  let buf = "";
  s.setEncoding("utf8");
  s.on("data", (chunk: string) => {
    buf += chunk;
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const msg = JSON.parse(line);
      if (msg.t === "out") out += Buffer.from(msg.d, "base64").toString("utf8");
      nl = buf.indexOf("\n");
    }
  });
  s.write(`${JSON.stringify({ role: "viewer", cols: 100, rows: 30 })}\n`);
  return {
    type: (text: string) =>
      s.write(`${JSON.stringify({ t: "in", d: Buffer.from(text).toString("base64") })}\n`),
    output: () => out,
    close: () => s.destroy(),
  };
}

const lastTool = (items: TranscriptItem[], name: string) =>
  items.filter((i) => i.kind === "tool" && i.data.name === name).at(-1) as
    | Extract<TranscriptItem, { kind: "tool" }>
    | undefined;

describe.skipIf(skipRealPi || !terminalSupport().ok)("gate: terminal transport", () => {
  let h: PiHarness;
  beforeAll(async () => {
    h = await setupPi([
      { when: when.userSays("hello"), reply: { text: "hi from the terminal" } },
      { when: when.userSays("pick"), reply: callTool("fixture_select") },
      { when: when.userSays("slow"), reply: callTool("fixture_slow") },
      { when: when.toolResult(), reply: (r) => ({ text: `tool said: ${r.lastText}` }) },
    ]);
  });
  afterAll(async () => {
    await h?.dispose();
  });

  it("prompts, answers dialogs remotely and in the terminal, steers, aborts, reattaches and stops", async () => {
    const s = h.newSession({ transport: "terminal" });
    const rec = record(s, ["item", "ui_resolved", "queue"]);
    await s.start();
    expect(s.runtime).toBe("idle");
    const socketPath = s.terminalSocket!;
    expect(socketPath).toBeTruthy();
    expect(s.remoteDialogs).toBe(true);

    // A plain prompt.
    let settled = waitFor(s, "settled");
    await s.prompt("hello there");
    let info = await settled;
    expect(info.lastAssistantText).toBe("hi from the terminal");
    const items = rec.of("item") as TranscriptItem[];
    expect(items.some((i) => i.kind === "user" && i.data.text === "hello there")).toBe(true);

    // A select answered remotely.
    let request = waitFor<PiUiRequest>(s, "ui_request", (r) => r.method === "select");
    settled = waitFor(s, "settled");
    await s.prompt("please pick a fruit");
    let req = await request;
    expect(req).toMatchObject({ title: "Pick a fruit", options: ["Apple", "Banana"] });
    expect(s.runtime).toBe("waiting_input");
    await s.respondUi(req.id, { value: "Banana" });
    info = await settled;
    expect(lastTool(rec.of("item"), "fixture_select")?.data.output).toContain("Banana");

    // A select answered in the terminal (Enter picks the first option).
    const v = viewer(socketPath);
    request = waitFor<PiUiRequest>(s, "ui_request", (r) => r.method === "select");
    settled = waitFor(s, "settled");
    await s.prompt("pick again");
    req = await request;
    const resolved = waitFor(s, "ui_resolved", (r: any) => r.id === req.id);
    await new Promise((r) => setTimeout(r, 500));
    v.type("\r");
    expect(await resolved).toMatchObject({ by: "terminal" });
    await settled;
    expect(lastTool(rec.of("item"), "fixture_select")?.data.output).toContain("Apple");
    expect(v.output().length).toBeGreaterThan(0);
    v.close();

    // Steer while a slow tool runs, then abort.
    const toolStarted = waitFor(s, "pi_event", (e: any) => e.type === "tool_execution_start");
    await s.prompt("run something slow");
    await toolStarted;
    expect(await s.prompt("also this", [], "steer")).toBe("queued");
    expect((rec.of("queue") as any[]).some((q) => q.steering.includes("also this"))).toBe(true);
    settled = waitFor(s, "settled");
    await s.abort();
    info = await settled;
    expect(info.aborted).toBe(true);

    // Detach and reattach.
    s.detach();
    const again = new ManagedSession({
      sessionId: s.sessionId,
      cwd: h.env.cwd,
      title: "Gate test",
      profile: {
        provider: "mock",
        model: "mock-1",
        thinking: null,
        projectTrust: "ask",
        extraArgs: [],
      },
      transport: "terminal",
      terminalSocket: socketPath,
    });
    h.sessions.push(again);
    await again.start();
    expect(again.runtime).toBe("idle");
    expect(again.nativeHandle?.sessionId).toBe(s.nativeHandle?.sessionId);
    settled = waitFor(again, "settled");
    await again.prompt("hello again");
    expect((await settled).lastAssistantText).toBe("hi from the terminal");

    // Stop.
    await again.stop({ graceMs: 5000, termMs: 2000 });
    expect(again.runtime).toBe("stopped");
    await new Promise((r) => setTimeout(r, 1500));
    expect(existsSync(socketPath)).toBe(false);
    await expect(PiTerminalProcess.attach(socketPath, 500)).rejects.toThrow();
  });
});
