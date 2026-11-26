// @module-tag slow
import type { HostCommand } from "@switchyard/protocol";
import { makeRepo, type TempRepo } from "@switchyard/test-fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROMPT_NOT_SENT, SESSION_LIVE_CONFLICT } from "../src/index.js";
import { type HostHarness, mockProfile, startCommand, startHarness, waitFor } from "./helpers.js";
import { interactions, isSettled, items, script, sid, startSession } from "./sessions-helpers.js";

describe("host agent with real Pi", () => {
  let h: HostHarness;
  let repo: TempRepo;
  let dropped = 0;

  beforeAll(async () => {
    h = await startHarness({
      script,
      testHooks: {
        dropReceipt: (commandId) => {
          if (commandId === "cmd_drop_first" && dropped === 0) {
            dropped++;
            return true;
          }
          return false;
        },
      },
    });
    repo = makeRepo();
  });
  afterAll(async () => {
    await h?.dispose();
    repo?.cleanup();
  });

  it("starts a session and emits session, transcript and settle events", async () => {
    const id = sid();
    const r = await startSession(h, id, h.pi!.cwd, { initialPrompt: "hello" });
    expect(r).toMatchObject({ sessionId: id, reused: false });
    expect(r.nativeHandle.sessionId).toMatch(/[0-9a-f-]{36}/);
    const settled = await h.coord.waitEvent(isSettled(id), 30000, "settled");
    expect(settled.data).toMatchObject({
      id,
      hostId: "hst_test",
      runtime: "idle",
      cwd: h.pi!.cwd,
      lastAssistantText: "ok",
      settled: { aborted: false, lastAssistantText: "ok" },
    });
    const kinds = items(h, id).map((i) => i.kind);
    expect(kinds).toContain("user");
    expect(kinds).toContain("assistant");
    const runtimes = h.coord.eventsOf("session.updated", id).map((e) => (e.data as any).runtime);
    expect(runtimes[0]).toBe("starting");
    expect(runtimes).toContain("running");
    // A second session.start for the live session reuses it.
    const again = await startSession(h, id, h.pi!.cwd);
    expect(again).toMatchObject({ sessionId: id, reused: true });
  });

  it("names a placeholder-titled session from its first prompt, once", async () => {
    const id = sid();
    await startSession(h, id, h.pi!.cwd, { title: "New session" });
    const prompt = (text: string) =>
      h.coord.ok({
        type: "session.prompt",
        sessionId: id,
        text,
        images: [],
        mode: "prompt",
        origin: "human",
        controlRevision: 1,
      });
    const mark = h.coord.events.length;
    await prompt("Refactor the login flow\nplease");
    await waitFor(
      () => h.agent.supervisor.record(id)?.title === "Refactor the login flow",
      30000,
      "auto-title",
    );
    expect(
      h.coord
        .eventsOf("session.updated", id)
        .some((e) => (e.data as any).title === "Refactor the login flow"),
    ).toBe(true);
    await h.coord.waitUntil(
      () => h.coord.events.slice(mark).some((e) => isSettled(id)(e.event)),
      30000,
      "settled",
    );
    await prompt("hello");
    expect(h.agent.supervisor.record(id)?.title).toBe("Refactor the login flow");
  });

  it("answers model, effort, command and compaction commands", async () => {
    const id = sid();
    await startSession(h, id, h.pi!.cwd);
    const models = await h.coord.ok<{ models: { id: string }[] }>({
      type: "session.models",
      sessionId: id,
    });
    expect(models.models.some((m) => m.id === "mock-2")).toBe(true);
    await h.coord.ok({
      type: "session.setModel",
      sessionId: id,
      provider: "mock",
      modelId: "mock-2",
    });
    await h.coord.waitUntil(
      () =>
        h.coord.eventsOf("session.updated", id).some((e) => (e.data as any).model?.id === "mock-2"),
      10000,
      "model update",
    );
    await h.coord.ok({ type: "session.setThinking", sessionId: id, level: "medium" });
    await h.coord.waitUntil(
      () =>
        h.coord.eventsOf("session.updated", id).some((e) => (e.data as any).thinking === "medium"),
      10000,
      "thinking update",
    );
    const cmds = await h.coord.ok<{ commands: { name: string }[] }>({
      type: "session.commands",
      sessionId: id,
    });
    expect(cmds.commands.some((c) => c.name === "fixture-hello")).toBe(true);

    await h.coord.ok({
      type: "session.prompt",
      sessionId: id,
      text: "please pick a fruit",
      images: [],
      mode: "prompt",
      origin: "human",
      controlRevision: 1,
    });
    await waitFor(
      () => interactions(h, id).some((i) => i.state === "pending"),
      30000,
      "pending interaction",
    );
    const r = await h.coord.command({ type: "session.compact", sessionId: id, instructions: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("conflict");
    await h.coord.ok({ type: "session.abort", sessionId: id, clearQueue: true });
  });

  it("lists importable native sessions and reads a native transcript", async () => {
    const id = sid();
    const r = await startSession(h, id, h.pi!.cwd, { initialPrompt: "hello native" });
    await h.coord.waitEvent(isSettled(id), 30000, "settled");
    const { sessions } = await h.coord.ok({ type: "session.importable" });
    const mine = sessions.find((s: any) => s.sessionFile === r.nativeHandle.sessionFile);
    expect(mine).toMatchObject({ sessionId: r.nativeHandle.sessionId, inactive: false });
    const native = await h.coord.ok({
      type: "session.readNative",
      sessionFile: r.nativeHandle.sessionFile,
    });
    expect(native.items.map((i: any) => i.kind)).toEqual(["user", "assistant"]);
    const missing = await h.coord.command({
      type: "session.readNative",
      sessionFile: `${r.nativeHandle.sessionFile}.gone`,
    });
    expect(missing).toMatchObject({ ok: false, error: { code: "native_session_missing" } });
    await h.coord.ok({ type: "session.stop", sessionId: id });
  });

  it("refuses a second live process for the same native session file", async () => {
    const a = sid();
    const ra = await startSession(h, a, h.pi!.cwd);
    const r = await h.coord.command(
      startCommand(sid(), h.pi!.cwd, { nativeHandle: ra.nativeHandle }),
    );
    expect(r).toMatchObject({
      ok: false,
      error: { code: "conflict", message: SESSION_LIVE_CONFLICT },
    });
    await h.coord.ok({ type: "session.stop", sessionId: a });
  });

  it("dispatch.start is idempotent: one worktree, one Pi process, reconcile adopts it", async () => {
    const spawnedBefore = h.agent.spawnedPiProcesses;
    const sessionId = sid();
    const cmd: HostCommand = {
      type: "dispatch.start",
      dispatchKey: "run_dispatch1",
      runId: "run_dispatch1",
      taskId: "tsk_1",
      sessionId,
      projectId: "prj_1",
      title: "Dispatched task",
      workspace: {
        createFrom: {
          checkoutPath: repo.path,
          branch: "task/one",
          base: "main",
          setupCommand: null,
        },
      },
      nativeHandle: null,
      profile: mockProfile,
      prompt: "do the task",
      controlRevision: 1,
    };
    // The receipt of the first attempt is lost.
    await expect(
      h.coord.command(cmd, { commandId: "cmd_drop_first", timeoutMs: 15000 }),
    ).rejects.toThrow(/no receipt/);
    const rec = await h.coord.ok({ type: "dispatch.reconcile", dispatchKey: "run_dispatch1" });
    expect(rec).toMatchObject({
      known: true,
      sessionId,
      state: "started",
      workspacePath: `${repo.path}/.worktrees/task-one`,
      error: null,
    });
    expect(["idle", "running"]).toContain(rec.runtime);

    // Re-sending the same command id returns the stored receipt; a new id returns the stored outcome.
    const sameId = await h.coord.command(cmd, { commandId: "cmd_drop_first" });
    expect(sameId).toMatchObject({ ok: true, result: { sessionId, reused: false } });
    const dup = await h.coord.ok(cmd);
    expect(dup).toMatchObject({
      sessionId,
      workspacePath: `${repo.path}/.worktrees/task-one`,
      reused: true,
    });
    expect(h.agent.spawnedPiProcesses - spawnedBefore).toBe(1);
    const { worktrees } = await h.coord.ok({ type: "workspace.discover", checkoutPath: repo.path });
    expect(
      worktrees.filter((w: any) => w.provenance === "managed").map((w: any) => w.branch),
    ).toEqual(["task/one"]);

    await h.coord.waitEvent(isSettled(sessionId), 30000, "dispatched settle");
    const updated = h.coord.eventsOf("session.updated", sessionId).at(-1)!;
    expect(updated.data).toMatchObject({ taskId: "tsk_1", runId: "run_dispatch1" });
    expect(updated.taskId).toBe("tsk_1");

    // A live session blocks worktree removal.
    const refused = await h.coord.command({
      type: "workspace.remove",
      path: `${repo.path}/.worktrees/task-one`,
      checkoutPath: repo.path,
      base: "main",
      force: { dirty: true, unmerged: true },
    });
    expect(refused).toMatchObject({ ok: false, error: { code: "workspace_active_sessions" } });
    await h.coord.ok({ type: "session.stop", sessionId });
    await waitFor(() => !h.agent.supervisor.isLive(sessionId), 15000, "stopped");
    expect(h.agent.supervisor.record(sessionId)?.runtime).toBe("stopped");
  });

  it("a retry dispatch delivers its own launch prompt and a repeat never sends it twice", async () => {
    const id = sid();
    const dispatch = (key: string, prompt: string): HostCommand => ({
      type: "dispatch.start",
      dispatchKey: key,
      runId: key,
      taskId: "tsk_retry",
      sessionId: id,
      projectId: "prj_1",
      title: "Retry",
      workspace: { path: h.pi!.cwd },
      nativeHandle: null,
      profile: mockProfile,
      prompt,
      controlRevision: 1,
      controlMode: "automation",
    });
    const userItems = () => items(h, id).filter((i) => i.kind === "user").length;
    const first = await h.coord.ok(dispatch(`run_retry_a_${id}`, "hello"));
    expect(first).toMatchObject({ reused: false, promptError: null });
    await h.coord.waitEvent(isSettled(id), 30000, "first settle");
    expect(userItems()).toBe(1);

    const retry = await h.coord.ok(dispatch(`run_retry_b_${id}`, "again"));
    expect(retry).toMatchObject({ promptError: null });
    await waitFor(() => userItems() === 2, 30000, "second prompt");
    await waitFor(() => h.agent.supervisor.record(id)?.runtime === "idle", 30000, "idle");

    const again = await h.coord.ok(dispatch(`run_retry_b_${id}`, "again"));
    expect(again).toMatchObject({ reused: true, promptError: null });
    await new Promise((r) => setTimeout(r, 300));
    expect(userItems()).toBe(2);
    await h.coord.ok({ type: "session.stop", sessionId: id });
  });

  it("a launch prompt Pi refuses is reported, not thrown", async () => {
    const id = sid();
    const dispatch = (key: string, prompt: string): HostCommand => ({
      type: "dispatch.start",
      dispatchKey: key,
      runId: key,
      taskId: "tsk_refused",
      sessionId: id,
      projectId: "prj_1",
      title: "Refused",
      workspace: { path: h.pi!.cwd },
      nativeHandle: null,
      profile: mockProfile,
      prompt,
      controlRevision: 1,
      controlMode: "automation",
    });
    await h.coord.ok(dispatch(`run_refused_a_${id}`, "work slowly"));
    await waitFor(() => h.agent.supervisor.record(id)?.runtime === "running", 30000, "running");
    const retry = await h.coord.ok(dispatch(`run_refused_b_${id}`, "again"));
    expect(retry.promptError).toMatch(/Session is running/);
    expect(
      items(h, id).some(
        (i) => i.kind === "notice" && (i.data as any).text.startsWith(PROMPT_NOT_SENT),
      ),
    ).toBe(true);
    await h.coord.ok({ type: "session.stop", sessionId: id });
  });

  it("two concurrent answers: one answered, one already_answered, Pi gets one response", async () => {
    const id = sid();
    await startSession(h, id, h.pi!.cwd);
    const proc = h.agent.supervisor.managedSession(id)!.process!;
    const responses: unknown[] = [];
    const original = proc.respondUi.bind(proc);
    proc.respondUi = (reqId: string, body: any) => {
      responses.push({ reqId, body });
      return original(reqId, body);
    };
    await h.coord.ok({
      type: "session.prompt",
      sessionId: id,
      text: "please pick a fruit",
      images: [],
      mode: "prompt",
      origin: "human",
      controlRevision: 1,
    });
    await waitFor(
      () => interactions(h, id).some((i) => i.state === "pending"),
      30000,
      "pending interaction",
    );
    const pending = interactions(h, id).find((i) => i.state === "pending")!;
    expect(pending).toMatchObject({
      revision: 1,
      adapterId: null,
      title: "Pick a fruit",
      source: { kind: "extension_ui", method: "select" },
    });
    expect(
      items(h, id).some((i) => i.kind === "interaction" && i.data.interactionId === pending.id),
    ).toBe(true);
    const answer = (value: string, deviceId: string): HostCommand => ({
      type: "session.answer",
      sessionId: id,
      interactionId: pending.id,
      revision: 1,
      response: { kind: "form", values: { value } },
      deviceId,
    });
    const [a, b] = await Promise.all([
      h.coord.ok(answer("Banana", "dev_a")),
      h.coord.ok(answer("Apple", "dev_b")),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(["already_answered", "answered"]);
    const winner = a.status === "answered" ? a : b;
    expect(winner.interaction).toMatchObject({
      state: "resolved",
      revision: 2,
      resolution: { by: "dev_a", summary: "Answered: Banana" },
    });
    const loser = a.status === "answered" ? b : a;
    expect(loser.interaction).toMatchObject({ state: "resolved", resolution: { by: "dev_a" } });

    const settled = await h.coord.waitEvent(isSettled(id), 30000, "settled after answer");
    expect((settled.data as any).lastAssistantText).toBe("tool said: selected Banana");
    expect(responses).toEqual([
      {
        reqId: pending.source.kind === "extension_ui" ? pending.source.piRequestIds[0] : "",
        body: { value: "Banana" },
      },
    ]);
    // A late answer after resolution is also already_answered.
    const late = await h.coord.ok(answer("Apple", "dev_c"));
    expect(late.status).toBe("already_answered");
    await h.coord.ok({ type: "session.stop", sessionId: id });
  });

  it("expires a pending interaction when Pi closes the dialog (abort)", async () => {
    const id = sid();
    await startSession(h, id, h.pi!.cwd, { initialPrompt: "please pick a fruit" });
    await waitFor(
      () => interactions(h, id).some((i) => i.state === "pending"),
      30000,
      "pending interaction",
    );
    const pending = interactions(h, id).find((i) => i.state === "pending")!;
    await h.coord.ok({ type: "session.abort", sessionId: id, clearQueue: true });
    await waitFor(
      () => interactions(h, id).some((i) => i.id === pending.id && i.state === "expired"),
      15000,
      "expired interaction",
    );
    const expired = interactions(h, id)
      .filter((i) => i.id === pending.id)
      .at(-1)!;
    expect(expired).toMatchObject({
      state: "expired",
      revision: 2,
      resolution: { by: "pi", summary: "Pi closed this question (timeout or abort)" },
    });
    const late = await h.coord.ok({
      type: "session.answer",
      sessionId: id,
      interactionId: pending.id,
      revision: 1,
      response: { kind: "form", values: { value: "Apple" } },
      deviceId: "dev_a",
    });
    expect(late).toMatchObject({ status: "already_answered", interaction: { state: "expired" } });
    await h.coord.ok({ type: "session.stop", sessionId: id });
  });

  it("rejects automation prompts with a stale control revision", async () => {
    const id = sid();
    await startSession(h, id, h.pi!.cwd, { controlMode: "automation", origin: "automation" });
    const prompt = (
      origin: "human" | "automation",
      controlRevision: number,
      text = "hello",
    ): HostCommand => ({
      type: "session.prompt",
      sessionId: id,
      text,
      images: [],
      mode: "prompt",
      origin,
      controlRevision,
    });
    // Takeover: revision 2, human.
    expect(
      await h.coord.ok({
        type: "session.setControl",
        sessionId: id,
        controlRevision: 2,
        mode: "human",
      }),
    ).toEqual({ controlRevision: 2, controlMode: "human" });
    const stale = await h.coord.command(prompt("automation", 1));
    expect(stale).toMatchObject({ ok: false, error: { code: "stale_control" } });
    const sameRevHuman = await h.coord.command(prompt("automation", 2));
    expect(sameRevHuman).toMatchObject({ ok: false, error: { code: "stale_control" } });
    // Humans can always prompt.
    await h.coord.ok(prompt("human", 1));
    await h.coord.waitEvent(isSettled(id), 30000, "human prompt settled");
    // Return to automation: revision 3.
    await h.coord.ok({
      type: "session.setControl",
      sessionId: id,
      controlRevision: 3,
      mode: "automation",
    });
    // An older setControl does not roll it back.
    expect(
      await h.coord.ok({
        type: "session.setControl",
        sessionId: id,
        controlRevision: 2,
        mode: "human",
      }),
    ).toEqual({ controlRevision: 3, controlMode: "automation" });
    await expect(h.coord.ok(prompt("automation", 3, "hello again"))).resolves.toMatchObject({
      disposition: "started",
    });
    const log = h.agent.router.commandLog.filter(
      (c) => c.sessionId === id && c.type === "session.prompt",
    );
    expect(log.map((c) => c.outcome)).toEqual(["stale_control", "stale_control", "ok", "ok"]);
    await h.coord.ok({ type: "session.stop", sessionId: id });
  });

  it("a takeover that arrives before the launch creates the session withholds the launch prompt", async () => {
    const id = sid();
    // The coordinator's takeover (revision 2) reaches the host while the launch prepares.
    expect(
      await h.coord.ok({
        type: "session.setControl",
        sessionId: id,
        controlRevision: 2,
        mode: "human",
      }),
    ).toEqual({ controlRevision: 2, controlMode: "human" });
    const started = await h.coord.ok({
      type: "dispatch.start",
      dispatchKey: `run_takeover_${id}`,
      runId: `run_takeover_${id}`,
      taskId: "tsk_takeover",
      sessionId: id,
      projectId: "prj_1",
      title: "Taken over",
      workspace: { path: h.pi!.cwd },
      nativeHandle: null,
      profile: mockProfile,
      prompt: "hello from automation",
      controlRevision: 1,
      controlMode: "automation",
    });
    expect(started).toMatchObject({ sessionId: id, reused: false });
    await waitFor(() => h.agent.supervisor.isLive(id), 15000, "live");
    await new Promise((r) => setTimeout(r, 300));
    expect(h.agent.supervisor.controlOf(id)).toEqual({ controlRevision: 2, controlMode: "human" });
    expect(items(h, id).filter((i) => i.kind === "user")).toEqual([]);
    expect(h.agent.supervisor.record(id)?.runtime).toBe("idle");

    // An equal revision never hands control back to automation.
    expect(
      await h.coord.ok({
        type: "session.setControl",
        sessionId: id,
        controlRevision: 2,
        mode: "automation",
      }),
    ).toEqual({ controlRevision: 2, controlMode: "human" });
    const sameRev = await h.coord.command({
      type: "session.prompt",
      sessionId: id,
      text: "automated",
      images: [],
      mode: "prompt",
      origin: "automation",
      controlRevision: 2,
    });
    expect(sameRev).toMatchObject({ ok: false, error: { code: "stale_control" } });
    expect(items(h, id).filter((i) => i.kind === "user")).toEqual([]);

    // A strictly newer automation command (return to automation whose setControl was missed)
    // is accepted and records automation control, so later continuations are not stalled.
    await h.coord.ok({
      type: "session.prompt",
      sessionId: id,
      text: "continue",
      images: [],
      mode: "prompt",
      origin: "automation",
      controlRevision: 3,
    });
    expect(h.agent.supervisor.controlOf(id)).toEqual({
      controlRevision: 3,
      controlMode: "automation",
    });
    await h.coord.waitEvent(isSettled(id), 30000, "automation prompt settled");
    const next = await h.coord.command({
      type: "session.prompt",
      sessionId: id,
      text: "continue again",
      images: [],
      mode: "prompt",
      origin: "automation",
      controlRevision: 3,
    });
    expect(next).toMatchObject({ ok: true });
    await h.coord.ok({ type: "session.stop", sessionId: id });
  });

  it("turns ctx.ui.custom() into an unsupported interaction with abort/message actions", async () => {
    const id = sid();
    await startSession(h, id, h.pi!.cwd);
    await h.coord.ok({
      type: "session.prompt",
      sessionId: id,
      text: "open custom ui",
      images: [],
      mode: "prompt",
      origin: "human",
      controlRevision: 1,
    });
    await h.coord.waitEvent(isSettled(id), 30000, "custom settled");
    await waitFor(() => interactions(h, id).length > 0, 10000, "unsupported interaction");
    const i = interactions(h, id)[0]!;
    expect(i).toMatchObject({
      state: "unsupported",
      source: { kind: "unsupported_custom" },
      title: "Terminal-only interface requested",
      presentation: {
        t: "section",
        title: "Terminal-only interface requested",
        children: [
          { t: "text", text: expect.stringContaining("In RPC mode Pi gave it no answer") },
          {
            t: "actions",
            actions: [
              expect.objectContaining({ id: "abort", label: "Stop the run" }),
              expect.objectContaining({ id: "message", label: "Send a message to Pi" }),
            ],
          },
        ],
      },
    });
    const tool = items(h, id)
      .filter((x) => x.kind === "tool")
      .at(-1)!;
    expect((tool.data as any).output).toContain("custom returned undefined");
    const r = await h.coord.ok({
      type: "session.answer",
      sessionId: id,
      interactionId: i.id,
      revision: i.revision,
      response: { kind: "action", actionId: "message" },
      deviceId: "dev_a",
    });
    expect(r).toMatchObject({
      status: "answered",
      interaction: {
        state: "unsupported",
        resolution: { by: "dev_a", summary: "Send a message to Pi" },
      },
    });
    // The resolution is published (the coordinator resolves its attention from it), and only
    // one alternative is ever accepted.
    await waitFor(
      () => interactions(h, id).some((x) => x.id === i.id && x.resolution !== null),
      10000,
      "resolution event",
    );
    const second = await h.coord.ok({
      type: "session.answer",
      sessionId: id,
      interactionId: i.id,
      revision: i.revision,
      response: { kind: "action", actionId: "abort" },
      deviceId: "dev_b",
    });
    expect(second).toMatchObject({
      status: "already_answered",
      interaction: { resolution: { by: "dev_a" } },
    });
    await h.coord.ok({ type: "session.stop", sessionId: id });
  });

  it("expires an unanswered terminal-only dialog when Pi exits", async () => {
    const id = sid();
    await startSession(h, id, h.pi!.cwd);
    await h.coord.ok({
      type: "session.prompt",
      sessionId: id,
      text: "open custom ui",
      images: [],
      mode: "prompt",
      origin: "human",
      controlRevision: 1,
    });
    await h.coord.waitEvent(isSettled(id), 30000, "custom settled");
    await waitFor(() => interactions(h, id).length > 0, 10000, "unsupported interaction");
    const i = interactions(h, id)[0]!;
    expect(i).toMatchObject({ state: "unsupported", resolution: null });
    await h.coord.ok({ type: "session.stop", sessionId: id });
    await waitFor(
      () => interactions(h, id).some((x) => x.id === i.id && x.state === "expired"),
      10000,
      "dialog expired",
    );
    expect(interactions(h, id).at(-1)).toMatchObject({
      id: i.id,
      state: "expired",
      revision: i.revision + 1,
      resolution: { by: "host", summary: "Pi exited before this question was answered" },
    });
    expect(h.agent.supervisor.pendingInteractions(id)).toEqual([]);
  });

  it("maps notify/setStatus/setWidget to notices and generic panels", async () => {
    const id = sid();
    await startSession(h, id, h.pi!.cwd, { initialPrompt: "set status please" });
    await h.coord.waitEvent(isSettled(id), 30000, "status settled");
    await waitFor(() => h.coord.eventsOf("panel.updated", id).length >= 2, 10000, "panels");
    const panels = h.coord.eventsOf("panel.updated", id).map((e) => e.data as any);
    expect(panels.find((p) => p.slot === "status")).toMatchObject({ adapterId: "generic" });
    expect(panels.find((p) => p.slot === "widget:fixture")).toMatchObject({
      mobileFallback: "fixture widget line 1\nfixture widget line 2",
    });
    expect(
      items(h, id).some((i) => i.kind === "notice" && i.data.text === "fixture notified"),
    ).toBe(true);
    const snap = await h.coord.ok({ type: "session.snapshot", sessionId: id });
    expect(snap).toMatchObject({ partial: [], pendingInteractions: [], runtime: "idle" });
    await h.coord.ok({ type: "session.stop", sessionId: id });
  });
});
