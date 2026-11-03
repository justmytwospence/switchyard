import type { Host, Project, Session } from "@switchyard/protocol";
import { describe, expect, it } from "vitest";
import { agentState, type PlanInput, planHerdr, sessionLabel } from "../src/herdr/plan.js";

const DIR = "/state/sessions";

function session(id: string, over: Partial<Session> = {}): Session {
  return {
    id,
    title: `Title ${id}`,
    subtitle: null,
    hostId: "hst_1",
    workspaceId: null,
    projectId: "prj_1",
    cwd: "/repo",
    nativeHandle: null,
    profileSnapshot: {
      id: "prf_1",
      name: "Default",
      provider: null,
      model: null,
      thinking: null,
      projectTrust: "ask",
      extraArgs: [],
    },
    runtime: "idle",
    runtimeDetail: null,
    connectivity: "connected",
    runId: null,
    taskId: null,
    provenance: "created",
    readOnly: false,
    lastActivityAt: "2026-11-02T00:00:00Z",
    archivedAt: null,
    queue: { steering: [], followUp: [] },
    stats: null,
    lastAssistantText: null,
    createdAt: "2026-11-02T00:00:00Z",
    terminal: true,
    ...over,
  };
}

const hosts = [{ id: "hst_1", name: "mac" }] as Host[];
const projects = [{ id: "prj_1", name: "switchyard" }] as Project[];

function input(over: Partial<PlanInput>): PlanInput {
  return {
    sessions: [],
    hosts,
    projects,
    panes: [],
    workspaces: [],
    sessionsDir: DIR,
    parked: new Set(),
    goneTicks: new Map(),
    ...over,
  };
}

describe("herdr plan", () => {
  it("creates a space for each live terminal session without one, unless parked", () => {
    const plan = planHerdr(
      input({
        sessions: [
          session("ses_a"),
          session("ses_b"),
          session("ses_rpc", { terminal: false }),
          session("ses_arch", { archivedAt: "2026-11-02T00:00:00Z" }),
        ],
        parked: new Set(["ses_b"]),
      }),
    );
    expect(plan.create).toEqual([{ sessionId: "ses_a", label: "switchyard · Title ses_a" }]);
  });

  it("reports state, renames, and offers restarts for mapped panes", () => {
    const plan = planHerdr(
      input({
        sessions: [session("ses_a", { runtime: "waiting_input" })],
        panes: [{ pane_id: "w1:p1", workspace_id: "w1", cwd: `${DIR}/ses_a` }],
        workspaces: [{ workspace_id: "w1", label: "old" }],
      }),
    );
    expect(plan.create).toEqual([]);
    expect(plan.rename).toEqual([{ workspaceId: "w1", label: "switchyard · Title ses_a" }]);
    expect(plan.report).toEqual([
      {
        paneId: "w1:p1",
        state: "blocked",
        message: "Title ses_a · waiting_input",
        customStatus: "mac",
      },
    ]);
    expect(plan.restartCandidates).toEqual([{ paneId: "w1:p1", sessionId: "ses_a" }]);
  });

  it("closes a space only after its session has been gone for two ticks", () => {
    const goneTicks = new Map<string, number>();
    const base = input({
      sessions: [session("ses_a", { terminal: false, runtime: "stopped" })],
      panes: [
        { pane_id: "w1:p1", workspace_id: "w1", cwd: `${DIR}/ses_a` },
        { pane_id: "w2:p1", workspace_id: "w2", cwd: "/elsewhere" },
      ],
      workspaces: [
        { workspace_id: "w1", label: "switchyard · Title ses_a" },
        { workspace_id: "w2", label: "mine" },
      ],
      goneTicks,
    });
    expect(planHerdr(base).close).toEqual([]);
    expect(planHerdr(base).close).toEqual(["w1"]);
    expect(goneTicks.size).toBe(0);
  });

  it("maps runtimes and cuts long labels", () => {
    expect(agentState("running")).toBe("working");
    expect(agentState("starting")).toBe("working");
    expect(agentState("waiting_input")).toBe("blocked");
    expect(agentState("idle")).toBe("idle");
    const label = sessionLabel(session("x", { title: "a".repeat(60) }), projects);
    expect(label).toHaveLength(40);
    expect(label.endsWith("…")).toBe(true);
    expect(sessionLabel(session("y", { projectId: null, cwd: "/p/repo" }), [])).toBe(
      "repo · Title y",
    );
  });
});
