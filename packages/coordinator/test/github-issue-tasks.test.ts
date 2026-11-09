import { DEFAULT_TASK_POLICY, githubIssueFromUrl, MARKERS, type Task } from "@switchyard/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { requireService } from "../src/index.js";
import { buildRunPrompt } from "../src/tasks/dispatcher.js";
import { until } from "./helpers.js";
import {
  cleanupHarness,
  commandsOf,
  createTask,
  dispatcherOf,
  type Harness,
  NO_REPLY,
  runOf,
  settle,
  setupHarness,
  task,
  untilRun,
} from "./task-helpers.js";

const url = "https://github.com/Owner/Repo/issues/17";
const prompt = `${url}\n\nRead it with \`gh issue view ${url}\`.`;
let h: Harness | undefined;
afterEach(async () => {
  await cleanupHarness(h);
  h = undefined;
});

async function importIssue(body: Record<string, unknown> = {}): Promise<Task> {
  return createTask(h!, {
    title: undefined,
    objective: "",
    acceptanceCriteria: [],
    githubIssueUrl: url,
    ...body,
  });
}

describe("issue task storage", () => {
  it("derives canonical immutable metadata without contacting GitHub and preserves normal selections", async () => {
    h = await setupHarness();
    const parent = await createTask(h);
    const dependency = await createTask(h);
    const before = h.host.commands.length;
    const tk = await importIssue({
      githubIssueUrl: "  HTTPS://GITHUB.COM/Owner/Repo/issues/17  ",
      parentTaskId: parent.id,
      dependencies: [dependency.id],
      priority: 1,
      notBefore: "2027-01-01T00:00:00.000Z",
      policy: { hostId: h.creds.hostId, workspace: { branch: "issue-17" } },
    });
    expect(tk).toMatchObject({
      title: "Owner/Repo #17",
      objective: url,
      acceptanceCriteria: [],
      githubIssue: { repository: "Owner/Repo", number: 17, url, launchPrompt: prompt },
      parentTaskId: parent.id,
      dependencies: [dependency.id],
      priority: 1,
      notBefore: "2027-01-01T00:00:00.000Z",
      state: "backlog",
      policy: {
        hostId: h.creds.hostId,
        workspace: { mode: "new_worktree", branch: "issue-17", base: null },
        continuation: DEFAULT_TASK_POLICY.continuation,
        completion: DEFAULT_TASK_POLICY.completion,
      },
    });
    expect(task(h, tk.id)).toEqual(tk);
    expect(tk.githubIssue!.launchPrompt.endsWith("\n")).toBe(false);
    expect(h.host.commands.slice(before)).toEqual([]);
    expect(h.t.c.store.runs.count()).toBe(0);
    const ordinary = await createTask(h, { objective: url });
    expect(ordinary.githubIssue).toBeUndefined();
    expect(ordinary.objective).toBe(url);
  });

  it("allows ordinary patches and reparenting but never changes the saved first-launch prompt", async () => {
    h = await setupHarness();
    const tk = await importIssue({ title: "  Custom title  " });
    expect(tk.title).toBe("Custom title");
    const parent = await createTask(h);
    const patched = await h.t.admin("PATCH", `/api/tasks/${tk.id}`, {
      title: "Later title",
      objective: "Later objective",
      acceptanceCriteria: ["Later acceptance"],
      parentTaskId: parent.id,
      policy: { completion: { checks: ["pnpm test"] } },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.githubIssue).toEqual(tk.githubIssue);
    expect(buildRunPrompt(patched.body, 1)).toBe(prompt);
    for (const field of ["githubIssueUrl", "githubIssue", "launchPrompt"]) {
      const before = task(h, tk.id);
      const rejected = await h.t.admin("PATCH", `/api/tasks/${tk.id}`, { [field]: url });
      expect(rejected.status).toBe(400);
      expect(task(h, tk.id)).toEqual(before);
    }
    const moved = await h.t.admin("POST", `/api/tasks/${tk.id}/move`, { to: "ready" });
    expect(moved.status).toBe(200);
    expect(moved.body.githubIssue).toEqual(tk.githubIssue);
  });

  it.each([
    { githubIssueUrl: null },
    { githubIssueUrl: "" },
    { githubIssueUrl: "   " },
    { githubIssueUrl: `${url}?extra=1` },
    { objective: "Hidden initial instruction" },
    { acceptanceCriteria: ["Hidden acceptance"] },
    { policy: { continuation: { enabled: true } } },
    { policy: { completion: { requireHumanReview: false } } },
    { githubIssue: githubIssueFromUrl(url) },
    { launchPrompt: "Client prompt" },
  ])("rejects conflicting/forbidden creation input with no writes: %j", async (invalid) => {
    h = await setupHarness();
    const { store } = h.t.c;
    const before = { tasks: store.tasks.list(), seq: store.currentSeq() };
    const res = await h.t.admin("POST", "/api/tasks", {
      projectId: h.project.id,
      githubIssueUrl: url,
      ...invalid,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_request");
    expect(store.tasks.list()).toEqual(before.tasks);
    expect(store.currentSeq()).toBe(before.seq);
    expect(store.st.get("SELECT * FROM task_subscriptions").all()).toEqual([]);
  });
});

describe("issue logical launch", () => {
  it("never wraps the first issue prompt with title, acceptance, feedback or watch markers", () => {
    const current = {
      title: "Not part of the initial prompt",
      objective: "Current objective",
      acceptanceCriteria: ["Current acceptance"],
      githubIssue: githubIssueFromUrl(url),
    };
    expect(buildRunPrompt(current, 1, ["Feedback"], { watch: true })).toBe(prompt);
    const later = buildRunPrompt(current, 2, ["Feedback"], { watch: true });
    expect(later).toContain("# Task: Not part of the initial prompt");
    expect(later).toContain("Current objective");
    expect(later).toContain("- Current acceptance");
    expect(later).toContain("- Feedback");
    expect(later).toContain(MARKERS.noChange);
    expect(later).toContain(MARKERS.done);
  });

  it("sends the exact frozen prompt even after edits before the first launch", async () => {
    h = await setupHarness();
    const tk = await importIssue();
    await h.t.admin("PATCH", `/api/tasks/${tk.id}`, {
      title: "Edited title",
      objective: "Edited objective",
      acceptanceCriteria: ["Edited acceptance"],
    });
    await h.t.admin("POST", `/api/tasks/${tk.id}/move`, { to: "ready" });
    await untilRun(h, tk.id, "running");
    expect(commandsOf(h.host, "dispatch.start")[0]!.prompt).toBe(prompt);
  });

  it("preserves exact first prompt across infrastructure retries within attempt one", async () => {
    h = await setupHarness();
    let fail = true;
    h.override = (cmd) =>
      cmd.type === "dispatch.start" && fail
        ? { __error: { code: "internal", message: "spawn failed before start" } }
        : undefined;
    const tk = await importIssue({ state: "ready" });
    await untilRun(h, tk.id, "queued");
    expect(runOf(h, tk.id)).toMatchObject({ attempt: 1, infraRetries: 1 });
    await h.t.admin("PATCH", `/api/tasks/${tk.id}`, { objective: "New text during backoff" });
    fail = false;
    h.t.clock.advance(31_000);
    dispatcherOf(h).tick();
    const run = await untilRun(h, tk.id, "running");
    expect(run).toMatchObject({ attempt: 1, infraRetries: 1 });
    const starts = commandsOf(h.host, "dispatch.start");
    expect(starts).toHaveLength(2);
    expect(starts.map((cmd) => cmd.prompt)).toEqual([prompt, prompt]);
    expect(starts[0]!.dispatchKey).not.toBe(starts[1]!.dispatchKey);
  });

  it("freezes transport resends and then uses current details/feedback in the reused session on attempt two", async () => {
    h = await setupHarness({
      coordinator: { dispatcher: { tickMs: 0, startTimeoutMs: 100 } },
      checks: ["pnpm test"],
    });
    let drop = true;
    h.override = (cmd) => (cmd.type === "dispatch.start" && drop ? NO_REPLY : undefined);
    const tk = await importIssue({ state: "ready" });
    const first = await untilRun(h, tk.id, "uncertain");
    await h.t.admin("PATCH", `/api/tasks/${tk.id}`, {
      title: "Current title",
      objective: "Current objective",
      acceptanceCriteria: ["Current acceptance"],
    });
    drop = false;
    await h.host.close();
    await h.host.open();
    const running = await untilRun(h, tk.id, "running");
    expect(running.id).toBe(first.id);
    const starts = commandsOf(h.host, "dispatch.start");
    expect(starts.length).toBeGreaterThanOrEqual(2);
    expect(starts.every((cmd) => cmd.prompt === prompt)).toBe(true);
    expect(new Set(starts.map((cmd) => cmd.dispatchKey))).toEqual(new Set([first.dispatchKey]));
    // A markerless issue turn still goes through normal checks to Review, without continuation.
    await settle(h, running.sessionId!, "Read the issue and completed the requested work.");
    await until(() => task(h!, tk.id).state === "review");
    expect(commandsOf(h.host, "session.prompt")).toHaveLength(0);
    expect(commandsOf(h.host, "checks.run")[0]!.commands).toEqual(["pnpm test"]);
    expect(
      (
        await h.t.admin("POST", `/api/tasks/${tk.id}/request-changes`, {
          feedback: ["Add coverage"],
        })
      ).status,
    ).toBe(200);
    // Issue mode does not bypass D.4's protected live-session launch gate.
    const unsupported = await h.t.admin("POST", `/api/tasks/${tk.id}/new-attempt`);
    expect(unsupported.status).toBe(409);
    expect(unsupported.body.error.message).toContain("Policy enforcement needs an updated host");
    const { store } = h.t.c;
    const session = store.sessions.require(running.sessionId!);
    const nativeSessionId = session.nativeHandle!.sessionId;
    store.putSession({
      ...session,
      bridge: {
        version: 1,
        runtimeId: "bridge-runtime",
        controllerEpoch: "controller-epoch",
        nativeSessionId,
        agentTools: true,
        messageDelivery: true,
        policyState: "active",
        policyPhases: ["request", "tool_call"],
      },
    });
    const root = store.workspaces.require(session.workspaceId!).path;
    requireService(h.t.c.ctx, "policies").bindBoundary(
      {
        authenticatedHostId: session.hostId,
        sessionId: session.id,
        nativeSessionId,
        runtimeId: "bridge-runtime",
      },
      { cwd: session.cwd, cwdReal: session.cwd, workspaceRoot: root, workspaceRootReal: root },
    );
    const nextAttempt = await h.t.admin("POST", `/api/tasks/${tk.id}/new-attempt`);
    expect(nextAttempt.status, JSON.stringify(nextAttempt.body)).toBe(200);
    const next = await untilRun(h, tk.id, "running");
    expect(next.attempt).toBe(2);
    expect(next.sessionId).toBe(first.sessionId);
    const [sent] = commandsOf(h.host, "session.prompt");
    expect(sent!.text).toBe(buildRunPrompt(task(h, tk.id), 2, ["Add coverage"]));
    expect(sent!.text).toContain("# Task: Current title");
    expect(sent!.text).toContain("Current objective");
    expect(sent!.text).toContain("- Current acceptance");
    expect(sent!.text).toContain("- Add coverage");
    expect(sent!.text).toContain(MARKERS.done);
    expect(task(h, tk.id).githubIssue!.launchPrompt).toBe(prompt);
  });

  it("preserves the explicit BLOCKED outcome instead of the markerless Review fallback", async () => {
    h = await setupHarness();
    const tk = await importIssue({ state: "ready" });
    const run = await untilRun(h, tk.id, "running");
    await settle(h, run.sessionId!, "SWITCHYARD: BLOCKED missing issue access");
    await untilRun(h, tk.id, "failed");
    expect(task(h, tk.id)).toMatchObject({
      state: "in_progress",
      blocked: { reason: "missing issue access" },
    });
    expect(commandsOf(h.host, "session.prompt")).toHaveLength(0);
  });
});
