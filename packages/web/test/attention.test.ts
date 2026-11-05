import type { AttentionItem } from "@switchyard/protocol";
import { describe, expect, it } from "vitest";
import {
  attentionMeta,
  groupAttention,
  normalizeShow,
  visibleAttention,
} from "../src/features/attention/logic";

const item = (id: string, patch: Partial<AttentionItem> = {}): AttentionItem => ({
  id,
  sessionId: null,
  taskId: null,
  projectId: null,
  reason: "needs_input",
  severity: "info",
  summary: id,
  interactionId: null,
  deepLink: "/",
  acknowledgedAt: null,
  resolvedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...patch,
});

describe("attention logic", () => {
  it("normalizes stored show values", () => {
    expect(normalizeShow("all")).toBe("open");
    expect(normalizeShow(undefined)).toBe("open");
    expect(normalizeShow("history")).toBe("history");
    expect(normalizeShow("dismissed")).toBe("dismissed");
  });

  it("splits open and dismissed, and shows nothing for history", () => {
    const all = [item("a"), item("b", { acknowledgedAt: "2026-01-02T00:00:00.000Z" })];
    expect(visibleAttention(all, "open").map((a) => a.id)).toEqual(["a"]);
    expect(visibleAttention(all, "dismissed").map((a) => a.id)).toEqual(["b"]);
    expect(visibleAttention(all, "history")).toEqual([]);
  });

  it("builds the meta line", () => {
    expect(attentionMeta()).toBe("Switchyard");
    const project = { name: "proj" } as never;
    const task = { title: "T" } as never;
    expect(attentionMeta(project, task, { title: "T" } as never)).toBe("proj · T");
    expect(attentionMeta(project, task, { title: "S" } as never)).toBe("proj · T · S");
  });

  it("groups by reason keeping input order", () => {
    const g = groupAttention([item("a"), item("b", { reason: "failed" }), item("c")]);
    expect(g.needs_input.map((a) => a.id)).toEqual(["a", "c"]);
    expect(g.failed.map((a) => a.id)).toEqual(["b"]);
  });
});
