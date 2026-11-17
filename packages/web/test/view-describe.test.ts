import type { Tracker, View } from "@switchyard/protocol";
import { describe, expect, it } from "vitest";
import {
  clientLabel,
  describeView,
  viewOptionLabel,
  viewSource,
} from "../src/features/views/describe";

const T = "2026-11-02T10:00:00.000Z";
function view(over: Partial<View> = {}): View {
  return {
    id: "viw_1",
    name: "work",
    mode: "all",
    projectIds: null,
    hostIds: null,
    sessionIds: [],
    clients: [],
    createdAt: T,
    updatedAt: T,
    ...over,
  };
}
const tracker = (over: Partial<Tracker> = {}): Tracker => ({
  id: "trk_1",
  name: "vo",
  provider: "github",
  hostId: "hst_1",
  owner: "VO-Health",
  repositories: null,
  board: null,
  writeBack: false,
  moveShared: true,
  enabled: true,
  login: "me",
  lastSyncedAt: null,
  lastError: null,
  createdAt: T,
  updatedAt: T,
  ...over,
});
const projects = {
  a: { name: "Alpha" },
  b: { name: "Beta" },
  c: { name: "Gamma" },
  d: { name: "Delta" },
  e: { name: "Epsilon" },
};
const hosts = { h1: { name: "NUC" }, h2: { name: "Mac" } };
const ctx = { trackers: [tracker()], projects, hosts };

describe("view descriptions", () => {
  it("names the source", () => {
    expect(viewSource(view({ trackerId: "trk_1" }))).toBe("tracker");
    expect(viewSource(view({ clientId: "herdr:default@mac" }))).toBe("client");
    expect(viewSource(view())).toBe("manual");
  });

  it("labels clients and options", () => {
    expect(clientLabel("herdr:default@mac-pro")).toBe("herdr default on mac-pro");
    expect(clientLabel("odd")).toBe("odd");
    expect(viewOptionLabel(view({ name: "vo", trackerId: "trk_1" }))).toBe("vo · GitHub");
    expect(viewOptionLabel(view({ name: "daily", clientId: "herdr:default@mac" }))).toBe(
      "daily · herdr default",
    );
    expect(viewOptionLabel(view({ name: "daily", clientId: "?" }))).toBe("daily · terminal");
    expect(viewOptionLabel(view())).toBe("work");
  });

  it("describes tracker views", () => {
    const v = view({ trackerId: "trk_1" });
    expect(describeView(v, ctx)).toBe("GitHub issues assigned to me in VO-Health");
    expect(
      describeView(v, {
        ...ctx,
        trackers: [
          tracker({
            login: null,
            board: { projectNumber: 1, statusField: "Status", onStart: null, onReview: null },
          }),
        ],
      }),
    ).toBe("GitHub issues assigned to you in VO-Health (board #1)");
    expect(describeView(v, { ...ctx, trackers: null })).toBe("Kept by a GitHub tracker");
  });

  it("describes client and pinned views", () => {
    expect(describeView(view({ clientId: "herdr:default@mac" }), ctx)).toBe(
      "Pi you start in herdr default on mac",
    );
    expect(describeView(view({ mode: "pinned", sessionIds: ["s"] }), ctx)).toBe("1 pinned session");
    expect(describeView(view({ mode: "pinned" }), ctx)).toBe("0 pinned sessions");
  });

  it("describes filters", () => {
    expect(describeView(view(), ctx)).toBe("Every session");
    expect(describeView(view({ projectIds: ["a", "zz"] }), ctx)).toBe("Sessions in Alpha");
    expect(describeView(view({ hostIds: ["h1"] }), ctx)).toBe("Sessions on NUC");
    expect(describeView(view({ projectIds: ["a"], hostIds: ["h1", "h2"] }), ctx)).toBe(
      "Sessions in Alpha on NUC, Mac",
    );
    expect(describeView(view({ projectIds: ["a", "b", "c", "d", "e"] }), ctx)).toBe(
      "Sessions in Alpha, Beta, Gamma and 2 more",
    );
  });
});
