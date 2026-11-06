import { describe, expect, it } from "vitest";
import { modelInfo, supportedThinkingLevels } from "../src/bridge/pi-model.js";

describe("pi-model", () => {
  it("no reasoning gives off only", () => {
    expect(supportedThinkingLevels({ reasoning: false })).toEqual(["off"]);
  });
  it("reasoning gives off..high", () => {
    expect(supportedThinkingLevels({ reasoning: true })).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
  });
  it("thinkingLevelMap adds xhigh/max and null removes a level", () => {
    expect(
      supportedThinkingLevels({
        reasoning: true,
        thinkingLevelMap: { xhigh: "x", max: "m", minimal: null },
      }),
    ).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
  });
  it("already-mapped thinkingLevels pass through filtered", () => {
    expect(supportedThinkingLevels({ thinkingLevels: ["off", "high", "bogus"] })).toEqual([
      "off",
      "high",
    ]);
  });
  it("modelInfo needs provider and id and trims the rest", () => {
    expect(modelInfo({ id: "a" })).toBeNull();
    expect(modelInfo({ provider: "p", id: "a", name: "", contextWindow: "x" })).toEqual({
      provider: "p",
      id: "a",
      name: null,
      contextWindow: null,
      reasoning: false,
      thinkingLevels: ["off"],
      promptCache: null,
    });
  });
  it("reads prompt cache lifetimes", () => {
    expect(
      modelInfo({ provider: "p", id: "a", promptCache: { short: 300, long: 3600 } })?.promptCache,
    ).toEqual({ short: 300, long: 3600 });
  });
});
