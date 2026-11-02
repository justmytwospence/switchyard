import { afterEach, describe, expect, it } from "vitest";
import { hostSession } from "./helpers.js";
import { cleanupHarness, type Harness, ROOT, setupHarness } from "./task-helpers.js";

let h: Harness | undefined;
afterEach(async () => {
  await cleanupHarness(h);
  h = undefined;
});

describe("host-reported attention and workspace removal", () => {
  it("raises adapter attention carried on diagnostic events", async () => {
    h = await setupHarness();
    await h.host.event("session.updated", hostSession("ses_d", { cwd: ROOT }));
    await h.host.event(
      "diagnostic",
      {
        sessionId: "ses_d",
        adapterId: "plan-mode",
        level: "info",
        message: "Plan ready",
        attention: { reason: "ready_for_review", summary: "Plan is ready to review" },
      },
      { sessionId: "ses_d" },
    );
    const [a] = h.t.c.attention.open({ sessionId: "ses_d", reason: "ready_for_review" });
    expect(a).toMatchObject({ summary: "Plan is ready to review", sessionId: "ses_d" });
    await h.host.event("diagnostic", {
      sessionId: "ses_d",
      adapterId: "x",
      level: "warning",
      message: "Something odd",
      attention: { reason: "weird", summary: "" },
    });
    const [u] = h.t.c.attention.open({ sessionId: "ses_d", reason: "unsupported_interaction" });
    expect(u!.summary).toBe("Something odd");
    // The diagnostic itself is still recorded without the extra key.
    const diag = h.t.c.store.latestEvents("diagnostic", 1)[0]!;
    expect(diag.data).not.toHaveProperty("attention");
  });

  it("matches workspace.removed by path", async () => {
    h = await setupHarness();
    const main = h.t.c.store.workspaceByPath(h.creds.hostId, ROOT)!;
    expect(main).toBeDefined();
    await h.host.event("workspace.removed", { id: ROOT, path: ROOT });
    expect(h.t.c.store.workspaces.get(main.id)).toBeUndefined();
  });
});
