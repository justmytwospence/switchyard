import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lostRuntime, openHostDb } from "../src/index.js";
import { type HostHarness, mockProfile, startHarness } from "./helpers.js";

describe("host agent restart", () => {
  let h: HostHarness | null = null;
  afterEach(async () => {
    await h?.dispose();
    h = null;
  });

  it("lostRuntime stops idle sessions and interrupts working ones", () => {
    expect(lostRuntime({ runtime: "idle", compacting: false })).toBe("stopped");
    expect(lostRuntime({ runtime: "idle", compacting: true })).toBe("interrupted");
    expect(lostRuntime({ runtime: "running", compacting: false })).toBe("interrupted");
    expect(lostRuntime({ runtime: "waiting_input", compacting: false })).toBe("interrupted");
    expect(lostRuntime({ runtime: "starting", compacting: false })).toBe("interrupted");
  });

  it("loads ended sessions lazily", async () => {
    h = await startHarness({ withPi: false });
    await h.agent.stop();
    const now = new Date().toISOString();
    const db = openHostDb(join(h.stateDir, "host.db"));
    db.run("INSERT INTO sessions (id, json) VALUES (?, ?)", [
      "ses_old",
      JSON.stringify({
        id: "ses_old",
        title: "Old",
        subtitle: null,
        cwd: "/tmp",
        projectId: null,
        workspaceId: null,
        runId: null,
        taskId: null,
        dispatchKey: null,
        profile: mockProfile,
        nativeHandle: null,
        runtime: "stopped",
        runtimeDetail: null,
        controlRevision: 3,
        controlMode: "human",
        origin: "human",
        readOnly: false,
        provenance: "created",
        nextOrder: 42,
        queue: { steering: [], followUp: [] },
        stats: null,
        lastAssistantText: null,
        lastActivityAt: now,
        createdAt: now,
      }),
    ]);
    db.close();
    const agent = await h.restartAgent();
    expect(agent.supervisor.record("ses_old")).toMatchObject({ id: "ses_old", nextOrder: 42 });
    expect(agent.supervisor.controlOf("ses_old")).toEqual({
      controlRevision: 3,
      controlMode: "human",
    });
  });
});
