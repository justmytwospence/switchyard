import { describe, expect, it } from "vitest";
import { reconnectDelay } from "../src/index.js";

describe("reconnectDelay", () => {
  it("steps through the backoff with jitter and repeats the last step", () => {
    const mid = () => 0.5;
    expect(reconnectDelay(0, undefined, mid)).toBe(1000);
    expect(reconnectDelay(1, undefined, mid)).toBe(2000);
    expect(reconnectDelay(99, undefined, mid)).toBe(30000);
    expect(reconnectDelay(0, undefined, () => 0)).toBe(800);
    expect(reconnectDelay(0, undefined, () => 1)).toBe(1200);
    expect(reconnectDelay(5, [50], mid)).toBe(50);
  });
});
