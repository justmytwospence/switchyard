import { describe, expect, it } from "vitest";
import { langFor, shouldHighlight } from "../src/lib/highlight";

describe("highlight", () => {
  it("maps names and aliases to languages", () => {
    expect(langFor("src/a.ts")).toBe("typescript");
    expect(langFor("Dockerfile")).toBe("dockerfile");
    expect(langFor("x.unknown")).toBeNull();
    expect(langFor("sh")).toBe("shellscript");
    expect(langFor("yml")).toBe("yaml");
    expect(langFor(undefined)).toBeNull();
  });
  it("skips unsupported and oversized text", () => {
    expect(shouldHighlight("a", null)).toBe(false);
    expect(shouldHighlight("a\n".repeat(5000), "typescript")).toBe(false);
    expect(shouldHighlight("a\n".repeat(100), "typescript")).toBe(true);
  });
});
