import type { HostCommand, HostCommandOf } from "@switchyard/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  enrollHost,
  FakeHost,
  hostSession,
  startCoordinator,
  type TestCoordinator,
  until,
} from "./helpers.js";
import { fullCapabilities } from "./task-helpers.js";

let t: TestCoordinator | undefined;
let host: FakeHost | undefined;
afterEach(async () => {
  await host?.close();
  host = undefined;
  await t?.cleanup();
  t = undefined;
});

const ROOT = "/repos/app";

function gitHandler(cmd: HostCommand): unknown {
  switch (cmd.type) {
    case "checkout.inspect":
      if (cmd.path === "/not/git") return { __error: { code: "not_a_git_repo", message: "no" } };
      return {
        root: ROOT,
        commonDir: `${ROOT}/.git`,
        repoIdentity: "https://github.com/me/app",
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
      return { nativeHandle: { sessionId: "n-1", sessionFile: "/s/n-1.jsonl" } };
    default:
      return null;
  }
}

async function setup() {
  t = await startCoordinator();
  const creds = await enrollHost(t);
  host = await FakeHost.connect(t, creds, gitHandler);
  const p = await t.admin("POST", "/api/projects", {
    name: "App",
    hostId: creds.hostId,
    path: ROOT,
  });
  expect(p.status).toBe(201);
  return { creds, project: p.body };
}

describe("projects and workspaces", () => {
  it("creates a project from checkout.inspect and discovers workspaces", async () => {
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

    const dupe = await t!.admin("POST", "/api/projects", {
      name: "x",
      hostId: creds.hostId,
      path: ROOT,
    });
    expect(dupe.status).toBe(409);
    const bad = await t!.admin("POST", "/api/projects", {
      name: "x",
      hostId: creds.hostId,
      path: "/not/git",
    });
    expect(bad.body.error.code).toBe("not_a_git_repo");

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
    expect(t!.c.store.workspaces.get(ws.body.id)).toBeUndefined();
  });
});

describe("sessions", () => {
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
    expect(s.nativeHandle?.sessionFile).toBe("/s/n-1.jsonl");
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

    await host!.event("session.updated", hostSession("ses_p", { runtime: "interrupted" }));
    const stopped = await t!.admin("POST", "/api/sessions/ses_p/prompt", { text: "x" });
    expect(stopped.status).toBe(409);

    const resume = await t!.admin("POST", "/api/sessions/ses_p/resume");
    expect(resume.status).toBe(200);
    const start = (await host!.waitForCommand("session.start"))
      .command as HostCommandOf<"session.start">;
    expect(start.nativeHandle).toEqual({
      sessionId: "native-1",
      sessionFile: "/tmp/native-1.jsonl",
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
          return { sessionFile: "/tmp/b.jsonl", prefill: "hi" };
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
    expect((await t!.admin("POST", "/api/sessions/ses_c/reload", {})).status).toBe(200);
    expect((await t!.admin("GET", "/api/sessions/ses_c/export")).body.fileName).toBe("s.jsonl");
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
