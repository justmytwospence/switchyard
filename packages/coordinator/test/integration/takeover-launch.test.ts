import type { Run } from "@switchyard/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Integration, sleep, steps, waitFor } from "./harness.js";

/**
 * A person takes over while the launch is still unconfirmed (the host is running the worktree
 * setup command, or the receipt was lost). The host must never accept the automated launch
 * prompt afterwards, and the run is adopted under human control.
 */
describe("takeover during an unconfirmed launch", { timeout: 180_000 }, () => {
  let env: Integration;
  beforeAll(async () => {
    env = await Integration.create({
      coordinator: {
        dispatcher: {
          tickMs: 100,
          reconcileEveryMs: 300,
          retryBackoffMs: 1000,
          startTimeoutMs: 500,
        },
      },
      project: { maxConcurrentRuns: 3 },
    });
    await env.ok("PATCH", `/api/projects/${env.project.id}`, {
      body: { setupCommand: "sleep 3" },
    });
  });
  afterAll(async () => {
    await env?.dispose();
  });

  const userItems = (sessionId: string) =>
    env.c.store.listItems(sessionId, { limit: 1000 }).items.filter((i) => i.kind === "user");

  async function takeoverDuringSetup(title: string): Promise<Run> {
    const requestsBefore = env.mock!.requests.length;
    const task = await env.createTask("admin", {
      title,
      objective: steps("done"),
      state: "ready",
    });
    await waitFor(
      () => env.commandsOf("dispatch.start").some((c) => c.taskId === task.id),
      "launch",
    );
    const run = env.run(task.id)!;
    expect(["dispatching", "uncertain"]).toContain(run.state);
    const r = await env.ok("POST", `/api/sessions/${run.sessionId}/takeover`, {
      as: env.devices!.terminal,
    });
    expect(r.run).toMatchObject({ controlMode: "human" });
    const adopted = await env.waitRun(task.id, (x) => x.state === "running", "adopted", 60_000);
    expect(adopted.controlMode).toBe("human");
    await waitFor(() => env.agent!.supervisor.isLive(run.sessionId!), "Pi live");
    await sleep(500);
    // Pi started, but the automated launch prompt never reached it.
    expect(env.agent!.supervisor.controlOf(run.sessionId!)).toEqual({
      controlRevision: r.run.controlRevision,
      controlMode: "human",
    });
    expect(userItems(run.sessionId!)).toEqual([]);
    expect(env.mock!.requests.length).toBe(requestsBefore);
    const automated = env.agent!.router.commandLog.filter(
      (e) => e.sessionId === run.sessionId && e.origin === "automation" && e.outcome === "ok",
    );
    expect(automated).toEqual([]);
    return adopted;
  }

  it("connected host: the takeover reaches the host before Pi starts", async () => {
    await takeoverDuringSetup("Taken over while dispatching");
  });

  it("lost receipt (uncertain): reconcile adopts it for the person, never prompting", async () => {
    env.hooks.dropReceipt = (_id, cmd) => cmd.type === "dispatch.start";
    try {
      const adopted = await takeoverDuringSetup("Taken over while uncertain");
      expect(env.commandsOf("dispatch.reconcile").some((c) => c.dispatchKey === adopted.id)).toBe(
        true,
      );
    } finally {
      env.hooks.dropReceipt = undefined;
    }
  });
});
