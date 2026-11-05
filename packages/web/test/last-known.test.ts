import { describe, expect, it } from "vitest";
import { lastKnownText } from "../src/components/ui/states";

describe("lastKnownText", () => {
  it("names what is shown, without a time when none is known", () => {
    expect(lastKnownText("queue", null)).toBe("Showing last known queue.");
  });

  it("adds the time of the last sync", () => {
    const text = lastKnownText("automations", "2026-05-01T10:42:00.000Z");
    expect(text).toMatch(/^Showing last known automations from .+\.$/);
  });

  it("never uses the words the connection banner is found by", () => {
    expect(lastKnownText("data", "2026-05-01T10:42:00.000Z")).not.toMatch(/Offline|Reconnecting/);
  });
});
