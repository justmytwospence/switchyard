import type { Host, Project } from "@switchyard/protocol";
import { describe, expect, it } from "vitest";
import {
  activeFilterChips,
  buildColumns,
  buildColumnTree,
  childProgress,
  columnTreeRows,
  DEFAULT_FILTERS,
  eligibilityText,
  moveHint,
  normalizeFilters,
  parentCandidates,
  planMove,
  positionFor,
  previewEligibility,
  taskAncestors,
  unresolvedForDone,
} from "../src/features/board/logic";
import { task } from "./fixtures";

const T0 = "2026-11-01T10:00:00Z";

function host(id: string, patch: Partial<Host> = {}): Host {
  return {
    id,
    name: `Host ${id}`,
    platform: "darwin",
    agentVersion: "0.1.0",
    piVersion: "0.70.0",
    piCompatible: true,
    capabilities: null,
    connectivity: "connected",
    lastSeenAt: T0,
    revokedAt: null,
    createdAt: T0,
    ...patch,
  };
}

function project(patch: Partial<Project> = {}): Project {
  return {
    id: "prj_1",
    name: "Switchyard",
    repoIdentity: "github.com/x/y",
    defaultProfileId: null,
    defaultHostId: "hst_1",
    maxConcurrentRuns: 1,
    automationEnabled: true,
    setupCommand: null,
    checks: [],
    workspaceSharing: "single_writer",
    createdAt: T0,
    updatedAt: T0,
    ...patch,
  };
}

describe("planMove", () => {
  it("authorizes Backlog to Ready as a plain move", () => {
    expect(planMove(task("a"), "ready")).toEqual({ kind: "move" });
  });

  it("rejects invalid transitions with a concrete reason", () => {
    const plan = planMove(task("a"), "in_progress");
    expect(plan.kind).toBe("invalid");
    if (plan.kind === "invalid") expect(plan.reason).toMatch(/Ready first/);
    const r = planMove(task("a", { state: "backlog" }), "review");
    expect(r.kind).toBe("invalid");
  });

  it("asks for a choice when running work moves backward", () => {
    const t = task("a", { state: "in_progress" });
    expect(planMove(t, "backlog")).toEqual({ kind: "choose_running" });
    expect(planMove(t, "ready")).toEqual({ kind: "choose_running" });
  });

  it("maps Ready to In progress to Run now and Review to In progress to a new attempt", () => {
    expect(planMove(task("a", { state: "ready" }), "in_progress")).toEqual({ kind: "run_now" });
    expect(planMove(task("a", { state: "review" }), "in_progress")).toEqual({
      kind: "new_attempt",
    });
  });

  it("requires acceptance confirmation for Done when criteria are unresolved", () => {
    const t = task("a", { state: "review", acceptanceCriteria: ["tests pass"] });
    const plan = planMove(t, "done");
    expect(plan.kind).toBe("confirm_done");
    expect(unresolvedForDone(t, null).join(" ")).toMatch(/criterion/);
  });

  it("is a no-op for the same state", () => {
    expect(planMove(task("a"), "backlog")).toEqual({ kind: "noop" });
  });
});

describe("positionFor", () => {
  const col = [task("a", { position: 1 }), task("b", { position: 2 }), task("c", { position: 3 })];
  it("places before a card or at the end", () => {
    expect(positionFor(col, "b", "x")).toBe(1.5);
    expect(positionFor(col, "a", "x")).toBe(0);
    expect(positionFor(col, null, "x")).toBe(4);
    expect(positionFor([], null, "x")).toBe(1);
  });
});

describe("filters", () => {
  const tasks = {
    a: task("a", { title: "Fix login", priority: 0 }),
    b: task("b", { title: "Docs", state: "ready" }),
    c: task("c", { title: "Old", state: "canceled" }),
    d: task("d", { title: "Routine", state: "done", hiddenFromBoard: true }),
    e: task("e", { title: "Other project", projectId: "prj_2" }),
  };
  const ctx = { projectId: null, runs: {}, attentionTaskIds: new Set<string>() };

  it("hides routine and canceled tasks by default", () => {
    const cols = buildColumns(tasks, DEFAULT_FILTERS, ctx);
    expect(cols.done).toHaveLength(0);
    expect(cols.canceled).toHaveLength(0);
    expect(cols.backlog.map((t) => t.id)).toEqual(["a", "e"]);
  });

  it("shows canceled through the filter and narrows by project, search and priority", () => {
    expect(
      buildColumns(tasks, { ...DEFAULT_FILTERS, showCanceled: true }, ctx).canceled,
    ).toHaveLength(1);
    expect(
      buildColumns(tasks, DEFAULT_FILTERS, { ...ctx, projectId: "prj_2" }).backlog,
    ).toHaveLength(1);
    expect(buildColumns(tasks, { ...DEFAULT_FILTERS, search: "login" }, ctx).backlog).toHaveLength(
      1,
    );
    expect(
      buildColumns(tasks, { ...DEFAULT_FILTERS, priorities: [0] }, ctx).backlog.map((t) => t.id),
    ).toEqual(["a"]);
  });

  it("normalizes persisted filters and builds removable chips", () => {
    const f = normalizeFilters({ priorities: [1, 9], sort: "bogus", showCompleted: false });
    expect(f.priorities).toEqual([1]);
    expect(f.sort).toBe("priority");
    expect(f.showCompleted).toBe(false);
    const chips = activeFilterChips({ ...f, hostId: "hst_1" }, () => "mac");
    expect(chips.map((c) => c.label)).toEqual(["Priority: High", "Host: mac"]);
    expect(chips[1]!.clear(f).hostId).toBeNull();
  });
});

