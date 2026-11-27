import { describe, expect, it } from "vitest";
import { shortActivity } from "../src/features/code/sessionListPresentation";

const now = new Date(2026, 10, 27, 12);

describe("session activity", () => {
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
