import type { CommandLogEntry } from "@switchyard/host-agent";
import type { Run } from "@switchyard/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getService, takeover } from "../../src/index.js";
import { Integration, NO_MARKER_TEXT, waitFor } from "./harness.js";

/**
 * Spec §19: takeover racing an automatic continuation. The mock never reports done, so every
 * settle under automation sends a continuation prompt.
 */
describe("takeover racing a continuation", { timeout: 180_000 }, () => {
  let env: Integration;
  let taskId: string;
  let sessionId: string;
  beforeAll(async () => {
    env = await Integration.create();
  });
  afterAll(async () => {
    await env?.dispose();
  });

  const log = (): CommandLogEntry[] => env.agent!.router.commandLog;
  const automatedPrompts = (from = 0) =>
    log()
      .slice(from)
      .filter((e) => e.type === "session.prompt" && e.origin === "automation");

  /** Wait until no command is pending on the host and the session is idle. */
  async function quiesce() {
    await waitFor(
      () =>
        log().every((e) => e.outcome !== "pending") &&
        env.session(sessionId).runtime === "idle" &&
        env.agent!.supervisor.record(sessionId)?.runtime === "idle",
      "quiet",
    );
  }

  /** After the takeover's setControl (revision `rev`) no automated prompt was accepted. */
  function assertNoAutomationAfter(rev: number) {
    const entries = log();
    const at = entries.findIndex(
      (e) =>
        e.type === "session.setControl" && e.sessionId === sessionId && e.controlRevision === rev,
    );
    expect(at).toBeGreaterThanOrEqual(0);
    for (const e of entries.slice(at + 1)) {
      if (e.type === "session.prompt" && e.origin === "automation" && e.sessionId === sessionId) {
        expect(e.outcome).not.toBe("ok");
        expect(e.outcome).toBe("stale_control");
      }
    }
    return at;
  }

  it("starts a continuation run that never reports done", async () => {
    const task = await env.createTask("admin", {
      title: "Endless",
      objective: "Keep going",
      state: "ready",
      policy: {
        continuation: {
          enabled: true,
          objective: "keep going",
          maxContinuations: 20,
          maxElapsedMinutes: 30,
          maxTokens: null,
          maxCostUsd: null,
        },
      },
    });
    taskId = task.id;
    const run = await env.waitRun(
      task.id,
      (r) => r.continuationsUsed >= 1 || r.state === "failed",
      "first continuation",
    );
    expect(run.state, run.outcome?.summary).toBe("running");
    sessionId = run.sessionId!;
    expect(env.session(sessionId).lastAssistantText).toBe(NO_MARKER_TEXT);
    await waitFor(() => automatedPrompts().length >= 1, "continuation reached the host");
  });

  /** Arm a takeover that fires (over HTTP) from the next settle of the session. */
  function armTakeover() {
    let p: Promise<{ status: number; body: any }> | null = null;
    const onSettled = (s: { session: { id: string } }) => {
      if (s.session.id !== sessionId || p) return;
      p = env.api("POST", `/api/sessions/${sessionId}/takeover`, { as: env.devices!.terminal });
      env.c.events.off("session.settled", onSettled);
    };
    env.c.events.on("session.settled", onSettled);
    return {
      fired: () => p !== null,
      result: () => p!,
      disarm: () => env.c.events.off("session.settled", onSettled),
    };
  }

  it("takeover issued concurrently at agent_settled: no automated prompt accepted afterwards", async () => {
    let armed = armTakeover();
    for (let round = 0; round < 3; round++) {
      try {
        await waitFor(armed.fired, `settle (round ${round})`);
      } finally {
        armed.disarm();
      }
      const r = await armed.result();
      expect(r.status).toBe(200);
      const run = r.body.run as Run;
      expect(run.controlMode).toBe("human");
      await quiesce();
      const at = assertNoAutomationAfter(run.controlRevision);
      // The continuation for this settle either landed before the takeover (and was the last
      // automated command) or was rejected as stale_control.
      const before = automatedPrompts().filter((e) => log().indexOf(e) < at);
      expect(before.length).toBeGreaterThan(0);
      expect(before.at(-1)!.outcome).toBe("ok");

      // Nothing automated happens while a human holds control, even on another settle.
      const count = automatedPrompts().length;
      const settles = env.hostSettles(sessionId);
      await env.ok("POST", `/api/sessions/${sessionId}/prompt`, {
        as: env.devices!.terminal,
        body: { text: "human turn" },
      });
      await waitFor(() => env.hostSettles(sessionId) > settles, "human turn settled");
      await quiesce();
      expect(automatedPrompts().length).toBe(count);
      expect(env.run(taskId)!.controlMode).toBe("human");
      assertNoAutomationAfter(run.controlRevision);

      // Hand back to automation for the next round (re-evaluates the idle session at once).
      armed = armTakeover();
      const back = await env.ok("POST", `/api/sessions/${sessionId}/return-to-automation`, {
        as: env.devices!.terminal,
      });
      expect(back.run.controlMode).toBe("automation");
      await waitFor(() => automatedPrompts().length > count, "continuation after return");
    }
    // The continuation sent by the last return is taken over at its settle as well.
    await waitFor(armed.fired, "final settle");
    armed.disarm();
    const last = await armed.result();
    expect(last.status).toBe(200);
    await quiesce();
    assertNoAutomationAfter(last.body.run.controlRevision);
  });

  it("takeover committed before the continuation is prepared: nothing automated is sent", async () => {
    // Deterministic ordering: our listener runs before the runs service on the next settle.
    let rev = 0;
    let fired = false;
    const first = (s: { session: { id: string } }) => {
      if (s.session.id !== sessionId || fired) return;
      fired = true;
      void takeover(env.c.ctx, sessionId).then((r) => {
        rev = r.run.controlRevision;
      });
    };
    env.c.events.prependListener("session.settled", first);
    const before = automatedPrompts().length;
    await env.ok("POST", `/api/sessions/${sessionId}/return-to-automation`, {
      as: env.devices!.terminal,
    });
    // The idle session is re-evaluated at once: one continuation goes out before our takeover.
    await waitFor(() => automatedPrompts().length === before + 1, "continuation after return");
    const count = automatedPrompts().length;
    try {
      await waitFor(() => fired && rev > 0, "takeover at settle");
    } finally {
      env.c.events.off("session.settled", first);
    }
    await quiesce();
    expect(automatedPrompts().length).toBe(count);
    assertNoAutomationAfter(rev);

    // Even an explicit re-evaluation of the settled session sends nothing under human control.
    const runs = getService(env.c.ctx, "runs")!;
    await runs.onSessionSettled({
      session: env.session(sessionId),
      aborted: false,
      lastAssistantText: NO_MARKER_TEXT,
    });
    await quiesce();
    expect(automatedPrompts().length).toBe(count);
    expect(env.run(taskId)!.controlMode).toBe("human");
    expect(env.agent!.spawnedPiProcesses).toBe(1);
  });
});