describe("task hierarchy", () => {
  const parent = task("parent", { position: 2 });
  const child = task("child", { parentTaskId: parent.id, position: 1 });
  const grandchild = task("grandchild", { parentTaskId: child.id, position: 3 });
  const sibling = task("sibling", { parentTaskId: parent.id, position: 4 });
  const other = task("other", { position: 5 });
  const all = { parent, child, grandchild, sibling, other };
  const ids = (tasks: ReturnType<typeof columnTreeRows>) => tasks.map((n) => n.task.id);

  it("nests visible same-column parents and preserves flat root/sibling order", () => {
    const column = [child, parent, grandchild, other, sibling];
    const tree = buildColumnTree(column, all);
    expect(tree.map((n) => n.task.id)).toEqual(["parent", "other"]);
    expect(tree[0]!.children.map((n) => n.task.id)).toEqual(["child", "sibling"]);
    const rows = columnTreeRows(tree);
    expect(ids(rows)).toEqual(["parent", "child", "grandchild", "sibling", "other"]);
    expect(rows.map((n) => n.depth)).toEqual([0, 1, 2, 1, 0]);
    expect(rows[2]!.ancestors.map((t) => t.id)).toEqual(["parent", "child"]);
    expect(column.map((t) => t.id)).toEqual(["child", "parent", "grandchild", "other", "sibling"]);
  });

  it("keeps children of filtered, hidden, missing and other-state parents visible", () => {
    const ctx = { projectId: "prj_1", runs: {}, attentionTaskIds: new Set<string>() };
    const tasks = {
      ...all,
      parent: { ...parent, hiddenFromBoard: true },
      other: { ...other, parentTaskId: "missing" },
    };
    const column = buildColumns(tasks, DEFAULT_FILTERS, ctx).backlog;
    const tree = buildColumnTree(column, tasks);
    expect(ids(columnTreeRows(tree))).toEqual(["child", "grandchild", "sibling", "other"]);
    expect(tree[0]!.ancestors.map((t) => t.id)).toEqual(["parent"]);
    const filtered = buildColumns(all, { ...DEFAULT_FILTERS, search: "grandchild" }, ctx);
    expect(ids(columnTreeRows(buildColumnTree(filtered.backlog, all)))).toEqual(["grandchild"]);
    const moved = { ...all, parent: { ...parent, state: "ready" as const } };
    const cols = buildColumns(moved, DEFAULT_FILTERS, ctx);
    expect(ids(buildColumnTree(cols.backlog, moved))).toEqual(["child", "sibling", "other"]);
    expect(cols.ready).toHaveLength(1);
    expect(buildColumnTree(cols.backlog, moved)[0]!.ancestors).toEqual([moved.parent]);
  });

  it("does not nest corrupt cross-project or cross-state relationships", () => {
    const crossProject = { ...child, projectId: "prj_2" };
    const crossState = { ...sibling, state: "ready" as const };
    expect(buildColumnTree([parent, crossProject, crossState], all)).toHaveLength(3);
    expect(taskAncestors(crossProject, all)).toEqual([]);
  });

  it.each([
    { a: task("a", { parentTaskId: "a" }) },
    { a: task("a", { parentTaskId: "b" }), b: task("b", { parentTaskId: "a" }) },
    {
      a: task("a", { parentTaskId: "b" }),
      b: task("b", { parentTaskId: "c" }),
      c: task("c", { parentTaskId: "a" }),
      d: task("d", { parentTaskId: "c" }),
    },
  ])("breaks corrupt cycles without losing or duplicating a row: %j", (tasks) => {
    const rows = columnTreeRows(buildColumnTree(Object.values(tasks), tasks));
    expect(new Set(ids(rows))).toEqual(new Set(Object.keys(tasks)));
    expect(rows).toHaveLength(Object.keys(tasks).length);
    for (const node of rows) {
      expect(node.ancestors.some((t) => t.id === node.task.id)).toBe(false);
      expect(new Set(node.ancestors.map((t) => t.id)).size).toBe(node.ancestors.length);
    }
  });

  it("preserves full depth and ancestry beyond the three-level visual cap", () => {
    const tasks = Object.fromEntries(
      Array.from({ length: 18 }, (_, i) => [
        `t${i}`,
        task(`t${i}`, { parentTaskId: i ? `t${i - 1}` : null }),
      ]),
    );
    const rows = columnTreeRows(buildColumnTree(Object.values(tasks), tasks));
    expect(rows[17]!.depth).toBe(17);
    expect(rows[17]!.ancestors.map((t) => t.id)).toEqual(rows.slice(0, 17).map((n) => n.task.id));
  });

  it("counts all direct children across states and filters, including canceled in the total", () => {
    const tasks = {
      ...all,
      child: { ...child, state: "done" as const, hiddenFromBoard: true },
      sibling: { ...sibling, state: "canceled" as const },
      other: { ...other, parentTaskId: parent.id, state: "ready" as const },
      foreign: task("foreign", { parentTaskId: parent.id, projectId: "prj_2" }),
    };
    expect(childProgress(parent.id, tasks)).toEqual({ done: 1, total: 3, canceled: 1 });
    expect(childProgress(child.id, tasks)).toEqual({ done: 0, total: 1, canceled: 0 });
    expect(childProgress(other.id, tasks)).toEqual({ done: 0, total: 0, canceled: 0 });
    expect(childProgress("missing", {})).toEqual({ done: 0, total: 0, canceled: 0 });
    expect(childProgress("self", { self: task("self", { parentTaskId: "self" }) }).total).toBe(0);
  });

  it("offers same-project parents separately from dependencies, excluding self and descendants", () => {
    const tasks = {
      ...all,
      parent: { ...parent, dependencies: ["other"] },
      hidden: task("hidden", { hiddenFromBoard: true }),
      canceled: task("canceled", { state: "canceled" }),
      foreign: task("foreign", { projectId: "prj_2" }),
    };
    const candidates = parentCandidates("prj_1", tasks, parent.id).map((t) => t.id);
    expect(candidates).toEqual(["canceled", "hidden", "other"]);
    expect(parentCandidates("prj_1", tasks).map((t) => t.id)).toContain("parent");
    expect(parentCandidates("prj_2", tasks).map((t) => t.id)).toEqual(["foreign"]);
    expect(parentCandidates("missing", tasks)).toEqual([]);
  });

  it("uses flat destination positions when tree rows differ, moving one task only", () => {
    const flat = [child, parent, grandchild, sibling, other];
    expect(ids(columnTreeRows(buildColumnTree(flat, all)))).not.toEqual(flat.map((t) => t.id));
    expect(positionFor(flat, parent.id, other.id)).toBe(1.5);
    expect(positionFor(flat, grandchild.id, parent.id)).toBe(2);
    expect(positionFor(flat, null, parent.id)).toBe(6);
    expect(child.parentTaskId).toBe(parent.id);
    expect(grandchild.state).toBe("backlog");
  });
});

