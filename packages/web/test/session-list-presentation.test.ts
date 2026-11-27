import { describe, expect, it } from "vitest";
import type { NavRow } from "../src/features/code/model";
import {
  branchActivity,
  branchChildren,
  recentSections,
  shortActivity,
} from "../src/features/code/sessionListPresentation";

function row(at: string, others: NavRow[] = [], attention = false): NavRow {
  return {
    session: { lastActivityAt: at } as NavRow["session"],
    others,
    attention,
    othersNeedInput: others.some((child) => child.attention),
  } as NavRow;
}

describe("branch children", () => {
  const children = Array.from({ length: 36 }, (_, index) => ({
    ...row("2026-11-27"),
    session: { id: `child-${index}`, lastActivityAt: "2026-11-27" } as NavRow["session"],
    attention: index === 10,
  }));
  const branch = row("2026-11-27", children);

  it("shows only required children when collapsed and preserves order through expansion", () => {
    expect(branchChildren(branch, "child-20", false)).toEqual({
      visible: [children[10], children[20]],
      optionalCount: 34,
    });
    expect(branchChildren(branch, "child-20", true)).toEqual({
      visible: children,
      optionalCount: 34,
    });
    expect(branchChildren(branch, "child-20", false).visible).toEqual([children[10], children[20]]);
  });

  it("counts a selected child needing input only once", () => {
    expect(branchChildren(branch, "child-10", false)).toEqual({
      visible: [children[10]],
      optionalCount: 35,
    });
  });

  it("handles branches with no optional children", () => {
    const required = row("2026-11-27", [children[10]!, children[20]!]);
    expect(branchChildren(required, "child-20", false)).toEqual({
      visible: required.others,
      optionalCount: 0,
    });
    expect(branchChildren(required, "child-20", true).optionalCount).toBe(0);
    expect(branchChildren(row("2026-11-27"), null, false)).toEqual({
      visible: [],
      optionalCount: 0,
    });
  });
});

const now = new Date(2026, 10, 27, 12);
const midnight = new Date(2026, 10, 27).toISOString();
const yesterday = new Date(2026, 10, 27, 0, 0, 0, -1).toISOString();

describe("session list activity", () => {
  it("uses the latest valid activity across the branch's visible sessions", () => {
    expect(branchActivity(row(yesterday, [row(midnight), row("bad")]))).toBe(midnight);
    expect(branchActivity(row("bad", [row("invalid")]))).toBe("bad");
    expect(branchActivity(row("bad", [row(midnight)]))).toBe(midnight);
  });

  it("groups by local day, prioritizes flagged children and preserves within-section order", () => {
    const earlier = row("bad");
    const late = row(new Date(2026, 10, 28).toISOString());
    const priorDay = row(yesterday);
    const branch = row(yesterday, [row(midnight, [], true)]);
    const atMidnight = row(midnight);
    const rows = [earlier, late, priorDay, branch, atMidnight];
    expect(recentSections(rows, true, now)).toEqual([
      { label: "Needs input", rows: [branch] },
      { label: "Today", rows: [late, atMidnight] },
      { label: "Yesterday", rows: [priorDay] },
      { label: "Earlier", rows: [earlier] },
    ]);
    expect(recentSections(rows, false, now)[0]).toEqual({
      label: "Today",
      rows: [late, branch, atMidnight],
    });
    expect(recentSections([], true, now)).toEqual([]);
  });

  it("keeps recent activity compact and formats older and invalid dates", () => {
    const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
    expect(shortActivity(ago(-1), now)).toBe("now");
    expect(shortActivity(ago(0.99), now)).toBe("now");
    expect(shortActivity(ago(1), now)).toBe("1m");
    expect(shortActivity(ago(59), now)).toBe("59m");
    expect(shortActivity(ago(60), now)).toBe("1h");
    expect(shortActivity(ago(1440), now)).toBe("1d");
    expect(shortActivity(ago(8 * 1440 - 1), now)).toBe("7d");
    expect(shortActivity(ago(8 * 1440), now)).toBe(
      new Date(ago(8 * 1440)).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    );
    expect(shortActivity(new Date(2025, 10, 27).toISOString(), now)).toContain("2025");
    expect(shortActivity("bad", now)).toBe("—");
  });
});
