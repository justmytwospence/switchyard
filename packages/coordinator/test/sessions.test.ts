// @module-tag slow
import type { HostCommand, HostCommandOf } from "@switchyard/protocol";
import { FakeRepositoryProvider, fixtureRepository } from "@switchyard/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import {
  attachFixtureCheckout,
  enrollHost,
  FakeHost,
  hostSession,
  sleep,
  startCoordinator,
  syncFixtureProject,
  type TestCoordinator,
  until,
} from "./helpers.js";
import { fullCapabilities } from "./task-helpers.js";

let t: TestCoordinator | undefined;
let host: FakeHost | undefined;
const releaseHandlers: (() => void)[] = [];
afterEach(async () => {
  for (const release of releaseHandlers.splice(0)) release();
  await sleep(0);
  await host?.close();
  host = undefined;
  await t?.cleanup();
  t = undefined;
});

const ROOT = "/repos/app";
const APP_REPO = fixtureRepository("me", "app");
const UNLISTED_ROOT = "/repos/unlisted";

function gitHandler(cmd: HostCommand): unknown {
  switch (cmd.type) {
    case "checkout.inspect":
      if (cmd.path === "/not/git") return { __error: { code: "not_a_git_repo", message: "no" } };
      return {
        root: cmd.path,
        commonDir: `${cmd.path}/.git`,
        repoIdentity:
          cmd.path === UNLISTED_ROOT ? "https://github.com/me/unlisted" : APP_REPO.webUrl,
        defaultBranch: "main",
      };
    case "workspace.discover":
      return [
        {
          path: ROOT,
          head: "abc",
          branch: "refs/heads/main",
          bare: false,
          detached: false,
          locked: false,
          prunable: false,
          provenance: "main",
          git: null,
        },
        {
          path: "/tmp/external",
          head: "def",
          branch: "refs/heads/spike",
          bare: false,
          detached: false,
          locked: false,
          prunable: false,
          provenance: "discovered",
          git: null,
        },
      ];
    case "workspace.create":
      return { path: `${cmd.checkoutPath}/.worktrees/${cmd.branch.replaceAll("/", "-")}` };
    case "session.start":
      return {
        nativeHandle: {
          sessionId: `n-${cmd.sessionId}`,
          sessionFile: `/s/n-${cmd.sessionId}.jsonl`,
        },
      };
    default:
      return null;
  }
}

async function setup(options: Parameters<typeof startCoordinator>[0] = {}) {
  t = await startCoordinator({
    repositoryProvider: new FakeRepositoryProvider(() => [APP_REPO]),
    ...options,
  });
  const listed = await syncFixtureProject(t.c, APP_REPO);
  const creds = await enrollHost(t);
  host = await FakeHost.connect(t, creds, gitHandler);
  const project = await attachFixtureCheckout(
    t.admin,
    listed.id,
    { hostId: creds.hostId, path: ROOT },
    { name: "App", defaultHostId: creds.hostId },
  );
  return { creds, project };
}

describe("projects and workspaces", () => {
  it("attaches a verified checkout to a listed project and discovers workspaces", async () => {
    const { creds, project } = await setup();
    expect(project.repoIdentity).toBe("https://github.com/me/app");
    expect(project.defaultHostId).toBe(creds.hostId);
    expect(project.checkouts).toHaveLength(1);
    expect(project.workspaces.map((w: { provenance: string }) => w.provenance).sort()).toEqual([
      "discovered",
      "main",
    ]);
    const main = project.workspaces.find((w: { provenance: string }) => w.provenance === "main");
    expect(main.branch).toBe("main");

    const checkoutPath = `/api/projects/${project.id}/checkouts`;
    const dupe = await t!.admin("POST", checkoutPath, { hostId: creds.hostId, path: ROOT });
    expect(dupe.body.checkout.id).toBe(project.checkouts[0].id);
    const bad = await t!.admin("POST", checkoutPath, { hostId: creds.hostId, path: "/not/git" });
    expect(bad.body.error.code).toBe("not_a_git_repo");
    const mismatch = await t!.admin("POST", checkoutPath, {
      hostId: creds.hostId,
      path: UNLISTED_ROOT,
    });
    expect(mismatch.body.error.code).toBe("repo_mismatch");

    const ws = await t!.admin("POST", "/api/workspaces", {
      checkoutId: project.checkouts[0].id,
      branch: "feat/x",
    });
    expect(ws.status).toBe(201);
    expect(ws.body).toMatchObject({
      path: `${ROOT}/.worktrees/feat-x`,
      provenance: "managed",
      baseBranch: "main",
    });

    const rm = await t!.admin("POST", `/api/workspaces/${ws.body.id}/remove`, {
      force: { dirty: true, unmerged: false },
    });
    expect(rm.status).toBe(200);
    const removeCmd = host!.commands.find((c) => c.command.type === "workspace.remove")!
      .command as HostCommandOf<"workspace.remove">;
    expect(removeCmd.force).toEqual({ dirty: true, unmerged: false });
    expect(t!.c.store.workspaces.get(ws.body.id)?.archivedAt).not.toBeNull();
    const last = t!.c.store
      .latestEvents("workspace.updated", 50)
      .find((e) => (e.data as { id: string }).id === ws.body.id)!;
    expect((last.data as { archivedAt: string | null }).archivedAt).not.toBeNull();
  });

  it("does not create projects through the legacy POST, even for a valid checkout", async () => {
    const { creds, project } = await setup();
    const result = await t!.admin("POST", "/api/projects", {
      name: "Unlisted",
      hostId: creds.hostId,
      path: UNLISTED_ROOT,
    });
    expect(result.status).toBe(409);
    expect(result.body.error.message).toContain("Projects come from your Git provider");
    expect(t!.c.store.projects.list().map((p) => p.id)).toEqual([project.id]);
  });
});