describe("previewEligibility", () => {
  const base = {
    hosts: { hst_1: host("hst_1") },
    tasks: {},
    dispatchPaused: false,
    runningByProject: {},
  };

  it("starts automatically on a connected default host", () => {
    const e = previewEligibility({ project: project(), hostId: null, dependencies: [] }, base);
    expect(eligibilityText(e)).toBe("Will start automatically on Host hst_1");
  });

  it("explains waits", () => {
    const off = previewEligibility(
      { project: project(), hostId: null, dependencies: [] },
      { ...base, hosts: { hst_1: host("hst_1", { connectivity: "unreachable" }) } },
    );
    expect(off).toMatchObject({ eligible: false, wait: "host_offline" });
    const dep = previewEligibility(
      { project: project(), hostId: null, dependencies: ["x"] },
      { ...base, tasks: { x: task("x", { title: "Schema" }) } },
    );
    expect(eligibilityText(dep)).toBe("Will wait: Waiting on Schema");
    expect(
      previewEligibility(
        { project: project(), hostId: null, dependencies: [] },
        { ...base, dispatchPaused: true },
      ),
    ).toMatchObject({ wait: "dispatch_paused" });
    expect(
      previewEligibility(
        { project: project(), hostId: null, dependencies: [] },
        { ...base, runningByProject: { prj_1: 1 } },
      ),
    ).toMatchObject({ wait: "project_limit" });
  });
});

describe("moveHint", () => {
  it("explains invalid and decision moves", () => {
    expect(moveHint(planMove(task("t", { state: "backlog" }), "in_progress"))).toMatch(
      /Ready first/,
    );
    expect(moveHint(planMove(task("t", { state: "backlog" }), "ready"))).toBeNull();
    expect(moveHint(planMove(task("t", { state: "ready" }), "in_progress"))).toBe(
      "Starts now if the task is eligible.",
    );
  });
});
