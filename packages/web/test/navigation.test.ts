import { describe, expect, it } from "vitest";
import { fromEntries, moveEntry, toEntries } from "../src/app/NavigationEditor";
import { DEFAULT_NAV_ORDER, MAX_NAV_BAR, navLayout, normalizeNav } from "../src/app/navigation";

describe("navigation layout", () => {
  it("makes a stored order whole", () => {
    expect(normalizeNav(undefined, undefined)).toEqual({ order: DEFAULT_NAV_ORDER, bar: 3 });
    const n = normalizeNav(["queue", "nope", "queue", "code"], 9);
    expect(n.order.slice(0, 2)).toEqual(["queue", "code"]);
    expect(n.order).toHaveLength(DEFAULT_NAV_ORDER.length);
    expect(n.bar).toBe(MAX_NAV_BAR);
    expect(normalizeNav([], 0).bar).toBe(1);
  });

  it("splits the bar from More", () => {
    const l = navLayout(["tasks", "code"], 2);
    expect(l.bar.map((d) => d.id)).toEqual(["tasks", "code"]);
    expect(l.more.map((d) => d.id)).not.toContain("tasks");
    expect(l.all).toHaveLength(DEFAULT_NAV_ORDER.length);
  });

  it("moves a page into the bar and back", () => {
    const e = toEntries(DEFAULT_NAV_ORDER, 3);
    // Queue (index 5) up into the bar, after Attention.
    const up = fromEntries(moveEntry(e, 5, 3));
    expect(up.bar).toBe(4);
    expect(up.order.slice(0, 4)).toEqual(["code", "board", "attention", "queue"]);
    // Sessions down under More.
    const down = fromEntries(moveEntry(e, 0, 3));
    expect(down.bar).toBe(2);
    expect(down.order.indexOf("code")).toBe(2);
  });

  it("keeps the bar between one and the maximum", () => {
    const full = toEntries(DEFAULT_NAV_ORDER, MAX_NAV_BAR);
    // Into a full bar: the bar's last page goes under More.
    const pushed = fromEntries(moveEntry(full, 5, 0));
    expect(pushed.bar).toBe(MAX_NAV_BAR);
    expect(pushed.order[0]).toBe("queue");
    // The only page in the bar cannot leave it empty.
    const one = toEntries(DEFAULT_NAV_ORDER, 1);
    expect(fromEntries(moveEntry(one, 0, 3)).bar).toBe(1);
  });
});
