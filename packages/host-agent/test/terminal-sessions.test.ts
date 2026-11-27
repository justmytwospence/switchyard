// @module-tag slow
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { PiTerminalProcess, terminalSupport } from "@switchyard/pi-runtime";
import type { HostEvent } from "@switchyard/protocol";
import { skipRealPi, when } from "@switchyard/test-fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { socketDirs } from "../../pi-runtime/src/bridge/socket-paths.js";
import { NO_TERMINAL } from "../src/index.js";
import { type HostHarness, slowPi, startCommand, startHarness, waitFor } from "./helpers.js";

let n = 0;
const sid = () => `ses_term${Date.now()}${++n}`;

function parentPid(pid: number): number {
  return Number(
    execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim(),
  );
}

function expectGone(pid: number) {
  expect(() => process.kill(pid, 0)).toThrow();
}

function expectNoOwnedSockets(h: HostHarness) {
  for (const dir of socketDirs(h.scope.runtimeDir)) {
    expect(
      existsSync(dir) ? readdirSync(dir).filter((name) => /^term-.*\.sock$/.test(name)) : [],
    ).toEqual([]);
  }
}

const isSettled =
  (sessionId: string, after = 0) =>
  (e: HostEvent) =>
    e.type === "session.updated" &&
    e.sessionId === sessionId &&
    (e.data as any).settled != null &&
    Date.parse(e.at) >= after;

describe.skipIf(skipRealPi || !terminalSupport().ok)("terminal sessions on the host", () => {
  let h: HostHarness;
  beforeAll(async () => {
    h = await startHarness({
      terminalSessions: true,
      script: [{ when: when.userSays("hello"), reply: { text: "hi" } }],
    });
  });
  afterAll(async () => {
    await h?.dispose();
  });

  it("runs a terminal session, survives an agent restart, and relays its terminal", async () => {
    expect(h.agent.terminalSessions).toBe(true);
    expect(h.coord.hellos.at(-1)?.capabilities?.terminal).toBe(true);
    const id = sid();
    await h.coord.ok(startCommand(id, h.pi!.cwd, { initialPrompt: "hello" }));
    await h.coord.waitEvent(isSettled(id), 30000, "settled");
    const updated = h.coord
      .eventsOf("session.updated", id)
      .map((e) => e.data as any)
      .at(-1);
    expect(updated).toMatchObject({ runtime: "idle", terminal: true });

    // Slash commands from a client run in the terminal session.
    const hi = await h.coord.ok<{ disposition: string }>({
      type: "session.prompt",
      sessionId: id,
      text: "/fixture-hello hi",
      images: [],
      mode: "prompt",
      origin: "human",
      controlRevision: 1,
    });
    expect(hi.disposition).toBe("handled");
    await h.coord.waitUntil(
      () =>
        h.coord
          .eventsOf("transcript.item", id)
          .some(
            (e) =>
              (e.data as any).kind === "notice" && (e.data as any).data.text === "fixture hello hi",
          ),
      10000,
      "fixture hello notice",
    );

    // The relay paints the terminal for a viewer.
    h.coord.sendTerm("trm_1", { t: "open", sessionId: id, cols: 100, rows: 30 });
    await h.coord.waitUntil(
      () => h.coord.term.some((f) => f.streamId === "trm_1" && f.msg.t === "out"),
      10000,
      "terminal output",
    );
    h.coord.sendTerm("trm_1", { t: "close" });

    // Opening a session that has no terminal says so.
    h.coord.sendTerm("trm_2", { t: "open", sessionId: "ses_nope", cols: 80, rows: 24 });
    await h.coord.waitUntil(
      () => h.coord.term.some((f) => f.streamId === "trm_2" && f.msg.t === "closed"),
      5000,
      "closed",
    );
    expect(h.coord.term.find((f) => f.streamId === "trm_2")?.msg).toEqual({
      t: "closed",
      reason: NO_TERMINAL,
    });

    // A graceful agent stop detaches; the next agent reattaches instead of interrupting.
    await h.agent.stop();
    const hellos = h.coord.hellos.length;
    const agent2 = await h.restartAgent();
    expect(agent2.interruptedOnStart).toEqual([]);
    expect(agent2.supervisor.isLive(id)).toBe(true);
    expect(agent2.supervisor.record(id)?.runtime).toBe("idle");
    // The reattached extension announced itself again: dialogs stay answerable remotely.
    expect(agent2.supervisor.managedSession(id)?.remoteDialogs).toBe(true);
    await waitFor(() => h.coord.hellos.length > hellos, 10000, "second hello");
    const t0 = Date.now();
    await h.coord.ok({
      type: "session.prompt",
      sessionId: id,
      text: "hello again",
      images: [],
      mode: "prompt",
      origin: "human",
      controlRevision: 1,
    });
    await h.coord.waitEvent(isSettled(id, t0), 30000, "settled after reattach");

    // Stopping the session ends its terminal.
    await h.coord.ok({ type: "session.stop", sessionId: id });
    await waitFor(() => agent2.supervisor.record(id)?.terminal == null, 10000, "terminal cleared");
    expect(agent2.supervisor.record(id)?.runtime).toBe("stopped");
  });

  it("stamps user items with entry ids and rebuilds the transcript on navigate", async () => {
    const id = sid();
    await h.coord.ok(startCommand(id, h.pi!.cwd, { initialPrompt: "hello" }));
    await h.coord.waitEvent(isSettled(id), 30000, "settled");
    const userItems = () =>
      h.coord
        .eventsOf("transcript.item", id)
        .map((e) => e.data as any)
        .filter((d) => d.kind === "user");
    await h.coord.waitUntil(
      () => userItems().some((d) => typeof d.data.entryId === "string"),
      10000,
      "entry id on the user item",
    );
    const entryId = userItems().find((d) => d.data.entryId).data.entryId as string;
    const r = await h.coord.ok<{ items: any[]; prefill: string | null }>({
      type: "session.navigate",
      sessionId: id,
      entryId,
      summarize: false,
      instructions: null,
    });
    expect(r.prefill).toBe("hello");
    // The branch before the first message is empty; orders continue after the live counter.
    expect(r.items.every((i) => i.sessionId === id)).toBe(true);
    await h.coord.ok({ type: "session.stop", sessionId: id });
  });
});