describe("sessions", () => {
  const uncertain =
    "The host has not confirmed startup yet. Pi may still be starting; check the terminal before retrying.";

  function holdCommand(type: HostCommand["type"], result?: unknown) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    releaseHandlers.push(release);
    host!.handler = async (cmd) => {
      if (cmd.type !== type) return gitHandler(cmd);
      await gate;
      return result === undefined ? gitHandler(cmd) : result;
    };
    return release;
  }

  async function releaseAndFlush(release: () => void) {
    release();
    // Let the deferred handler send its receipt, then use an event ack as a wire-order barrier.
    await sleep(0);
    await host!.event("session.updated", hostSession("ses_receipt_barrier"));
  }

  async function createInMain(project: {
    id: string;
    workspaces: { id: string; provenance: string }[];
  }) {
    const main = project.workspaces.find((w: { provenance: string }) => w.provenance === "main");
    const r = await t!.admin("POST", "/api/sessions", {
      projectId: project.id,
      workspace: { existingId: main!.id },
      prompt: "",
    });
    expect(r.status).toBe(202);
    return r.body.id as string;
  }

  function expectNoErrorNotice(id: string) {
    expect(
      t!.c.store
        .listItems(id)
        .items.filter((item) => item.kind === "notice" && item.data.level === "error"),
    ).toHaveLength(0);
  }

  it("uses separate production command and session start defaults", async () => {
    await setup();
    expect(t!.c.config.commandTimeoutMs).toBe(30_000);
    expect(t!.c.config.sessionStartTimeoutMs).toBe(17 * 60_000);
  });

  it("waits for a start receipt beyond the generic command deadline", async () => {
    const { project } = await setup({ commandTimeoutMs: 50, sessionStartTimeoutMs: 1000 });
    const release = holdCommand("session.start");
    const id = await createInMain(project);
    await host!.waitForCommand("session.start");
    await sleep(120);
    await host!.event("session.updated", hostSession(id, { runtime: "idle", nativeHandle: null }));
    release();
    await until(() => t!.c.store.sessions.require(id).nativeHandle?.sessionId === `n-${id}`);
    expect(t!.c.store.sessions.require(id).runtime).toBe("idle");
    expectNoErrorNotice(id);
  });

  it("keeps a timed-out start uncertain and accepts a later host update", async () => {
    const { project } = await setup({ sessionStartTimeoutMs: 80 });
    const release = holdCommand("session.start");
    const id = await createInMain(project);
    await host!.waitForCommand("session.start");
    await until(() => t!.c.store.sessions.require(id).runtimeDetail === uncertain);
    expect(t!.c.store.sessions.require(id).runtime).toBe("starting");
    expectNoErrorNotice(id);
    await host!.event(
      "session.updated",
      hostSession(id, { runtime: "idle", runtimeDetail: "Ready" }),
    );
    await releaseAndFlush(release);
    expect(t!.c.store.sessions.require(id)).toMatchObject({
      runtime: "idle",
      runtimeDetail: "Ready",
      nativeHandle: hostSession(id).nativeHandle,
    });
    expectNoErrorNotice(id);
  });

  it("does not overwrite an idle host update when its start receipt times out", async () => {
    const { project } = await setup({ sessionStartTimeoutMs: 100 });
    const release = holdCommand("session.start");
    const id = await createInMain(project);
    await host!.waitForCommand("session.start");
    await host!.event(
      "session.updated",
      hostSession(id, { runtime: "idle", runtimeDetail: "Ready" }),
    );
    await sleep(180);
    await releaseAndFlush(release);
    expect(t!.c.store.sessions.require(id)).toMatchObject({
      runtime: "idle",
      runtimeDetail: "Ready",
      nativeHandle: hostSession(id).nativeHandle,
    });
    expectNoErrorNotice(id);
  });

  it.each([false, true])(
    "preserves resume state on timeout (idle before timeout: %s)",
    async (earlyIdle) => {
      await setup({ sessionStartTimeoutMs: 100 });
      const id = "ses_resume_timeout";
      await host!.event("session.updated", hostSession(id, { runtime: "stopped" }));
      const release = holdCommand("session.start");
      const pending = t!.admin("POST", `/api/sessions/${id}/resume`);
      await host!.waitForCommand("session.start");
      if (earlyIdle) {
        await host!.event(
          "session.updated",
          hostSession(id, { runtime: "idle", runtimeDetail: "Ready" }),
        );
      }
      const response = await pending;
      expect(response.body.error.code).toBe("timeout");
      expect(response.status).toBe(503);
      expect(t!.c.store.sessions.require(id)).toMatchObject(
        earlyIdle
          ? { runtime: "idle", runtimeDetail: "Ready" }
          : { runtime: "starting", runtimeDetail: uncertain },
      );
      if (!earlyIdle) {
        await host!.event(
          "session.updated",
          hostSession(id, { runtime: "idle", runtimeDetail: "Ready" }),
        );
      }
      await releaseAndFlush(release);
      expect(t!.c.store.sessions.require(id)).toMatchObject({
        runtime: "idle",
        runtimeDetail: "Ready",
        nativeHandle: hostSession(id).nativeHandle,
      });
      expectNoErrorNotice(id);
    },
  );

  it("does not send a prompt when its automatic resume times out", async () => {
    await setup({ sessionStartTimeoutMs: 80 });
    const id = "ses_prompt_timeout";
    await host!.event("session.updated", hostSession(id, { runtime: "stopped" }));
    const release = holdCommand("session.start");
    const response = await t!.admin("POST", `/api/sessions/${id}/prompt`, { text: "hello" });
    expect(response.body.error.code).toBe("timeout");
    expect(t!.c.store.sessions.require(id)).toMatchObject({
      runtime: "starting",
      runtimeDetail: uncertain,
    });
    expect(host!.commands.some((c) => c.command.type === "session.prompt")).toBe(false);
    release();
  });

  it("treats a worktree creation timeout as a definitive failure", async () => {
    const { project } = await setup({ commandTimeoutMs: 80, sessionStartTimeoutMs: 1000 });
    const release = holdCommand("workspace.create");
    const r = await t!.admin("POST", "/api/sessions", {
      projectId: project.id,
      workspace: { checkoutId: project.checkouts[0].id, newBranch: "timeout" },
      prompt: "",
    });
    expect(r.status).toBe(202);
    await until(() => t!.c.store.sessions.require(r.body.id).runtime === "failed");
    expect(t!.c.store.listItems(r.body.id).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "notice",
          data: expect.objectContaining({ level: "error" }),
        }),
      ]),
    );
    expect(host!.commands.some((c) => c.command.type === "session.start")).toBe(false);
    release();
  });

  it("does not replace idle with a delayed host refusal", async () => {
    const { project } = await setup({ sessionStartTimeoutMs: 1000 });
    const release = holdCommand("session.start", {
      __error: { code: "pi_incompatible", message: "Pi too old" },
    });
    const id = await createInMain(project);
    await host!.waitForCommand("session.start");
    await host!.event(
      "session.updated",
      hostSession(id, { runtime: "idle", runtimeDetail: "Ready" }),
    );
    await releaseAndFlush(release);
    expect(t!.c.store.sessions.require(id)).toMatchObject({
      runtime: "idle",
      runtimeDetail: "Ready",
    });
    expectNoErrorNotice(id);
  });

  it("rolls a resumed session back after a genuine host refusal", async () => {
    await setup();
    const id = "ses_resume_refused";
    await host!.event("session.updated", hostSession(id, { runtime: "stopped" }));
    host!.handler = (cmd) =>
      cmd.type === "session.start"
        ? { __error: { code: "pi_incompatible", message: "Pi too old" } }
        : gitHandler(cmd);
    const response = await t!.admin("POST", `/api/sessions/${id}/resume`);
    expect(response.body.error.code).toBe("pi_incompatible");
    expect(t!.c.store.sessions.require(id)).toMatchObject({
      runtime: "stopped",
      runtimeDetail: "Pi too old",
    });
  });

  it("creates a session in a new worktree, returns 202 and starts it on the host", async () => {
    const { project } = await setup();
    const r = await t!.admin("POST", "/api/sessions", {
      projectId: project.id,
      workspace: { checkoutId: project.checkouts[0].id, newBranch: "feat/y" },
      prompt: "Fix the login bug\nmore detail",
    });
    expect(r.status).toBe(202);
    expect(r.body.runtime).toBe("starting");
    expect(r.body.runtimeDetail).toBe("Creating worktree…");
    expect(r.body.title).toBe("Fix the login bug");
    const start = await host!.waitForCommand("session.start");
    const cmd = start.command as HostCommandOf<"session.start">;
    expect(cmd.workspacePath).toBe(`${ROOT}/.worktrees/feat-y`);
    expect(cmd.initialPrompt).toBe("Fix the login bug\nmore detail");
    expect(cmd.nativeHandle).toBeNull();
    expect(cmd.profile.name).toBe("Default");
    await until(() => !!t!.c.store.sessions.require(r.body.id).nativeHandle);
    const s = t!.c.store.sessions.require(r.body.id);
    expect(s.workspaceId).not.toBeNull();
    expect(s.nativeHandle?.sessionFile).toBe(`/s/n-${r.body.id}.jsonl`);
  });

  it("sets and clears the primary session, one per workspace", async () => {
    const { project } = await setup();
    const main = project.workspaces.find((w: { provenance: string }) => w.provenance === "main");
    const make = async () =>
      (
        await t!.admin("POST", "/api/sessions", {
          projectId: project.id,
          workspace: { existingId: main.id },
          prompt: "",
        })
      ).body.id as string;
    const a = await make();
    const b = await make();
    const set = (id: string, primary: boolean) =>
      t!.admin("POST", `/api/sessions/${id}/primary`, { primary });
    expect((await set(a, true)).body.primary).toBe(true);
    expect((await set(b, true)).body.primary).toBe(true);
    expect(t!.c.store.sessions.require(a).primary).toBe(false);
    expect((await set(b, false)).body.primary).toBe(false);
  });

  it("marks the session failed with an error item when the host refuses", async () => {
    const { project } = await setup();
    host!.handler = (cmd) =>
      cmd.type === "session.start"
        ? { __error: { code: "pi_incompatible", message: "Pi too old" } }
        : gitHandler(cmd);
    const main = project.workspaces.find((w: { provenance: string }) => w.provenance === "main");
    const r = await t!.admin("POST", "/api/sessions", {
      projectId: project.id,
      workspace: { existingId: main.id },
      prompt: "",
    });
    expect(r.status).toBe(202);
    await until(() => t!.c.store.sessions.require(r.body.id).runtime === "failed");
    const items = await t!.admin("GET", `/api/sessions/${r.body.id}/transcript`);
    expect(items.body.items[0]).toMatchObject({ kind: "notice", data: { level: "error" } });
    expect(items.body.items[0].data.text).toContain("Pi too old");
  });

  it("prompts, refuses resume without a handle, and resumes with --session", async () => {
    const { creds } = await setup();
    await host!.event("session.updated", hostSession("ses_p", { runtime: "idle" }));
    const p = await t!.admin("POST", "/api/sessions/ses_p/prompt", { text: "hi", mode: "steer" });
    expect(p.status).toBe(200);
    const prompt = (await host!.waitForCommand("session.prompt"))
      .command as HostCommandOf<"session.prompt">;
    expect(prompt).toMatchObject({ text: "hi", mode: "steer", origin: "human" });

    // Sending to a stopped session resumes it first, then sends.
    await host!.event("session.updated", hostSession("ses_p", { runtime: "interrupted" }));
    const auto = await t!.admin("POST", "/api/sessions/ses_p/prompt", { text: "x" });
    expect(auto.status).toBe(200);
    const kinds = host!.commands.map((c) => c.command.type);
    expect(kinds.lastIndexOf("session.start")).toBeLessThan(kinds.lastIndexOf("session.prompt"));
    const sent = host!.commands.filter((c) => c.command.type === "session.prompt").at(-1)!
      .command as HostCommandOf<"session.prompt">;
    expect(sent.text).toBe("x");
    // Steering never resumes.
    await host!.event("session.updated", hostSession("ses_p", { runtime: "stopped" }));
    const steer = await t!.admin("POST", "/api/sessions/ses_p/prompt", {
      text: "y",
      mode: "steer",
    });
    expect(steer.status).toBe(409);

    const resume = await t!.admin("POST", "/api/sessions/ses_p/resume");
    expect(resume.status).toBe(200);
    const start = (await host!.waitForCommand("session.start"))
      .command as HostCommandOf<"session.start">;
    expect(start.nativeHandle).toEqual({
      sessionId: "native-ses_p",
      sessionFile: "/tmp/native-ses_p.jsonl",
    });

    // A session that never got a native handle cannot be resumed.
    const s = t!.c.store.sessions.require("ses_p");
    t!.c.store.putSession({ ...s, id: "ses_nohandle", nativeHandle: null, runtime: "stopped" });
    const nr = await t!.admin("POST", "/api/sessions/ses_nohandle/resume");
    expect(nr.body.error.code).toBe("native_session_missing");
    expect(creds.hostId).toBeTruthy();
  });

  it("takeover without a run is refused; with a run it bumps controlRevision", async () => {
    await setup();
    await host!.event("session.updated", hostSession("ses_t", { runtime: "running" }));
    const none = await t!.admin("POST", "/api/sessions/ses_t/takeover");
    expect(none.status).toBe(400);

    const now = new Date().toISOString();
    t!.c.store.putRun({
      id: "run_1",
      taskId: "tsk_1",
      sessionId: "ses_t",
      hostId: null,
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
    });
    const r = await t!.admin("POST", "/api/sessions/ses_t/takeover");
    expect(r.status).toBe(200);
    expect(r.body.run).toMatchObject({ controlMode: "human", controlRevision: 2 });
    const setControl = (await host!.waitForCommand("session.setControl"))
      .command as HostCommandOf<"session.setControl">;
    expect(setControl).toMatchObject({ controlRevision: 2, mode: "human" });
    const back = await t!.admin("POST", "/api/sessions/ses_t/return-to-automation");
    expect(back.body.run).toMatchObject({ controlMode: "automation", controlRevision: 3 });
  });

  it("imports inactive native sessions with their transcript", async () => {
    const { creds } = await setup();
    host!.handler = (cmd) => {
      if (cmd.type === "session.importable") {
        return [
          {
            sessionFile: "/s/old.jsonl",
            sessionId: "old",
            cwd: ROOT,
            name: "Old work",
            mtime: new Date(0).toISOString(),
            inactive: true,
          },
          {
            sessionFile: "/s/live.jsonl",
            sessionId: "live",
            cwd: ROOT,
            name: null,
            mtime: new Date().toISOString(),
            inactive: false,
          },
        ];
      }
      if (cmd.type === "session.readNative") {
        return [
          {
            id: "itm_a",
            sessionId: "x",
            order: 0,
            at: new Date(0).toISOString(),
            kind: "user",
            data: { text: "q" },
          },
          {
            id: "itm_b",
            sessionId: "x",
            order: 1,
            at: new Date(0).toISOString(),
            kind: "assistant",
            data: { text: "a" },
          },
        ];
      }
      return gitHandler(cmd);
    };
    const list = await t!.admin("GET", `/api/sessions/importable?hostId=${creds.hostId}`);
    expect(list.body).toHaveLength(2);
    const live = await t!.admin("POST", "/api/sessions/import", {
      hostId: creds.hostId,
      sessionFile: "/s/live.jsonl",
    });
    expect(live.status).toBe(409);
    const imp = await t!.admin("POST", "/api/sessions/import", {
      hostId: creds.hostId,
      sessionFile: "/s/old.jsonl",
    });
    expect(imp.status).toBe(201);
    expect(imp.body).toMatchObject({
      provenance: "imported",
      runtime: "stopped",
      title: "Old work",
    });
    expect(imp.body.projectId).not.toBeNull();
    const tr = await t!.admin("GET", `/api/sessions/${imp.body.id}/transcript`);
    expect(tr.body.items.map((i: { kind: string }) => i.kind)).toEqual(["user", "assistant"]);
    expect(tr.body.items[0].sessionId).toBe(imp.body.id);
    const again = await t!.admin("POST", "/api/sessions/import", {
      hostId: creds.hostId,
      sessionFile: "/s/old.jsonl",
    });
    expect(again.status).toBe(409);
  });

  it("concurrent imports of one Pi session create one session", async () => {
    const { creds } = await setup();
    let open!: () => void;
    const gate = new Promise<void>((r) => {
      open = r;
    });
    host!.handler = async (cmd) => {
      if (cmd.type === "session.importable") {
        return [
          {
            sessionFile: "/s/old.jsonl",
            sessionId: "old",
            cwd: ROOT,
            name: "Old work",
            mtime: new Date(0).toISOString(),
            inactive: true,
          },
        ];
      }
      if (cmd.type === "session.readNative") {
        await gate;
        return [];
      }
      return gitHandler(cmd);
    };
    const post = () =>
      t!.admin("POST", "/api/sessions/import", {
        hostId: creds.hostId,
        sessionFile: "/s/old.jsonl",
      });
    const both = Promise.all([post(), post()]);
    await until(
      () => host!.commands.filter((c) => c.command.type === "session.readNative").length === 2,
    );
    open();
    const [a, b] = await both;
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const ok = a.status === 201 ? a : b;
    const conflict = a.status === 201 ? b : a;
    expect(conflict.body.error.details.sessionId).toBe(ok.body.id);
    expect(t!.c.store.sessions.list("native_session_file = ?", ["/s/old.jsonl"])).toHaveLength(1);
  });

  it("pages transcripts backwards", async () => {
    await setup();
    await host!.event("session.updated", hostSession("ses_pg"));
    for (let i = 0; i < 5; i++) {
      await host!.event("transcript.item", {
        id: `itm_${i}`,
        sessionId: "ses_pg",
        order: i,
        at: new Date().toISOString(),
        kind: "user",
        data: { text: `m${i}` },
      });
    }
    const last = await t!.admin("GET", "/api/sessions/ses_pg/transcript?limit=2");
    expect(last.body.items.map((i: { order: number }) => i.order)).toEqual([3, 4]);
    expect(last.body.hasMore).toBe(true);
    const prev = await t!.admin("GET", "/api/sessions/ses_pg/transcript?limit=2&before=3");
    expect(prev.body.items.map((i: { order: number }) => i.order)).toEqual([1, 2]);
  });

  it("transcript afterRev returns changed items for the same epoch and a reset page for another", async () => {
    await setup();
    await host!.event("session.updated", hostSession("ses_rv"));
    const put = (i: number, text: string) =>
      host!.event("transcript.item", {
        id: `itm_${i}`,
        sessionId: "ses_rv",
        order: i,
        at: new Date().toISOString(),
        kind: "user",
        data: { text },
      });
    await put(0, "a");
    await put(1, "b");
    const full = await t!.admin("GET", "/api/sessions/ses_rv/transcript");
    expect(full.body).toMatchObject({ epoch: 0, rev: 2 });
    await put(1, "b2");
    const d = await t!.admin("GET", "/api/sessions/ses_rv/transcript?afterRev=2&epoch=0");
    expect(d.body.delta).toBe(true);
    expect(d.body.items.map((i: { id: string }) => i.id)).toEqual(["itm_1"]);
    const r = await t!.admin("GET", "/api/sessions/ses_rv/transcript?afterRev=2&epoch=5");
    expect(r.body.reset).toBe(true);
    expect(r.body.items).toHaveLength(2);
  });

  it("refuses to archive a possibly live session while its host is offline", async () => {
    const { creds } = await setup();
    await host!.event("session.updated", hostSession("ses_idle", { runtime: "idle" }));
    await host!.event("session.updated", hostSession("ses_busy", { runtime: "running" }));
    await host!.event("session.updated", hostSession("ses_done", { runtime: "stopped" }));
    await host!.close();
    await until(() => !t!.c.hostHub.isConnected(creds.hostId));
    for (const id of ["ses_idle", "ses_busy"]) {
      const r = await t!.admin("POST", `/api/sessions/${id}/archive`);
      expect(r.status, id).toBe(503);
      expect(r.body.error.code).toBe("host_unreachable");
      expect(t!.c.store.sessions.require(id).archivedAt).toBeNull();
    }
    // No process can be live for a stopped session: archiving works offline.
    const done = await t!.admin("POST", "/api/sessions/ses_done/archive");
    expect(done.status).toBe(200);
    expect(done.body.archivedAt).not.toBeNull();
    // Back online, the idle session's Pi is stopped first, then it is archived.
    await host!.open();
    const ok = await t!.admin("POST", "/api/sessions/ses_idle/archive");
    expect(ok.status).toBe(200);
    expect(host!.commands.some((c) => c.command.type === "session.stop")).toBe(true);
  });
});

