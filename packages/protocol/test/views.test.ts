import { describe, expect, it } from "vitest";
import { CLIENT_OPEN_MS, findView, openClients, sessionInView, type View } from "../src/index.js";

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

describe("openClients", () => {
  it("drops clients older than ten minutes and sorts by kind then name", () => {
    const at = (ms: number) => new Date(NOW - ms).toISOString();
    const c = (id: string, kind: "herdr" | "tmux", name: string, lastSeenAt: string) => ({
      id,
      kind,
      name,
      machine: "m",
      lastSeenAt,
    });
    const v = view({
      clients: [
        c("1", "tmux", "a", at(1000)),
        c("2", "herdr", "z", at(1000)),
        c("3", "herdr", "old", at(CLIENT_OPEN_MS + 1)),
      ],
    });
    expect(openClients(v, NOW).map((x) => x.id)).toEqual(["2", "1"]);
  });
});
