import { describe, expect, it } from "vitest";
import {
  describeTool,
  editDiffFiles,
  relativePath,
  toolLabel,
} from "../src/features/code/toolView";

const cwd = "/Users/me/repo";

describe("relativePath", () => {
  it("shortens paths inside the session's directory", () => {
    expect(relativePath("/Users/me/repo/src/a.ts", cwd)).toEqual({
      label: "src/a.ts",
      inside: true,
    });
    expect(relativePath("/Users/me/repo/src/a.ts", `${cwd}/`)).toEqual({
      label: "src/a.ts",
      inside: true,
    });
    expect(relativePath(cwd, cwd)).toEqual({ label: ".", inside: true });
  });
  it("treats relative paths as inside unless they climb out", () => {
    expect(relativePath("src/a.ts", cwd)).toEqual({ label: "src/a.ts", inside: true });
    expect(relativePath("./src/a.ts", cwd)).toEqual({ label: "src/a.ts", inside: true });
    expect(relativePath("../other/a.ts", cwd)).toEqual({ label: "../other/a.ts", inside: false });
    expect(relativePath("src/a.ts", null)).toEqual({ label: "src/a.ts", inside: true });
  });
  it("keeps paths outside as written", () => {
    expect(relativePath("/etc/hosts", cwd)).toEqual({ label: "/etc/hosts", inside: false });
    expect(relativePath("/Users/me/repo-two/a.ts", cwd)).toEqual({
      label: "/Users/me/repo-two/a.ts",
      inside: false,
    });
    expect(relativePath("~/notes.md", cwd)).toEqual({ label: "~/notes.md", inside: false });
    expect(relativePath("C:\\work\\a.ts", cwd)).toEqual({ label: "C:\\work\\a.ts", inside: false });
    expect(relativePath("/Users/me/repo/a.ts", null)).toEqual({
      label: "/Users/me/repo/a.ts",
      inside: false,
    });
  });
});

describe("editDiffFiles", () => {
  it("returns nothing without edits", () => {
    expect(editDiffFiles("a.ts", [])).toEqual([]);
  });
  it("keeps at most two lines of context on each side", () => {
    const [file] = editDiffFiles("a.ts", [
      { oldText: "1\n2\n3\nold\n5\n6\n7", newText: "1\n2\n3\nnew\nextra\n5\n6\n7" },
    ]);
    expect(file).toMatchObject({ path: "a.ts", status: "modified", additions: 2, deletions: 1 });
    expect(file?.lines.map((l) => `${l.kind}:${l.text}`)).toEqual([
      "context:2",
      "context:3",
      "del:old",
      "add:new",
      "add:extra",
      "context:5",
      "context:6",
    ]);
    expect(file?.lines.every((l) => l.oldLine === null && l.newLine === null)).toBe(true);
  });
  it("numbers the hunks only for several edits", () => {
    const one = editDiffFiles("a.ts", [{ oldText: "a", newText: "b" }]);
    expect(one[0]?.lines.some((l) => l.kind === "hunk")).toBe(false);
    const [two] = editDiffFiles("a.ts", [
      { oldText: "a", newText: "b" },
      { oldText: "c\n", newText: "" },
    ]);
    expect(two?.lines.map((l) => `${l.kind}:${l.text}`)).toEqual([
      "hunk:Edit 1 of 2",
      "del:a",
      "add:b",
      "hunk:Edit 2 of 2",
      "del:c",
    ]);
    expect(two).toMatchObject({ additions: 1, deletions: 2 });
  });
  it("does not let the common prefix and suffix overlap", () => {
    const [file] = editDiffFiles("a.ts", [{ oldText: "x\nx", newText: "x\nx\nx" }]);
    expect(file).toMatchObject({ additions: 1, deletions: 0 });
  });
});

