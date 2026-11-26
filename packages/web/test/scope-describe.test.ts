import type { Client, GitHubSource, Scope } from "@switchyard/protocol";
import { describe, expect, it } from "vitest";
import {
  describeScope,
  emptyScopeState,
  mirrorLabel,
  scopeOptionLabel,
  scopeSourceKind,
  shownIn,
} from "../src/features/scopes/describe";

const T = "2026-11-02T10:00:00.000Z";
function scope(over: Partial<Scope> = {}): Scope {
  return {
    id: "viw_1",
    name: "work",
    mode: "all",
    projectIds: null,
    hostIds: null,
    sessionIds: [],
    source: null,
    createdAt: T,
    updatedAt: T,
    ...over,
  };
}
const github = (over: Partial<GitHubSource> = {}): GitHubSource => ({
  kind: "github",
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
  ...over,
});
/** A GitHub scope with this source. */
const fed = (over: Partial<GitHubSource> = {}, name = "work") =>
  scope({ id: "trk_1", name, source: github(over) });
const projects = {
  a: { name: "Alpha" },
  b: { name: "Beta" },
  c: { name: "Gamma" },
  d: { name: "Delta" },
  e: { name: "Epsilon" },
};
const hosts = { h1: { name: "NUC" }, h2: { name: "Mac" } };
const ctx = { projects, hosts };

describe("scope descriptions", () => {
  it("names the source", () => {
    expect(scopeSourceKind(fed())).toBe("github");
    expect(scopeSourceKind(scope())).toBe("manual");
  });

  it("labels options", () => {
    expect(scopeOptionLabel(fed({}, "vo"))).toBe("vo · GitHub");
    expect(scopeOptionLabel(scope())).toBe("work");
  });

  it("describes GitHub scopes", () => {
    const board = { projectNumber: 1, statusField: "Status", onStart: null, onReview: null };
    expect(describeScope(fed(), ctx)).toBe(
      "Issues assigned to me in VO-Health, and live sessions there",
    );
    expect(describeScope(fed({ login: null, board }), ctx)).toBe(
      "Issues assigned to you in VO-Health (board #1), and live sessions there",
    );
    expect(
      describeScope(fed({ follow: "board", board: { ...board, backlog: ["Backlog"] } }), ctx),
    ).toBe("Issues on VO-Health's board #1, except Backlog, and live sessions there");
    expect(describeScope(fed({ extraRepositories: ["other/lib"] }), ctx)).toBe(
      "Issues assigned to me in VO-Health and other/lib, and live sessions there",
    );
    expect(describeScope(fed({ extraRepositories: ["other/lib", "other/app"], board }), ctx)).toBe(
      "Issues assigned to me in VO-Health and 2 other repositories (board #1), and live sessions there",
    );
    expect(describeScope(fed({ enabled: false }), ctx)).toBe(
      "Issues assigned to me in VO-Health, and live sessions there (sync paused: issues are not updated)",
    );
  });

  it("describes what a scope covers on Tasks", () => {
    expect(describeScope(fed(), ctx, "tasks")).toBe("Tasks in the repositories of VO-Health");
    expect(describeScope(fed({ extraRepositories: ["other/lib"] }), ctx, "tasks")).toBe(
      "Tasks in the repositories of VO-Health and other/lib",
    );
    expect(describeScope(scope({ mode: "pinned" }), ctx, "tasks")).toBe(
      "Tasks of sessions you pin",
    );
    expect(describeScope(scope(), ctx, "tasks")).toBe("Every task");
    expect(describeScope(scope({ projectIds: ["a"], hostIds: ["h1"] }), ctx, "tasks")).toBe(
      "Tasks in Alpha",
    );
  });

  it("describes pinned and filtered scopes", () => {
    expect(describeScope(scope({ mode: "pinned", sessionIds: ["s"] }), ctx)).toBe(
      "Only sessions you pin",
    );
    expect(describeScope(scope({ mode: "pinned" }), ctx)).toBe("Only sessions you pin");
  });

  it("describes filters", () => {
    expect(describeScope(scope(), ctx)).toBe("Every session");
    expect(describeScope(scope({ projectIds: ["a", "zz"] }), ctx)).toBe("Sessions in Alpha");
    expect(describeScope(scope({ hostIds: ["h1"] }), ctx)).toBe("Sessions on NUC");
    expect(describeScope(scope({ projectIds: ["a"], hostIds: ["h1", "h2"] }), ctx)).toBe(
      "Sessions in Alpha on NUC, Mac",
    );
    expect(describeScope(scope({ projectIds: ["a", "b", "c", "d", "e"] }), ctx)).toBe(
      "Sessions in Alpha, Beta, Gamma and 2 more",
    );
  });

  it("lists the clients a scope is shown in", () => {
    const now = Date.parse(T);
    const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
    const v = scope();
    const client = (over: Partial<Client>): Client => ({
      id: "herdr:vo@mac",
      kind: "herdr",
      name: "vo",
      machine: "mac",
      deviceId: "dev_1",
      hostId: null,
      mirror: "scope",
      scopeId: v.id,
      lastSeenAt: at(1),
      createdAt: at(30),
      ...over,
    });
    expect(shownIn(v, [], {}, now)).toBeNull();
    expect(shownIn(v, [client({ lastSeenAt: at(11) })], {}, now)).toBeNull();
    expect(shownIn(v, [client({ scopeId: "viw_other" })], {}, now)).toBeNull();
    expect(shownIn(v, [client({ mirror: "all" })], {}, now)).toBeNull();
    expect(
      shownIn(
        v,
        [
          client({
            id: "tmux:main@nuc",
            kind: "tmux",
            name: "main",
            machine: "nuc",
            hostId: "h1",
          }),
          client({ lastSeenAt: at(2) }),
        ],
        { h1: { name: "NUC" } },
        now,
      ),
    ).toBe("herdr vo on mac, tmux main on NUC");
  });

  it("says what a client mirrors", () => {
    const scopes = { viw_1: { name: "work" } };
    expect(mirrorLabel({ mirror: "all", scopeId: null }, scopes)).toBe("everything");
    expect(mirrorLabel({ mirror: "scope", scopeId: "viw_1" }, scopes)).toBe("scope work");
    expect(mirrorLabel({ mirror: "scope", scopeId: "viw_gone" }, scopes)).toBe("scope (deleted)");
    expect(mirrorLabel({ mirror: "none", scopeId: null }, scopes)).toBe("nothing");
  });

  it("explains an empty scope", () => {
    const opts = { filter: "all" as const, source: "Every session", origin: "dev.example" };
    expect(emptyScopeState(scope(), { ...opts, filter: "attention" }).title).toBe(
      "Nothing needs your input in work",
    );
    expect(emptyScopeState(scope(), { ...opts, filter: "active" }).title).toBe(
      "No active sessions in work",
    );
    expect(emptyScopeState(scope(), opts).title).toBe("No sessions in work");
    expect(emptyScopeState(scope({ mode: "pinned" }), opts).description).toBe(
      "This scope holds only sessions you pin. Pin one from its menu: Pin to work.",
    );
    expect(emptyScopeState(scope(), opts).description).toBe("This scope contains: Every session.");
    expect(emptyScopeState(fed({}, "vo"), opts).description).toBe(
      "This scope shows sessions on vo's issues and live sessions in its repositories. Issues that are not started are on the Board.",
    );
  });
});
