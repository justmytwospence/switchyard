import { describe, expect, it } from "vitest";
import { bindingFromValue, bindingValue } from "../src/features/settings/TerminalsSection";

describe("Terminals settings", () => {
  it("round-trips a binding through the select value", () => {
    expect(bindingValue({ mirror: "none", viewId: null })).toBe("none");
    expect(bindingValue({ mirror: "all", viewId: null })).toBe("all");
    expect(bindingValue({ mirror: "view", viewId: "viw_1" })).toBe("view:viw_1");
    expect(bindingValue({ viewId: "viw_1" })).toBe("view:viw_1");
    expect(bindingFromValue("view:viw_1")).toEqual({ mirror: "view", viewId: "viw_1" });
    expect(bindingFromValue("all")).toEqual({ mirror: "all" });
    expect(bindingFromValue("none")).toEqual({ mirror: "none" });
  });
});
