import { describe, expect, it } from "vitest";
import { emptyQueryItems, rankItems, scoreMatch } from "../src/features/palette/match";
import type { PaletteItem } from "../src/features/palette/registry";
import { matchShortcut } from "../src/features/palette/shortcuts";

const item = (id: string, title: string, over: Partial<PaletteItem> = {}): PaletteItem => ({
  id,
  title,
  group: "Sessions",
  run: () => {},
  ...over,
});

describe("scoreMatch", () => {
  it("tiers", () => {
    expect(scoreMatch("fix", "Fix")).toBe(100);
    expect(scoreMatch("fix", "Fix login")).toBe(80);
    expect(scoreMatch("log fix", "Fix login")).toBe(60);
    expect(scoreMatch("ogi", "Fix login")).toBe(40);
    expect(scoreMatch("flg", "Fix login")).toBe(20);
    expect(scoreMatch("zzz", "Fix login")).toBe(0);
  });
});

describe("rankItems", () => {
  it("breaks ties by activity, then recency", () => {
    const a = item("a", "Fix a", { activityAt: "2026-01-01" });
    const b = item("b", "Fix b", { activityAt: "2026-01-02" });
    expect(rankItems([a, b], "fix", []).map((i) => i.id)).toEqual(["b", "a"]);
    const c = item("c", "Fix c");
    const d = item("d", "Fix d");
    expect(rankItems([c, d], "fix", ["d", "c"]).map((i) => i.id)).toEqual(["d", "c"]);
    expect(rankItems([item("x", "nope")], "fix", [])).toEqual([]);
  });
});

describe("emptyQueryItems", () => {
  it("orders sections and omits empty ones", () => {
    const items = [
      item("s1", "One"),
      item("s2", "Two"),
      item("s3", "Three"),
      item("act", "New session", { group: "Actions" }),
    ];
    const out = emptyQueryItems(items, { needsYou: new Set(["s1"]), review: new Set(["s2"]) });
    expect(out.map((s) => s.label)).toEqual(["Needs you", "Ready to review", "Recent", "Actions"]);
    const none = emptyQueryItems([item("act", "x", { group: "Actions" })], {
      needsYou: new Set(),
      review: new Set(),
    });
    expect(none.map((s) => s.label)).toEqual(["Actions"]);
  });
});

describe("matchShortcut", () => {
  const e = (
    code: string,
    o: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {},
  ) => ({
    code,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...o,
  });
  it("matches Mod per platform, Alt by code, and rejects extra modifiers", () => {
    expect(matchShortcut(e("KeyK", { metaKey: true }), true)).toBe("palette");
    expect(matchShortcut(e("KeyK", { ctrlKey: true }), true)).toBeNull();
    expect(matchShortcut(e("KeyK", { ctrlKey: true }), false)).toBe("palette");
    expect(matchShortcut(e("KeyN", { altKey: true }), true)).toBe("newSession");
    expect(matchShortcut(e("KeyN", { altKey: true, shiftKey: true }), true)).toBeNull();
    expect(matchShortcut(e("KeyK", { metaKey: true, altKey: true }), true)).toBeNull();
  });
});
