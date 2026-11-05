import { describe, expect, it } from "vitest";
import { lostRuntime } from "../src/index.js";

describe("host agent restart", () => {
  it("lostRuntime stops idle sessions and interrupts working ones", () => {
    expect(lostRuntime({ runtime: "idle", compacting: false })).toBe("stopped");
    expect(lostRuntime({ runtime: "idle", compacting: true })).toBe("interrupted");
    expect(lostRuntime({ runtime: "running", compacting: false })).toBe("interrupted");
    expect(lostRuntime({ runtime: "waiting_input", compacting: false })).toBe("interrupted");
    expect(lostRuntime({ runtime: "starting", compacting: false })).toBe("interrupted");
  });
});
