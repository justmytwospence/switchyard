import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TickThrottle, tickShape } from "../src/tick-throttle.js";

describe("TickThrottle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("treats values that differ only in digits as the same shape", () => {
    expect(tickShape({ rows: [["cache", "cache 57:50"]] })).toBe(
      tickShape({ rows: [["cache", "cache 9:01"]] }),
    );
    expect(tickShape({ rows: [["mode", "plan"]] })).not.toBe(
      tickShape({ rows: [["mode", "work"]] }),
    );
  });

  it("sends a ticking value once per window, ending on the latest", () => {
    const sent: string[] = [];
    const t = new TickThrottle<string>((_k, v) => sent.push(v), 30_000);
    t.offer("status", "cache 60:00");
    for (let s = 59; s >= 40; s--) {
      vi.advanceTimersByTime(1000);
      t.offer("status", `cache 59:${s}`);
    }
    expect(sent).toEqual(["cache 60:00"]);
    vi.advanceTimersByTime(10_000);
    expect(sent).toEqual(["cache 60:00", "cache 59:40"]);
    vi.advanceTimersByTime(60_000);
    expect(sent).toHaveLength(2);
  });

  it("sends a change of shape at once and keeps keys apart", () => {
    const sent: [string, string][] = [];
    const t = new TickThrottle<string>((k, v) => sent.push([k, v]), 30_000);
    t.offer("status", "plan 1");
    t.offer("status", "plan 2");
    t.offer("status", "work 2");
    t.offer("widget", "plan 3");
    expect(sent).toEqual([
      ["status", "plan 1"],
      ["status", "work 2"],
      ["widget", "plan 3"],
    ]);
    vi.advanceTimersByTime(30_000);
    expect(sent).toHaveLength(3);
  });

  it("drops held values on clear", () => {
    const sent: string[] = [];
    const t = new TickThrottle<string>((_k, v) => sent.push(v), 30_000);
    t.offer("status", "a 1");
    t.offer("status", "a 2");
    t.clear();
    vi.advanceTimersByTime(60_000);
    expect(sent).toEqual(["a 1"]);
  });
});
