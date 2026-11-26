import { describe, expect, it } from "vitest";
import { migratePrefs } from "../src/prefs";

describe("migratePrefs", () => {
  it("turns the fold switch into a level of tool activity", () => {
    expect(migratePrefs({ collapseWork: false, railExpanded: true }, 1)).toEqual({
      transcriptDetail: "detailed",
      railExpanded: true,
    });
    expect(migratePrefs({ collapseWork: true }, 1)).toEqual({ transcriptDetail: "normal" });
    expect(migratePrefs({ railExpanded: false }, 0)).toEqual({
      transcriptDetail: "normal",
      railExpanded: false,
    });
  });
  it("leaves current preferences alone", () => {
    const current = { transcriptDetail: "summary", collapseWork: false };
    expect(migratePrefs(current, 2)).toBe(current);
    expect(migratePrefs(null, 1)).toBeNull();
  });
});
