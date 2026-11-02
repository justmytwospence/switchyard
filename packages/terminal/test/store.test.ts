import { describe, expect, it } from "vitest";
import {
  applyEvent,
  applyReplay,
  applySessionSnapshot,
  applySnapshot,
  applyStream,
  applyTranscriptPage,
  emptyState,
  upsertInteraction,
} from "../src/store.js";
import { event, interaction, item, session, syncState } from "./fixtures.js";

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

  it("replays events in seq order", () => {
    const s = applyReplay(applySnapshot(emptyState(), 1, syncState()), 3, [
      event(3, "session.updated", session({ title: "three" })),
      event(2, "session.updated", session({ title: "two" })),
    ]);
    expect(s.sessions.ses_1?.title).toBe("three");
    expect(s.seq).toBe(3);
  });

  it("marks loaded transcripts stale on snapshot and replaces them on reload", () => {
    let s = applyTranscriptPage(
      applySnapshot(emptyState(), 1, syncState()),
      "ses_1",
      [item({ id: "itm_a", kind: "user", data: { text: "hi" } })],
      false,
    );
    s = applySnapshot(s, 5, syncState());
    expect(s.transcripts.ses_1?.stale).toBe(true);
    s = applyTranscriptPage(
      s,
      "ses_1",
      [item({ id: "itm_b", kind: "user", data: { text: "x" } })],
      false,
    );
    expect(s.transcripts.ses_1?.items.map((i) => i.id)).toEqual(["itm_b"]);
    expect(s.transcripts.ses_1?.stale).toBe(false);
  });

  it("buffers stream deltas and drops them when the durable item arrives", () => {
    let s = applySnapshot(emptyState(), 1, syncState());
    s = applyStream(s, { sessionId: "ses_1", itemId: "itm_x", kind: "text", delta: "Hel" });
    s = applyStream(s, { sessionId: "ses_1", itemId: "itm_x", kind: "text", delta: "lo" });
    expect(s.streaming.itm_x?.text).toBe("Hello");
    s = applyEvent(
      s,
      event(
        2,
        "transcript.item",
        item({ id: "itm_x", kind: "assistant", data: { text: "Hello" } }),
      ),
    );
    expect(s.streaming.itm_x).toBeUndefined();
    expect(s.transcripts.ses_1?.items[0]?.id).toBe("itm_x");
  });

  it("clears a session's streams when it leaves a live runtime", () => {
    let s = applySnapshot(emptyState(), 1, syncState());
    s = applyStream(s, { sessionId: "ses_1", itemId: "itm_x", kind: "text", delta: "a" });
    s = applyEvent(s, event(2, "session.updated", session({ runtime: "running" })));
    expect(s.streaming.itm_x).toBeDefined();
    s = applyEvent(s, event(3, "session.updated", session({ runtime: "stopped" })));
    expect(s.streaming.itm_x).toBeUndefined();
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

  it("merges a host session snapshot without duplicating durable items", () => {
    let s = applyTranscriptPage(
      emptyState(),
      "ses_1",
      [item({ id: "itm_a", order: 1, kind: "user", data: { text: "hi" } })],
      false,
    );
    s = applySessionSnapshot(s, "ses_1", {
      partial: [
        item({ id: "itm_a", order: 1, kind: "user", data: { text: "changed" } }),
        item({ id: "itm_b", order: 2, kind: "assistant", data: { text: "par", streaming: true } }),
      ],
      pendingInteractions: [interaction({ t: "text", text: "q" })],
    });
    expect(s.transcripts.ses_1?.items.map((i) => i.id)).toEqual(["itm_a", "itm_b"]);
    expect(s.transcripts.ses_1?.items[0]?.data).toMatchObject({ text: "hi" });
    expect(s.interactions.int_1?.state).toBe("pending");
  });
});