describe("describeTool", () => {
  it("read: path and line range", () => {
    const v = describeTool(
      { name: "read", args: { path: `${cwd}/src/a.ts`, offset: 10, limit: 20 } },
      cwd,
    );
    expect(v).toMatchObject({
      kind: "read",
      verb: "Read",
      activeVerb: "Reading",
      target: "src/a.ts",
      path: `${cwd}/src/a.ts`,
      filePath: "src/a.ts",
      meta: ["lines 10–29"],
      detail: { t: "read", range: "lines 10–29" },
    });
    expect(describeTool({ name: "read", args: { path: "a", offset: 5 } }, cwd).meta).toEqual([
      "from line 5",
    ]);
    expect(describeTool({ name: "read", args: { path: "a", limit: 5 } }, cwd).meta).toEqual([
      "first 5 lines",
    ]);
    const outside = describeTool({ name: "read", args: { path: "/etc/hosts" } }, cwd);
    expect(outside).toMatchObject({ target: "/etc/hosts", filePath: null, meta: [] });
  });
  it("bash: the first line, with a count of the rest", () => {
    const v = describeTool(
      { name: "bash", args: { command: "\ncd  packages/web &&\n  pnpm   test\n\necho done\n" } },
      cwd,
    );
    expect(v).toMatchObject({
      kind: "command",
      verb: "Ran",
      target: "cd packages/web &&",
      meta: ["+2 lines"],
      filePath: null,
    });
    expect(v.detail).toEqual({
      t: "command",
      command: "\ncd  packages/web &&\n  pnpm   test\n\necho done\n",
    });
    expect(describeTool({ name: "powershell", args: { command: "ls" } }, cwd)).toMatchObject({
      kind: "command",
      target: "ls",
      meta: [],
    });
  });
  it("edit: a list of edits or the single pair", () => {
    const many = describeTool(
      {
        name: "edit",
        args: {
          path: "src/a.ts",
          edits: [
            { oldText: "a", newText: "b\nc" },
            { oldText: "d", newText: "" },
            { nonsense: true },
          ],
        },
      },
      cwd,
    );
    expect(many).toMatchObject({
      kind: "edit",
      verb: "Edited",
      target: "src/a.ts",
      filePath: "src/a.ts",
      meta: ["2 edits"],
      stat: { added: 2, removed: 2 },
    });
    expect(many.detail.t === "edit" && many.detail.files[0]?.path).toBe("src/a.ts");
    const single = describeTool(
      { name: "edit", args: { path: "src/a.ts", oldText: "a", newText: "b" } },
      cwd,
    );
    expect(single).toMatchObject({ meta: [], stat: { added: 1, removed: 1 } });
    const none = describeTool({ name: "edit", args: { path: "src/a.ts" } }, cwd);
    expect(none).toMatchObject({ stat: null, detail: { t: "edit", files: [] } });
  });
  it("write: counts lines with and without a trailing newline", () => {
    const v = describeTool({ name: "write", args: { path: "a.txt", content: "one\ntwo\n" } }, cwd);
    expect(v).toMatchObject({
      kind: "write",
      verb: "Wrote",
      target: "a.txt",
      stat: { added: 2, removed: 0 },
      detail: { t: "write", content: "one\ntwo\n" },
    });
    expect(
      describeTool({ name: "write", args: { path: "a.txt", content: "one\ntwo" } }, cwd).stat,
    ).toEqual({ added: 2, removed: 0 });
    expect(describeTool({ name: "write", args: { path: "a.txt", content: "" } }, cwd).stat).toBe(
      null,
    );
  });
  it("grep, find and ls are searches", () => {
    expect(
      describeTool(
        { name: "grep", args: { pattern: "foo\\(", path: `${cwd}/src`, glob: "*.ts" } },
        cwd,
      ),
    ).toMatchObject({
      kind: "search",
      verb: "Searched",
      target: "foo\\(",
      meta: ["in src", "*.ts"],
      path: null,
      filePath: null,
      detail: { t: "search", query: "foo\\(", where: "src" },
    });
    expect(describeTool({ name: "find", args: { pattern: "*.md" } }, cwd)).toMatchObject({
      verb: "Searched files",
      activeVerb: "Searching files",
      target: "*.md",
      meta: [],
    });
    expect(describeTool({ name: "ls", args: {} }, cwd)).toMatchObject({
      verb: "Listed",
      target: ".",
      detail: { t: "search", query: ".", where: null },
    });
    expect(describeTool({ name: "ls", args: { path: cwd } }, cwd).target).toBe(".");
  });
  it("any other tool keeps its name and shows its arguments", () => {
    const scalar = describeTool(
      { name: "todo", args: { id: 3, action: "update", done: true } },
      cwd,
    );
    expect(scalar).toMatchObject({ kind: "other", verb: null, activeVerb: null, target: "update" });
    expect(scalar.detail).toEqual({
      t: "args",
      rows: [
        ["id", "3"],
        ["action", "update"],
        ["done", "true"],
      ],
      raw: null,
    });
    const nested = describeTool(
      { name: "subagent", args: { tasks: [{ task: "x" }], label: "  two\n words " } },
      cwd,
    );
    expect(nested.target).toBe("two words");
    expect(nested.detail).toMatchObject({
      t: "args",
      rows: [
        ["tasks", '[{"task":"x"}]'],
        ["label", "  two\n words "],
      ],
    });
    expect(nested.detail.t === "args" && nested.detail.raw).toContain('"tasks": [');
    const long = describeTool({ name: "x", args: { text: "a".repeat(400) } }, cwd);
    expect(long.target).toHaveLength(121);
    expect(long.detail.t === "args" && long.detail.rows[0]?.[1]).toHaveLength(301);
    expect(long.detail.t === "args" && long.detail.raw).not.toBeNull();
  });
  it("reads arguments defensively", () => {
    for (const args of [undefined, null, 3, {}]) {
      expect(describeTool({ name: "x", args }, cwd)).toMatchObject({
        target: "",
        detail: { t: "args", rows: [], raw: null },
      });
    }
    expect(describeTool({ name: "x", args: "partial" }, cwd).detail).toEqual({
      t: "args",
      rows: [],
      raw: "partial",
    });
    expect(describeTool({ name: "read", args: null }, cwd)).toMatchObject({
      kind: "read",
      target: "",
      path: null,
      filePath: null,
    });
    expect(describeTool({ name: "bash", args: { command: 3 } }, cwd).target).toBe("");
  });
});

describe("toolLabel", () => {
  it("uses the verb for built-in tools and the name for the rest", () => {
    const read = describeTool({ name: "read", args: { path: "a" } }, cwd);
    expect(toolLabel(read, "read", "running")).toEqual({ text: "Reading", mono: false });
    expect(toolLabel(read, "read", "ok")).toEqual({ text: "Read", mono: false });
    expect(toolLabel(read, "read", "error")).toEqual({ text: "Read", mono: false });
    const other = describeTool({ name: "todo", args: {} }, cwd);
    expect(toolLabel(other, "todo", "running")).toEqual({ text: "todo", mono: true });
    expect(toolLabel(other, "todo", "ok")).toEqual({ text: "todo", mono: true });
  });
});
