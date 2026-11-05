import { describe, expect, it } from "vitest";
import {
  countPendingInteractions,
  isBusyRuntime,
  isLiveRuntime,
  isOpenAttention,
  isStreamingRuntime,
  isUnacknowledgedAttention,
  pendingInteractionsFor,
  pendingInteractionsForSessions,
  sessionsNeedingAttention,
} from "../src/sync/selectors";
import { attention, interaction } from "./fixtures";

describe("runtime sets", () => {
  it("classifies every runtime", () => {
    const table = {
      starting: [true, true, false],
      idle: [false, true, false],
      running: [true, true, true],
      waiting_input: [true, true, true],
      stopped: [false, false, false],
    } as const;
    for (const [runtime, [streaming, live, busy]] of Object.entries(table)) {
      const r = runtime as Parameters<typeof isLiveRuntime>[0];
      expect([runtime, isStreamingRuntime(r), isLiveRuntime(r), isBusyRuntime(r)]).toEqual([
        runtime,
        streaming,
        live,
        busy,
      ]);
    }
  });

  it("treats idle as live but neither streaming nor busy", () => {
    expect(isLiveRuntime("idle")).toBe(true);
    expect(isStreamingRuntime("idle")).toBe(false);
    expect(isBusyRuntime("idle")).toBe(false);
  });
});

describe("pending interactions", () => {
  const all = {
    i3: interaction("i3", { sessionId: "ses_1", createdAt: "2026-11-01T10:03:00Z" }),
    i1: interaction("i1", { sessionId: "ses_1", createdAt: "2026-11-01T10:01:00Z" }),
    i2: interaction("i2", { sessionId: "ses_2", createdAt: "2026-11-01T10:02:00Z" }),
    done: interaction("done", { sessionId: "ses_1", state: "answered" }),
  };

  it("filters by session and sorts oldest first", () => {
    expect(pendingInteractionsFor(all, "ses_1").map((i) => i.id)).toEqual(["i1", "i3"]);
    expect(countPendingInteractions(all, "ses_1")).toBe(2);
    expect(countPendingInteractions(all, "ses_9")).toBe(0);
  });

  it("filters by a set of sessions and sorts oldest first", () => {
    const ids = pendingInteractionsForSessions(all, new Set(["ses_1", "ses_2"])).map((i) => i.id);
    expect(ids).toEqual(["i1", "i2", "i3"]);
    expect(pendingInteractionsForSessions(all, new Set(["ses_2"])).map((i) => i.id)).toEqual([
      "i2",
    ]);
  });
});

describe("attention", () => {
  const open = attention("open", { sessionId: "ses_1" });
  const acked = attention("acked", { sessionId: "ses_2", acknowledgedAt: "2026-11-01T11:00:00Z" });
  const resolved = attention("resolved", {
    sessionId: "ses_3",
    resolvedAt: "2026-11-01T11:00:00Z",
  });

  it("separates open from unacknowledged", () => {
    expect(isOpenAttention(acked)).toBe(true);
    expect(isOpenAttention(resolved)).toBe(false);
    expect(isUnacknowledgedAttention(open)).toBe(true);
    expect(isUnacknowledgedAttention(acked)).toBe(false);
    expect(isUnacknowledgedAttention(resolved)).toBe(false);
  });

  it("flags sessions with open (acknowledged included) attention or a pending interaction", () => {
    const set = sessionsNeedingAttention(
      { open, acked, resolved },
      { q: interaction("q", { sessionId: "ses_4" }) },
    );
    expect([...set].sort()).toEqual(["ses_1", "ses_2", "ses_4"]);
  });
});
