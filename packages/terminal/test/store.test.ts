import { describe, expect, it } from "vitest";
import {
  applyEvent,
  applyReplay,
  applySnapshot,
  emptyState,
  upsertInteraction,
} from "../src/store.js";
import { event, interaction, session, syncState } from "./fixtures.js";

describe("store reducer", () => {
  it("applies a snapshot and ignores events at or below the cursor", () => {
    let s = applySnapshot(emptyState(), 10, syncState());
    expect(s.seq).toBe(10);
    expect(s.synced).toBe(true);
    expect(s.sessions.ses_1?.title).toBe("Fix login");
    s = applyEvent(s, event(9, "session.updated", session({ title: "old" })));
    expect(s.sessions.ses_1?.title).toBe("Fix login");
    s = applyEvent(s, event(11, "session.updated", session({ title: "new" })));
    expect(s.sessions.ses_1?.title).toBe("new");
    expect(s.seq).toBe(11);
  });

  it.each(["workspace.deleted", "workspace.removed"])("%s drops the workspace", (type) => {
    let s = applySnapshot(emptyState(), 0, syncState());
    s = applyEvent(s, event(1, "workspace.updated", { id: "wsp_1", archivedAt: null }));
    expect(s.workspaces.wsp_1).toBeDefined();
    s = applyEvent(s, event(2, type as never, { id: "wsp_1" }));
    expect(s.workspaces.wsp_1).toBeUndefined();
  });

  it("replays events in seq order", () => {
    const s = applyReplay(applySnapshot(emptyState(), 1, syncState()), 3, [
      event(3, "session.updated", session({ title: "three" })),
      event(2, "session.updated", session({ title: "two" })),
    ]);
    expect(s.sessions.ses_1?.title).toBe("three");
    expect(s.seq).toBe(3);
  });

  it("never lets an older interaction revision overwrite a newer one", () => {
    const node = { t: "text" as const, text: "q" };
    let s = upsertInteraction(emptyState(), interaction(node, { revision: 2, state: "resolved" }));
    s = upsertInteraction(s, interaction(node, { revision: 1, state: "pending" }));
    expect(s.interactions.int_1?.state).toBe("resolved");
  });

  it("drops resolved attention items", () => {
    let s = applySnapshot(emptyState(), 1, syncState());
    const att = {
      id: "att_1",
      sessionId: "ses_1",
      taskId: null,
      projectId: "prj_1",
      reason: "needs_input" as const,
      severity: "warning" as const,
      summary: "q",
      interactionId: null,
      deepLink: "/code/ses_1",
      acknowledgedAt: null,
      resolvedAt: null,
      createdAt: "2026-11-02T10:00:00.000Z",
    };
    s = applyEvent(s, event(2, "attention.updated", att));
    expect(Object.keys(s.attention)).toEqual(["att_1"]);
    s = applyEvent(s, event(3, "attention.updated", { ...att, resolvedAt: att.createdAt }));
    expect(Object.keys(s.attention)).toEqual([]);
  });
});
