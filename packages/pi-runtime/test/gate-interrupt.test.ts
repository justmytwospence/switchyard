import { when } from "@switchyard/test-fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type PiHarness, record, setupPi, skipRealPi, waitFor } from "./helpers.js";

describe.skipIf(skipRealPi)("gate: interrupt", () => {
  let h: PiHarness;
  beforeAll(async () => {
    h = await setupPi([
      {
        when: when.userSays("slow"),
        reply: { toolCalls: [{ name: "fixture_slow", arguments: {} }] },
      },
    ]);
  });
  afterAll(async () => {
    await h?.dispose();
  });

  it("SIGKILL of the child marks the session interrupted and keeps the native handle", async () => {
    const s = h.newSession();
    const rec = record(s, ["runtime", "exit"]);
    await s.start();
    const handle = s.nativeHandle!;
    const toolStarted = waitFor(s, "pi_event", (e: any) => e.type === "tool_execution_start");
    await s.prompt("do something slow");
    await toolStarted;

    const exited = waitFor(s, "exit");
    process.kill(s.process!.pid!, "SIGKILL");
    const info = await exited;
    expect(info).toMatchObject({ signal: "SIGKILL", requested: false });
    expect(s.runtime).toBe("interrupted");
    expect(s.runtimeDetail).toContain("SIGKILL");
    expect(s.nativeHandle).toEqual(handle);
    expect(rec.of("runtime").at(-1)).toMatchObject({ runtime: "interrupted" });
    await expect(s.prompt("hello")).rejects.toMatchObject({ code: "invalid_request" });

    // the interrupted session resumes with the same identity
    h.mock.setScript([]);
    const resumed = h.newSession({ nativeHandle: handle });
    await resumed.start();
    expect(resumed.nativeHandle).toEqual(handle);
    const history = await resumed.history();
    expect(history.some((i) => i.kind === "user" && i.data.text === "do something slow")).toBe(
      true,
    );
  });

  it("a requested stop is `stopped`, not interrupted", async () => {
    const s = h.newSession();
    await s.start();
    const exit = await s.stop();
    expect(exit?.requested).toBe(true);
    expect(s.runtime).toBe("stopped");
  });

  it("a spawn failure gives `failed`", async () => {
    const s = h.newSession({ piBin: "/nonexistent/pi-binary" });
    await expect(s.start()).rejects.toMatchObject({ code: "internal" });
    expect(s.runtime).toBe("failed");
    expect(s.runtimeDetail).toContain("Could not start Pi");
  });

  it("a Pi that exits during startup gives `failed`", async () => {
    const s = h.newSession({ extraArgs: ["--bogus-flag"] });
    await expect(s.start()).rejects.toMatchObject({ code: "internal" });
    expect(s.runtime).toBe("failed");
    expect(s.runtimeDetail).toContain("Unknown option: --bogus-flag");
  });
});
