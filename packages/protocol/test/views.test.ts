import { describe, expect, it } from "vitest";
import {
  findView,
  openSurfaces,
  SURFACE_OPEN_MS,
  sessionInView,
  taskInView,
  type View,
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
  it("a session started in the view's source surface is in it, also in pinned mode", () => {
    const src = "herdr:default@mac";
    const started = s({ startedIn: src });
    expect(sessionInView(view({ mode: "pinned", clientId: src }), started, {})).toBe(true);
    expect(sessionInView(view({ hostIds: ["hst_2"], clientId: src }), started, {})).toBe(true);
    expect(sessionInView(view({ mode: "pinned", clientId: src }), s(), {})).toBe(false);
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

describe("openSurfaces", () => {
  it("keeps this view's recent surfaces, sorted by kind then name", () => {
    const at = (ms: number) => new Date(NOW - ms).toISOString();
    const c = (
      id: string,
      kind: "herdr" | "tmux",
      name: string,
      lastSeenAt: string,
      viewId = "viw_1",
    ) => ({
      id,
      kind,
      name,
      machine: "m",
      deviceId: "dev_1",
      hostId: null,
      viewId,
      lastSeenAt,
      createdAt: at(SURFACE_OPEN_MS * 2),
    });
    const surfaces = [
      c("1", "tmux", "a", at(1000)),
      c("2", "herdr", "z", at(1000)),
      c("3", "herdr", "old", at(SURFACE_OPEN_MS + 1)),
      c("4", "herdr", "elsewhere", at(1000), "viw_2"),
    ];
    expect(openSurfaces(surfaces, "viw_1", NOW).map((x) => x.id)).toEqual(["2", "1"]);
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
