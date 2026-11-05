import type { View } from "@switchyard/protocol";
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
    views: [],
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
    const st = state({ sessions: [session("ses_1"), session("ses_2"), session("ses_3")] });
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
    const view = {
      id: "viw_1",
      name: "v",
      mode: "pinned",
      projectIds: null,
      hostIds: null,
      sessionIds: [],
      clients: [],
      createdAt: "",
      updatedAt: "",
    } as View;
    const w = win("@1", { sessionId: "ses_1", name: windowName(st.sessions[0]!, st) });
    expect(planTmux(st, view, [w], emptyTmuxMemory(), NOW).closeWindows).toEqual([
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
