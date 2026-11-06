import { existsSync } from "node:fs";
import { terminalSupport } from "@switchyard/pi-runtime";
import type { HostEvent } from "@switchyard/protocol";
import { skipRealPi, when } from "@switchyard/test-fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NO_TERMINAL } from "../src/index.js";
import { type HostHarness, slowPi, startCommand, startHarness, waitFor } from "./helpers.js";

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
    // The reattached extension announced itself again: dialogs stay answerable remotely.
    expect(agent2.supervisor.managedSession(id)?.remoteDialogs).toBe(true);
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

  it("stamps user items with entry ids and rebuilds the transcript on navigate", async () => {
    const id = sid();
    await h.coord.ok(startCommand(id, h.pi!.cwd, { initialPrompt: "hello" }));
    await h.coord.waitEvent(isSettled(id), 30000, "settled");
    const userItems = () =>
      h.coord
        .eventsOf("transcript.item", id)
        .map((e) => e.data as any)
        .filter((d) => d.kind === "user");
    await h.coord.waitUntil(
      () => userItems().some((d) => typeof d.data.entryId === "string"),
      10000,
      "entry id on the user item",
    );
    const entryId = userItems().find((d) => d.data.entryId).data.entryId as string;
    const r = await h.coord.ok<{ items: any[]; prefill: string | null }>({
      type: "session.navigate",
      sessionId: id,
      entryId,
      summarize: false,
      instructions: null,
    });
    expect(r.prefill).toBe("hello");
    // The branch before the first message is empty; orders continue after the live counter.
    expect(r.items.every((i) => i.sessionId === id)).toBe(true);
    await h.coord.ok({ type: "session.stop", sessionId: id });
  });
});

describe.skipIf(skipRealPi || !terminalSupport().ok)("terminal sessions still starting", () => {
  it("a terminal session still starting when the agent stops keeps its socket and finishes starting under the next agent", async () => {
    const slow = slowPi(4);
    const h = await startHarness({
      terminalSessions: true,
      piBin: slow.path,
      script: [{ when: when.userSays("hello"), reply: { text: "hi" } }],
    });
    try {
      const id = sid();
      const started = h.coord.command(startCommand(id, h.pi!.cwd)).catch(() => null);
      await waitFor(
        () => {
          const rec = h.agent.supervisor.record(id);
          return rec?.terminal != null && rec.runtime === "starting";
        },
        15000,
        "starting with a socket",
      );
      await h.agent.stop();
      await started;
      const agent2 = await h.restartAgent();
      expect(agent2.supervisor.record(id)?.runtime).toBe("starting");
      expect(agent2.supervisor.record(id)?.terminal).not.toBeNull();
      await waitFor(() => agent2.supervisor.record(id)?.runtime === "idle", 30000, "idle");
      await h.coord.ok({ type: "session.stop", sessionId: id });
      await waitFor(() => agent2.supervisor.record(id)?.runtime === "stopped", 10000, "stopped");
    } finally {
      await h.dispose();
      slow.cleanup();
    }
  });

  it("session.stop during a slow terminal start kills its holder and ends stopped", async () => {
    const slow = slowPi(20);
    const h = await startHarness({ terminalSessions: true, piBin: slow.path });
    try {
      const id = sid();
      const started = h.coord.command(startCommand(id, h.pi!.cwd));
      await waitFor(() => h.agent.supervisor.record(id)?.runtime === "starting", 15000, "starting");
      const socketPath = h.agent.supervisor.record(id)?.terminal?.socketPath;
      const t0 = Date.now();
      await h.coord.ok({ type: "session.stop", sessionId: id });
      expect(Date.now() - t0).toBeLessThan(8000);
      expect(h.agent.supervisor.record(id)).toMatchObject({ runtime: "stopped", terminal: null });
      expect(await started).toMatchObject({ ok: true, result: { runtime: "stopped" } });
      if (socketPath) await waitFor(() => !existsSync(socketPath), 10000, "holder gone");
    } finally {
      await h.dispose();
      slow.cleanup();
    }
  });
});
