import { afterEach, describe, expect, it, vi } from "vitest";
import { enrollHost, FakeHost, hostSession, NO_REPLY, sleep, until } from "./helpers.js";
import {
  cleanupHarness,
  commandsOf,
  createTask,
  dispatcherOf,
  type Harness,
  ROOT,
  runOf,
  setupHarness,
  task,
  untilRun,
} from "./task-helpers.js";

let h: Harness | undefined;
let extra: FakeHost | undefined;
afterEach(async () => {
  await extra?.close().catch(() => undefined);
  extra = undefined;
  await cleanupHarness(h);
  h = undefined;
});

describe("dispatcher", () => {
  it("persists run, session and task before contacting the host", async () => {
    h = await setupHarness();
    const seen: unknown[] = [];
    h.override = (cmd) => {
      if (cmd.type !== "dispatch.start") return undefined;
      const s = h!.t.c.store;
      const run = s.runs.get(cmd.runId)!;
      const session = s.sessions.get(cmd.sessionId)!;
      const tk = s.tasks.get(cmd.taskId)!;
      seen.push({
        run: run.state,
        dispatchKey: run.dispatchKey === run.id && cmd.dispatchKey === run.id,
        session: session.runtime,
        task: tk.state,
        currentRunId: tk.currentRunId === run.id,
      });
      return undefined; // fall through to the smart host
    };
    const tk = await createTask(h, { state: "ready", title: "Fix: the Login bug!" });
    const run = await untilRun(h, tk.id, "running");
    expect(seen).toEqual([
      {
        run: "dispatching",
        dispatchKey: true,
        session: "starting",
        task: "in_progress",
        currentRunId: true,
      },
    ]);
    const [start] = commandsOf(h.host, "dispatch.start");
    const short = tk.id.slice(-6).toLowerCase();
    expect(start!.workspace).toEqual({
      createFrom: {
        checkoutPath: ROOT,
        branch: `sy/fix-the-login-bug-${short}`,
        base: "main",
        setupCommand: null,
        worktreeDir: ".worktrees",
      },
    });
    expect(start!.prompt).toContain("# Task: Fix: the Login bug!");
    expect(start!.controlRevision).toBe(1);
    expect(run).toMatchObject({ attempt: 1, controlMode: "automation", hostId: h.creds.hostId });
    expect(run.startedAt).not.toBeNull();
    expect(run.usage).toMatchObject({
      accounting: "unavailable",
      note: "Token/cost accounting not reported by this Pi provider",
    });
    const session = h.t.c.store.sessions.require(run.sessionId!);
    expect(session.nativeHandle?.sessionFile).toBe(`/s/${session.id}.jsonl`);
    const ws = h.t.c.store.workspaces.require(session.workspaceId!);
    expect(ws).toMatchObject({
      path: `${ROOT}/.worktrees/sy-fix-the-login-bug-${short}`,
      branch: `sy/fix-the-login-bug-${short}`,
      baseBranch: "main",
      provenance: "managed",
    });
    expect(task(h, tk.id)).toMatchObject({ state: "in_progress", sessionId: session.id });
  });

  it("a lost receipt makes the launch uncertain; reconcile adopts a known dispatch", async () => {
    h = await setupHarness({ coordinator: { dispatcher: { tickMs: 0, startTimeoutMs: 300 } } });
    let swallow = true;
    h.override = (cmd) => {
      if (cmd.type === "dispatch.start" && swallow) {
        // The host performs the launch but the receipt is lost.
        h!.state.dispatches.set(cmd.dispatchKey, {
          sessionId: cmd.sessionId,
          workspacePath: `${ROOT}/.worktrees/x`,
        });
        return NO_REPLY;
      }
      return undefined;
    };
    const tk = await createTask(h, { state: "ready" });
    const run = await untilRun(h, tk.id, "uncertain");
    const elig = await h.t.admin("GET", `/api/tasks/${tk.id}/eligibility`);
    expect(elig.body).toMatchObject({ eligible: false, wait: "not_ready" });
    swallow = false;
    await h.host.close();
    await h.host.open();
    const adopted = await untilRun(h, tk.id, "running");
    expect(adopted.id).toBe(run.id);
    expect(commandsOf(h.host, "dispatch.reconcile").map((c) => c.dispatchKey)).toEqual([run.id]);
    expect(commandsOf(h.host, "dispatch.start")).toHaveLength(1);
    const session = h.t.c.store.sessions.require(run.sessionId!);
    expect(session.cwd).toBe(`${ROOT}/.worktrees/x`);
  });

  it("re-asks a connected host about an uncertain launch on the store clock", async () => {
    h = await setupHarness({ coordinator: { dispatcher: { tickMs: 0, startTimeoutMs: 300 } } });
    let busy = true;
    h.override = (cmd) => {
      if (cmd.type === "dispatch.start") {
        h!.state.dispatches.set(cmd.dispatchKey, {
          sessionId: cmd.sessionId,
          workspacePath: `${ROOT}/.worktrees/x`,
        });
        return NO_REPLY;
      }
      if (cmd.type === "dispatch.reconcile" && busy) {
        return { __error: { code: "internal", message: "busy" } };
      }
      return undefined;
    };
    const tk = await createTask(h, { state: "ready" });
    await untilRun(h, tk.id, "uncertain");
    const asked = () => commandsOf(h!.host, "dispatch.reconcile").length;
    await until(() => {
      dispatcherOf(h!).tick();
      return asked() === 1;
    });
    await sleep(50);
    dispatcherOf(h).tick();
    await sleep(20);
    expect(asked()).toBe(1);
    h.t.clock.advance(31_000);
    await until(() => {
      dispatcherOf(h!).tick();
      return asked() === 2;
    });
    busy = false;
    h.t.clock.advance(31_000);
    dispatcherOf(h).tick();
    await untilRun(h, tk.id, "running");
    dispatcherOf(h).tick();
    expect(
      (dispatcherOf(h) as unknown as { lastReconcile: Map<string, number> }).lastReconcile.size,
    ).toBe(0);
  });

  it("session updates schedule dispatch only when a session can free work", async () => {
    h = await setupHarness();
    await h.host.event("session.updated", hostSession("ses_x", { runtime: "running" }));
    const spy = vi.spyOn(dispatcherOf(h), "schedule");
    await h.host.event(
      "session.updated",
      hostSession("ses_x", { runtime: "running", title: "Renamed" }),
    );
    await sleep(20);
    expect(spy).toHaveBeenCalledTimes(0);
    await h.host.event("session.updated", hostSession("ses_x", { runtime: "idle" }));
    await until(() => spy.mock.calls.length === 1);
    await h.host.event("session.updated", hostSession("ses_x", { runtime: "running" }));
    await sleep(20);
    expect(spy).toHaveBeenCalledTimes(1);
    await h.host.event("session.updated", hostSession("ses_x", { runtime: "stopped" }));
    await until(() => spy.mock.calls.length === 2);
    const store = h.t.c.store;
    store.putSession({ ...store.sessions.require("ses_x"), archivedAt: new Date().toISOString() });
    await until(() => spy.mock.calls.length === 3);
  });

  it("an unknown dispatch is resent with the same dispatchKey", async () => {
    h = await setupHarness({ coordinator: { dispatcher: { tickMs: 0, startTimeoutMs: 300 } } });
    let drop = true;
    h.override = (cmd) => (cmd.type === "dispatch.start" && drop ? NO_REPLY : undefined);
    const tk = await createTask(h, { state: "ready" });
    const run = await untilRun(h, tk.id, "uncertain");
    drop = false;
    await h.host.close();
    await h.host.open();
    await untilRun(h, tk.id, "running");
    const starts = commandsOf(h.host, "dispatch.start");
    expect(starts.length).toBeGreaterThanOrEqual(2);
    expect(new Set(starts.map((s) => s.dispatchKey))).toEqual(new Set([run.dispatchKey]));
    expect(new Set(starts.map((s) => s.sessionId))).toEqual(new Set([run.sessionId]));
    expect(h.t.c.store.runs.list("task_id = ?", [tk.id])).toHaveLength(1);
  });

  it("a disconnect makes the launch uncertain; the reconnect resend settles it", async () => {
    h = await setupHarness();
    let first = true;
    h.override = (cmd) => {
      if (cmd.type === "dispatch.start" && first) {
        first = false;
        void h!.host.close();
        return NO_REPLY;
      }
      return undefined;
    };
    const tk = await createTask(h, { state: "ready" });
    const run = await untilRun(h, tk.id, "uncertain");
    await h.host.open();
    const running = await untilRun(h, tk.id, "running");
    expect(running.id).toBe(run.id);
    const starts = commandsOf(h.host, "dispatch.start");
    expect(new Set(starts.map((s) => s.dispatchKey))).toEqual(new Set([run.dispatchKey]));
  });

  it("never fails over an uncertain launch to another host", async () => {
    h = await setupHarness({ coordinator: { dispatcher: { tickMs: 0, startTimeoutMs: 300 } } });
    h.override = (cmd) => (cmd.type === "dispatch.start" ? NO_REPLY : undefined);
    const creds2 = await enrollHost(h.t, "other-host");
    extra = await FakeHost.connect(h.t, creds2, () => null);
    h.t.c.store.putCheckout({
      id: "chk_other",
      projectId: h.project.id,
      hostId: creds2.hostId,
      path: "/other/app",
      commonDir: "/other/app/.git",
      defaultBranch: "main",
      createdAt: new Date().toISOString(),
    });
    const tk = await createTask(h, { state: "ready" });
    await untilRun(h, tk.id, "uncertain");
    await h.host.close();
    dispatcherOf(h).tick();
    await sleep(50);
    expect(extra.commands.filter((c) => c.command.type === "dispatch.start")).toHaveLength(0);
    expect(task(h, tk.id).state).toBe("in_progress");
    expect(runOf(h, tk.id).state).toBe("uncertain");
    // Another Ready task waits for its host rather than moving to the other one.
    const other = await createTask(h, { state: "ready", title: "Second" });
    dispatcherOf(h).tick();
    await sleep(30);
    expect(dispatcherOf(h).eligibility(task(h, other.id))).toMatchObject({
      eligible: false,
      wait: "host_offline",
    });
    expect(extra.commands.filter((c) => c.command.type === "dispatch.start")).toHaveLength(0);
    expect(dispatcherOf(h).eligibility(task(h, tk.id))).toMatchObject({ wait: "not_ready" });
    const now = await h.t.admin("GET", "/api/now");
    expect(now.body.running).toEqual([
      expect.objectContaining({ taskId: tk.id, runId: runOf(h, tk.id).id }),
    ]);
  });

  it("retries pre-start launch failures with backoff, then blocks with failed attention", async () => {
    h = await setupHarness();
    h.override = (cmd) =>
      cmd.type === "dispatch.start"
        ? {
            __error: {
              code: "internal",
              message: "spawn pi ENOENT",
              details: { state: "accepted" },
            },
          }
        : undefined;
    const tk = await createTask(h, { state: "ready" });
    await until(() => task(h!, tk.id).state === "ready" && runOf(h!, tk.id).state === "queued");
    const queued = runOf(h, tk.id);
    expect(queued).toMatchObject({ infraRetries: 1, attempt: 1 });
    expect(Date.parse(queued.nextAttemptAt!) - h.t.clock.now).toBe(30_000);
    expect(dispatcherOf(h).eligibility(task(h, tk.id))).toMatchObject({
      eligible: false,
      wait: "retry_backoff",
    });
    dispatcherOf(h).tick();
    await sleep(30);
    expect(commandsOf(h.host, "dispatch.start")).toHaveLength(1);

    h.t.clock.advance(31_000);
    dispatcherOf(h).tick();
    await until(() => runOf(h!, tk.id).infraRetries === 2 && runOf(h!, tk.id).state === "queued");
    h.t.clock.advance(31_000);
    dispatcherOf(h).tick();
    await until(() => task(h!, tk.id).blocked !== null);
    const starts = commandsOf(h.host, "dispatch.start");
    expect(starts).toHaveLength(3);
    expect(new Set(starts.map((s) => s.dispatchKey)).size).toBe(3);
    expect(starts[1]!.dispatchKey).toBe(queued.dispatchKey);
    const t = task(h, tk.id);
    expect(t).toMatchObject({
      state: "in_progress",
      blocked: { reason: "Launch failed: spawn pi ENOENT" },
    });
    expect(runOf(h, tk.id)).toMatchObject({ state: "failed", infraRetries: 2 });
    const att = h.t.c.attention.open({ taskId: tk.id, reason: "failed" });
    expect(att).toHaveLength(1);
  });

  it("does not retry failures after the session started", async () => {
    h = await setupHarness();
    h.override = (cmd) =>
      cmd.type === "dispatch.start"
        ? { __error: { code: "internal", message: "crashed", details: { state: "started" } } }
        : undefined;
    const tk = await createTask(h, { state: "ready" });
    await until(() => task(h!, tk.id).blocked !== null);
    expect(commandsOf(h.host, "dispatch.start")).toHaveLength(1);
    expect(runOf(h, tk.id).state).toBe("failed");
  });

  it("a launch whose prompt was not delivered blocks the task without retrying", async () => {
    h = await setupHarness();
    h.override = (cmd) =>
      cmd.type === "dispatch.start"
        ? {
            sessionId: cmd.sessionId,
            workspacePath: "/w",
            nativeHandle: null,
            reused: false,
            promptError: "Pi did not answer prompt",
          }
        : undefined;
    const tk = await createTask(h, { state: "ready" });
    await until(() => task(h!, tk.id).blocked !== null);
    await sleep(30);
    expect(task(h, tk.id).blocked?.reason).toMatch(/Launch prompt was not delivered/);
    expect(commandsOf(h.host, "dispatch.start")).toHaveLength(1);
    expect(runOf(h, tk.id)).toMatchObject({ state: "failed" });
    expect(h.t.c.attention.open({ taskId: tk.id, reason: "failed" })).toHaveLength(1);
  });

  it("a host restart after Pi may have started never replays the prompt (receipt)", async () => {
    h = await setupHarness();
    const handle = { sessionId: "native-x", sessionFile: "/s/native-x.jsonl" };
    h.override = (cmd) =>
      cmd.type === "dispatch.start"
        ? {
            __error: {
              code: "internal",
              message: "Host agent restarted during launch; Pi may have started",
              details: {
                started: "unknown",
                nativeHandle: handle,
                workspacePath: `${ROOT}/.worktrees/x`,
              },
            },
          }
        : undefined;
    const tk = await createTask(h, { state: "ready" });
    await until(() => task(h!, tk.id).blocked !== null);
    await sleep(30);
    dispatcherOf(h).tick();
    await sleep(30);
    expect(commandsOf(h.host, "dispatch.start")).toHaveLength(1);
    expect(h.t.c.store.runs.list("task_id = ?", [tk.id])).toHaveLength(1);
    const run = runOf(h, tk.id);
    expect(run.state).toBe("interrupted");
    expect(task(h, tk.id)).toMatchObject({
      state: "in_progress",
      blocked: { reason: "Host restarted during launch; verify and resume" },
    });
    expect(h.t.c.attention.open({ taskId: tk.id, reason: "failed" })).toHaveLength(1);
    const session = h.t.c.store.sessions.require(run.sessionId!);
    expect(session.nativeHandle).toEqual(handle);
    expect(session.cwd).toBe(`${ROOT}/.worktrees/x`);
    expect(session.runtime).toBe("interrupted");
  });

  it("a host restart after Pi may have started never replays the prompt (reconcile)", async () => {
    h = await setupHarness({ coordinator: { dispatcher: { tickMs: 0, startTimeoutMs: 300 } } });
    let restarted = false;
    h.override = (cmd) => {
      if (cmd.type === "dispatch.start" && !restarted) return NO_REPLY;
      if (cmd.type === "dispatch.reconcile") {
        return {
          known: true,
          sessionId: null,
          state: "failed",
          runtime: null,
          workspacePath: null,
          nativeHandle: null,
          error: "Host agent restarted during launch; Pi may have started",
          errorDetails: { started: "unknown", nativeHandle: null, workspacePath: null },
        };
      }
      return undefined;
    };
    const tk = await createTask(h, { state: "ready" });
    await untilRun(h, tk.id, "uncertain");
    restarted = true;
    await h.host.close();
    await h.host.open();
    await until(() => task(h!, tk.id).blocked !== null);
    expect(task(h, tk.id).blocked?.reason).toBe("Host restarted during launch; verify and resume");
    expect(runOf(h, tk.id).state).toBe("interrupted");
    expect(commandsOf(h.host, "dispatch.start")).toHaveLength(1);
    expect(h.t.c.store.runs.list("task_id = ?", [tk.id])).toHaveLength(1);
    expect(h.t.c.attention.open({ taskId: tk.id, reason: "failed" })).toHaveLength(1);
  });

  it("a host restart before Pi was spawned is retried like any pre-start failure", async () => {
    h = await setupHarness();
    h.override = (cmd) =>
      cmd.type === "dispatch.start"
        ? {
            __error: {
              code: "internal",
              message: "Host agent restarted during dispatch",
              details: { started: false },
            },
          }
        : undefined;
    const tk = await createTask(h, { state: "ready" });
    await until(() => runOf(h!, tk.id).state === "queued");
    expect(runOf(h, tk.id).infraRetries).toBe(1);
  });

  it("explains waits and honors pause, dependencies and run-now", async () => {
    h = await setupHarness();
    await h.t.admin("POST", "/api/dispatch/pause", { paused: true });
    const dep = await createTask(h, { title: "Schema migration" });
    const tk = await createTask(h, { state: "ready", dependencies: [dep.id] });
    let e = await h.t.admin("GET", `/api/tasks/${tk.id}/eligibility`);
    expect(e.body).toMatchObject({ wait: "dispatch_paused" });
    const now = await h.t.admin("GET", "/api/now");
    expect(now.body.dispatchPaused).toBe(true);
    expect(now.body.queued[0]).toMatchObject({ taskId: tk.id });

    const rn = await h.t.admin("POST", `/api/tasks/${tk.id}/run-now`);
    expect(rn.status).toBe(409);
    expect(rn.body.error).toMatchObject({
      code: "conflict",
      message: "Waiting for Schema migration",
      details: { wait: "dependency" },
    });

    // Cycles are rejected with the titles involved.
    const cyc = await h.t.admin("PATCH", `/api/tasks/${dep.id}`, { dependencies: [tk.id] });
    expect(cyc.status).toBe(400);
    expect(cyc.body.error.code).toBe("dependency_cycle");
    expect(cyc.body.error.message).toContain("Schema migration");

    await h.t.admin("PATCH", `/api/tasks/${tk.id}`, { dependencies: [] });
    const future = new Date(h.t.clock.now + 3_600_000).toISOString();
    await h.t.admin("PATCH", `/api/tasks/${tk.id}`, { notBefore: future, priority: 0 });
    e = await h.t.admin("GET", `/api/tasks/${tk.id}/eligibility`);
    expect(e.body.wait).toBe("dispatch_paused");
    await h.t.admin("POST", "/api/dispatch/pause", { paused: false });
    e = await h.t.admin("GET", `/api/tasks/${tk.id}/eligibility`);
    expect(e.body).toMatchObject({ wait: "scheduled_time" });
    // Run now dispatches immediately despite the scheduled time.
    const ok = await h.t.admin("POST", `/api/tasks/${tk.id}/run-now`);
    expect(ok.status).toBe(200);
    expect(ok.body.run.state).toBe("dispatching");
    await untilRun(h, tk.id, "running");

    // Host offline.
    const t2 = await createTask(h, { state: "ready", title: "Other" });
    await h.host.close();
    await until(() => !h!.t.c.hostHub.isConnected(h!.creds.hostId));
    expect(dispatcherOf(h).eligibility(task(h, t2.id))).toMatchObject({ wait: "host_offline" });
  });

  it("a canceled dependency is reported as invalid configuration, not an endless wait", async () => {
    h = await setupHarness();
    const dep = await createTask(h, { title: "Schema migration" });
    const tk = await createTask(h, { state: "ready", dependencies: [dep.id] });
    let e = await h.t.admin("GET", `/api/tasks/${tk.id}/eligibility`);
    expect(e.body).toMatchObject({ wait: "dependency" });
    const c = await h.t.admin("POST", `/api/tasks/${dep.id}/cancel`, {});
    expect(c.status).toBe(200);
    e = await h.t.admin("GET", `/api/tasks/${tk.id}/eligibility`);
    expect(e.body).toMatchObject({
      eligible: false,
      wait: "invalid_configuration",
      message: "Dependency Schema migration was canceled",
    });
    dispatcherOf(h).tick();
    await sleep(20);
    expect(commandsOf(h.host, "dispatch.start")).toHaveLength(0);
  });

  it("moves, deletes and validates tasks", async () => {
    h = await setupHarness();
    await h.t.admin("POST", "/api/dispatch/pause", { paused: true });
    const tk = await createTask(h);
    const bad = await h.t.admin("POST", `/api/tasks/${tk.id}/move`, { to: "review" });
    expect(bad.status).toBe(409);
    expect(bad.body.error.code).toBe("invalid_transition");
    const ready = await h.t.admin("POST", `/api/tasks/${tk.id}/move`, { to: "ready" });
    expect(ready.body.state).toBe("ready");
    const del = await h.t.admin("DELETE", `/api/tasks/${tk.id}`);
    expect(del.body.error.code).toBe("invalid_transition");
    await h.t.admin("POST", `/api/tasks/${tk.id}/cancel`);
    expect((await h.t.admin("DELETE", `/api/tasks/${tk.id}`)).status).toBe(200);
    expect(h.t.c.store.tasks.get(tk.id)).toBeUndefined();
  });

  it("patches task policy field by field", async () => {
    h = await setupHarness();
    await h.t.admin("POST", "/api/dispatch/pause", { paused: true });
    const tk = await createTask(h, {
      policy: { completion: { checks: ["pnpm test"], requireHumanReview: true } },
    });
    const ok = await h.t.admin("PATCH", `/api/tasks/${tk.id}`, {
      policy: { completion: { requireHumanReview: false } },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.policy.completion).toEqual({ checks: ["pnpm test"], requireHumanReview: false });
    const bad = await h.t.admin("PATCH", `/api/tasks/${tk.id}`, {
      policy: { continuation: { enabled: true } },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("invalid_request");
  });
});
