// @module-tag slow
import { existsSync } from "node:fs";
import type { TranscriptItem } from "@switchyard/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RESTART_NOTICE } from "../src/index.js";
import { type HostHarness, startCommand, startHarness, waitFor } from "./helpers.js";
import { isSettled, script, sid, startSession } from "./sessions-helpers.js";

async function stopWithoutRecordingPiExit(h: HostHarness, id: string): Promise<void> {
  // Simulate a crash by hiding Pi's exit from the supervisor, leaving the persisted runtime stale.
  const ms = h.agent.supervisor.managedSession(id)!;
  ms.removeAllListeners();
  await h.agent.link.stop();
  await ms.stop({ graceMs: 500, termMs: 500 });
  // Finish shutting down the in-process agent while the broker can still write to the database.
  await h.agent.stop();
}

describe("host agent restart", () => {
  let h: HostHarness;
  beforeAll(async () => {
    h = await startHarness({ script });
  });
  afterAll(async () => {
    await h?.dispose();
  });

  it("an idle session the agent lost becomes stopped without a notice; resume keeps identity", async () => {
    const id = sid();
    const started = await startSession(h, id, h.pi!.cwd, { initialPrompt: "hello" });
    await h.coord.waitEvent(isSettled(id), 30000, "settled");
    expect(h.agent.supervisor.record(id)?.runtime).toBe("idle");

    await stopWithoutRecordingPiExit(h, id);

    const hellos = h.coord.hellos.length;
    const mark = h.coord.events.length;
    const agent2 = await h.restartAgent();
    expect(agent2.interruptedOnStart).toEqual([]);
    expect(agent2.stoppedOnStart).toEqual([id]);
    await waitFor(() => h.coord.hellos.length > hellos, 10000, "second hello");
    await h.coord.waitUntil(
      () =>
        h.coord.events
          .slice(mark)
          .some(
            (e) =>
              e.event.type === "session.updated" && (e.event.data as any).runtime === "stopped",
          ),
      10000,
      "stopped",
    );
    const after = h.coord.events.slice(mark).map((e) => e.event);
    const updated = after.find(
      (e) => e.type === "session.updated" && (e.data as any).runtime === "stopped",
    )!.data as any;
    expect(updated).toMatchObject({
      id,
      runtime: "stopped",
      runtimeDetail: null,
      nativeHandle: started.nativeHandle,
    });
    expect(
      after.some((e) => e.type === "transcript.item" && (e.data as any).kind === "notice"),
    ).toBe(false);
    expect(agent2.spawnedPiProcesses).toBe(0);

    // Resume with the same native session.
    expect(existsSync(started.nativeHandle.sessionFile)).toBe(true);
    const resumed = await h.coord.ok(
      startCommand(id, h.pi!.cwd, { nativeHandle: started.nativeHandle, initialPrompt: "again" }),
    );
    expect(resumed.nativeHandle).toEqual(started.nativeHandle);
    expect(agent2.spawnedPiProcesses).toBe(1);
    await waitFor(
      () => h.coord.events.slice(mark).filter((e) => isSettled(id)(e.event)).length > 0,
      30000,
      "resumed settle",
    );
    await agent2.stop();
    expect(agent2.supervisor.record(id)?.runtime).toBe("stopped");
  });

  describe("while Pi was working", () => {
    let w: HostHarness;
    beforeAll(async () => {
      w = await startHarness({ script });
    });
    afterAll(async () => {
      await w?.dispose();
    });

    it("a session working when the agent died becomes interrupted with the working notice", async () => {
      const id = sid();
      await startSession(w, id, w.pi!.cwd);
      await w.coord.ok({
        type: "session.prompt",
        sessionId: id,
        text: "work slowly",
        images: [],
        mode: "prompt",
        origin: "human",
        controlRevision: 1,
      });
      await waitFor(() => w.agent.supervisor.record(id)?.runtime === "running", 30000, "running");

      await stopWithoutRecordingPiExit(w, id);

      const mark = w.coord.events.length;
      const agent2 = await w.restartAgent();
      expect(agent2.interruptedOnStart).toEqual([id]);
      expect(agent2.stoppedOnStart).toEqual([]);
      expect(agent2.supervisor.record(id)).toMatchObject({
        runtime: "interrupted",
        runtimeDetail: "Host agent restarted",
      });
      await w.coord.waitUntil(
        () =>
          w.coord.events
            .slice(mark)
            .some(
              (e) => e.event.type === "transcript.item" && (e.event.data as any).kind === "notice",
            ),
        10000,
        "notice",
      );
      const notice = w.coord.events
        .slice(mark)
        .map((e) => e.event)
        .find((e) => e.type === "transcript.item" && (e.data as any).kind === "notice")!
        .data as TranscriptItem;
      expect(notice).toMatchObject({ data: { level: "warning", text: RESTART_NOTICE } });
      await agent2.stop();
    });
  });
});
