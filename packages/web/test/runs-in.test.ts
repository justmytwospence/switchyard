import { describe, expect, it } from "vitest";
import { runsIn } from "../src/features/scopes/where";

describe("runsIn", () => {
  const place = { terminalId: "herdr:default@mac-pro", pane: "w1:p2" };
  it("names where a stopped Pi last ran by hand, until Switchyard starts it", () => {
    expect(runsIn({ hostId: "h1", external: null, runtime: "stopped", place }, "Mac")).toBe(
      "Last run by hand in herdr default on Mac",
    );
    expect(runsIn({ hostId: "h1", external: null, runtime: "idle", place }, "Mac")).toBeNull();
    expect(runsIn({ hostId: "h1", external: null, runtime: "stopped" }, "Mac")).toBeNull();
    expect(
      runsIn(
        { hostId: "h1", external: { client: place.terminalId }, runtime: "idle", place },
        "Mac",
      ),
    ).toBe("herdr default on Mac (your terminal)");
  });
});
