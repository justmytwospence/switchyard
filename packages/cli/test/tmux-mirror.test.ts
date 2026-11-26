import type { Scope } from "@switchyard/protocol";
import { describe, expect, it } from "vitest";
import type { MirrorState } from "../src/mirror/state.js";
import {
  emptyTmuxMemory,
  planTmux,
  type TmuxWindow,
  titleFromWindowName,
  windowName,
} from "../src/tmux/mirror.js";
import { session } from "./herdr-fixtures.js";

const NOW = Date.parse("2026-11-03T00:00:00Z");

function state(over: Partial<MirrorState> = {}): MirrorState {
  return {
    sessions: [],
    workspaces: [],
    projects: [{ id: "prj_sy", name: "switchyard" }] as MirrorState["projects"],
    hosts: [
      { id: "hst_mac", name: "mac", capabilities: { terminal: true } },
    ] as MirrorState["hosts"],
    checkouts: [],
    scopes: [],
    ...over,
  };
}

const win = (windowId: string, over: Partial<TmuxWindow> = {}): TmuxWindow => ({
  windowId,
  name: "x",
  sessionId: null,
  paneId: `%${windowId.slice(1)}`,
  paneDead: false,
  paneCommand: "zsh",
  ...over,
});

describe("planTmux", () => {
  it("creates windows for viewed sessions without one, honouring pending and grace", () => {
    const st = state({
      sessions: [
        session("ses_1", { cwd: "/a" }),
        session("ses_2", { cwd: "/b" }),
        session("ses_3", { cwd: "/c" }),
      ],
    });
    const mem = emptyTmuxMemory();
    mem.pending.ses_2 = { windowId: "@9", at: NOW - 1000 };
    const plan = planTmux(st, null, [], mem, NOW);
    expect(plan.createWindows.map((c) => c.sessionId)).toEqual(["ses_1", "ses_3"]);
    const young = state({
      sessions: [session("ses_1", { createdAt: new Date(NOW).toISOString() })],
    });
    expect(planTmux(young, null, [], emptyTmuxMemory(), NOW).createWindows).toEqual([]);
  });

  it("closes windows of sessions that left the set, never archiving", () => {
    const st = state({ sessions: [session("ses_1")] });
    const scope = {
      id: "viw_1",
      name: "v",
      mode: "pinned",
      projectIds: null,
      hostIds: null,
      sessionIds: [],
      source: null,
      createdAt: "",
      updatedAt: "",
    } as unknown as Scope;
    const w = win("@1", { sessionId: "ses_1", name: windowName(st.sessions[0]!, st) });
    expect(planTmux(st, scope, [w], emptyTmuxMemory(), NOW).closeWindows).toEqual([
      { windowId: "@1", sessionId: "ses_1" },
    ]);
  });

  it("keeps the active window of a session that stopped out of a GitHub scope", () => {
    const st = state({
      sessions: [session("ses_1", { runtime: "stopped", projectId: "prj_sy" })],
      issues: [],
    });
    const scope = {
      id: "viw_t",
      name: "personal",
      mode: "all",
      projectIds: ["prj_sy"],
      hostIds: null,
      sessionIds: [],
      source: { kind: "github" },
      createdAt: "",
      updatedAt: "",
    } as unknown as Scope;
    const name = windowName(st.sessions[0]!, st);
    const active = win("@1", { sessionId: "ses_1", name, active: true });
    expect(planTmux(st, scope, [active], emptyTmuxMemory(), NOW).closeWindows).toEqual([]);
    const other = win("@1", { sessionId: "ses_1", name, active: false });
    expect(planTmux(st, scope, [other], emptyTmuxMemory(), NOW).closeWindows).toEqual([
      { windowId: "@1", sessionId: "ses_1" },
    ]);
  });

  it("respawns dead claimed panes and renames to project · title", () => {
    const st = state({ sessions: [session("ses_1")] });
    const w = win("@1", { sessionId: "ses_1", paneDead: true, name: "old" });
    const plan = planTmux(st, null, [w], emptyTmuxMemory(), NOW);
    expect(plan.respawns).toEqual([{ paneId: "%1", sessionId: "ses_1" }]);
    expect(plan.renames).toEqual([{ windowId: "@1", name: "switchyard · Title ses_1" }]);
  });

  it("offers only to added, unoffered shell windows", () => {
    const mem = emptyTmuxMemory();
    mem.added.add("@2");
    mem.added.add("@3");
    mem.added.add("@4");
    mem.offered.add("@4");
    const windows = [win("@1"), win("@2"), win("@3", { paneCommand: "vim" }), win("@4")];
    expect(planTmux(state(), null, windows, mem, NOW).offers).toEqual([
      { windowId: "@2", paneId: "%2" },
    ]);
  });

  it("strips the project prefix from a window name", () => {
    const st = state({ sessions: [session("ses_1")] });
    const s = st.sessions[0]!;
    expect(titleFromWindowName("switchyard · Fix it", s, st)).toBe("Fix it");
    expect(titleFromWindowName("Fix it", s, st)).toBe("Fix it");
  });
});

describe("one window per active branch", () => {
  const old = { runtime: "stopped" as const, lastActivityAt: "2026-10-01T00:00:00Z" };

  it("closes a window it opened once the branch is inactive; one you opened or are in stays", () => {
    const st = state({ sessions: [session("ses_1", { ...old, cwd: "/a" })] });
    const w = win("@1", { sessionId: "ses_1", name: windowName(st.sessions[0]!, st) });
    const mem = emptyTmuxMemory();
    expect(planTmux(st, null, [w], mem, NOW).closeWindows).toEqual([]);
    mem.ownWindows["@1"] = "ses_1";
    expect(planTmux(st, null, [w], mem, NOW).closeWindows).toEqual([
      { windowId: "@1", sessionId: "ses_1" },
    ]);
    expect(planTmux(st, null, [{ ...w, active: true }], mem, NOW).closeWindows).toEqual([]);
  });

  it("opens one window per branch and none for a window you closed", () => {
    const st = state({ sessions: [session("ses_1"), session("ses_2")] });
    const mem = emptyTmuxMemory();
    expect(planTmux(st, null, [], mem, NOW).createWindows.map((c) => c.sessionId)).toEqual([
      "ses_1",
    ]);
    mem.hidden.ses_1 = st.sessions[0]!.lastActivityAt;
    expect(planTmux(st, null, [], mem, NOW).createWindows).toEqual([]);
  });
});
