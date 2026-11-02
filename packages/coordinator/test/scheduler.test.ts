import { afterEach, describe, expect, it } from "vitest";
import { requireService } from "../src/index.js";
import { startCoordinator } from "./helpers.js";
import { cleanupHarness, createTask, type Harness, setupHarness, task } from "./task-helpers.js";

let h: Harness | undefined;
afterEach(async () => {
  await cleanupHarness(h);
  h = undefined;
});

const template = {
  title: "Daily report {{date}}",
  objective: "Summarize {{time}} occurrence {{occurrence}}",
  acceptanceCriteria: [],
  priority: 2,
};

async function setup(at: string) {
  h = await setupHarness();
  h.t.clock.now = Date.parse(at);
  await h.t.admin("POST", "/api/dispatch/pause", { paused: true });
  return h;
}

async function automation(h: Harness, body: Record<string, unknown>) {
  const r = await h.t.admin("POST", "/api/automations", {
    name: "Auto",
    projectId: h.project.id,
    template,
    ...body,
  });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return r.body;
}

const scheduler = (h: Harness) => requireService(h.t.c.ctx, "scheduler");
const occurrences = (h: Harness, id: string) =>
  h.t.c.store.occurrences.list("automation_id = ?", [id], "created_at, rowid");
const tasksOf = (h: Harness, id: string) =>
  h.t.c.store.tasks.list("automation_id = ?", [id], "created_at, rowid");

