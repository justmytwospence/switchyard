import { describe, expect, it } from "vitest";
import {
  findView,
  openTerminals,
  type Session,
  scopeHasWorkspace,
  sessionInView,
  sessionViewReason,
  TERMINAL_OPEN_MS,
  taskInView,
  trackerScope,
  View,
} from "../src/index.js";

const NOW = Date.parse("2026-11-03T00:00:00Z");

function view(over: Partial<View> = {}): View {
  return {
    id: "viw_1",
    name: "work",
    mode: "all",
    projectIds: null,
    hostIds: null,
    sessionIds: [],
    clients: [],
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    ...over,
  };
}

const s = (over: Record<string, unknown> = {}) => ({
  id: "ses_1",
  projectId: "prj_a" as string | null,
  workspaceId: "wsp_1" as string | null,
  hostId: "hst_1",
  archivedAt: null as string | null,
  runtime: "idle" as Session["runtime"],
  ...over,
});

describe("sessionInView", () => {
  it("never includes archived sessions", () => {
    expect(sessionInView(view({ sessionIds: ["ses_1"] }), s({ archivedAt: "x" }), {})).toBe(false);
  });
  it("pinned mode only has pinned sessions", () => {
    expect(sessionInView(view({ mode: "pinned", sessionIds: ["ses_1"] }), s(), {})).toBe(true);
    expect(sessionInView(view({ mode: "pinned" }), s(), {})).toBe(false);
  });
  it("all mode with null filters includes everything", () => {
    expect(sessionInView(view(), s(), {})).toBe(true);
  });
  it("matches projects through the workspace", () => {
    const v = view({ projectIds: ["prj_b"] });
    const x = s({ projectId: null });
    expect(sessionInView(v, x, { wsp_1: { projectId: "prj_b" } })).toBe(true);
    expect(sessionInView(v, x, new Map([["wsp_1", { projectId: "prj_b" }]]))).toBe(true);
    expect(sessionInView(v, x, {})).toBe(false);
  });
  it("filters by host", () => {
    expect(sessionInView(view({ hostIds: ["hst_2"] }), s(), {})).toBe(false);
  });
  it("drops a retired clientId from a stored view", () => {
    expect("clientId" in View.parse({ ...view(), clientId: "herdr:x@mac" })).toBe(false);
  });
  it("a pin beats the filters", () => {
    expect(
      sessionInView(
        view({ projectIds: ["prj_z"], hostIds: ["hst_2"], sessionIds: ["ses_1"] }),
        s(),
        {},
      ),
    ).toBe(true);
  });
});

describe("tracker views", () => {
  const v = view({ trackerId: "trk_1", projectIds: ["prj_a"] });
  const ws = {
    wsp_1: { projectId: "prj_a", branch: "feat/x" },
    wsp_2: { projectId: "prj_a", branch: "other" },
  };
  const issue = (over: Record<string, unknown> = {}) => ({
    trackerId: "trk_1",
    projectId: "prj_a",
    workspaceId: null as string | null,
    branch: null as string | null,
    branches: [] as string[],
    ...over,
  });
  const stopped = { runtime: "stopped" as const };

  it("trackerScope is null without a tracker and collects workspaces and branches", () => {
    expect(trackerScope(view(), [issue()])).toBeNull();
    const scope = trackerScope(v, [
      issue({ workspaceId: "wsp_9", branch: "a", branches: ["b"] }),
      issue({ trackerId: "trk_2", workspaceId: "wsp_8" }),
    ])!;
    expect([...scope.workspaceIds]).toEqual(["wsp_9"]);
    expect([...scope.branches].sort()).toEqual(["prj_a\na", "prj_a\nb"]);
  });
  it("a stopped session on an issue's workspace is in the view", () => {
    const scope = trackerScope(v, [issue({ workspaceId: "wsp_1" })]);
    expect(sessionInView(v, s(stopped), ws, scope)).toBe(true);
  });
  it("a stopped session on an issue's branch name is in the view", () => {
    const scope = trackerScope(v, [issue({ branches: ["feat/x"] })]);
    expect(sessionInView(v, s(stopped), ws, scope)).toBe(true);
  });
  it("a live session with no issue is in the view; a stopped one is not", () => {
    const scope = trackerScope(v, []);
    expect(sessionInView(v, s({ runtime: "running" }), ws, scope)).toBe(true);
    expect(sessionInView(v, s(stopped), ws, scope)).toBe(false);
    expect(sessionInView(v, s({ ...stopped, workspaceId: null }), ws, scope)).toBe(false);
  });
  it("a live session in another project is not in the view", () => {
    const scope = trackerScope(v, []);
    expect(sessionInView(v, s({ projectId: "prj_b" }), ws, scope)).toBe(false);
  });
  it("without a scope a tracker view falls back to its projects", () => {
    expect(sessionInView(v, s(stopped), ws)).toBe(true);
  });
  it("a pin still wins", () => {
    const scope = trackerScope(v, []);
    expect(sessionInView({ ...v, sessionIds: ["ses_1"] }, s(stopped), ws, scope)).toBe(true);
  });
  it("sessionViewReason names pin, issue, live and filter", () => {
    const scope = trackerScope(v, [issue({ workspaceId: "wsp_1" })]);
    expect(sessionViewReason({ ...v, sessionIds: ["ses_1"] }, s(stopped), ws, scope)).toBe(
      "pinned",
    );
    expect(sessionViewReason(v, s(stopped), ws, scope)).toBe("issue");
    expect(sessionViewReason(v, s(), ws, scope)).toBe("issue");
    expect(sessionViewReason(v, s({ workspaceId: "wsp_2" }), ws, scope)).toBe("live");
    expect(sessionViewReason(v, s({ ...stopped, workspaceId: "wsp_2" }), ws, scope)).toBeNull();
    expect(sessionViewReason(view(), s(stopped), ws)).toBe("filter");
  });
  it("scopeHasWorkspace matches by id or branch", () => {
    const scope = trackerScope(v, [issue({ workspaceId: "wsp_9", branches: ["feat/x"] })])!;
    expect(scopeHasWorkspace(scope, { id: "wsp_9", projectId: "prj_z" })).toBe(true);
    expect(scopeHasWorkspace(scope, { id: "wsp_1", projectId: "prj_a", branch: "feat/x" })).toBe(
      true,
    );
    expect(scopeHasWorkspace(scope, { id: "wsp_2", projectId: "prj_a", branch: "other" })).toBe(
      false,
    );
  });
});