describe.skipIf(skipRealPi || !terminalSupport().ok)("fixture-owned terminal teardown", () => {
  it("disposes a detached holder without affecting another harness", async () => {
    const first = await startHarness({ terminalSessions: true });
    let second: HostHarness | undefined;
    try {
      second = await startHarness({
        terminalSessions: true,
        script: [{ when: when.userSays("hello"), reply: { text: "hi" } }],
      });
      const a = sid();
      const b = sid();
      await first.coord.ok(startCommand(a, first.pi!.cwd));
      await second.coord.ok(startCommand(b, second.pi!.cwd));
      const proc = first.agent.supervisor.managedSession(a)!.process!;
      await waitFor(() => !!proc.pid, 10000, "first Pi pid");
      const pid = proc.pid!;
      const holder = parentPid(pid);
      expect(holder).toBeGreaterThan(1);
      const socket = first.agent.supervisor.record(a)!.terminal!.socketPath;
      await first.agent.stop();
      await first.dispose();
      await first.dispose();
      await waitFor(
        () => {
          try {
            process.kill(holder, 0);
            return false;
          } catch {
            return true;
          }
        },
        10000,
        "holder exit",
      );
      expectGone(pid);
      expectGone(holder);
      expect(existsSync(socket)).toBe(false);
      expectNoOwnedSockets(first);
      const t0 = Date.now();
      await second.coord.ok({
        type: "session.prompt",
        sessionId: b,
        text: "hello",
        images: [],
        mode: "prompt",
        origin: "human",
        controlRevision: 1,
      });
      await second.coord.waitEvent(isSettled(b, t0), 30000, "surviving session settled");
    } finally {
      try {
        await first.dispose();
      } finally {
        await second?.dispose();
      }
    }
  }, 90000);

  it("disposes a holder while slow Pi is starting", async () => {
    const slow = slowPi(20);
    const h = await startHarness({ terminalSessions: true, piBin: slow.path });
    try {
      const id = sid();
      const started = h.coord.command(startCommand(id, h.pi!.cwd)).catch(() => null);
      await waitFor(() => !!h.agent.supervisor.record(id)?.terminal, 15000, "starting holder");
      const socket = h.agent.supervisor.record(id)!.terminal!.socketPath;
      const proc = h.agent.supervisor.managedSession(id)!.process!;
      await waitFor(() => !!proc.pid, 10000, "slow Pi pid");
      const pid = proc.pid!;
      const holder = parentPid(pid);
      await h.dispose();
      await started;
      await waitFor(
        () => {
          try {
            process.kill(holder, 0);
            return false;
          } catch {
            return true;
          }
        },
        10000,
        "holder exit",
      );
      expectGone(pid);
      expectGone(holder);
      expect(existsSync(socket)).toBe(false);
      expectNoOwnedSockets(h);
    } finally {
      try {
        await h.dispose();
      } finally {
        slow.cleanup();
      }
    }
  }, 60000);

  it("waits for a holder start delayed before binding", async () => {
    const original = PiTerminalProcess.start;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const called = new Promise<void>((resolve) => {
      entered = resolve;
    });
    PiTerminalProcess.start = async (opts) => {
      entered();
      await gate;
      return original.call(PiTerminalProcess, opts);
    };
    let h: HostHarness | undefined;
    try {
      h = await startHarness({ terminalSessions: true });
      const started = h.coord.command(startCommand(sid(), h.pi!.cwd)).catch(() => null);
      await called;
      let disposed = false;
      const disposing = h.dispose().then(() => {
        disposed = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(disposed).toBe(false);
      release();
      await disposing;
      await started;
      expectNoOwnedSockets(h);
    } finally {
      release();
      try {
        await h?.dispose();
      } finally {
        PiTerminalProcess.start = original;
      }
    }
  }, 60000);
});

describe.skipIf(skipRealPi || !terminalSupport().ok)("terminal sessions still starting", () => {
  it("a terminal session still starting when the agent stops keeps its socket and finishes starting under the next agent", async () => {
    const slow = slowPi(4);
    const h = await startHarness({
      terminalSessions: true,
      piBin: slow.path,
      script: [{ when: when.userSays("hello"), reply: { text: "hi" } }],
    });
    try {
      const id = sid();
      const started = h.coord.command(startCommand(id, h.pi!.cwd)).catch(() => null);
      await waitFor(
        () => {
          const rec = h.agent.supervisor.record(id);
          return rec?.terminal != null && rec.runtime === "starting";
        },
        15000,
        "starting with a socket",
      );
      await h.agent.stop();
      await started;
      const agent2 = await h.restartAgent();
      expect(agent2.supervisor.record(id)?.runtime).toBe("starting");
      expect(agent2.supervisor.record(id)?.terminal).not.toBeNull();
      await waitFor(() => agent2.supervisor.record(id)?.runtime === "idle", 30000, "idle");
      await h.coord.ok({ type: "session.stop", sessionId: id });
      await waitFor(() => agent2.supervisor.record(id)?.runtime === "stopped", 10000, "stopped");
    } finally {
      await h.dispose();
      slow.cleanup();
    }
  });

  it("session.stop during a slow terminal start kills its holder and ends stopped", async () => {
    const slow = slowPi(20);
    const h = await startHarness({ terminalSessions: true, piBin: slow.path });
    try {
      const id = sid();
      const started = h.coord.command(startCommand(id, h.pi!.cwd));
      await waitFor(() => h.agent.supervisor.record(id)?.runtime === "starting", 15000, "starting");
      const socketPath = h.agent.supervisor.record(id)?.terminal?.socketPath;
      const t0 = Date.now();
      await h.coord.ok({ type: "session.stop", sessionId: id });
      expect(Date.now() - t0).toBeLessThan(8000);
      expect(h.agent.supervisor.record(id)).toMatchObject({ runtime: "stopped", terminal: null });
      expect(await started).toMatchObject({ ok: true, result: { runtime: "stopped" } });
      if (socketPath) await waitFor(() => !existsSync(socketPath), 10000, "holder gone");
    } finally {
      await h.dispose();
      slow.cleanup();
    }
  });
});