describe("scheduler", () => {
  it("fires 09:00 America/Denver across the DST change", async () => {
    const h = await setup("2026-03-06T20:00:00Z");
    const a = await automation(h, {
      trigger: { kind: "cron", expr: "0 9 * * *", timezone: "America/Denver" },
      groupingKey: "report-{{date}}",
    });
    expect(a.summary).toBe("Every day at 09:00 (America/Denver)");
    expect(a.nextAt).toBe("2026-03-07T16:00:00.000Z");
    const preview = await h.t.admin("GET", `/api/automations/${a.id}/preview`);
    expect(preview.body.next.slice(0, 3)).toEqual([
      "2026-03-07T16:00:00.000Z",
      "2026-03-08T15:00:00.000Z",
      "2026-03-09T15:00:00.000Z",
    ]);
    expect(preview.body.task.title).toBe("Daily report 2026-03-06");

    for (const at of ["2026-03-07T16:00:20Z", "2026-03-08T15:00:20Z", "2026-03-09T15:00:20Z"]) {
      h.t.clock.now = Date.parse(at);
      scheduler(h).tick();
    }
    const occ = occurrences(h, a.id);
    expect(occ.map((o) => [o.key, o.state])).toEqual([
      ["2026-03-07T16:00:00.000Z", "fired"],
      ["2026-03-08T15:00:00.000Z", "fired"],
      ["2026-03-09T15:00:00.000Z", "fired"],
    ]);
    // Templates render in the automation's timezone.
    const tasks = tasksOf(h, a.id);
    expect(tasks.map((t) => t.title)).toEqual([
      "Daily report 2026-03-07",
      "Daily report 2026-03-08",
      "Daily report 2026-03-09",
    ]);
    expect(tasks[1]!.objective).toBe("Summarize 09:00 occurrence 2026-03-08T15:00:00.000Z");
    expect(tasks[0]!.origin).toMatchObject({ kind: "automation", routine: true });
    const cur = h.t.c.store.automations.require(a.id);
    expect(cur.lastEvaluatedAt).toBe("2026-03-09T15:00:20.000Z");
    expect(cur.nextAt).toBe("2026-03-10T15:00:00.000Z");
  });

  it("missed skip records only the newest missed occurrence", async () => {
    const h = await setup("2026-05-01T00:00:00Z");
    const a = await automation(h, {
      trigger: { kind: "cron", expr: "0 * * * *", timezone: "UTC" },
      missed: "skip",
      overlap: "append",
    });
    h.t.clock.now = Date.parse("2026-05-01T05:30:00Z");
    scheduler(h).tick();
    const occ = occurrences(h, a.id);
    expect(occ).toHaveLength(1);
    expect(occ[0]).toMatchObject({
      key: "2026-05-01T05:00:00.000Z",
      state: "skipped_missed",
      reason: "Missed 5 occurrences while offline",
    });
    expect(tasksOf(h, a.id)).toHaveLength(0);
  });

  it("missed run_once fires the newest and records the older as skipped", async () => {
    const h = await setup("2026-05-01T00:00:00Z");
    const a = await automation(h, {
      trigger: { kind: "cron", expr: "0 * * * *", timezone: "UTC" },
      missed: "run_once",
    });
    h.t.clock.now = Date.parse("2026-05-01T05:30:00Z");
    scheduler(h).tick();
    const occ = occurrences(h, a.id);
    expect(occ.map((o) => [o.key, o.state])).toEqual([
      ["2026-05-01T04:00:00.000Z", "skipped_missed"],
      ["2026-05-01T05:00:00.000Z", "fired"],
    ]);
    expect(tasksOf(h, a.id)).toHaveLength(1);
    // Another tick in the same window does nothing.
    scheduler(h).tick();
    expect(occurrences(h, a.id)).toHaveLength(2);
  });

  it("once triggers fire a single time", async () => {
    const h = await setup("2026-05-01T00:00:00Z");
    const a = await automation(h, { trigger: { kind: "once", at: "2026-05-01T01:00:00Z" } });
    expect(a.summary).toBe("Once on 2026-05-01 01:00 UTC");
    h.t.clock.now = Date.parse("2026-05-01T01:00:30Z");
    scheduler(h).tick();
    h.t.clock.now = Date.parse("2026-05-02T01:00:30Z");
    scheduler(h).tick();
    expect(occurrences(h, a.id).map((o) => o.state)).toEqual(["fired"]);
    expect(h.t.c.store.automations.require(a.id).nextAt).toBeNull();
  });

  it("restarts never double-fire the same occurrence key", async () => {
    const t = await startCoordinator({ dispatcher: { tickMs: 0 }, schedulerTickMs: 0 });
    const dir = t.dir;
    try {
      t.clock.now = Date.parse("2026-05-01T08:59:00Z");
      t.c.store.setDispatchPaused(true);
      const now = new Date(t.clock.now).toISOString();
      t.c.store.putProject({
        id: "prj_x",
        name: "X",
        repoIdentity: "local:abc",
        defaultProfileId: null,
        defaultHostId: null,
        maxConcurrentRuns: 1,
        automationEnabled: true,
        setupCommand: null,
        checks: [],
        workspaceSharing: "single_writer",
        createdAt: now,
        updatedAt: now,
      });
      const a = requireService(t.c.ctx, "automations").create({
        name: "Nine",
        projectId: "prj_x",
        trigger: { kind: "cron", expr: "0 9 * * *", timezone: "UTC" },
        template,
        overlap: "append",
      });
      t.clock.now = Date.parse("2026-05-01T09:00:10Z");
      requireService(t.c.ctx, "scheduler").tick();
      expect(t.c.store.occurrences.count("automation_id = ?", [a.id])).toBe(1);
      await t.stop();

      const t2 = await startCoordinator({ dir, dispatcher: { tickMs: 0 }, schedulerTickMs: 0 });
      try {
        t2.clock.now = Date.parse("2026-05-01T09:00:40Z");
        // Simulate a crash that lost lastEvaluatedAt: the window is evaluated again.
        const cur = t2.c.store.automations.require(a.id);
        t2.c.store.automations.upsert({ ...cur, lastEvaluatedAt: "2026-05-01T08:00:00.000Z" });
        requireService(t2.c.ctx, "scheduler").tick();
        expect(t2.c.store.occurrences.count("automation_id = ?", [a.id])).toBe(1);
        expect(t2.c.store.tasks.count("automation_id = ?", [a.id])).toBe(1);
      } finally {
        await t2.cleanup();
      }
    } finally {
      await t.cleanup();
    }
  });
});

