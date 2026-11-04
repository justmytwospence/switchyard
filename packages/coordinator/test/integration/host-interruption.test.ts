import { existsSync, rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Integration, sessionFiles, steps, waitFor } from "./harness.js";

/** Spec §19: host/process interruption, resume, and a missing native session. */
describe("Pi process interruption and resume", { timeout: 180_000 }, () => {
  let env: Integration;
  beforeAll(async () => {
    env = await Integration.create();
  });
  afterAll(async () => {
    await env?.dispose();
  });

  async function killPi(sessionId: string) {
    const ms = env.agent!.supervisor.managedSession(sessionId);
    const proc = ms!.process!;
    proc.child.kill("SIGKILL");
    await waitFor(() => !env.agent!.supervisor.isLive(sessionId), "Pi gone");
  }

  it("killing Pi interrupts the session; sending resumes the same native session", async () => {
    const { terminal } = env.devices!;
    const s = await env.createSession(terminal, "", "Interrupt me");
    const handle = s.nativeHandle!;
    await env.livePi(s.id);
    await env.ok("POST", `/api/sessions/${s.id}/prompt`, {
      as: terminal,
      body: { text: `Take your time ${steps("slow:30000", "done")}` },
    });
    await env.waitSession(s.id, (x) => x.runtime === "running", "running");
    // Kill while the slow tool executes, once Pi has written the native session file.
    await waitFor(
      () =>
        env.c.store
          .listItems(s.id, { limit: 1000 })
          .items.some(
            (i) => i.kind === "tool" && (i.data as { name: string }).name === "fixture_slow",
          ) && existsSync(handle.sessionFile),
      "slow tool running",
    );
    await killPi(s.id);

    const interrupted = await env.waitSession(
      s.id,
      (x) => x.runtime === "interrupted",
      "interrupted",
    );
    expect(interrupted.nativeHandle).toEqual(handle);
    // Sending to an interrupted session resumes the same native session, then sends.
    const filesBefore = sessionFiles(env.pi!.sessionsDir);
    await env.ok("POST", `/api/sessions/${s.id}/prompt`, {
      as: terminal,
      body: { text: `Carry on ${steps("done")}` },
    });
    const live = env.session(s.id);
    expect(live.nativeHandle!.sessionId).toBe(handle.sessionId);
    expect(live.nativeHandle!.sessionFile).toBe(handle.sessionFile);
    expect(env.agent!.spawnedPiProcesses).toBe(2);

    // The resumed Pi has the earlier conversation and continues it in the same file.
    await env.waitSession(
      s.id,
      (x) => x.runtime === "idle" && /SWITCHYARD: DONE/.test(x.lastAssistantText ?? ""),
      "continued",
    );
    const last = env.mock!.requests.at(-1)!;
    const userTexts = last.messages
      .filter((m) => m.role === "user")
      .map((m) => JSON.stringify(m.content));
    expect(userTexts.some((t) => t.includes("Take your time"))).toBe(true);
    expect(sessionFiles(env.pi!.sessionsDir)).toEqual(filesBefore);
    expect(env.session(s.id).nativeHandle).toEqual(handle);
  });

  it("resume after the native file was deleted gives native_session_missing and creates nothing", async () => {
    const { terminal } = env.devices!;
    const s = await env.createSession(terminal, `Hello ${steps("done")}`, "Lose my file");
    await env.waitSession(
      s.id,
      (x) => x.runtime === "idle" && /SWITCHYARD: DONE/.test(x.lastAssistantText ?? ""),
      "first turn",
    );
    await env.livePi(s.id);
    await killPi(s.id);
    const interrupted = await env.waitSession(
      s.id,
      (x) => x.runtime === "interrupted",
      "interrupted",
    );
    const file = interrupted.nativeHandle!.sessionFile;
    await waitFor(() => existsSync(file), "native session file written");
    rmSync(file);
    const before = sessionFiles(env.pi!.sessionsDir);
    const spawned = env.agent!.spawnedPiProcesses;

    const r = await env.api("POST", `/api/sessions/${s.id}/resume`, { as: terminal });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("native_session_missing");
    expect(sessionFiles(env.pi!.sessionsDir)).toEqual(before);
    expect(env.agent!.spawnedPiProcesses).toBe(spawned);
    const after = env.session(s.id);
    // Not live; the host may record the failed start (`failed`) or keep `interrupted`.
    expect(["interrupted", "failed"]).toContain(after.runtime);
    if (after.runtime === "failed") expect(after.runtimeDetail ?? "").toMatch(/not found|missing/i);
    expect(after.nativeHandle).toEqual(interrupted.nativeHandle);
  });
});
