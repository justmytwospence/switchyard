import { describe, expect, it, vi } from "vitest";
import { branchSession, treeRows } from "../src/pi-session-manager.js";

const msg = (id: string, parentId: string | null, role: string, text: string) => ({
  id,
  parentId,
  type: "message",
  timestamp: "2026-01-01T00:00:00Z",
  message: { role, content: [{ type: "text", text }] },
});
const node = (entry: any, children: any[] = [], label?: string) => ({ entry, children, label });

function fakeSm() {
  const root = msg("u1", null, "user", "hello");
  const a = msg("a1", "u1", "assistant", "hi");
  const hidden = { id: "c1", parentId: "a1", type: "custom", timestamp: "t" };
  const ub = msg("u2", "c1", "user", "x".repeat(300));
  const uc = msg("u3", "a1", "user", "other");
  const tree = [node(root, [node(a, [node(hidden, [node(ub)]), node(uc, [], "tag")])])];
  const entries: Record<string, any> = { u1: root, a1: a, c1: hidden, u2: ub, u3: uc };
  return {
    getTree: () => tree,
    getBranch: () => [root, a, hidden, ub],
    getLeafId: () => "u2",
    getEntry: (id: string) => entries[id],
    createBranchedSession: vi.fn((id: string) => `/tmp/branch-${id}.jsonl`),
  };
}

describe("treeRows", () => {
  it("lists messages with depth, branch and leaf flags", () => {
    const rows = treeRows(fakeSm());
    expect(rows.map((r) => [r.entryId, r.depth, r.parentId])).toEqual([
      ["u1", 0, null],
      ["a1", 1, "u1"],
      ["u2", 2, "a1"],
      ["u3", 2, "a1"],
    ]);
    expect(rows.filter((r) => r.activeBranch).map((r) => r.entryId)).toEqual(["u1", "a1", "u2"]);
    expect(rows.find((r) => r.leaf)?.entryId).toBe("u2");
    expect(rows.find((r) => r.entryId === "u2")!.text).toHaveLength(160);
    expect(rows.find((r) => r.entryId === "u3")!.label).toBe("tag");
  });
});

describe("branchSession", () => {
  const load = (sm: any) => async () => ({ open: () => sm });
  it("forks from the parent of a user message and returns its text", async () => {
    const sm = fakeSm();
    const r = await branchSession("/s/x.jsonl", "u3", true, undefined, load(sm));
    expect(sm.createBranchedSession).toHaveBeenCalledWith("a1");
    expect(r).toEqual({ sessionFile: "/tmp/branch-a1.jsonl", prefill: "other" });
  });
  it("forking the first message writes no file", async () => {
    const sm = fakeSm();
    expect(await branchSession("/s/x.jsonl", "u1", true, undefined, load(sm))).toEqual({
      sessionFile: null,
      prefill: "hello",
    });
    expect(sm.createBranchedSession).not.toHaveBeenCalled();
  });
  it("rejects a non-user entry when forking", async () => {
    await expect(
      branchSession("/s/x.jsonl", "a1", true, undefined, load(fakeSm())),
    ).rejects.toThrow("Pick one of your messages");
  });
  it("clones the leaf when no entry is given", async () => {
    const sm = fakeSm();
    await branchSession("/s/x.jsonl", null, false, undefined, load(sm));
    expect(sm.createBranchedSession).toHaveBeenCalledWith("u2");
  });
});
