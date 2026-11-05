import { describe, expect, it } from "vitest";
import {
  applyEvent,
  applyEvents,
  applySnapshot,
  applyStream,
  applyTranscriptPage,
  emptySyncData,
  mergeTranscriptItems,
  toSyncState,
} from "../src/sync/reduce";
import { countAttention, groupTasksByState, useSyncStore } from "../src/sync/store";
import { assistant, attention, ev, interaction, session, snapshot, task } from "./fixtures";

describe("snapshot", () => {
  it("normalizes entities, drops resolved attention and round-trips", () => {
    const s = applySnapshot(
      emptySyncData(),
      10,
      snapshot({
        tasks: [task("tsk_a"), task("tsk_b")],
        sessions: [session("ses_1")],
        attention: [attention("att_1"), attention("att_2", { resolvedAt: "2026-11-01T11:00:00Z" })],
        dispatchPaused: true,
      }),
    );
    expect(s.seq).toBe(10);
    expect(Object.keys(s.tasks)).toEqual(["tsk_a", "tsk_b"]);
    expect(Object.keys(s.attention)).toEqual(["att_1"]);
    expect(s.dispatchPaused).toBe(true);
    const back = toSyncState(s);
    expect(back.tasks).toHaveLength(2);
    expect(back.sessions[0]!.id).toBe("ses_1");
  });

  it("keeps loaded transcripts but marks them stale and clears streams", () => {
    let s = applyTranscriptPage(emptySyncData(), "ses_1", [assistant("itm_1", 1, "a")], {
      hasMore: false,
      older: false,
    });
    s = applyStream(s, { sessionId: "ses_1", itemId: "itm_2", kind: "text", delta: "x" });
    s = applySnapshot(s, 5, snapshot());
    expect(s.transcripts.ses_1!.stale).toBe(true);
    expect(s.transcripts.ses_1!.items).toHaveLength(1);
    expect(s.streaming).toEqual({});
  });
});

describe("events", () => {
  it("applies durable events and ignores ones at or below the cursor", () => {
    let s = applySnapshot(emptySyncData(), 100, snapshot({ tasks: [task("tsk_a")] }));
    s = applyEvent(s, ev("task.updated", task("tsk_a", { state: "ready" }), 100));
    expect(s.tasks.tsk_a!.state).toBe("backlog");
    s = applyEvent(s, ev("task.updated", task("tsk_a", { state: "ready" }), 101));
    expect(s.tasks.tsk_a!.state).toBe("ready");
    expect(s.seq).toBe(101);
    s = applyEvent(s, ev("task.deleted", { id: "tsk_a" }, 102));
    expect(s.tasks.tsk_a).toBeUndefined();
  });

  it("applies replay batches in seq order", () => {
    const s = applyEvents(applySnapshot(emptySyncData(), 0, snapshot()), [
      ev("session.updated", session("ses_1", { title: "second" }), 3),
      ev("session.updated", session("ses_1", { title: "first" }), 2),
      ev("settings.updated", { dispatchPaused: true }, 4),
    ]);
    expect(s.sessions.ses_1!.title).toBe("second");
    expect(s.dispatchPaused).toBe(true);
    expect(s.seq).toBe(4);
  });

  it("handles attention resolution, interactions, panels, occurrences and diagnostics", () => {
    let s = applySnapshot(emptySyncData(), 0, snapshot());
    s = applyEvent(s, ev("attention.updated", attention("att_1"), 1));
    s = applyEvent(s, ev("attention.updated", attention("att_2", { acknowledgedAt: "x" }), 2));
    expect(countAttention(s.attention)).toBe(1);
    s = applyEvent(s, ev("attention.updated", attention("att_1", { resolvedAt: "x" }), 3));
    expect(s.attention.att_1).toBeUndefined();

    s = applyEvent(s, ev("interaction.updated", interaction("int_1", { revision: 2 }), 4));
    s = applyEvent(
      s,
      ev("interaction.updated", interaction("int_1", { revision: 1, title: "old" }), 5),
    );
    expect(s.interactions.int_1!.revision).toBe(2);

    const panel = {
      sessionId: "ses_1",
      adapterId: "todo",
      slot: "main",
      title: "Todos",
      node: { t: "text", text: "1" },
      webRenderer: false,
      mobileFallback: null,
      updatedAt: "x",
    };
    s = applyEvent(s, ev("panel.updated", panel, 6));
    expect(Object.keys(s.panels)).toEqual(["ses_1:todo:main"]);
    s = applyEvent(s, ev("panel.updated", { ...panel, node: null }, 7));
    expect(s.panels).toEqual({});

    const occ = {
      id: "occ_1",
      automationId: "aut_1",
      key: "k",
      scheduledFor: null,
      state: "fired",
      taskId: null,
      reason: null,
      outcome: null,
      createdAt: "x",
    };
    s = applyEvent(s, ev("occurrence.created", occ, 8));
    s = applyEvent(s, ev("occurrence.created", { ...occ, id: "occ_2" }, 9));
    expect(s.occurrences.aut_1!.map((o) => o.id)).toEqual(["occ_2", "occ_1"]);

    s = applyEvent(
      s,
      ev(
        "diagnostic",
        { sessionId: null, adapterId: "a", level: "warning", message: "m", at: "x" },
        10,
      ),
    );
    expect(s.diagnostics).toHaveLength(1);

    s = applyEvent(s, ev("adapters.updated", { hostId: "hst_1", adapters: [] }, 11));
    expect(s.adapters.hst_1).toEqual([]);
  });

  it("groups tasks by state sorted by priority, position, createdAt and hides routine tasks", () => {
    const tasks = {
      a: task("a", { state: "ready", priority: 2, position: 2 }),
      b: task("b", { state: "ready", priority: 0, position: 5 }),
      c: task("c", { state: "ready", priority: 2, position: 1 }),
      d: task("d", { state: "done", hiddenFromBoard: true }),
    };
    const g = groupTasksByState(tasks);
    expect(g.ready.map((t) => t.id)).toEqual(["b", "c", "a"]);
    expect(g.done).toEqual([]);
    expect(groupTasksByState(tasks, { includeHidden: true }).done).toHaveLength(1);
  });
});

