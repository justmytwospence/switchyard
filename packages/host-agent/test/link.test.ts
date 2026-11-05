import { existsSync } from "node:fs";
import { makeRepo, type TempRepo } from "@switchyard/test-fixtures";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RESTART_TERMINAL_LOST_DETAIL,
  RESTARTED_WHILE_RUNNING,
  terminalLostNotice,
} from "../src/index.js";
import { type HostHarness, seedSession, sleep, startHarness, waitFor } from "./helpers.js";

function diag(h: HostHarness, message: string): void {
  h.agent.db.tx(() =>
    h.agent.link.emit({
      type: "diagnostic",
      data: {
        sessionId: null,
        adapterId: null,
        level: "info",
        message,
        at: new Date().toISOString(),
      },
    }),
  );
}

const messages = (h: HostHarness, from = 0) =>
  h.coord.events
    .slice(from)
    .filter((e) => e.event.type === "diagnostic")
    .map((e) => (e.event.data as { message: string }).message)
    .filter((m) => m.startsWith("m"));

describe("coordinator link", () => {
  let h: HostHarness;
  beforeEach(async () => {
    h = await startHarness({ withPi: false });
  });
  afterEach(async () => {
    await h.dispose();
  });

  it("says hello with identity, versions and capabilities", async () => {
    const hello = h.coord.hellos[0]!;
    expect(hello).toMatchObject({
      hostId: "hst_test",
      credential: "secret",
      name: "test host",
      protocolVersion: 1,
    });
    expect(["darwin", "linux"]).toContain(hello.platform);
    expect(typeof hello.agentVersion).toBe("string");
    expect(typeof hello.piCompatible).toBe("boolean");
    await h.coord.waitEvent((e) => e.type === "adapters.updated", 5000, "adapters.updated");
    const adapters = h.coord.eventsOf("adapters.updated").at(-1)!.data as {
      adapters: { id: string; tier: string; status: string }[];
    };
    // No Pi packages and no owner adapters, and nothing is bundled by default.
    expect(adapters.adapters).toEqual([]);
  });

  it("replays outbox rows written while disconnected, in order, exactly once after ack", async () => {
    diag(h, "m1");
    diag(h, "m2");
    diag(h, "m3");
    await h.coord.waitUntil(() => messages(h).length === 3, 5000, "m1..m3");
    const ackedBefore = h.coord.ackedHostSeq;

    // Coordinator goes away; the host keeps writing durable events.
    await h.coord.close();
    await waitFor(() => !h.agent.link.connected, 5000, "host notices");
    await sleep(50);
    diag(h, "m4");
    diag(h, "m5");
    diag(h, "m6");
    expect(h.agent.link.pending(ackedBefore).map((r) => (r.event.data as any).message)).toEqual([
      "m4",
      "m5",
      "m6",
    ]);
    const mark = h.coord.events.length;
    await h.coord.listen();
    await h.coord.waitUntil(() => messages(h, mark).length >= 3, 10000, "replay");
    await sleep(200);
    const replayed = h.coord.events.slice(mark);
    expect(messages(h, mark)).toEqual(["m4", "m5", "m6"]);
    const seqs = replayed.map((e) => e.hostSeq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(Math.min(...seqs)).toBeGreaterThan(ackedBefore);
    // Every event id arrived once overall.
    const ids = h.coord.events.map((e) => e.event.eventId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(h.agent.link.ackedHostSeq()).toBe(h.coord.ackedHostSeq);

    // An unacked event is re-sent after a reconnect (at least once until acked).
    h.coord.autoAck = false;
    diag(h, "m7");
    await h.coord.waitUntil(() => messages(h).includes("m7"), 5000, "m7");
    const mark2 = h.coord.events.length;
    h.coord.autoAck = true;
    h.coord.socket?.terminate();
    await h.coord.waitUntil(() => messages(h, mark2).includes("m7"), 10000, "m7 replay");
    await sleep(200);
    expect(messages(h, mark2)).toEqual(["m7"]);
  });

  it("emit() inside a rolled-back transaction sends nothing", async () => {
    const before = h.agent.link.lastHostSeq();
    expect(() =>
      h.agent.db.tx(() => {
        diag(h, "mrollback");
        throw new Error("abort");
      }),
    ).toThrow("abort");
    diag(h, "mafter");
    await h.coord.waitUntil(() => messages(h).includes("mafter"), 5000, "mafter");
    expect(messages(h)).not.toContain("mrollback");
    expect(h.agent.link.pending(before).map((r) => (r.event.data as any).message)).toEqual([
      "mafter",
    ]);
  });
});

describe("command router", () => {
  let h: HostHarness;
  let repo: TempRepo;
  beforeEach(async () => {
    h = await startHarness({ withPi: false });
    repo = makeRepo();
  });
  afterEach(async () => {
    await h.dispose();
    repo.cleanup();
  });

  it("resends the stored receipt for a duplicate commandId without re-running it", async () => {
    const cmd = {
      type: "workspace.create" as const,
      checkoutPath: repo.path,
      branch: "feat/dup",
      base: "main",
      setupCommand: null,
    };
    const first = await h.coord.command(cmd, { commandId: "cmd_dup1" });
    expect(first.ok).toBe(true);
    const second = await h.coord.command(cmd, { commandId: "cmd_dup1" });
    expect(second).toEqual(first);
    // A new commandId really runs again (and collides).
    const third = await h.coord.command(cmd, { commandId: "cmd_dup2" });
    expect(third).toMatchObject({ ok: false, error: { code: "path_collision" } });
    expect(
      h.agent.router.commandLog.filter((c) => c.commandId === "cmd_dup1").map((c) => c.outcome),
    ).toEqual(["ok", "duplicate"]);
  });

  it("not-live errors name what a person can do about it", async () => {
    seedSession(h, "ses_idle", { runtime: "stopped" });
    await h.agent.stop();
    const hellos = h.coord.hellos.length;
    await h.restartAgent();
    await waitFor(() => h.coord.hellos.length > hellos, 10000, "second hello");
    const cases = [
      [{ type: "session.models", sessionId: "ses_idle" }, "resume to list models"],
      [{ type: "session.commands", sessionId: "ses_idle" }, "resume to list commands"],
      [{ type: "session.compact", sessionId: "ses_idle", instructions: null }, "resume to compact"],
      [{ type: "session.abort", sessionId: "ses_idle", clearQueue: false }, "nothing to abort"],
    ] as const;
    for (const [cmd, hint] of cases) {
      const r = await h.coord.command(cmd as any);
      expect(r).toMatchObject({
        ok: false,
        error: { code: "invalid_request", message: `Session stopped (stopped): ${hint}` },
      });
    }
  });

  it("a command interrupted by a restart answers with an error instead of running again", async () => {
    const now = new Date().toISOString();
    const pending = (commandId: string, type: string) =>
      h.agent.db.run("INSERT INTO receipts (command_id, json, created_at) VALUES (?, ?, ?)", [
        commandId,
        JSON.stringify({ commandId, pending: true, type }),
        now,
      ]);
    pending("cmd_pend", "workspace.create");
    // Reads are rerunnable and never leave a marker, but any pending row is converted.
    pending("cmd_pend_read", "workspace.status");
    await h.agent.stop();
    const hellos = h.coord.hellos.length;
    await h.restartAgent();
    await waitFor(() => h.coord.hellos.length > hellos, 10000, "second hello");

    const branch = "feat/pending";
    const r = await h.coord.command(
      {
        type: "workspace.create",
        checkoutPath: repo.path,
        branch,
        base: "main",
        setupCommand: null,
      },
      { commandId: "cmd_pend" },
    );
    expect(r).toMatchObject({
      ok: false,
      error: { code: "internal", message: RESTARTED_WHILE_RUNNING },
    });
    expect(existsSync(`${repo.path}/.worktrees/feat-pending`)).toBe(false);
    const read = await h.coord.command(
      { type: "workspace.status", path: repo.path },
      { commandId: "cmd_pend_read" },
    );
    expect(read).toMatchObject({ ok: false, error: { message: RESTARTED_WHILE_RUNNING } });
  });

  it("rejects malformed commands with invalid_request", async () => {
    const r = await h.coord.command({ type: "workspace.status" } as any);
    expect(r).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  });

  it("creates, discovers, validates and removes worktrees", async () => {
    const { runGit } = await import("../src/git.js");
    const info = await h.coord.ok({ type: "checkout.inspect", path: repo.path });
    expect(info).toMatchObject({ root: repo.path, defaultBranch: "main" });

    const created = await h.coord.ok({
      type: "workspace.create",
      checkoutPath: repo.path,
      branch: "feat/x",
      base: "main",
      setupCommand: "echo setting up",
    });
    expect(created).toMatchObject({
      path: `${repo.path}/.worktrees/feat-x`,
      branch: "feat/x",
      baseBranch: "main",
      provenance: "managed",
    });
    await h.coord.waitEvent(
      (e) =>
        e.type === "workspace.updated" &&
        (e.data as any).path === created.path &&
        (e.data as any).setup?.state === "succeeded",
      10000,
      "setup succeeded",
    );
    const setupEvent = h.coord
      .eventsOf("workspace.updated")
      .find((e) => (e.data as any).setup?.state === "succeeded")!;
    expect((setupEvent.data as any).setup.log).toContain("setting up");

    // External worktree outside .worktrees/
    const ext = `${repo.path}-ext`;
    await runGit(repo.path, ["worktree", "add", "-b", "ext", ext, "main"]);
    const { worktrees } = await h.coord.ok<{ worktrees: any[] }>({
      type: "workspace.discover",
      checkoutPath: repo.path,
    });
    const byPath = Object.fromEntries(worktrees.map((w) => [w.path, w]));
    expect(byPath[repo.path]).toMatchObject({ provenance: "main", branch: "main" });
    expect(byPath[created.path]).toMatchObject({ provenance: "managed", branch: "feat/x" });
    expect(byPath[ext]).toMatchObject({ provenance: "discovered", branch: "ext" });

    const bad = await h.coord.command({
      type: "workspace.create",
      checkoutPath: repo.path,
      branch: "bad..name",
      base: "main",
      setupCommand: null,
    });
    expect(bad).toMatchObject({ ok: false, error: { code: "branch_invalid" } });
    const collide = await h.coord.command({
      type: "workspace.create",
      checkoutPath: repo.path,
      branch: "feat-x",
      base: "main",
      setupCommand: null,
    });
    expect(collide).toMatchObject({ ok: false, error: { code: "path_collision" } });

    // Dirty removal is refused without force.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(`${created.path}/scratch.txt`, "wip\n");
    const status = await h.coord.ok({ type: "workspace.status", path: created.path, base: "main" });
    expect(status.git).toMatchObject({ dirty: true, changedFiles: 1 });
    const refused = await h.coord.command({
      type: "workspace.remove",
      path: created.path,
      checkoutPath: repo.path,
      base: "main",
      force: { dirty: false, unmerged: false },
    });
    expect(refused).toMatchObject({ ok: false, error: { code: "workspace_dirty" } });
    expect(existsSync(created.path)).toBe(true);

    const diff = await h.coord.ok({
      type: "workspace.diff",
      path: created.path,
      base: "main",
      file: null,
    });
    expect(diff.files).toContainEqual(
      expect.objectContaining({ path: "scratch.txt", status: "untracked" }),
    );

    const files = await h.coord.ok({ type: "workspace.files", path: created.path, dir: "" });
    expect(files.entries.map((e: any) => e.name)).toContain("scratch.txt");
    const file = await h.coord.ok({
      type: "workspace.readFile",
      path: created.path,
      file: "scratch.txt",
    });
    expect(file).toMatchObject({ content: "wip\n", encoding: "utf8" });
    const outside = await h.coord.command({
      type: "workspace.readFile",
      path: created.path,
      file: "../../etc/passwd",
    });
    expect(outside).toMatchObject({ ok: false });

    const removed = await h.coord.ok({
      type: "workspace.remove",
      path: created.path,
      checkoutPath: repo.path,
      base: "main",
      force: { dirty: true, unmerged: false },
    });
    expect(removed).toMatchObject({ ok: true });
    expect(existsSync(created.path)).toBe(false);
    await h.coord.waitEvent((e) => e.type === "workspace.deleted", 5000, "workspace.deleted");
  });

  it("runs owner-configured checks with exit codes and tails", async () => {
    const r = await h.coord.ok({
      type: "checks.run",
      sessionId: "ses_x",
      path: repo.path,
      commands: ["echo fine", "echo broken >&2; exit 3"],
    });
    expect(r.results).toEqual([
      { command: "echo fine", exitCode: 0, outputTail: expect.stringContaining("fine") },
      {
        command: "echo broken >&2; exit 3",
        exitCode: 3,
        outputTail: expect.stringContaining("broken"),
      },
    ]);
  });

  it("reconcile of an unknown dispatch key is known:false", async () => {
    expect(await h.coord.ok({ type: "dispatch.reconcile", dispatchKey: "run_nope" })).toEqual({
      known: false,
    });
  });
});

describe("a terminal session whose holder is gone after a restart", () => {
  it("says why it was lost", async () => {
    const h = await startHarness({ withPi: false });
    try {
      seedSession(h, "ses_lost", {
        runtime: "running",
        terminal: { socketPath: "/nonexistent/term-gone.sock" },
      });
      await h.agent.stop();
      const mark = h.coord.events.length;
      const agent2 = await h.restartAgent();
      expect(agent2.interruptedOnStart).toEqual(["ses_lost"]);
      const reason = "Terminal holder not running";
      expect(agent2.supervisor.record("ses_lost")).toMatchObject({
        runtime: "interrupted",
        runtimeDetail: `${RESTART_TERMINAL_LOST_DETAIL} (${reason})`,
        terminal: null,
      });
      const notices = () =>
        h.coord.events
          .slice(mark)
          .map((e) => e.event)
          .filter((e) => e.type === "transcript.item" && e.sessionId === "ses_lost")
          .map((e) => (e.data as any).data?.text);
      await h.coord.waitUntil(
        () => notices().includes(terminalLostNotice(reason)),
        10000,
        "lost notice",
      );
    } finally {
      await h.dispose();
    }
  });
});
