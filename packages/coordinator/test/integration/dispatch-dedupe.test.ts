import type { Run } from "@switchyard/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Integration, steps, waitFor, worktreePaths } from "./harness.js";

/**
 * Spec §19: dispatch deduplication after a lost acknowledgment. The host stores the receipt of
 * the first `dispatch.start` but the test hook drops it on the wire.
 */
describe("dispatch dedupe after a lost receipt", { timeout: 180_000 }, () => {
  let env: Integration;
  /** Run states seen per run id, in order. */
  const seen = new Map<string, Run["state"][]>();

  beforeAll(async () => {
    env = await Integration.create({
      coordinator: {
        // A lost receipt times out quickly (Pi starts well within this in tests).
        dispatcher: { tickMs: 100, startTimeoutMs: 8000, reconcileEveryMs: 600_000 },
      },
    });
    env.c.events.on("run.changed", (r) => {
      const list = seen.get(r.id) ?? [];
      if (list.at(-1) !== r.state) list.push(r.state);
      seen.set(r.id, list);
    });
  });
  afterAll(async () => {
    await env?.dispose();
  });

  async function finish(taskId: string, sessionId: string) {
    const q = await env.pendingInteraction(sessionId);
    await env.ok("POST", `/api/interactions/${q.id}/answer`, {
      body: { revision: q.revision, response: { kind: "form", values: { value: "Apple" } } },
    });
    await env.waitTaskState(taskId, "review");
  }

  /** The coordinator still awaits a receipt for this command (it would re-send it on reconnect). */
  const awaitingReceipt = (commandId: string) =>
    (env.c.hostHub as unknown as { pending: Map<string, unknown> }).pending.has(commandId);

  it("receipt lost -> uncertain -> reconnect -> dispatch.reconcile adopts the same session", async () => {
    let dropped: string | null = null;
    env.hooks.dropReceipt = (commandId, cmd) => {
      if (cmd.type === "dispatch.start" && dropped === null) {
        dropped = commandId;
        // The link goes down together with the lost receipt and stays down for now.
        void env.agent!.link.stop();
        return true;
      }
      return false;
    };
    const task = await env.createTask("admin", {
      title: "Lost receipt",
      objective: steps("select", "done"),
      state: "ready",
    });
    const run0 = await env.waitRun(task.id, (r) => r.state !== "queued", "dispatching");
    expect(run0.state === "dispatching" || run0.state === "uncertain").toBe(true);
    await waitFor(() => dropped !== null, "receipt dropped");
    expect(dropped).toBe(`cmd_${run0.dispatchKey}`);
    // The host is gone without a receipt: the launch is uncertain (Pi already runs on the host).
    const uncertain = await env.waitRun(task.id, (r) => r.state === "uncertain", "uncertain");
    expect(uncertain.id).toBe(run0.id);
    // Once the receipt wait times out there is nothing left to re-send on reconnect.
    await waitFor(() => !awaitingReceipt(dropped!), "receipt wait timed out", 30_000);
    expect(env.run(task.id)!.state).toBe("uncertain");
    expect(env.commandsOf("dispatch.reconcile")).toHaveLength(0);

    // Reconnect the host link: the coordinator reconciles by dispatch key.
    env.agent!.link.start();
    await env.waitHostConnected();
    const adopted = await env.waitRun(
      task.id,
      (r) => r.state === "running" || r.state === "waiting_input",
      "adopted",
    );
    const reconciles = env.commandsOf("dispatch.reconcile");
    expect(reconciles.length).toBeGreaterThanOrEqual(1);
    expect(reconciles.every((c) => c.dispatchKey === run0.dispatchKey)).toBe(true);
    expect(adopted.id).toBe(run0.id);
    expect(adopted.sessionId).toBe(run0.sessionId);
    const states = seen.get(run0.id)!;
    expect(states.slice(0, 2)).toEqual(["dispatching", "uncertain"]);
    expect(states.indexOf("uncertain")).toBeLessThan(
      Math.max(states.indexOf("running"), states.indexOf("waiting_input")),
    );

    // Exactly one dispatch.start was ever sent for this key, one Pi process, one worktree.
    const starts = env
      .commandsOf("dispatch.start")
      .filter((c) => c.dispatchKey === run0.dispatchKey);
    expect(starts).toHaveLength(1);
    expect(env.agent!.spawnedPiProcesses).toBe(1);
    const session = env.session(run0.sessionId!);
    expect(session.nativeHandle).not.toBeNull();
    const trees = worktreePaths(env.repo!.path).filter((p) => p !== env.repo!.path);
    expect(trees).toHaveLength(1);
    expect(session.cwd).toBe(trees[0]);
    expect(trees[0]!.startsWith(`${env.repo!.path}/.worktrees/`)).toBe(true);
    const managed = env.c.store.workspaces
      .list("project_id = ?", [env.project.id])
      .filter((w) => w.provenance === "managed");
    expect(managed.map((w) => w.path)).toEqual(trees);

    await finish(task.id, session.id);
    expect(env.agent!.spawnedPiProcesses).toBe(1);
  });

  it("receipt lost, link drops at once: the resent command gets the stored receipt", async () => {
    let dropped: string | null = null;
    let linkStopped: Promise<void> | undefined;
    env.hooks.dropReceipt = (commandId, cmd) => {
      if (cmd.type === "dispatch.start" && dropped === null) {
        dropped = commandId;
        // Hold reconnect until the coordinator observes the disconnect: a fast replacement can
        // arrive before the old socket's close event and legitimately skip the uncertain state.
        linkStopped = env.agent!.link.stop();
        return true;
      }
      return false;
    };
    const processesBefore = env.agent!.spawnedPiProcesses;
    const treesBefore = worktreePaths(env.repo!.path).length;
    const task = await env.createTask("admin", {
      title: "Lost receipt then disconnect",
      objective: steps("select", "done"),
      state: "ready",
    });
    const run0 = await env.waitRun(task.id, (r) => r.state !== "queued", "dispatching");
    await waitFor(() => dropped !== null, "receipt dropped");
    // The disconnect makes the launch uncertain right away.
    await waitFor(() => (seen.get(run0.id) ?? []).includes("uncertain"), "uncertain");
    await linkStopped;
    // Reconnect before the receipt deadline, unlike the reconciliation case above.
    expect(awaitingReceipt(dropped!)).toBe(true);
    env.agent!.link.start();
    await env.waitHostConnected();
    const adopted = await env.waitRun(
      task.id,
      (r) => r.state === "running" || r.state === "waiting_input",
      "adopted",
    );
    expect(adopted.id).toBe(run0.id);
    expect(adopted.sessionId).toBe(run0.sessionId);

    // The pending command is replayed with the same commandId and answered from its receipt.
    const log = env.agent!.router.commandLog.filter((e) => e.commandId === dropped);
    expect(log.length).toBeGreaterThanOrEqual(2);
    expect(log[0]!.outcome).toBe("ok");
    for (const dup of log.slice(1)) expect(dup.outcome).toBe("duplicate");
    const starts = env
      .commandsOf("dispatch.start")
      .filter((c) => c.dispatchKey === run0.dispatchKey);
    expect(starts.length).toBe(log.length);
    expect(env.agent!.spawnedPiProcesses).toBe(processesBefore + 1);
    expect(worktreePaths(env.repo!.path)).toHaveLength(treesBefore + 1);

    await finish(task.id, run0.sessionId!);
    expect(env.agent!.spawnedPiProcesses).toBe(processesBefore + 1);
  });
});
