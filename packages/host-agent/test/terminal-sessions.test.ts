import { terminalSupport } from "@switchyard/pi-runtime";
import type { HostEvent } from "@switchyard/protocol";
import { skipRealPi, when } from "@switchyard/test-fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NO_TERMINAL } from "../src/index.js";
import { type HostHarness, startCommand, startHarness, waitFor } from "./helpers.js";

let n = 0;
const sid = () => `ses_term${Date.now()}${++n}`;

const isSettled =
  (sessionId: string, after = 0) =>
  (e: HostEvent) =>
    e.type === "session.updated" &&
    e.sessionId === sessionId &&
    (e.data as any).settled != null &&
    Date.parse(e.at) >= after;

describe.skipIf(skipRealPi || !terminalSupport().ok)("terminal sessions on the host", () => {
  let h: HostHarness;
  beforeAll(async () => {
    h = await startHarness({
      terminalSessions: true,
      script: [{ when: when.userSays("hello"), reply: { text: "hi" } }],
    });
  });
  afterAll(async () => {
    await h?.dispose();
  });

  it("runs a terminal session, survives an agent restart, and relays its terminal", async () => {
    expect(h.agent.terminalSessions).toBe(true);
    expect(h.coord.hellos.at(-1)?.capabilities?.terminal).toBe(true);
    const id = sid();
    await h.coord.ok(startCommand(id, h.pi!.cwd, { initialPrompt: "hello" }));
    await h.coord.waitEvent(isSettled(id), 30000, "settled");
    const updated = h.coord
      .eventsOf("session.updated", id)
      .map((e) => e.data as any)
      .at(-1);
    expect(updated).toMatchObject({ runtime: "idle", terminal: true });

    // Slash commands from a client run in the terminal session.
    const hi = await h.coord.ok<{ disposition: string }>({
      type: "session.prompt",
      sessionId: id,
      text: "/fixture-hello hi",
      images: [],
      mode: "prompt",
      origin: "human",
      controlRevision: 1,
    });
    expect(hi.disposition).toBe("handled");
    await h.coord.waitUntil(
      () =>
        h.coord
          .eventsOf("transcript.item", id)
          .some(
            (e) =>
              (e.data as any).kind === "notice" && (e.data as any).data.text === "fixture hello hi",
          ),
      10000,
      "fixture hello notice",
    );

    // The relay paints the terminal for a viewer.
    h.coord.sendTerm("trm_1", { t: "open", sessionId: id, cols: 100, rows: 30 });
    await h.coord.waitUntil(
      () => h.coord.term.some((f) => f.streamId === "trm_1" && f.msg.t === "out"),
      10000,
      "terminal output",
    );
    h.coord.sendTerm("trm_1", { t: "close" });

    // Opening a session that has no terminal says so.
    h.coord.sendTerm("trm_2", { t: "open", sessionId: "ses_nope", cols: 80, rows: 24 });
    await h.coord.waitUntil(
      () => h.coord.term.some((f) => f.streamId === "trm_2" && f.msg.t === "closed"),
      5000,
      "closed",
    );
    expect(h.coord.term.find((f) => f.streamId === "trm_2")?.msg).toEqual({
      t: "closed",
      reason: NO_TERMINAL,
    });

    // A graceful agent stop detaches; the next agent reattaches instead of interrupting.
    await h.agent.stop();
    const hellos = h.coord.hellos.length;
    const agent2 = await h.restartAgent();
    expect(agent2.interruptedOnStart).toEqual([]);
    expect(agent2.supervisor.isLive(id)).toBe(true);
    expect(agent2.supervisor.record(id)?.runtime).toBe("idle");
    await waitFor(() => h.coord.hellos.length > hellos, 10000, "second hello");
    const t0 = Date.now();
    await h.coord.ok({
      type: "session.prompt",
      sessionId: id,
      text: "hello again",
      images: [],
      mode: "prompt",
      origin: "human",
      controlRevision: 1,
    });
    await h.coord.waitEvent(isSettled(id, t0), 30000, "settled after reattach");

    // Stopping the session ends its terminal.
    await h.coord.ok({ type: "session.stop", sessionId: id });
    await waitFor(() => agent2.supervisor.record(id)?.terminal == null, 10000, "terminal cleared");
    expect(agent2.supervisor.record(id)?.runtime).toBe("stopped");
  });
});
