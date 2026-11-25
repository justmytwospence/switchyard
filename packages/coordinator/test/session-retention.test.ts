// @module-tag slow
import { afterEach, describe, expect, it } from "vitest";
import { archiveEndedSessions } from "../src/session-retention.js";
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
    expect(archived.sort()).toEqual(["ses_mid", "ses_old"]);
    expect(store.sessions.require("ses_old").archivedAt).not.toBeNull();
    for (const id of ["ses_recent", "ses_latest", "ses_live_old", "ses_alone", "ses_older_pinned"])
      expect(store.sessions.require(id).archivedAt, id).toBeNull();
    expect(archiveEndedSessions(store)).toEqual([]);
    expect(archiveEndedSessions(store, 0)).toEqual([]);

    // Its Pi comes back in a terminal: the session is work again.
    await put("ses_old", { runtime: "idle", lastActivityAt: store.nowIso() });
    expect(store.sessions.require("ses_old").archivedAt).toBeNull();
  });
});
