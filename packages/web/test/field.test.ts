import { describe, expect, it } from "vitest";
import { fieldControlProps } from "../src/components/ui/Field";

describe("fieldControlProps", () => {
  it("adds nothing for a plain field", () => {
    expect(fieldControlProps("a", {})).toEqual({
      "aria-describedby": undefined,
      "aria-invalid": undefined,
    });
  });

  it("links the hint and the error by id", () => {
    expect(fieldControlProps("a", { hint: true, error: "Bad" })).toEqual({
      "aria-describedby": "a-hint a-error",
      "aria-invalid": true,
    });
  });

  it("marks only an error as invalid", () => {
    expect(fieldControlProps("a", { hint: true })).toEqual({
      "aria-describedby": "a-hint",
      "aria-invalid": undefined,
    });
    expect(fieldControlProps("a", { error: "Bad" })["aria-describedby"]).toBe("a-error");
  });
});
