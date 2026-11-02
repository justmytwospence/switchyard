import type { StreamDelta, TranscriptItem } from "@switchyard/protocol";
import { when } from "@switchyard/test-fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ManagedSession } from "../src/index.js";
import { type PiHarness, setupPi, skipRealPi, waitFor } from "./helpers.js";

const EVENTS = ["item", "stream", "runtime", "settled", "queue", "ui_request", "bridge"] as const;

/** A client view fed by the host fan-out: durable items plus live partial text. */
function attachClient(session: ManagedSession) {
  const log: string[] = [];
  const items = new Map<string, TranscriptItem>();
  const partial = new Map<string, string>();
  const snap = session.snapshot();
  for (const p of snap.partial) partial.set(p.itemId, p.text);
  for (const event of EVENTS) {
    session.on(event, (value: any) => {
      log.push(
        `${event}:${JSON.stringify(value, (k, v) => (k === "at" || k === "seq" ? undefined : v))}`,
      );
      if (event === "item") items.set(value.id, value);
      if (event === "stream") {
        const d = value as StreamDelta;
        partial.set(d.itemId, (partial.get(d.itemId) ?? "") + d.delta);
      }
    });
  }
  return { log, items, partial, snap };
}

describe.skipIf(skipRealPi)("gate: reconnect (shared session fan-out)", () => {
  let h: PiHarness;
  const long = "The quick brown fox jumps over the lazy dog. ".repeat(6).trim();
  beforeAll(async () => {
    h = await setupPi([
      { when: when.userSays("stream"), reply: { text: long, chunkDelayMs: 150 } },
      {
        when: when.userSays("pick"),
        reply: { toolCalls: [{ name: "fixture_select", arguments: {} }] },
      },
    ]);
  });
  afterAll(async () => {
    await h?.dispose();
  });

  it("two listeners (terminal and web) receive the same sequence", async () => {
    const s = h.newSession();
    await s.start();
    const terminal = attachClient(s);
    const web = attachClient(s);

    const settled = waitFor(s, "settled");
    await s.prompt("stream something");
    await settled;
    const ask = waitFor(s, "ui_request", (r: any) => r.method === "select");
    const settled2 = waitFor(s, "settled");
    await s.prompt("pick one");
    const req: any = await ask;
    await s.respondUi(req.id, { value: "Apple" });
    await settled2;

    expect(terminal.log.length).toBeGreaterThan(10);
    expect(web.log).toEqual(terminal.log);
  });

  it("a client attaching mid-stream rebuilds the same message from snapshot plus deltas", async () => {
    const s = h.newSession();
    await s.start();
    const early = attachClient(s);
    const settled = waitFor(s, "settled");
    // attach the late client after a few deltas have streamed
    let late: ReturnType<typeof attachClient> | null = null;
    let deltas = 0;
    s.on("stream", () => {
      if (++deltas === 2 && !late) late = attachClient(s);
    });
    await s.prompt("stream please");
    await settled;

    expect(late).not.toBeNull();
    const lateClient = late as unknown as ReturnType<typeof attachClient>;
    expect(lateClient.snap.partial.length).toBe(1);
    expect(lateClient.snap.partial[0]!.text.length).toBeGreaterThan(0);
    expect(lateClient.snap.runtime).toBe("running");

    const final = [...early.items.values()].find((i) => i.kind === "assistant")!;
    expect(final.data).toMatchObject({ text: long });
    // live view reconstructed by the late client matches the durable item
    expect(lateClient.partial.get(final.id)).toBe(long);
    expect(lateClient.items.get(final.id)).toEqual(final);
    // everything the late client saw is the tail of what the early client saw
    expect(early.log.slice(early.log.length - lateClient.log.length)).toEqual(lateClient.log);
  });
});
