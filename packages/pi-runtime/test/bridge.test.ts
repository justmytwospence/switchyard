import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import bridge from "../src/bridge/switchyard-bridge.js";
import { JsonlReader } from "../src/jsonl.js";

function fakePi() {
  const handlers = new Map<string, ((e: any) => void)[]>();
  return {
    handlers,
    on(event: string, h: (e: any) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), h]);
      return () => {};
    },
    fire(event: string, payload: any) {
      for (const h of handlers.get(event) ?? []) h(payload);
    },
  };
}

const saved = process.env.SWITCHYARD_BRIDGE_SOCKET;
afterEach(() => {
  if (saved === undefined) delete process.env.SWITCHYARD_BRIDGE_SOCKET;
  else process.env.SWITCHYARD_BRIDGE_SOCKET = saved;
});

describe("bridge extension", () => {
  it("is a no-op without SWITCHYARD_BRIDGE_SOCKET", () => {
    delete process.env.SWITCHYARD_BRIDGE_SOCKET;
    const pi = fakePi();
    bridge(pi);
    expect(pi.handlers.size).toBe(0);
  });

  it("forwards ui_prompt_start/end as JSON lines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sy-br-"));
    const path = join(dir, "b.sock");
    const lines: any[] = [];
    const server = createServer((s) => JsonlReader.attach(s, (r) => lines.push(r)));
    await new Promise<void>((r) => server.listen(path, r));
    try {
      process.env.SWITCHYARD_BRIDGE_SOCKET = path;
      const pi = fakePi();
      bridge(pi);
      pi.fire("session_start", { type: "session_start" });
      pi.fire("ui_prompt_start", {
        type: "ui_prompt_start",
        reason: "ui_prompt",
        kind: "select",
        title: "Pick",
      });
      pi.fire("ui_prompt_end", {
        type: "ui_prompt_end",
        reason: "ui_prompt",
        kind: "select",
        title: "Pick",
      });
      pi.fire("ui_prompt_start", { type: "ui_prompt_start", reason: "ui_prompt", kind: "custom" });
      for (let i = 0; i < 50 && lines.length < 5; i++) await new Promise((r) => setTimeout(r, 10));
      expect(lines.map((l) => [l.type, l.kind ?? null, l.title])).toEqual([
        ["hello", null, null],
        ["model_state", null, null],
        ["ui_prompt_start", "select", "Pick"],
        ["ui_prompt_end", "select", "Pick"],
        ["ui_prompt_start", "custom", null],
      ]);
      expect(lines.map((l) => l.seq)).toEqual([1, 2, 3, 4, 5]);
      pi.fire("session_shutdown", {});
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never throws when the socket is unreachable", async () => {
    process.env.SWITCHYARD_BRIDGE_SOCKET = join(tmpdir(), "sy-missing-dir", "nope.sock");
    const pi = fakePi();
    expect(() => bridge(pi)).not.toThrow();
    expect(() => pi.fire("session_start", {})).not.toThrow();
    await new Promise((r) => setTimeout(r, 30));
    expect(() => pi.fire("ui_prompt_start", { kind: "select", title: "x" })).not.toThrow();
  });
});
