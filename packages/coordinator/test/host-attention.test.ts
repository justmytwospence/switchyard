// @module-tag slow
import type { Interaction } from "@switchyard/protocol";
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

  it("ends a session's input when its Pi stops, whatever raised it", async () => {
    h = await setupHarness();
    await h.host.event("session.updated", hostSession("ses_s", { cwd: ROOT, runtime: "running" }));
    // A terminal-only dialog still open when Pi exits (hosts one release behind never close it).
    await h.host.event("interaction.updated", dialog("int_term", "ses_s"));
    // A question raised by an adapter.
    await h.host.event("diagnostic", {
      sessionId: "ses_s",
      adapterId: "ask",
      level: "info",
      message: "Waiting for you",
      attention: { reason: "needs_input", summary: "Answer me" },
    });
    // Not a question: keeps its label after the session stops.
    await h.host.event("diagnostic", {
      sessionId: "ses_s",
      adapterId: "plan-mode",
      level: "info",
      message: "Plan ready",
      attention: { reason: "ready_for_review", summary: "Plan is ready" },
    });
    const open = () =>
      h!.t.c.attention
        .open({ sessionId: "ses_s" })
        .map((a) => a.reason)
        .sort();
    expect(open()).toEqual(["needs_input", "ready_for_review", "unsupported_interaction"]);

    await h.host.event("session.updated", hostSession("ses_s", { cwd: ROOT, runtime: "stopped" }));
    expect(open()).toEqual(["ready_for_review"]);
    expect(h.t.c.store.interactions.require("int_term")).toMatchObject({
      state: "expired",
      revision: 2,
      resolution: { by: "coordinator" },
    });

    // Late reports from the stopped session raise nothing.
    await h.host.event("interaction.updated", dialog("int_late", "ses_s"));
    await h.host.event("diagnostic", {
      sessionId: "ses_s",
      adapterId: "ask",
      level: "info",
      message: "Still waiting",
      attention: { reason: "needs_input", summary: "Answer me" },
    });
    expect(open()).toEqual(["ready_for_review"]);
    expect(h.t.c.store.interactions.require("int_late").state).toBe("expired");
  });

  it("resolves a terminal-only dialog's attention when the host expires it", async () => {
    h = await setupHarness();
    await h.host.event("session.updated", hostSession("ses_e", { cwd: ROOT, runtime: "running" }));
    const d = dialog("int_e", "ses_e");
    await h.host.event("interaction.updated", d);
    expect(h.t.c.attention.open({ sessionId: "ses_e" })).toHaveLength(1);
    await h.host.event("interaction.updated", {
      ...d,
      revision: 2,
      state: "expired",
      resolution: { by: "host", summary: "Pi exited", at: new Date().toISOString() },
    });
    expect(h.t.c.attention.open({ sessionId: "ses_e" })).toEqual([]);
  });

  it("dismisses an item by resolving it", async () => {
    h = await setupHarness();
    await h.host.event("session.updated", hostSession("ses_x", { cwd: ROOT }));
    await h.host.event("diagnostic", {
      sessionId: "ses_x",
      adapterId: "x",
      level: "info",
      message: "m",
      attention: { reason: "ready_for_review", summary: "Look" },
    });
    const [a] = h.t.c.attention.open({ sessionId: "ses_x" });
    const r = await h.t.admin("POST", `/api/attention/${a!.id}/dismiss`);
    expect(r.status).toBe(200);
    expect(r.body.resolvedAt).not.toBeNull();
    expect(r.body.acknowledgedAt).not.toBeNull();
    expect(h.t.c.attention.open({ sessionId: "ses_x" })).toEqual([]);
  });

  it("accepts the legacy workspace.removed name", async () => {
    h = await setupHarness();
    const main = h.t.c.store.workspaceByPath(h.creds.hostId, ROOT)!;
    expect(main).toBeDefined();
    await h.host.event("workspace.removed" as never, { id: ROOT, path: ROOT });
    expect(h.t.c.store.workspaces.get(main.id)?.archivedAt).not.toBeNull();
  });

  it("matches workspace.deleted by path", async () => {
    h = await setupHarness();
    const main = h.t.c.store.workspaceByPath(h.creds.hostId, ROOT)!;
    expect(main).toBeDefined();
    await h.host.event("workspace.deleted", { id: ROOT, path: ROOT });
    expect(h.t.c.store.workspaces.get(main.id)?.archivedAt).not.toBeNull();
  });
});

function dialog(id: string, sessionId: string): Interaction {
  return {
    id,
    sessionId,
    revision: 1,
    source: { kind: "unsupported_custom", title: null },
    adapterId: null,
    title: "Terminal-only interface requested",
    presentation: { t: "text", text: "unsupported" },
    state: "unsupported",
    resolution: null,
    createdAt: new Date().toISOString(),
  };
}
