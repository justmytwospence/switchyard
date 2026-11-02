import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Integration, steps, waitFor } from "./harness.js";

/** Spec §19: coordinator restart during execution. */
describe("coordinator restart mid-run", { timeout: 180_000 }, () => {
  let env: Integration;
  beforeAll(async () => {
    env = await Integration.create();
  });
  afterAll(async () => {
    await env?.dispose();
  });

  it("the host keeps running, replays its outbox, and the run completes into Review once", async () => {
    const task = await env.createTask("admin", {
      title: "Slow work",
      objective: steps("slow:3000", "done"),
      state: "ready",
    });
    const run = await env.waitRun(task.id, (r) => r.state === "running", "running");
    const sid = run.sessionId!;
    // Wait until the slow tool is executing on the host, then stop the coordinator.
    await waitFor(
      () =>
        env.c.store
          .listItems(sid, { limit: 1000 })
          .items.some(
            (i) => i.kind === "tool" && (i.data as { name: string }).name === "fixture_slow",
          ),
      "fixture_slow started",
    );
    expect(env.hostSettles(sid)).toBe(0);
    await env.stopCoordinator();

    // 2. The host keeps executing: Pi finishes and settles while the coordinator is down.
    await waitFor(() => !env.agent!.link.connected, "link down", 10_000);
    await waitFor(() => env.hostSettles(sid) > 0, "settle recorded in the host outbox", 30_000);
    const unacked = env.agent!.link.pending().length;
    expect(unacked).toBeGreaterThan(0);
    expect(env.agent!.spawnedPiProcesses).toBe(1);

    // 3. Restart on the same data dir and port; the host reconnects and replays.
    await env.restartCoordinator();
    await env.waitHostConnected();
    await env.waitTaskState(task.id, "review");
    await waitFor(() => env.agent!.link.pending().length === 0, "outbox acked");

    // 4. Review exactly once; one dispatch.start for the key; one Pi process; one run.
    const runs = env.c.store.runs.list("task_id = ?", [task.id]);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.id).toBe(run.id);
    expect(runs[0]!.state).toBe("succeeded");
    const starts = env.commandsOf("dispatch.start");
    expect(starts.filter((c) => c.dispatchKey === run.dispatchKey)).toHaveLength(1);
    expect(starts).toHaveLength(1);
    expect(env.agent!.spawnedPiProcesses).toBe(1);
    const reviews = env.c.store
      .eventsAfter(0, 100_000)
      .filter(
        (e) =>
          e.type === "task.updated" &&
          (e.data as { id: string; state: string }).id === task.id &&
          (e.data as { state: string }).state === "review",
      );
    // One transition into Review (later task.updated events in Review are allowed, not re-entries).
    const states = env.c.store
      .eventsAfter(0, 100_000)
      .filter((e) => e.type === "task.updated" && (e.data as { id: string }).id === task.id)
      .map((e) => (e.data as { state: string }).state);
    const entries = states.filter((s, i) => s === "review" && states[i - 1] !== "review");
    expect(entries).toHaveLength(1);
    expect(reviews.length).toBeGreaterThanOrEqual(1);
    const ready = env.c.store.attention.list("task_id = ? AND reason = 'ready_for_review'", [
      task.id,
    ]);
    expect(ready).toHaveLength(1);

    // A second restart replays nothing new and changes nothing.
    await env.restartCoordinator();
    await env.waitHostConnected();
    expect(env.task(task.id).state).toBe("review");
    expect(env.c.store.runs.list("task_id = ?", [task.id])).toHaveLength(1);
    expect(env.commandsOf("dispatch.start")).toHaveLength(1);
  });
});
