import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../src/components/intent/diff";

const PATCH = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 one
-two
+TWO
+three
 four
diff --git a/new.txt b/new.txt
new file mode 100644
--- /dev/null
+++ b/new.txt
@@ -0,0 +1 @@
+hello
`;

describe("parseUnifiedDiff", () => {
  it("parses files, counts and line numbers", () => {
    const files = parseUnifiedDiff(PATCH);
    expect(files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ["src/a.ts", "modified", 2, 1],
      ["new.txt", "added", 1, 0],
    ]);
    const body = files[0]!.lines.filter((l) => l.kind !== "meta" && l.kind !== "hunk");
    expect(body.map((l) => [l.kind, l.oldLine, l.newLine])).toEqual([
      ["context", 1, 1],
      ["del", 2, null],
      ["add", null, 2],
      ["add", null, 3],
      ["context", 3, 4],
    ]);
  });

  it("splits plain multi-file patches without git headers", () => {
    const files = parseUnifiedDiff(
      "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n--- a/y\n+++ b/y\n@@ -1 +1 @@\n-c\n+d\n",
    );
    expect(files.map((f) => f.path)).toEqual(["x", "y"]);
  });
});