describe("session controls", () => {
  async function controlSetup(capable = true) {
    await setup();
    await host!.close();
    await host!.open({
      capabilities: capable ? fullCapabilities({ sessionControls: true }) : fullCapabilities(),
    });
    host!.handler = (cmd) => {
      switch (cmd.type) {
        case "session.models":
          return {
            models: [
              {
                provider: "mock",
                id: "m1",
                name: null,
                contextWindow: 1000,
                reasoning: false,
                thinkingLevels: ["off"],
              },
            ],
          };
        case "session.tree":
          return {
            rows: [
              {
                entryId: "e1",
                parentId: null,
                depth: 0,
                role: "user",
                text: "hi",
                activeBranch: true,
                leaf: true,
                label: null,
                at: null,
              },
            ],
          };
        case "session.branch":
          return { sessionFile: cmd.fork ? "/tmp/b.jsonl" : "/tmp/c.jsonl", prefill: "hi" };
        case "session.readNative":
          return { sessionId: "n2", cwd: "/repo", name: null, items: [] };
        case "session.reload":
          return { ok: true };
        case "session.export":
          return { fileName: "s.jsonl", content: "{}" };
        case "session.complete":
          return { items: [{ value: "x", label: "x", description: null }], prefix: "" };
        case "session.setModel":
        case "session.setThinking":
          return { model: null, thinking: "high" };
        default:
          return gitHandler(cmd);
      }
    };
    await host!.event("session.updated", hostSession("ses_c", { runtime: "idle" }));
  }

  it("negotiates contract v2 and clears the queue only on a host that can", async () => {
    await controlSetup();
    // The fake host's default hello is from before contract v2 and the queue command.
    expect(t!.c.hostHub.negotiatedFeatures(host!.hostId).has("adapterContract.v2")).toBe(false);
    const old = await t!.admin("POST", "/api/sessions/ses_c/queue/clear");
    expect(old.status).toBe(409);
    expect(old.body.error.code).toBe("unsupported_capability");

    await host!.close();
    const welcome = await host!.open({
      features: ["adapterContract.v2", "queueClear.v1"],
      capabilities: fullCapabilities({ sessionControls: true }),
    });
    expect(welcome).toMatchObject({ type: "welcome", features: ["adapterContract.v2"] });
    host!.handler = (cmd) =>
      cmd.type === "session.clearQueue"
        ? { cleared: { steering: ["now"], followUp: ["later", 3] } }
        : gitHandler(cmd);
    await host!.event("session.updated", hostSession("ses_c", { runtime: "running" }));
    const r = await t!.admin("POST", "/api/sessions/ses_c/queue/clear");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ steering: ["now"], followUp: ["later"] });
  });

  it("forwards models, model, thinking and compact", async () => {
    await controlSetup();
    const models = await t!.admin("GET", "/api/sessions/ses_c/models");
    expect(models.body.models[0].id).toBe("m1");
    const m = await t!.admin("POST", "/api/sessions/ses_c/model", {
      provider: "mock",
      modelId: "m1",
    });
    expect(m.status).toBe(200);
    const sent = host!.commands.find((c) => c.command.type === "session.setModel")!
      .command as HostCommandOf<"session.setModel">;
    expect(sent).toMatchObject({ provider: "mock", modelId: "m1" });
    expect(
      (await t!.admin("POST", "/api/sessions/ses_c/thinking", { level: "bogus" })).status,
    ).toBe(400);
    expect(
      (await t!.admin("POST", "/api/sessions/ses_c/thinking", { level: "high" })).body.thinking,
    ).toBe("high");
    expect((await t!.admin("POST", "/api/sessions/ses_c/compact", {})).status).toBe(200);
    const compact = host!.commands.find((c) => c.command.type === "session.compact")!
      .command as HostCommandOf<"session.compact">;
    expect(compact.instructions).toBeNull();

    await host!.event("session.updated", hostSession("ses_c", { runtime: "running" }));
    expect((await t!.admin("POST", "/api/sessions/ses_c/compact", {})).status).toBe(409);
    await host!.event("session.updated", hostSession("ses_c", { runtime: "stopped" }));
    expect((await t!.admin("GET", "/api/sessions/ses_c/models")).status).toBe(409);
  });

  it("forwards argument completions", async () => {
    await controlSetup();
    const r = await t!.admin("POST", "/api/sessions/ses_c/complete", { text: "/model " });
    expect(r.status).toBe(200);
    expect(r.body.items[0].value).toBe("x");
    expect((await t!.admin("POST", "/api/sessions/ses_c/complete", {})).status).toBe(400);
  });

  it("forwards tree, branch, reload and export", async () => {
    await controlSetup();
    expect((await t!.admin("GET", "/api/sessions/ses_c/tree")).body.rows[0].entryId).toBe("e1");
    const b = await t!.admin("POST", "/api/sessions/ses_c/branch", { entryId: "e1", fork: true });
    expect(b.status).toBe(201);
    expect(b.body.prefill).toBe("hi");
    expect(b.body.session.provenance).toBe("imported");
    expect(b.body.session.nativeHandle.sessionFile).toBe("/tmp/b.jsonl");
    expect(b.body.session.title).toBe("Fork of Host session");
    const copy = await t!.admin("POST", "/api/sessions/ses_c/branch", {
      entryId: null,
      fork: false,
    });
    expect(copy.status).toBe(201);
    expect(copy.body.session.title).toBe("Copy of Host session");
    expect((await t!.admin("POST", "/api/sessions/ses_c/reload", {})).status).toBe(200);
    expect((await t!.admin("GET", "/api/sessions/ses_c/export")).body.fileName).toBe("s.jsonl");
  });

  describe("navigate", () => {
    const entries = [
      {
        id: "itm_n1",
        sessionId: "ses_c",
        order: 0,
        at: "2026-01-01T00:00:00.000Z",
        kind: "user",
        data: { text: "hi", entryId: "e1" },
      },
    ];
    async function navSetup(over: Record<string, unknown> = {}, terminalHost = true) {
      await controlSetup();
      await host!.close();
      await host!.open({
        capabilities: fullCapabilities({ sessionControls: true, treeNavigation: terminalHost }),
      });
      const prev = host!.handler;
      host!.handler = (cmd) =>
        cmd.type === "session.navigate" ? { items: entries, prefill: "hi" } : prev!(cmd);
      await host!.event(
        "session.updated",
        hostSession("ses_c", { runtime: "idle", terminal: true, ...over }),
      );
    }

    it("replaces the transcript, bumps the epoch and emits transcript.reset", async () => {
      await navSetup();
      const before = t!.c.store.currentSeq();
      const r = await t!.admin("POST", "/api/sessions/ses_c/navigate", {
        entryId: "e1",
        summarize: true,
        instructions: "short",
      });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ prefill: "hi", epoch: 1 });
      const sent = host!.commands.find((c) => c.command.type === "session.navigate")!
        .command as HostCommandOf<"session.navigate">;
      expect(sent).toMatchObject({ entryId: "e1", summarize: true, instructions: "short" });
      expect(t!.c.store.listItems("ses_c").items.map((i) => i.id)).toEqual(["itm_n1"]);
      expect(t!.c.store.sessions.require("ses_c").transcriptEpoch).toBe(1);
      expect(
        t!.c.store.eventsAfter(before).filter((e) => e.type === "transcript.reset"),
      ).toHaveLength(1);
    });

    it("refuses non-terminal, busy and compacting sessions", async () => {
      await navSetup({ terminal: false });
      const body = { entryId: "e1" };
      expect((await t!.admin("POST", "/api/sessions/ses_c/navigate", body)).status).toBe(400);
      await host!.event(
        "session.updated",
        hostSession("ses_c", { runtime: "running", terminal: true }),
      );
      expect((await t!.admin("POST", "/api/sessions/ses_c/navigate", body)).status).toBe(409);
      await host!.event(
        "session.updated",
        hostSession("ses_c", { runtime: "idle", terminal: true, compacting: true }),
      );
      expect((await t!.admin("POST", "/api/sessions/ses_c/navigate", body)).status).toBe(409);
    });
  });

  it("refuses hosts without the capability", async () => {
    await controlSetup(false);
    const r = await t!.admin("GET", "/api/sessions/ses_c/commands");
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain("Update Switchyard");
  });

  it("projects live model fields from the host", async () => {
    await controlSetup();
    await host!.event(
      "session.updated",
      hostSession("ses_c", {
        model: {
          provider: "mock",
          id: "m1",
          name: null,
          contextWindow: 1000,
          reasoning: false,
          thinkingLevels: ["off"],
        },
        thinking: "off",
        compacting: true,
        stats: { tokens: 1, costUsd: 0, context: { tokens: 5, window: 10, percent: 50 } },
      }),
    );
    const s = t!.c.store.sessions.require("ses_c");
    expect(s.model?.id).toBe("m1");
    expect(s.thinking).toBe("off");
    expect(s.compacting).toBe(true);
    expect(s.stats?.context?.window).toBe(10);
  });
});
