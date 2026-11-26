import type { GitHubSource, Scope } from "@switchyard/protocol";
import { describe, expect, it } from "vitest";
import {
  contentsOf,
  disconnects,
  type ScopeDraft,
  scopeBodyOf,
  scopeDraftOf,
  validateScopeDraft,
} from "../src/features/scopes/scopeFormLogic";

const T = "2026-11-02T10:00:00.000Z";
const source: GitHubSource = {
  kind: "github",
  hostId: "hst_1",
  owner: "acme",
  repositories: null,
  extraRepositories: [],
  board: null,
  follow: "assigned",
  writeBack: false,
  moveShared: true,
  worktrees: true,
  enabled: true,
  login: "me",
  lastSyncedAt: T,
  lastError: null,
};
const scope = (over: Partial<Scope> = {}): Scope => ({
  id: "scp_1",
  name: "work",
  mode: "all",
  projectIds: ["prj_a"],
  hostIds: null,
  sessionIds: [],
  source: null,
  createdAt: T,
  updatedAt: T,
  ...over,
});
const draft = (over: Partial<ScopeDraft> = {}): ScopeDraft => ({
  ...scopeDraftOf(null, "hst_1"),
  name: "work",
  ...over,
});
const github = (s: Scope) => scope({ ...s, source });

describe("scope form", () => {
  it("reads what a scope contains", () => {
    expect(contentsOf(null)).toBe("projects");
    expect(contentsOf(scope({ mode: "pinned" }))).toBe("pins");
    expect(contentsOf(github(scope()))).toBe("github");
    expect(contentsOf(github(scope({ mode: "pinned" })))).toBe("github");
  });

  it("builds the body of a new scope", () => {
    expect(scopeBodyOf(draft({ projectIds: ["a", "b"] }), null)).toEqual({
      name: "work",
      mode: "all",
      projectIds: ["a", "b"],
      hostIds: null,
    });
    expect(scopeBodyOf(draft(), null)).toMatchObject({ projectIds: null });
    expect(scopeBodyOf(draft({ contents: "pins" }), null)).toMatchObject({ mode: "pinned" });
    const d = draft({ contents: "github" });
    const body = scopeBodyOf({ ...d, github: { ...d.github, owner: "acme" } }, null);
    expect(body).toMatchObject({ mode: "all", source: { owner: "acme", hostId: "hst_1" } });
    expect("projectIds" in body).toBe(false);
  });

  it("disconnects a GitHub scope that is saved as another kind", () => {
    const s = github(scope());
    const d = scopeDraftOf(s, "h");
    expect(disconnects(d, s)).toBe(false);
    expect("projectIds" in scopeBodyOf(d, s)).toBe(false);
    const away = { ...d, contents: "projects" as const };
    expect(disconnects(away, s)).toBe(true);
    expect(scopeBodyOf(away, s)).toMatchObject({
      source: null,
      mode: "all",
      projectIds: ["prj_a"],
    });
  });

  it("connecting a pins scope makes it a scope of mode all", () => {
    const s = scope({ mode: "pinned", projectIds: null });
    const d = scopeDraftOf(s, "h");
    expect(d.contents).toBe("pins");
    const body = scopeBodyOf(
      { ...d, contents: "github", github: { ...d.github, owner: "acme" } },
      s,
    );
    expect(body.mode).toBe("all");
  });

  it("sends no source for a scope that has none", () => {
    const s = scope();
    expect("source" in scopeBodyOf(scopeDraftOf(s, "h"), s)).toBe(false);
  });

  it("validates the name always and the source only for GitHub", () => {
    for (const contents of ["projects", "pins", "github"] as const) {
      expect(validateScopeDraft(draft({ contents, name: " " })).name).toBe("Enter a name.");
    }
    expect(validateScopeDraft(draft({ contents: "projects" }))).toEqual({});
    expect(validateScopeDraft(draft({ contents: "github" })).owner).toBe(
      "Enter a GitHub organization or user name.",
    );
  });

  it("trims the name and uses it over the GitHub draft's", () => {
    const d = draft({ contents: "github", name: "  fresh  " });
    expect(
      scopeBodyOf({ ...d, github: { ...d.github, name: "old", owner: "acme" } }, null).name,
    ).toBe("fresh");
  });
});
