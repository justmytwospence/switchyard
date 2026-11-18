import { describe, expect, it } from "vitest";
import { emptyQueryItems, rankItems, scoreMatch } from "../src/features/palette/match";
import type { PaletteItem } from "../src/features/palette/registry";
import {
  horizontalNavigationDelta,
  matchNavigationKey,
  matchShortcut,
  NAVIGATION_SHORTCUTS,
  paletteNavigationDelta,
  verticalNavigationDelta,
} from "../src/features/palette/shortcuts";

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
  it("keeps adapter entries in their own section without altering built-in actions", () => {
    const out = emptyQueryItems(
      [
        item("action", "New session", { group: "Actions" }),
        item('["ses","adapter","slot"]', "Slot action", { group: "Extensions" }),
      ],
      { needsYou: new Set(), review: new Set() },
    );
    expect(out.map((section) => section.label)).toEqual(["Actions", "Extensions"]);
    expect(out[1]?.items[0]?.id).toContain("adapter");
  });

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

describe("navigation shortcut matching", () => {
  const key = (k: string, options: Record<string, unknown> = {}) => ({
    key: k,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...options,
  });
  it("recognizes g sequences and expires or discards invalid continuations", () => {
    expect(matchNavigationKey(key("g"), { pendingG: null, now: 1 })).toEqual({
      action: null,
      pendingG: 1,
      handled: true,
    });
    for (const [letter, action] of [
      ["c", "goCode"],
      ["b", "goBoard"],
      ["a", "goAttention"],
      ["t", "goTasks"],
      ["q", "goQueue"],
      ["o", "goAutomations"],
      ["s", "goSettings"],
      ["g", "first"],
    ]) {
      expect(matchNavigationKey(key(letter), { pendingG: 1, now: 799 }).action).toBe(action);
    }
    expect(matchNavigationKey(key("c"), { pendingG: 1, now: 801 }).handled).toBe(false);
    expect(matchNavigationKey(key("x"), { pendingG: 1, now: 2 }).handled).toBe(false);
    expect(matchNavigationKey(key("g", { repeat: true }), { pendingG: 1, now: 2 }).handled).toBe(
      false,
    );
  });
  it("leaves modifiers, composition and disabled widget aliases alone", () => {
    expect(
      matchNavigationKey(key("?", { shiftKey: true }), { pendingG: null, now: 1 }).action,
    ).toBe("help");
    expect(
      matchNavigationKey(key("G", { shiftKey: true }), { pendingG: null, now: 1 }).action,
    ).toBe("last");
    expect(
      matchNavigationKey(key("j", { ctrlKey: true }), { pendingG: null, now: 1 }).handled,
    ).toBe(false);
    expect(
      matchNavigationKey(key("g", { isComposing: true }), { pendingG: null, now: 1 }).handled,
    ).toBe(false);
    expect(
      matchNavigationKey(key("g", { defaultPrevented: true }), { pendingG: null, now: 1 }).handled,
    ).toBe(false);
    expect(matchNavigationKey(key("d", { ctrlKey: true }), { pendingG: null, now: 1 }).action).toBe(
      "halfDown",
    );
    expect(verticalNavigationDelta("j", false)).toBe(0);
    expect(horizontalNavigationDelta("h", false)).toBe(0);
    expect(verticalNavigationDelta("ArrowDown", false)).toBe(1);
    expect(horizontalNavigationDelta("ArrowLeft", false)).toBe(-1);
    expect(paletteNavigationDelta(key("k", { ctrlKey: true }))).toBe(-1);
    expect(paletteNavigationDelta(key("n", { ctrlKey: true }))).toBe(1);
    expect(NAVIGATION_SHORTCUTS.some((entry) => entry.keys === "?")).toBe(true);
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
