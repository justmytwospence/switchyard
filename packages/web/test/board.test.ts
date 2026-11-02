import type { Host, Project } from "@switchyard/protocol";
import { describe, expect, it } from "vitest";
import {
  activeFilterChips,
  buildColumns,
  DEFAULT_FILTERS,
  eligibilityText,
  normalizeFilters,
  planMove,
  positionFor,
  previewEligibility,
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
