import type { Checkout, Host, Project, Workspace } from "@switchyard/protocol";
import { describe, expect, it } from "vitest";
import {
  agentState,
  emptyMemory,
  type HerdrSnapshot,
  type MirrorState,
  mirroredSessions,
  planMirror,
  SOURCE,
  spaceLabel,
  tabLabel,
} from "../src/herdr/mirror.js";
import { session } from "./herdr-fixtures.js";

const NOW = Date.parse("2026-11-03T00:00:00Z");

function workspace(id: string, over: Partial<Workspace> = {}): Workspace {
  return {
    id,
    checkoutId: "chk_mac",
    projectId: "prj_sy",
    hostId: "hst_mac",
    path: "/repo",
    branch: "main",
    baseBranch: null,
    provenance: "main",
    git: {} as Workspace["git"],
    setup: { state: "none", log: "" },
    archivedAt: null,
    updatedAt: "2026-11-02T00:00:00Z",
    ...over,
  };
}

function state(over: Partial<MirrorState> = {}): MirrorState {
  return {
    sessions: [],
    workspaces: [
      workspace("wsp_main"),
      workspace("wsp_feat", {
        path: "/repo/.worktrees/feat",
        branch: "feat",
        provenance: "managed",
      }),
      workspace("wsp_other", { projectId: "prj_29", path: "/29ers", checkoutId: "chk_29" }),
    ],
    projects: [
      { id: "prj_sy", name: "switchyard" },
      { id: "prj_29", name: "29ers" },
    ] as Project[],
    hosts: [
      { id: "hst_mac", name: "mac", capabilities: { terminal: true } },
      { id: "hst_nuc", name: "nuc", capabilities: { terminal: true } },
    ] as Host[],
    checkouts: [
      { id: "chk_mac", projectId: "prj_sy", hostId: "hst_mac" },
      { id: "chk_29", projectId: "prj_29", hostId: "hst_mac" },
    ] as Checkout[],
    ...over,
  };
}

const claim = (value: string) => ({ source: SOURCE, agent: SOURCE, kind: "id", value });

function herdr(over: Partial<HerdrSnapshot> = {}): HerdrSnapshot {
  return { workspaces: [], tabs: [], panes: [], ...over };
}

