// @module-tag slow
import { afterEach, describe, expect, it } from "vitest";
import { archiveEndedSessions, sweepStaleSessionState } from "../src/session-retention.js";
import {
  enrollHost,
  FakeHost,
  hostSession,
  startCoordinator,
  type TestCoordinator,
} from "./helpers.js";

let t: TestCoordinator;
afterEach(async () => {
  await t?.cleanup();
});

const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

describe("archiving ended sessions", () => {
  it("keeps a branch's latest session and archives the older ended ones", async () => {
    t = await startCoordinator();
    const store = t.c.store;
    const host = await FakeHost.connect(t, await enrollHost(t));
    const put = (id: string, over: Record<string, unknown>) =>
      host.event("session.updated", hostSession(id, { runtime: "stopped", ...over }));
    await put("ses_old", { lastActivityAt: ago(10) });
    await put("ses_older_pinned", { lastActivityAt: ago(9) });
    await put("ses_mid", { lastActivityAt: ago(5) });
    await put("ses_recent", { lastActivityAt: ago(1) });
    await put("ses_latest", { lastActivityAt: ago(0.1) });
    await put("ses_live_old", { runtime: "idle", lastActivityAt: ago(20) });
    // Alone on its branch: the primary, however old.
    await put("ses_alone", { cwd: "/tmp/elsewhere", lastActivityAt: ago(30) });
    const now = store.nowIso();
    store.views.upsert({
      id: "viw_pin",
      name: "pins",
      mode: "pinned",
      projectIds: null,
      hostIds: null,
      sessionIds: ["ses_older_pinned"],
      clients: [],
      createdAt: now,
      updatedAt: now,
    });

    const archived = archiveEndedSessions(store).map((s) => s.id);
    // A pin is membership only: the pinned session is archived like any other, and unpinned.
    expect(archived.sort()).toEqual(["ses_mid", "ses_old", "ses_older_pinned"]);
    expect(store.sessions.require("ses_old").archivedAt).not.toBeNull();
    expect(store.views.require("viw_pin").sessionIds).toEqual([]);
    for (const id of ["ses_recent", "ses_latest", "ses_live_old", "ses_alone"])
      expect(store.sessions.require(id).archivedAt, id).toBeNull();
    expect(archiveEndedSessions(store)).toEqual([]);
    expect(archiveEndedSessions(store, 0)).toEqual([]);

    // Its Pi comes back in a terminal: the session is work again.
    await put("ses_old", { runtime: "idle", lastActivityAt: store.nowIso() });
    expect(store.sessions.require("ses_old").archivedAt).toBeNull();
  });

  it("clears questions and pins an older release left behind", async () => {
    t = await startCoordinator();
    const store = t.c.store;
    const host = await FakeHost.connect(t, await enrollHost(t));
    await host.event("session.updated", hostSession("ses_stuck", { runtime: "stopped" }));
    await host.event("session.updated", hostSession("ses_live", { runtime: "running" }));
    await host.event("session.updated", hostSession("ses_gone", { runtime: "stopped" }));
    const now = store.nowIso();
    // What 0.19 left: a terminal-only dialog and an adapter question on a stopped session.
    const dialog = (id: string, sessionId: string) => ({
      id,
      sessionId,
      revision: 1,
      source: { kind: "unsupported_custom" as const, title: null },
      adapterId: null,
      title: "Terminal-only interface requested",
      presentation: { t: "text" as const, text: "unsupported" },
      state: "unsupported" as const,
      resolution: null,
      createdAt: now,
    });
    store.putInteraction(dialog("int_stuck", "ses_stuck"));
    store.putInteraction(dialog("int_live", "ses_live"));
    const raise = (sessionId: string, reason: "needs_input" | "ready_for_review") =>
      store.putAttention({
        id: `att_${sessionId}_${reason}`,
        sessionId,
        taskId: null,
        projectId: null,
        reason,
        severity: "warning",
        summary: "x",
        interactionId: null,
        deepLink: "/attention",
        acknowledgedAt: now,
        resolvedAt: null,
        createdAt: now,
      });
    raise("ses_stuck", "needs_input");
    raise("ses_stuck", "ready_for_review");
    raise("ses_live", "needs_input");
    store.putSession({ ...store.sessions.require("ses_gone"), archivedAt: now });
    store.views.upsert({
      id: "viw_old",
      name: "old",
      mode: "pinned",
      projectIds: null,
      hostIds: null,
      sessionIds: ["ses_stuck", "ses_gone", "ses_missing"],
      clients: [],
      createdAt: now,
      updatedAt: now,
    });

    expect(sweepStaleSessionState(store, t.c.attention)).toEqual({ sessions: 1, pins: 2 });
    expect(store.interactions.require("int_stuck").state).toBe("expired");
    expect(store.interactions.require("int_live").state).toBe("unsupported");
    const open = store.attention.list("resolved_at IS NULL").map((a) => a.id);
    expect(open.sort()).toEqual(["att_ses_live_needs_input", "att_ses_stuck_ready_for_review"]);
    expect(store.views.require("viw_old").sessionIds).toEqual(["ses_stuck"]);
    expect(sweepStaleSessionState(store, t.c.attention)).toEqual({ sessions: 0, pins: 0 });
  });
});
