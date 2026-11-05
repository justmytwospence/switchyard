import { PRIORITY_LABELS } from "@switchyard/protocol";
import { describe, expect, it } from "vitest";
import { PRIORITY_INFO } from "../src/components/ui/Priority";

describe("PRIORITY_INFO", () => {
  it("has an icon, tone and the protocol label for each priority", () => {
    expect(Object.keys(PRIORITY_INFO)).toEqual(["0", "1", "2", "3"]);
    for (const p of [0, 1, 2, 3] as const) {
      expect(PRIORITY_INFO[p].label).toBe(PRIORITY_LABELS[p]);
      expect(PRIORITY_INFO[p].icon).toBeTruthy();
    }
  });

  it("marks Urgent as danger and High as warning", () => {
    expect(PRIORITY_INFO[0].tone).toBe("danger");
    expect(PRIORITY_INFO[1].tone).toBe("warning");
  });
});
