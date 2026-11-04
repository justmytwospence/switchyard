import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgumentHint, readArgumentHint } from "../src/command-hints.js";

describe("parseArgumentHint", () => {
  it("reads plain and quoted values", () => {
    expect(parseArgumentHint("---\nargument-hint: <file> [focus]\n---\nbody")).toBe(
      "<file> [focus]",
    );
    expect(parseArgumentHint('---\nargument-hint: "<a>"\n---\n')).toBe("<a>");
    expect(parseArgumentHint("---\nargument-hint: '<b>'\n---\n")).toBe("<b>");
    expect(parseArgumentHint("---\r\nargument-hint: <c>\r\n---\r\n")).toBe("<c>");
  });
  it("returns null when absent", () => {
    expect(parseArgumentHint("no frontmatter")).toBeNull();
    expect(parseArgumentHint("---\nargument-hint: <x>\nbody")).toBeNull();
    expect(parseArgumentHint("---\ndescription: d\n---\n")).toBeNull();
    expect(parseArgumentHint("---\nargument-hint:   \n---\n")).toBeNull();
    expect(parseArgumentHint("---\ndescription: d\n---\nargument-hint: <x>\n")).toBeNull();
  });
  it("reads from files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sy-hint-"));
    const md = join(dir, "t.md");
    writeFileSync(md, "---\nargument-hint: <f>\n---\n");
    writeFileSync(join(dir, "t.txt"), "---\nargument-hint: <f>\n---\n");
    expect(await readArgumentHint(md)).toBe("<f>");
    expect(await readArgumentHint(join(dir, "t.txt"))).toBeNull();
    expect(await readArgumentHint(join(dir, "missing.md"))).toBeNull();
  });
});