describe("planMirror", () => {
  it("creates one space per workspace for the first session, next to the project's spaces", () => {
    const st = state({
      sessions: [
        session("ses_1"),
        session("ses_2"),
        session("ses_3", { workspaceId: "wsp_feat", cwd: "/repo/.worktrees/feat" }),
      ],
    });
    const plan = planMirror(st, herdr(), emptyMemory(), NOW);
    expect(plan.createSpaces.map((c) => [c.key, c.firstSessionId, c.label])).toEqual([
      ["wsp_main", "ses_1", "switchyard"],
      ["wsp_feat", "ses_3", "switchyard · feat"],
    ]);
    expect(plan.createTabs).toEqual([]);

    const withSpace = planMirror(
      st,
      herdr({
        workspaces: [
          { workspace_id: "w1", label: "switchyard", number: 1 },
          { workspace_id: "w2", label: "mine", number: 2 },
        ],
        tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "Title ses_1" }],
        panes: [
          { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", agent_session: claim("ses_1") },
        ],
      }),
      emptyMemory(),
      NOW,
    );
    expect(withSpace.createSpaces).toEqual([
      expect.objectContaining({ key: "wsp_feat", insertIndex: 1 }),
    ]);
  });

  it("adds tabs to a space, unless a typed command is still pending", () => {
    const st = state({ sessions: [session("ses_1"), session("ses_2")] });
    const h = herdr({
      workspaces: [{ workspace_id: "w1", label: "switchyard", number: 1 }],
      tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "Title ses_1" }],
      panes: [
        { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", agent_session: claim("ses_1") },
      ],
    });
    expect(planMirror(st, h, emptyMemory(), NOW).createTabs).toEqual([
      { workspaceId: "w1", sessionId: "ses_2", label: "Title ses_2", cwd: "/repo" },
    ]);
    const mem = emptyMemory();
    mem.pending.ses_2 = { tabId: "w1:t2", at: NOW - 1000 };
    expect(planMirror(st, h, mem, NOW).createTabs).toEqual([]);
  });

  it("closes tabs of archived sessions and own spaces left empty", () => {
    const st = state({ sessions: [session("ses_1", { archivedAt: "2026-11-02T01:00:00Z" })] });
    const mem = emptyMemory();
    mem.spaces.w1 = { key: "wsp_main", label: "switchyard" };
    const h = herdr({
      workspaces: [{ workspace_id: "w1", label: "switchyard", number: 1 }],
      tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "Title ses_1" }],
      panes: [
        { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", agent_session: claim("ses_1") },
      ],
    });
    const plan = planMirror(st, h, mem, NOW);
    expect(plan.closeTabs).toEqual([{ tabId: "w1:t1", sessionId: "ses_1" }]);
    // The claimed pane keeps the space until its tab is gone.
    expect(plan.closeSpaces).toEqual([]);
    const after = planMirror(
      st,
      herdr({ workspaces: h.workspaces, tabs: [], panes: [] }),
      mem,
      NOW,
    );
    expect(after.closeSpaces).toEqual(["w1"]);
  });

  it("moves panes in the wrong space, into a new space when none exists", () => {
    const st = state({
      sessions: [
        session("ses_1"),
        session("ses_2"),
        session("ses_3", { workspaceId: "wsp_feat" }),
        session("ses_4", { workspaceId: "wsp_other", projectId: "prj_29" }),
      ],
    });
    const h = herdr({
      workspaces: [
        { workspace_id: "w1", label: "switchyard", number: 1 },
        { workspace_id: "w2", label: "switchyard · feat", number: 2 },
      ],
      tabs: [
        { tab_id: "w1:t1", workspace_id: "w1", label: "Title ses_1" },
        { tab_id: "w1:t2", workspace_id: "w1", label: "Title ses_3" },
        { tab_id: "w1:t3", workspace_id: "w1", label: "Title ses_4" },
        { tab_id: "w2:t1", workspace_id: "w2", label: "Title ses_2" },
      ],
      panes: [
        { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", agent_session: claim("ses_1") },
        { pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1", agent_session: claim("ses_3") },
        { pane_id: "w1:p3", tab_id: "w1:t3", workspace_id: "w1", agent_session: claim("ses_4") },
        { pane_id: "w2:p1", tab_id: "w2:t1", workspace_id: "w2", agent_session: claim("ses_2") },
      ],
    });
    const mem = emptyMemory();
    mem.spaces.w2 = { key: "wsp_feat", label: "switchyard · feat" };
    const plan = planMirror(st, h, mem, NOW);
    // w1 is wsp_main (two votes vs one each); w2 holds only ses_2, so it is wsp_main too.
    expect(plan.moves).toEqual(
      expect.arrayContaining([
        { paneId: "w1:p2", sessionId: "ses_3", toWorkspaceId: null, label: "switchyard · feat" },
        { paneId: "w1:p3", sessionId: "ses_4", toWorkspaceId: null, label: "29ers" },
        { paneId: "w2:p1", sessionId: "ses_2", toWorkspaceId: "w1", label: "Title ses_2" },
      ]),
    );
    expect(plan.createSpaces).toEqual([]);
  });

  it("renames tabs to titles, honouring pending title overrides", () => {
    const st = state({ sessions: [session("ses_1", { title: "New title" })] });
    const h = herdr({
      workspaces: [{ workspace_id: "w1", label: "switchyard", number: 1 }],
      tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "Old" }],
      panes: [
        { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", agent_session: claim("ses_1") },
      ],
    });
    expect(planMirror(st, h, emptyMemory(), NOW).renameTabs).toEqual([
      { tabId: "w1:t1", label: "New title" },
    ]);
    const mem = emptyMemory();
    mem.titleOverrides.ses_1 = "Old";
    expect(planMirror(st, h, mem, NOW).renameTabs).toEqual([]);
  });

  it("keeps a space label the user chose until Switchyard's label changes", () => {
    const st = state({ sessions: [session("ses_1")] });
    const h = herdr({
      workspaces: [{ workspace_id: "w1", label: "my name", number: 1 }],
      tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "Title ses_1" }],
      panes: [
        { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", agent_session: claim("ses_1") },
      ],
    });
    const mem = emptyMemory();
    mem.spaces.w1 = { key: "wsp_main", label: "switchyard" };
    expect(planMirror(st, h, mem, NOW).renameSpaces).toEqual([]);
    mem.spaces.w1 = { key: "wsp_main", label: "old project name" };
    expect(planMirror(st, h, mem, NOW).renameSpaces).toEqual([
      { workspaceId: "w1", label: "switchyard" },
    ]);
  });

  it("offers the picker in tabs someone opened, and restarts own tabs", () => {
    const st = state({
      sessions: [session("ses_1"), session("ses_9", { workspaceId: null, cwd: "/x/y" })],
    });
    const mem = emptyMemory();
    mem.ownTabs["w1:t3"] = "ses_1";
    mem.spaces.w2 = { key: "cwd:hst_mac:/x/y", label: "y · y" };
    const h = herdr({
      workspaces: [
        { workspace_id: "w1", label: "switchyard", number: 1 },
        { workspace_id: "w2", label: "y · y", number: 2 },
      ],
      tabs: [
        { tab_id: "w1:t2", workspace_id: "w1", label: "2" },
        { tab_id: "w1:t3", workspace_id: "w1", label: "Title ses_1" },
        { tab_id: "w2:t1", workspace_id: "w2", label: "1" },
      ],
      panes: [
        { pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1" },
        { pane_id: "w1:p3", tab_id: "w1:t3", workspace_id: "w1" },
        { pane_id: "w2:p1", tab_id: "w2:t1", workspace_id: "w2" },
      ],
    });
    // w1's key comes from nothing yet (no claims, no memory): give it one.
    mem.spaces.w1 = { key: "wsp_main", label: "switchyard" };
    const plan = planMirror(st, h, mem, NOW);
    expect(plan.restarts).toEqual([{ paneId: "w1:p3", sessionId: "ses_1" }]);
    expect(plan.createTabs.map((t) => t.sessionId)).toEqual(["ses_9"]);
    expect(plan.offers).toEqual([
      { tabId: "w1:t2", paneId: "w1:p2", workspaceKey: "wsp_main" },
      { tabId: "w2:t1", paneId: "w2:p1", workspaceKey: null },
    ]);
  });

  it("ignores read-only sessions and reports state", () => {
    const st = state({
      sessions: [
        session("ses_1", { runtime: "waiting_input" }),
        session("ses_2", { readOnly: true }),
      ],
    });
    const h = herdr({
      workspaces: [{ workspace_id: "w1", label: "switchyard", number: 1 }],
      tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "Title ses_1" }],
      panes: [
        { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", agent_session: claim("ses_1") },
      ],
    });
    const plan = planMirror(st, h, emptyMemory(), NOW);
    expect(plan.createTabs).toEqual([]);
    expect(plan.reports).toEqual([
      {
        paneId: "w1:p1",
        sessionId: "ses_1",
        state: "blocked",
        message: "waiting_input",
        displayAgent: "pi · mac",
      },
    ]);
  });
});