describe("transcripts", () => {
  it("merges by id and sorts by order", () => {
    const merged = mergeTranscriptItems(
      [assistant("i3", 3, "c"), assistant("i1", 1, "a")],
      [assistant("i2", 2, "b"), assistant("i3", 3, "c2")],
    );
    expect(merged.map((i) => i.id)).toEqual(["i1", "i2", "i3"]);
    expect((merged[2]!.data as { text: string }).text).toBe("c2");
  });

  it("merges REST pages with live transcript.item events in order", () => {
    let s = applySnapshot(emptySyncData(), 0, snapshot());
    // A live item arrives before the history page is loaded.
    s = applyEvent(s, ev("transcript.item", assistant("i5", 5, "live"), 1));
    s = applyTranscriptPage(s, "ses_1", [assistant("i3", 3, "c"), assistant("i4", 4, "d")], {
      hasMore: true,
      older: false,
    });
    expect(s.transcripts.ses_1!.items.map((i) => i.order)).toEqual([3, 4, 5]);
    expect(s.transcripts.ses_1!.hasMore).toBe(true);
    s = applyTranscriptPage(s, "ses_1", [assistant("i1", 1, "a"), assistant("i2", 2, "b")], {
      hasMore: false,
      older: true,
    });
    expect(s.transcripts.ses_1!.items.map((i) => i.order)).toEqual([1, 2, 3, 4, 5]);
    expect(s.transcripts.ses_1!.hasMore).toBe(false);
  });

  it("buffers stream deltas and drops them when the durable item lands", () => {
    let s = applySnapshot(emptySyncData(), 0, snapshot());
    s = applyStream(s, { sessionId: "ses_1", itemId: "i9", kind: "text", delta: "Hel", order: 9 });
    s = applyStream(s, { sessionId: "ses_1", itemId: "i9", kind: "text", delta: "lo" });
    s = applyStream(s, { sessionId: "ses_1", itemId: "i9", kind: "thinking", delta: "hmm" });
    expect(s.streaming.i9).toMatchObject({ text: "Hello", thinking: "hmm", order: 9 });
    s = applyEvent(s, ev("transcript.item", assistant("i9", 9, "Hello"), 1));
    expect(s.streaming.i9).toBeUndefined();
  });

  it("clears a session's streams when it stops running", () => {
    let s = applySnapshot(emptySyncData(), 0, snapshot());
    s = applyStream(s, { sessionId: "ses_1", itemId: "i9", kind: "text", delta: "x" });
    s = applyEvent(s, ev("session.updated", session("ses_1", { runtime: "running" }), 1));
    expect(s.streaming.i9).toBeDefined();
    s = applyEvent(s, ev("session.updated", session("ses_1", { runtime: "idle" }), 2));
    expect(s.streaming.i9).toBeUndefined();
  });

  it("replaces stale items when the newest page is reloaded after a resync", () => {
    let s = applyTranscriptPage(emptySyncData(), "ses_1", [assistant("old", 1, "x")], {
      hasMore: false,
      older: false,
    });
    s = applySnapshot(s, 50, snapshot());
    s = applyTranscriptPage(s, "ses_1", [assistant("new", 2, "y")], {
      hasMore: false,
      older: false,
    });
    expect(s.transcripts.ses_1!.items.map((i) => i.id)).toEqual(["new"]);
    expect(s.transcripts.ses_1!.stale).toBe(false);
  });
});

describe("upsertSessionIfMissing", () => {
  it("inserts a new session, keeps an existing one, and sync events replace it", () => {
    const store = useSyncStore;
    store.getState().reset?.();
    store.getState().upsertSessionIfMissing(session("ses_up", { title: "from http" }));
    expect(store.getState().sessions.ses_up?.title).toBe("from http");
    store.getState().upsertSessionIfMissing(session("ses_up", { title: "ignored" }));
    expect(store.getState().sessions.ses_up?.title).toBe("from http");
    store
      .getState()
      .applyEvent(
        ev("session.updated", session("ses_up", { title: "from sync" }), store.getState().seq + 1),
      );
    expect(store.getState().sessions.ses_up?.title).toBe("from sync");
  });
});

describe("lastSyncedAt", () => {
  it("lives outside connection so live events keep its identity", () => {
    const store = useSyncStore;
    store.getState().reset();
    expect(store.getState().lastSyncedAt).toBeNull();
    store.getState().applySnapshot(1, snapshot());
    const c = store.getState().connection;
    expect(store.getState().lastSyncedAt).not.toBeNull();
    store.getState().applyEvent(ev("session.updated", session("ses_1"), 2));
    store.getState().markSynced();
    expect(store.getState().connection).toBe(c);
    expect(store.getState().lastSyncedAt).not.toBeNull();
  });
});

describe("applyReplay", () => {
  it("drops stream buffers missed while disconnected", () => {
    const store = useSyncStore;
    store.getState().reset();
    store.getState().applySnapshot(1, snapshot());
    store
      .getState()
      .applyStream({ sessionId: "ses_1", itemId: "i9", kind: "text", delta: "partial", order: 9 });
    expect(store.getState().streaming.i9).toBeDefined();
    store.getState().applyReplay(2, []);
    expect(store.getState().streaming).toEqual({});
  });
});
