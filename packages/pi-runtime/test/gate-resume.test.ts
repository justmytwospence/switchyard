import { readFileSync, rmSync } from "node:fs";
import { when } from "@switchyard/test-fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lastSessionName } from "../src/index.js";
import { type PiHarness, record, setupPi, skipRealPi, waitFor } from "./helpers.js";

describe.skipIf(skipRealPi)("gate: resume", () => {
  let h: PiHarness;
  beforeAll(async () => {
    h = await setupPi([
      { when: when.userSays("remember"), reply: { text: "I will remember the walrus" } },
      { when: when.userSays("what"), reply: { text: "You said walrus" } },
    ]);
  });
  afterAll(async () => {
    await h?.dispose();
  });

  it("restarts with --session <file>: same native session id, history contains the earlier prompt", async () => {
    const first = h.newSession({ title: "Resume me" });
    await first.start();
    const settled = waitFor(first, "settled");
    await first.prompt("remember the walrus");
    await settled;
    const handle = first.nativeHandle!;
    await first.stop();
    expect(first.runtime).toBe("stopped");

    const second = h.newSession({ title: "Resume me", nativeHandle: handle });
    const rec = record(second, ["native"]);
    expect(second.buildArgs().slice(0, 2)).toEqual(["--session", handle.sessionFile]);
    // same title: no extra --name (Pi would append another session_info entry)
    expect(second.buildArgs()).not.toContain("--name");
    await second.start();
    expect(rec.of("native")).toEqual([handle]);
    const state = await second.state();
    expect(state.sessionId).toBe(handle.sessionId);
    expect(state.sessionFile).toBe(handle.sessionFile);

    const history = await second.history();
    const texts = history.map((i) => `${i.kind}:${(i.data as any).text ?? ""}`);
    expect(texts).toContain("user:remember the walrus");
    expect(texts).toContain("assistant:I will remember the walrus");
    expect(history.map((i) => i.order)).toEqual(history.map((_, n) => n));

    // the resumed session continues with the earlier context
    const again = waitFor(second, "settled");
    await second.prompt("what did I say?");
    await again;
    const lastRequest = h.mock.requests.at(-1)!;
    expect(JSON.stringify(lastRequest.messages)).toContain("remember the walrus");
    await second.stop();

    // renaming on resume passes --name once
    const third = h.newSession({ title: "Renamed", nativeHandle: handle });
    expect(third.buildArgs()).toContain("--name");
    await third.start();
    await third.rename("Renamed again");
    await third.stop();
    expect(lastSessionName(readFileSync(handle.sessionFile, "utf8"))).toBe("Renamed again");
  });

  it("a missing session file fails with native_session_missing and never starts a fresh session", async () => {
    const first = h.newSession();
    await first.start();
    const settled = waitFor(first, "settled");
    await first.prompt("remember this");
    await settled;
    const handle = first.nativeHandle!;
    await first.stop();
    rmSync(handle.sessionFile);

    const resumed = h.newSession({ nativeHandle: handle });
    const rec = record(resumed, ["runtime"]);
    await expect(resumed.start()).rejects.toMatchObject({ code: "native_session_missing" });
    expect(resumed.process).toBeNull();
    expect(resumed.runtime).toBe("failed");
    expect(rec.of("runtime").at(-1)).toMatchObject({ runtime: "failed" });
    expect(resumed.nativeHandle).toEqual(handle);
  });
});
