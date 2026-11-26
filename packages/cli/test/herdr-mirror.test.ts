import type { Checkout, Host, Project, Scope, Workspace } from "@switchyard/protocol";
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
import { paneSession, scopedSessions, wantedSessions } from "../src/mirror/state.js";
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
    scopes: [],
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
    // ses_1 is an extra opened by hand; its branch's primary ses_2 gets a tab next to it.
    const st = state({ sessions: [session("ses_1"), session("ses_2", { primary: true })] });
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

describe("scopes and ownership", () => {
  it("does not offer the picker in a space the mirror does not own", () => {
    const h = herdr({
      workspaces: [{ workspace_id: "mine", label: "my stuff", number: 1 }],
      tabs: [{ tab_id: "mine:t1", workspace_id: "mine", label: "1" }],
      panes: [{ pane_id: "mine:p1", tab_id: "mine:t1", workspace_id: "mine" }],
    });
    expect(planMirror(state(), h, emptyMemory(), NOW).offers).toEqual([]);
  });

  it("only mirrors sessions in the bound scope and closes tabs of the rest", () => {
    const st = state({ sessions: [session("ses_1"), session("ses_2")] });
    const scope = {
      id: "viw_1",
      name: "v",
      mode: "pinned",
      projectIds: null,
      hostIds: null,
      sessionIds: ["ses_1"],
      source: null,
      createdAt: "",
      updatedAt: "",
    } as const;
    const mem = emptyMemory();
    mem.spaces.w1 = { key: "wsp_main", label: "switchyard" };
    const h = herdr({
      workspaces: [{ workspace_id: "w1", label: "switchyard", number: 1 }],
      tabs: [
        { tab_id: "w1:t1", workspace_id: "w1", label: "a" },
        { tab_id: "w1:t2", workspace_id: "w1", label: "b" },
      ],
      panes: [
        { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", agent_session: claim("ses_1") },
        { pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1", agent_session: claim("ses_2") },
      ],
    });
    const plan = planMirror(st, h, mem, NOW, scope as any);
    expect(plan.closeTabs).toEqual([{ tabId: "w1:t2", sessionId: "ses_2" }]);
  });

  it("a GitHub scope mirrors issue sessions and live ones only", () => {
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
    } as const;
    const st = state({
      sessions: [
        session("ses_live"),
        session("ses_old", { runtime: "stopped" }),
        session("ses_issue", {
          runtime: "stopped",
          workspaceId: "wsp_feat",
          cwd: "/repo/.worktrees/feat",
        }),
      ],
      issues: [
        {
          id: "trk_1:I_1",
          scopeId: "viw_t",
          itemId: "I_1",
          projectId: "prj_sy",
          repository: "me/switchyard",
          number: 1,
          title: "x",
          url: "https://github.com/me/switchyard/issues/1",
          assignees: [],
          branches: ["feat"],
          branch: null,
          workspaceId: null,
          pullRequest: null,
          board: null,
          updatedAt: "",
        },
      ],
    });
    expect(
      scopedSessions(st, scope as any)
        .map((s) => s.id)
        .sort(),
    ).toEqual(["ses_issue", "ses_live"]);
  });
});

describe("GitHub scopes keep the focused tab", () => {
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
  } as const;
  const h = (focusedTabId: string) =>
    herdr({
      workspaces: [{ workspace_id: "w1", label: "switchyard", number: 1 }],
      tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "old" }],
      panes: [
        { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", agent_session: claim("ses_old") },
      ],
      focusedTabId,
    });
  const mem = () => {
    const m = emptyMemory();
    m.spaces.w1 = { key: "wsp_main", label: "switchyard" };
    return m;
  };

  it("keeps the focused tab of a session that stopped out of a GitHub scope", () => {
    const st = state({ sessions: [session("ses_old", { runtime: "stopped" })], issues: [] });
    expect(planMirror(st, h("w1:t1"), mem(), NOW, scope as any).closeTabs).toEqual([]);
    expect(planMirror(st, h("w1:t9"), mem(), NOW, scope as any).closeTabs).toEqual([
      { tabId: "w1:t1", sessionId: "ses_old" },
    ]);
    const archived = state({
      sessions: [session("ses_old", { runtime: "stopped", archivedAt: "2026-11-02T00:00:00Z" })],
      issues: [],
    });
    expect(planMirror(archived, h("w1:t1"), mem(), NOW, scope as any).closeTabs).toEqual([
      { tabId: "w1:t1", sessionId: "ses_old" },
    ]);
  });
});

