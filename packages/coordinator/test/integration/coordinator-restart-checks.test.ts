import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Integration, steps, tempDir, waitFor } from "./harness.js";

/**
 * A coordinator restart while acceptance checks run on the host: the recovery sweep re-sends
 * `checks.run` with the same command id, the host joins (or returns) the original run instead of
 * running the checks again, and the task reaches Review once.
 */
describe("coordinator restart while checking", { timeout: 180_000 }, () => {
  const marks = tempDir("sy-int-checks-");
  const counter = join(marks, "runs.txt");
  let env: Integration;
  beforeAll(async () => {
    env = await Integration.create({
      project: { checks: [`echo run >> '${counter}'; sleep 3`] },
    });
  });
  afterAll(async () => {
    await env?.dispose();
    rmSync(marks, { recursive: true, force: true });
  });

  it("re-sends checks with a deterministic id and completes into Review", async () => {
    const task = await env.createTask("admin", {
      title: "Checked work",
      objective: steps("done"),
      state: "ready",
    });
    const run = await env.waitRun(task.id, (r) => r.state === "checking", "checking");
    await waitFor(() => existsSync(counter), "checks started on the host");
    await env.stopCoordinator();
    await env.restartCoordinator();
    await env.waitHostConnected();
    await env.waitTaskState(task.id, "review");

    const final = env.c.store.runs.require(run.id);
    expect(final.state).toBe("succeeded");
    expect(final.checks).toHaveLength(1);
    expect(final.checks[0]!.exitCode).toBe(0);
    // The checks ran exactly once on the host; the resend carried the same command id.
    expect(readFileSync(counter, "utf8").trim().split("\n")).toEqual(["run"]);
    const checkCmds = env.agent!.router.commandLog.filter((e) => e.type === "checks.run");
    expect(checkCmds.length).toBeGreaterThanOrEqual(2);
    expect(new Set(checkCmds.map((e) => e.commandId)).size).toBe(1);
    expect(checkCmds[0]!.commandId).toMatch(new RegExp(`^chk_${run.id}_`));
    expect(env.c.store.runs.list("task_id = ?", [task.id])).toHaveLength(1);
  });
});