describe("claims", () => {
  it("reads the session token, and gives new sessions time to be claimed", () => {
    const st = state({
      sessions: [
        session("ses_1"),
        session("ses_2", { createdAt: new Date(NOW - 1000).toISOString() }),
      ],
    });
    const h = herdr({
      workspaces: [{ workspace_id: "w1", label: "switchyard", number: 1 }],
      tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "Title ses_1" }],
      panes: [
        {
          pane_id: "w1:p1",
          tab_id: "w1:t1",
          workspace_id: "w1",
          tokens: { switchyard_session: "ses_1" },
        },
      ],
    });
    const plan = planMirror(st, h, emptyMemory(), NOW);
    expect(plan.reports.map((r) => r.sessionId)).toEqual(["ses_1"]);
    expect(plan.createTabs).toEqual([]);
    // No live pane process holds the token: run it again in that pane.
    expect(plan.restarts).toEqual([{ paneId: "w1:p1", sessionId: "ses_1" }]);
    h.panes[0]!.agent = "switchyard";
    expect(planMirror(st, h, emptyMemory(), NOW).restarts).toEqual([]);
    expect(planMirror(st, h, emptyMemory(), NOW + 5000).createTabs.map((t) => t.sessionId)).toEqual(
      ["ses_2"],
    );
  });
});

describe("terminals", () => {
  it("mirrors only sessions with a Pi terminal, now or when resumed", () => {
    const st = state({
      hosts: [
        { id: "hst_mac", name: "mac", capabilities: { terminal: true } },
        { id: "hst_nuc", name: "nuc", capabilities: { terminal: false } },
      ] as Host[],
      sessions: [
        session("ses_1", { hostId: "hst_nuc", workspaceId: "wsp_other", projectId: "prj_29" }),
        session("ses_2", { terminal: false }),
        session("ses_3", { runtime: "stopped", terminal: undefined }),
        session("ses_4", { runtime: "starting", terminal: undefined }),
      ],
    });
    expect(mirroredSessions(st).map((s) => s.id)).toEqual(["ses_3", "ses_4"]);
    const plan = planMirror(st, herdr(), emptyMemory(), NOW);
    expect(plan.createSpaces.map((c) => c.firstSessionId)).toEqual(["ses_3"]);
  });
});

describe("labels", () => {
  it("caps labels and adds the host only for projects on several hosts", () => {
    const st = state();
    expect(tabLabel(session("ses_1", { title: "a".repeat(60) }))).toHaveLength(40);
    expect(spaceLabel("wsp_main", st)).toBe("switchyard");
    const two = state({
      checkouts: [
        { id: "chk_mac", projectId: "prj_sy", hostId: "hst_mac" },
        { id: "chk_nuc", projectId: "prj_sy", hostId: "hst_nuc" },
      ] as Checkout[],
    });
    expect(spaceLabel("wsp_feat", two)).toBe("switchyard · feat · mac");
    expect(agentState("starting")).toBe("working");
    expect(agentState("stopped")).toBe("idle");
  });
});