describe("findView", () => {
  it("finds by id, then case-insensitive name, and not when ambiguous", () => {
    const a = view();
    const b = view({ id: "viw_2", name: "Play" });
    expect(findView([a, b], "viw_2")).toBe(b);
    expect(findView([a, b], "WORK")).toBe(a);
    expect(findView([a, view({ id: "viw_3", name: "WORK" })], "work")).toBeNull();
    expect(findView([a], "nope")).toBeNull();
  });
});

describe("openTerminals", () => {
  it("keeps recent terminals mirroring this view, sorted by kind then name", () => {
    const at = (ms: number) => new Date(NOW - ms).toISOString();
    const c = (
      id: string,
      kind: "herdr" | "tmux",
      name: string,
      lastSeenAt: string,
      viewId = "viw_1",
      mirror: "view" | "all" | undefined = undefined,
    ) => ({
      id,
      kind,
      name,
      machine: "m",
      deviceId: "dev_1",
      hostId: null,
      viewId,
      ...(mirror ? { mirror } : {}),
      lastSeenAt,
      createdAt: at(TERMINAL_OPEN_MS * 2),
    });
    const surfaces = [
      c("1", "tmux", "a", at(1000)),
      c("2", "herdr", "z", at(1000)),
      c("3", "herdr", "old", at(TERMINAL_OPEN_MS + 1)),
      c("4", "herdr", "elsewhere", at(1000), "viw_2"),
      c("5", "herdr", "everything", at(1000), "viw_1", "all"),
      c("6", "herdr", "recorded", at(1000), "viw_1", "view"),
    ];
    expect(openTerminals(surfaces, "viw_1", NOW).map((x) => x.id)).toEqual(["6", "2", "1"]);
  });
});

describe("taskInView", () => {
  const t = (over: { projectId?: string; sessionId?: string | null } = {}) => ({
    projectId: "prj_a",
    sessionId: null as string | null,
    ...over,
  });
  it("matches by project in an all view, with any project when unlimited", () => {
    expect(taskInView(view(), t())).toBe(true);
    expect(taskInView(view({ projectIds: ["prj_a"] }), t())).toBe(true);
    expect(taskInView(view({ projectIds: ["prj_b"] }), t())).toBe(false);
  });
  it("ignores host filters", () => {
    expect(taskInView(view({ hostIds: ["hst_9"] }), t())).toBe(true);
  });
  it("in a pinned view, only tasks whose session is pinned", () => {
    expect(taskInView(view({ mode: "pinned" }), t())).toBe(false);
    expect(
      taskInView(view({ mode: "pinned", sessionIds: ["ses_1"] }), t({ sessionId: "ses_1" })),
    ).toBe(true);
    expect(
      taskInView(view({ projectIds: ["prj_b"], sessionIds: ["ses_1"] }), t({ sessionId: "ses_1" })),
    ).toBe(true);
  });
});