describe("overlap and modes", () => {
  it("skip records skipped_overlap while work is tracked", async () => {
    const h = await setup("2026-05-01T00:00:00Z");
    const a = await automation(h, { trigger: { kind: "manual" }, overlap: "skip" });
    const r1 = await h.t.admin("POST", `/api/automations/${a.id}/run`);
    expect(r1.body.occurrence.state).toBe("fired");
    expect(r1.body.task.state).toBe("ready");
    expect(r1.body.task.origin.routine).toBe(false);
    const r2 = await h.t.admin("POST", `/api/automations/${a.id}/run`);
    expect(r2.body.occurrence).toMatchObject({ state: "skipped_overlap", taskId: r1.body.task.id });
    expect(tasksOf(h, a.id)).toHaveLength(1);
    const list = await h.t.admin("GET", "/api/automations");
    expect(list.body[0]).toMatchObject({
      summary: "Manually",
      lastOutcome: "Skipped: previous work still running",
    });
  });

  it("queue_one queues one occurrence and fires it when the work leaves the queue", async () => {
    const h = await setup("2026-05-01T00:00:00Z");
    const a = await automation(h, { trigger: { kind: "manual" }, overlap: "queue_one" });
    const r1 = await h.t.admin("POST", `/api/automations/${a.id}/run`);
    const r2 = await h.t.admin("POST", `/api/automations/${a.id}/run`);
    const r3 = await h.t.admin("POST", `/api/automations/${a.id}/run`);
    expect([r2.body.occurrence.state, r3.body.occurrence.state]).toEqual([
      "queued",
      "skipped_overlap",
    ]);
    await h.t.admin("POST", `/api/tasks/${r1.body.task.id}/cancel`);
    const tasks = tasksOf(h, a.id);
    expect(tasks).toHaveLength(2);
    expect(tasks[1]!.state).toBe("ready");
    const occ = h.t.c.store.occurrences.require(r2.body.occurrence.id);
    expect(occ).toMatchObject({ state: "fired", taskId: tasks[1]!.id });
  });

  it("append extends the tracked task's objective", async () => {
    const h = await setup("2026-05-01T00:00:00Z");
    const a = await automation(h, {
      trigger: { kind: "manual" },
      overlap: "append",
      template: { ...template, objective: "Handle {{payload.issue}}" },
    });
    const r1 = await h.t.admin("POST", `/api/automations/${a.id}/run`, { issue: "#1" });
    const r2 = await h.t.admin("POST", `/api/automations/${a.id}/run`, { issue: "#2" });
    expect(r2.body.occurrence).toMatchObject({ state: "appended", taskId: r1.body.task.id });
    const t = task(h, r1.body.task.id);
    expect(t.objective).toBe("Handle #1\n\n## Update 2026-05-01 00:00\n\nHandle #2");
    expect(t.state).toBe("ready");
  });

  it("continue mode reopens the grouped task on its session", async () => {
    const h = await setup("2026-05-01T00:00:00Z");
    const a = await automation(h, {
      trigger: { kind: "manual" },
      mode: "continue",
      groupingKey: "pr-{{payload.pr}}",
    });
    const r1 = await h.t.admin("POST", `/api/automations/${a.id}/run`, { pr: 7 });
    const t1 = task(h, r1.body.task.id);
    expect(t1.groupingKey).toBe("pr-7");
    h.t.c.store.putTask({ ...t1, state: "done" });
    const r2 = await h.t.admin("POST", `/api/automations/${a.id}/run`, { pr: 7 });
    expect(r2.body.task.id).toBe(t1.id);
    expect(task(h, t1.id).state).toBe("ready");
    const r3 = await h.t.admin("POST", `/api/automations/${a.id}/run`, { pr: 8 });
    expect(r3.body.task.id).not.toBe(t1.id);
  });

  it("dependency triggers fire once when the source task is done", async () => {
    const h = await setup("2026-05-01T00:00:00Z");
    const src = await createTask(h, { title: "Release" });
    const a = await automation(h, {
      trigger: { kind: "dependency", taskId: src.id },
      template: { ...template, title: "After {{payload.task.title}}" },
    });
    expect(a.summary).toBe('When "Release" is done');
    h.t.c.store.putTask({ ...task(h, src.id), state: "review" });
    const acc = await h.t.admin("POST", `/api/tasks/${src.id}/accept`);
    expect(acc.body.state).toBe("done");
    const occ = occurrences(h, a.id);
    expect(occ).toHaveLength(1);
    expect(occ[0]!.key).toMatch(new RegExp(`^dep:${src.id}:`));
    expect(tasksOf(h, a.id)[0]!.title).toBe("After Release");
    // Further updates while done do not fire again.
    await h.t.admin("PATCH", `/api/tasks/${src.id}`, { priority: 1 });
    expect(occurrences(h, a.id)).toHaveLength(1);
  });
});

