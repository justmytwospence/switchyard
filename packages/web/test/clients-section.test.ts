import { describe, expect, it } from "vitest";
import { bindingFromValue, bindingValue } from "../src/features/settings/ClientsSection";

describe("Clients settings", () => {
  it("round-trips a binding through the select value", () => {
    expect(bindingValue({ mirror: "none", scopeId: null })).toBe("none");
    expect(bindingValue({ mirror: "all", scopeId: null })).toBe("all");
    expect(bindingValue({ mirror: "scope", scopeId: "viw_1" })).toBe("scope:viw_1");
    expect(bindingFromValue("scope:viw_1")).toEqual({ mirror: "scope", scopeId: "viw_1" });
    expect(bindingFromValue("all")).toEqual({ mirror: "all" });
    expect(bindingFromValue("none")).toEqual({ mirror: "none" });
  });
});
