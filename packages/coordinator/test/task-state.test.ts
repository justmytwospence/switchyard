import { DEFAULT_TASK_POLICY, type Run, type Task } from "@switchyard/protocol";
import { describe, expect, it } from "vitest";
import {
  buildRunPrompt,
  defaultBranch,
  describeCron,
  detectCycle,
  move,
  parseMarker,
  TRANSITIONS,
} from "../src/index.js";

const now = new Date().toISOString();

function mkTask(over: Partial<Task> = {}): Task {
  return {
    id: "tsk_01ABCDEFGHJKMNPQRS",
    projectId: "prj_1",
    title: "Fix the login bug",
    objective: "Users cannot log in",
    acceptanceCriteria: ["Login works"],
    dependencies: [],
    priority: 2,
    position: 1,
    state: "backlog",
    blocked: null,
    notBefore: null,
    policy: DEFAULT_TASK_POLICY,
    origin: { kind: "manual" },
    groupingKey: null,
    currentRunId: null,
    sessionId: null,
    review: { feedback: [], changesRequested: false },
    hiddenFromBoard: false,
    lastActivityAt: now,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

function mkRun(over: Partial<Run> = {}): Run {
  return {
    id: "run_1",
    taskId: "tsk_1",
    sessionId: "ses_1",
    hostId: "hst_1",
    dispatchKey: "run_1",
    attempt: 1,
    state: "running",
    controlMode: "automation",
    controlRevision: 1,
    continuationsUsed: 0,
    infraRetries: 0,
    nextAttemptAt: null,
    startedAt: now,
    endedAt: null,
    outcome: null,
    limits: { enabled: false },
    usage: { tokens: null, costUsd: null, accounting: "unavailable", note: null },
    checks: [],
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

function reason(fn: () => unknown): { code: string; message: string } {
  try {
    fn();
  } catch (err) {
    return err as { code: string; message: string };
  }
  throw new Error("expected a throw");
}

describe("task state machine", () => {
  it("has the plan's transition table", () => {
    expect(TRANSITIONS).toEqual({
      backlog: ["ready", "canceled"],
      ready: ["backlog", "in_progress", "canceled"],
      in_progress: ["review", "ready", "backlog", "canceled", "done"],
      review: ["in_progress", "done", "ready", "canceled"],
      done: ["ready", "backlog"],
      canceled: ["backlog"],
    });
  });

  it("rejects invalid transitions with a concrete reason", () => {
    const e = reason(() => move(mkTask(), "done", { checks: [] }));
    expect(e.code).toBe("invalid_transition");
    expect(e.message).toBe("A Backlog task must be made Ready before it can move to Done");
    expect(reason(() => move(mkTask({ state: "canceled" }), "ready", { checks: [] })).message).toBe(
      "A canceled task can only be restored to Backlog, not Ready",
    );
    expect(
      reason(() => move(mkTask({ state: "ready" }), "in_progress", { checks: [] })).message,
    ).toMatch(/Run now/);
    expect(
      move(mkTask({ state: "ready" }), "in_progress", { checks: [], byDispatcher: true }).to,
    ).toBe("in_progress");
  });

  it("requires a pause/stop choice before moving running work backward", () => {
    const t = mkTask({ state: "in_progress", currentRunId: "run_1" });
    const e = reason(() => move(t, "backlog", { checks: [], run: mkRun() }));
    expect(e.message).toBe(
      "A running task cannot be moved to Backlog without choosing to pause automation or stop execution",
    );
    expect(move(t, "backlog", { checks: [], run: mkRun(), onRunning: "pause" }).runningAction).toBe(
      "pause",
    );
    expect(move(t, "ready", { checks: [], run: mkRun(), onRunning: "stop" }).runningAction).toBe(
      "stop",
    );
    // A blocked (interrupted) run is not running work.
    expect(
      move(t, "ready", { checks: [], run: mkRun({ state: "interrupted" }) }).runningAction,
    ).toBeNull();
  });

  it("needs confirmation for Done with unresolved review or checks", () => {
    const review = mkTask({ state: "review" });
    const e = reason(() => move(review, "done", { checks: [] }));
    expect(e.message).toMatch(/needs confirmation: Human review is required/);
    expect(move(review, "done", { checks: [], accepted: true }).to).toBe("done");
    expect(move(review, "done", { checks: [], confirm: true }).unresolved).toHaveLength(1);
    const failing = mkRun({
      state: "succeeded",
      checks: [{ command: "npm test", exitCode: 1, outputTail: "x" }],
    });
    expect(
      reason(() => move(review, "done", { checks: ["npm test"], accepted: true, run: failing }))
        .message,
    ).toMatch(/Checks failed: npm test/);
    expect(
      reason(() => move(review, "done", { checks: ["npm test"], accepted: true, run: mkRun() }))
        .message,
    ).toMatch(/Checks have not passed/);
    const passing = mkRun({
      state: "succeeded",
      checks: [{ command: "npm test", exitCode: 0, outputTail: "" }],
    });
    expect(move(review, "done", { checks: ["npm test"], accepted: true, run: passing }).to).toBe(
      "done",
    );
    // In progress -> Done always needs an explicit confirm.
    const ip = mkTask({ state: "in_progress" });
    expect(
      reason(() => move(ip, "done", { checks: [], run: mkRun({ state: "interrupted" }) })).message,
    ).toMatch(/needs confirmation/);
    expect(
      move(ip, "done", { checks: [], run: mkRun({ state: "interrupted" }), confirm: true }).to,
    ).toBe("done");
    expect(move(review, "in_progress", { checks: [] }).newAttempt).toBe(true);
  });

  it("detects dependency cycles and names their titles", () => {
    const tasks: Record<string, Pick<Task, "id" | "title" | "dependencies">> = {
      a: { id: "a", title: "Alpha", dependencies: ["b"] },
      b: { id: "b", title: "Beta", dependencies: ["c"] },
      c: { id: "c", title: "Gamma", dependencies: [] },
    };
    const lookup = (id: string) => tasks[id];
    expect(() => detectCycle("c", [], lookup)).not.toThrow();
    expect(() => detectCycle("d", ["a"], lookup, "Delta")).not.toThrow();
    const e = reason(() => detectCycle("c", ["a"], lookup));
    expect(e.code).toBe("dependency_cycle");
    expect(e.message).toBe("Dependency cycle: Gamma → Alpha → Beta → Gamma");
  });
});

describe("helpers", () => {
  it("derives the default branch from title and short id", () => {
    expect(defaultBranch({ id: "tsk_01HXYZABCDEF", title: "Fix: the Login bug!" })).toBe(
      "sy/fix-the-login-bug-abcdef",
    );
  });

  it("parses completion markers from the end of the message", () => {
    expect(parseMarker("all good\nSWITCHYARD: DONE")).toEqual({ kind: "done" });
    expect(parseMarker("x\n`SWITCHYARD: BLOCKED need the API key`\n")).toEqual({
      kind: "blocked",
      reason: "need the API key",
    });
    expect(parseMarker("SWITCHYARD: NO_CHANGE")).toEqual({ kind: "no_change" });
    expect(parseMarker("SWITCHYARD: DONE\nmore work then\nSWITCHYARD: BLOCKED oops")).toMatchObject(
      { kind: "blocked" },
    );
    expect(parseMarker("still working")).toBeNull();
  });

  it("builds the run prompt with feedback and watch instructions", () => {
    const p = buildRunPrompt(mkTask(), 2, ["Add a test"], { watch: true });
    expect(p).toContain("# Task: Fix the login bug");
    expect(p).toContain("## Acceptance criteria\n- Login works");
    expect(p).toContain("## Review feedback (attempt 2)");
    expect(p).toContain("- Add a test");
    expect(p).toContain("`SWITCHYARD: DONE`");
    expect(p).toContain("`SWITCHYARD: BLOCKED <reason>`");
    expect(p).toContain("`SWITCHYARD: NO_CHANGE`");
    expect(buildRunPrompt(mkTask(), 1, ["ignored"])).not.toContain("Review feedback");
  });

  it("describes cron expressions", () => {
    expect(describeCron("0 9 * * 1-5")).toBe("Every weekday at 09:00");
    expect(describeCron("30 7 * * *")).toBe("Every day at 07:30");
    expect(describeCron("*/15 * * * *")).toBe("Every 15 minutes");
    expect(describeCron("0 9 * * 1,3")).toBe("Every Monday and Wednesday at 09:00");
    expect(describeCron("0 0 1 * *")).toBe("On day 1 of every month at 00:00");
    expect(describeCron("0 9 L * *")).toBeNull();
  });
});
