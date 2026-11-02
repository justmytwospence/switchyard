import type { Occurrence, Task } from "@switchyard/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getService, nextOccurrences } from "../../src/index.js";
import { Integration, steps, waitFor, waitForValue } from "./harness.js";

/**
 * Scheduler end to end. The fake-clock unit tests (`test/scheduler.test.ts`) cover DST, missed
 * policies, overlap and restarts against a fake host; here the coordinator clock is shifted and
 * the occurrences flow into real dispatches on a real host with real Pi.
 */
describe("scheduler into real dispatch", { timeout: 180_000 }, () => {
  let env: Integration;
  beforeAll(async () => {
    env = await Integration.create();
  });
  afterAll(async () => {
    await env?.dispose();
  });

  const tick = () => getService(env.c.ctx, "scheduler")!.tick();
  const history = async (id: string): Promise<Occurrence[]> =>
    env.ok("GET", `/api/automations/${id}/history`);

  async function automation(name: string, trigger: unknown) {
    return env.ok("POST", "/api/automations", {
      body: {
        name,
        projectId: env.project.id,
        trigger,
        template: { title: name, objective: steps("done"), acceptanceCriteria: [], priority: 2 },
      },
    });
  }

  /** The fired occurrence's task runs on the host and lands in Review. */
  async function runsToReview(occ: Occurrence): Promise<Task> {
    expect(occ.state).toBe("fired");
    const task = env.task(occ.taskId!);
    expect(task.origin).toMatchObject({ kind: "automation" });
    const done = await env.waitTaskState(task.id, "review");
    const run = env.run(task.id)!;
    expect(run.state).toBe("succeeded");
    expect(env.session(run.sessionId!).cwd.startsWith(`${env.repo!.path}/.worktrees/`)).toBe(true);
    return done;
  }

  let onceTask: Task;

  it("a once trigger fires at its time and dispatches a real run", async () => {
    const at = new Date(env.c.store.now().getTime() + 60_000).toISOString();
    const a = await automation("Once job", { kind: "once", at });
    tick();
    expect(await history(a.id)).toEqual([]);
    env.clockOffsetMs += 90_000;
    tick();
    const [occ] = await history(a.id);
    expect(occ).toMatchObject({ key: at, scheduledFor: at, state: "fired" });
    onceTask = await runsToReview(occ!);
    tick();
    expect(await history(a.id)).toHaveLength(1);
  });

  it("a cron trigger fires at local 09:00 America/Denver", async () => {
    const trigger = { kind: "cron", expr: "0 9 * * *", timezone: "America/Denver" };
    const a = await automation("Morning job", trigger);
    const next = new Date(nextOccurrences(trigger as never, env.c.store.now(), 1)[0]!);
    env.clockOffsetMs += next.getTime() - env.c.store.now().getTime() + 30_000;
    tick();
    const [occ] = await history(a.id);
    expect(occ!.scheduledFor).toBe(next.toISOString());
    const local = new Intl.DateTimeFormat("en-GB", {
      timeZone: "America/Denver",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(occ!.scheduledFor!));
    expect(local).toBe("09:00");
    await runsToReview(occ!);

    // A coordinator restart re-evaluates the same window without firing it again.
    await env.restartCoordinator();
    await env.waitHostConnected();
    tick();
    expect(await history(a.id)).toHaveLength(1);
    expect(env.commandsOf("dispatch.start")).toHaveLength(2);
  });

  it("a dependency trigger fires when its task is done; a dependency cycle is rejected", async () => {
    const a = await automation("After once", { kind: "dependency", taskId: onceTask.id });
    expect(await history(a.id)).toEqual([]);
    await env.ok("POST", `/api/tasks/${onceTask.id}/accept`, { body: { confirm: true } });
    const occ = await waitForValue(async () => (await history(a.id))[0], "dependency fired");
    await runsToReview(occ);
    await waitFor(() => env.commandsOf("dispatch.start").length === 3, "third dispatch");

    const t1 = await env.createTask("admin", { title: "A", objective: "a" });
    const t2 = await env.createTask("admin", { title: "B", objective: "b", dependencies: [t1.id] });
    const cyc = await env.api("PATCH", `/api/tasks/${t1.id}`, { body: { dependencies: [t2.id] } });
    expect(cyc.status).toBe(400);
    expect(cyc.body.error.code).toBe("dependency_cycle");
  });
});