describe("claims", () => {
  it("reads the session token, and gives new sessions time to be claimed", () => {
    const st = state({
      sessions: [
        session("ses_1"),
        session("ses_2", { createdAt: new Date(NOW - 1000).toISOString(), primary: true }),
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
        session("ses_2", { terminal: false, workspaceId: "wsp_other", projectId: "prj_29" }),
        session("ses_3", { runtime: "stopped", terminal: undefined, workspaceId: "wsp_feat" }),
        session("ses_4", { runtime: "starting", terminal: undefined }),
      ],
    });
    expect(mirroredSessions(st).map((s) => s.id)).toEqual(["ses_3", "ses_4"]);
    const plan = planMirror(st, herdr(), emptyMemory(), NOW);
    expect(plan.createSpaces.map((c) => c.firstSessionId)).toEqual(["ses_3", "ses_4"]);
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

describe("one tab per active branch", () => {
  const DAY = 24 * 60 * 60_000;
  const ago = (ms: number) => new Date(NOW - ms).toISOString();
  const feat = { workspaceId: "wsp_feat", cwd: "/repo/.worktrees/feat" };

  it("opens only each branch's primary, and only while the branch is active", () => {
    const st = state({
      sessions: [
        session("ses_1", { runtime: "stopped", lastActivityAt: ago(DAY) }),
        session("ses_2", { runtime: "stopped", lastActivityAt: ago(DAY / 2) }),
        session("ses_3", { ...feat, runtime: "stopped", lastActivityAt: ago(3 * DAY) }),
      ],
    });
    // ses_2 is wsp_main's primary (most recently active); feat stopped three days ago.
    expect(wantedSessions(st, null, NOW).map((s) => s.id)).toEqual(["ses_2"]);
    const unread = state({
      sessions: [session("ses_3", { ...st.sessions[2]!, unreadSince: ago(3 * DAY) })],
    });
    expect(wantedSessions(unread, null, NOW).map((s) => s.id)).toEqual(["ses_3"]);
    const live = state({ sessions: [session("ses_3", { ...st.sessions[2]!, runtime: "idle" })] });
    expect(wantedSessions(live, null, NOW).map((s) => s.id)).toEqual(["ses_3"]);
  });

  it("treats a pin as membership: a pinned extra stands for its branch only when the primary is not in the scope", () => {
    const old = { runtime: "stopped" as const, lastActivityAt: "2026-10-01T00:00:00Z" };
    const st = state({ sessions: [session("ses_1"), session("ses_2")] });
    const scope = {
      id: "viw_1",
      name: "v",
      mode: "pinned",
      projectIds: null,
      hostIds: null,
      sessionIds: ["ses_2"],
      source: null,
      createdAt: "",
      updatedAt: "",
    } as unknown as Scope;
    expect(wantedSessions(st, scope, NOW).map((s) => s.id)).toEqual(["ses_2"]);
    expect(wantedSessions(st, null, NOW).map((s) => s.id)).toEqual(["ses_1"]);
    // A pin is not activity: a long-stopped pinned session opens no tab.
    const stale = state({ sessions: [session("ses_1", old), session("ses_2", old)] });
    expect(wantedSessions(stale, scope, NOW)).toEqual([]);
  });

  it("opens no tab for a session whose Pi last ran by hand in this terminal", () => {
    const place = { terminalId: "herdr:a@m", pane: "w1:p2" };
    const st = state({ sessions: [session("ses_1", { runtime: "stopped", place })] });
    expect(wantedSessions(st, null, NOW, "herdr:a@m")).toEqual([]);
    expect(wantedSessions(st, null, NOW, "herdr:b@m").map((s) => s.id)).toEqual(["ses_1"]);
    // An older host reports only `external` while it runs.
    const old = state({
      sessions: [session("ses_1", { runtime: "stopped", external: { client: "herdr:a@m" } })],
    });
    expect(wantedSessions(old, null, NOW, "herdr:a@m")).toEqual([]);
  });

  it("finds the hand-started Pi in a focused pane", () => {
    const place = { terminalId: "herdr:a@m", pane: "w1:p2" };
    const external = { client: "herdr:a@m" };
    const st = state({ sessions: [session("ses_1", { terminal: false, external, place })] });
    expect(paneSession(st, "herdr:a@m", "w1:p2")).toBe("ses_1");
    expect(paneSession(st, "herdr:a@m", "w1:p3")).toBeNull();
    const stopped = state({ sessions: [session("ses_1", { runtime: "stopped", place })] });
    expect(paneSession(stopped, "herdr:a@m", "w1:p2")).toBeNull();
  });

  it("closes a tab it opened once the branch is inactive; a tab you opened or are in stays", () => {
    const old = { runtime: "stopped" as const, lastActivityAt: ago(3 * DAY) };
    const st = state({ sessions: [session("ses_1", old), session("ses_3", { ...feat, ...old })] });
    const h = herdr({
      workspaces: [
        { workspace_id: "w1", label: "switchyard", number: 1 },
        { workspace_id: "w2", label: "switchyard · feat", number: 2 },
      ],
      tabs: [
        { tab_id: "w1:t1", workspace_id: "w1", label: "Title ses_1" },
        { tab_id: "w2:t1", workspace_id: "w2", label: "Title ses_3" },
      ],
      panes: [
        { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", agent_session: claim("ses_1") },
        { pane_id: "w2:p1", tab_id: "w2:t1", workspace_id: "w2", agent_session: claim("ses_3") },
      ],
    });
    const mem = emptyMemory();
    mem.ownTabs["w1:t1"] = "ses_1";
    expect(planMirror(st, h, mem, NOW).closeTabs).toEqual([{ tabId: "w1:t1", sessionId: "ses_1" }]);
    expect(planMirror(st, { ...h, focusedTabId: "w1:t1" }, mem, NOW).closeTabs).toEqual([]);
  });

  it("does not reopen a tab you closed until the session is active again", () => {
    const st = state({ sessions: [session("ses_1")] });
    const mem = emptyMemory();
    mem.hidden.ses_1 = st.sessions[0]!.lastActivityAt;
    expect(planMirror(st, herdr(), mem, NOW).createSpaces).toEqual([]);
    mem.hidden.ses_1 = "2026-01-01T00:00:00Z";
    expect(planMirror(st, herdr(), mem, NOW).createSpaces).toHaveLength(1);
  });
});
