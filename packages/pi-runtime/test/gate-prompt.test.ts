import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { TranscriptItem } from "@switchyard/protocol";
import { when } from "@switchyard/test-fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type PiHarness, record, setupPi, skipRealPi, waitFor } from "./helpers.js";

describe.skipIf(skipRealPi)("gate: prompt", () => {
  let h: PiHarness;
  beforeAll(async () => {
    h = await setupPi([
      { when: when.userSays("hello"), reply: { thinking: "considering", text: "Hello from mock" } },
    ]);
  });
  afterAll(async () => {
    await h?.dispose();
  });

  it("prompts, streams, maps items and settles; the session file exists", async () => {
    const s = h.newSession({ nextOrder: 10 });
    const rec = record(s, ["item", "stream", "runtime", "settled", "native", "pi_event", "queue"]);
    await s.start();
    expect(s.runtime).toBe("idle");
    const native = rec.of("native")[0];
    expect(native.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(native.sessionFile).toMatch(/\.jsonl$/);

    const settled = waitFor(s, "settled");
    const disposition = await s.prompt("hello there");
    expect(disposition).toBe("started");
    const info = await settled;
    expect(info).toEqual({ aborted: false, lastAssistantText: "Hello from mock" });
    expect(s.runtime).toBe("idle");

    const items = rec.of("item") as TranscriptItem[];
    for (const item of items) expect(() => TranscriptItem.parse(item)).not.toThrow();
    const user = items.find((i) => i.kind === "user");
    const thinking = items.find((i) => i.kind === "thinking");
    const assistant = items.find((i) => i.kind === "assistant");
    expect(user?.data).toEqual({ text: "hello there" });
    expect(thinking?.data).toEqual({ text: "considering" });
    expect(assistant?.data).toEqual({ text: "Hello from mock" });
    // host-assigned, monotonic order starting from the injected counter
    expect(user!.order).toBe(10);
    expect(thinking!.order).toBeGreaterThan(user!.order);
    expect(assistant!.order).toBeGreaterThan(thinking!.order);
    expect(s.nextOrder).toBe(13);
    expect(items.every((i) => i.sessionId === "ses_test1")).toBe(true);

    // stream deltas reassemble to the final texts and reference the final item ids
    const streams = rec.of("stream");
    const text = streams
      .filter((d) => d.kind === "text")
      .map((d) => d.delta)
      .join("");
    expect(text).toBe("Hello from mock");
    expect(streams.find((d) => d.kind === "text").itemId).toBe(assistant!.id);
    expect(streams.find((d) => d.kind === "thinking").itemId).toBe(thinking!.id);

    // runtime: starting -> idle -> running -> idle
    expect(rec.of("runtime").map((r) => r.runtime)).toEqual(["idle", "running", "idle"]);

    // raw Pi events are exposed for adapters
    const types = rec.of("pi_event").map((e) => e.type);
    expect(types).toContain("agent_start");
    expect(types).toContain("message_end");
    expect(types).toContain("agent_settled");

    // Pi persisted the session file at the native handle's path
    expect(existsSync(native.sessionFile)).toBe(true);
    const header = JSON.parse(readFileSync(native.sessionFile, "utf8").split("\n")[0]!);
    expect(header).toMatchObject({ type: "session", id: native.sessionId });

    const stats = await s.stats();
    expect(stats.tokens).toBeGreaterThan(0);
    expect(stats.costUsd).toBeGreaterThan(0);

    // a second prompt while running is rejected with a clear message
    h.mock.setScript([{ when: when.always(), reply: { text: "slow", delayMs: 1500 } }]);
    await s.prompt("again");
    await expect(s.prompt("third")).rejects.toMatchObject({
      code: "invalid_request",
      message: "Session is running: choose Steer or Queue follow-up",
    });
    const queued = await s.prompt("after this", [], "followUp");
    expect(queued).toBe("queued");
    await waitFor(s, "settled", undefined, 20000);
    expect(rec.of("queue").some((q) => q.followUp.includes("after this"))).toBe(true);
    expect(s.queue).toEqual({ steering: [], followUp: [] });

    await s.stop();
    expect(s.runtime).toBe("stopped");
    expect(s.nativeHandle).toEqual(native);
  });

  it("creates a new native session with the requested --session-id", async () => {
    const uuid = randomUUID();
    const s = h.newSession({ newNativeSessionId: uuid });
    expect(s.buildArgs().slice(0, 2)).toEqual(["--session-id", uuid]);
    await s.start();
    expect(s.nativeHandle?.sessionId).toBe(uuid);
    expect(s.nativeHandle?.sessionFile).toContain(uuid);
    expect(s.nativeHandle?.sessionFile.startsWith(h.env.sessionsDir)).toBe(true);
    await s.stop();
  });
});