describe("webhooks", () => {
  it("authenticates, filters and dedupes deliveries", async () => {
    const h = await setup("2026-05-01T00:00:00Z");
    const a = await automation(h, {
      trigger: { kind: "webhook" },
      filters: [{ path: "action", equals: "opened" }],
      template: { ...template, title: "Triage {{payload.issue.title}}" },
      overlap: "append",
    });
    const hook = `/api/hooks/${a.id}`;
    expect((await h.t.api("POST", hook, { body: {} })).status).toBe(401);
    const tok = await h.t.admin("POST", `/api/automations/${a.id}/webhook-token`);
    expect(tok.status).toBe(201);
    expect(tok.body.url).toMatch(new RegExp(`/api/hooks/${a.id}$`));
    expect(h.t.c.store.automations.require(a.id).webhookTokenSet).toBe(true);
    const row = h.t.c.store.st
      .get("SELECT webhook_token_hash AS h FROM automations WHERE id = ?")
      .get(a.id) as { h: string };
    expect(row.h).not.toContain(tok.body.token);
    expect(
      (await h.t.api("POST", hook, { token: "wrong", body: { action: "opened" } })).status,
    ).toBe(401);

    const filtered = await h.t.api("POST", hook, {
      token: tok.body.token,
      body: { action: "closed" },
      headers: { "x-github-delivery": "d-1" },
    });
    expect(filtered.status).toBe(202);
    expect(filtered.body.state).toBe("filtered");

    const body = { action: "opened", issue: { title: "Crash on login" } };
    const ok = await h.t.api("POST", hook, {
      token: tok.body.token,
      body,
      headers: { "idempotency-key": "k-1" },
    });
    expect(ok.status).toBe(202);
    expect(ok.body.state).toBe("fired");
    const again = await h.t.api("POST", hook, {
      token: tok.body.token,
      body,
      headers: { "idempotency-key": "k-1" },
    });
    expect(again.body).toMatchObject({ occurrenceId: ok.body.occurrenceId, state: "fired" });
    expect(tasksOf(h, a.id).map((t) => t.title)).toEqual(["Triage Crash on login"]);

    // Without a delivery id, a retry of the same body in the same 10-minute window dedupes.
    const plain = { action: "opened", issue: { title: "No delivery id" } };
    const first = await h.t.api("POST", hook, { token: tok.body.token, body: plain });
    expect(first.status).toBe(202);
    expect(first.body.duplicate).toBeUndefined();
    h.t.clock.advance(60_000);
    const retry = await h.t.api("POST", hook, { token: tok.body.token, body: plain });
    expect(retry.body).toMatchObject({ occurrenceId: first.body.occurrenceId, duplicate: true });
    const other = await h.t.api("POST", hook, {
      token: tok.body.token,
      body: { ...plain, issue: { title: "Another" } },
    });
    expect(other.body.occurrenceId).not.toBe(first.body.occurrenceId);
    h.t.clock.advance(10 * 60_000);
    const later = await h.t.api("POST", hook, { token: tok.body.token, body: plain });
    expect(later.body.occurrenceId).not.toBe(first.body.occurrenceId);

    const big = await h.t.api("POST", hook, {
      token: tok.body.token,
      body: { action: "opened", blob: "x".repeat(300 * 1024) },
    });
    expect(big.status).toBe(413);

    // Rotating invalidates the old token.
    await h.t.admin("POST", `/api/automations/${a.id}/webhook-token`);
    expect((await h.t.api("POST", hook, { token: tok.body.token, body })).status).toBe(401);
    const hist = await h.t.admin("GET", `/api/automations/${a.id}/history`);
    const states = hist.body.map((o: { state: string }) => o.state);
    // k-1, the body-keyed delivery, "Another", the next-window delivery, and the filtered one.
    expect(states).toHaveLength(5);
    expect(states.at(-1)).toBe("filtered");
  });
});
