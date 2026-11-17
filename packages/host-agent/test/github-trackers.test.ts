import { describe, expect, it, vi } from "vitest";
import { type Gh, trackerSearch, trackerSetStatus, trackerSync } from "../src/github-trackers.js";

const REPO = "acme/app";

function issue(n: number, over: Record<string, unknown> = {}) {
  return {
    id: `I_${n}`,
    number: n,
    title: `Issue ${n}`,
    url: `https://github.com/${REPO}/issues/${n}`,
    repository: { nameWithOwner: REPO },
    assignees: { nodes: [{ login: "me" }] },
    linkedBranches: { nodes: [] },
    closedByPullRequestsReferences: { nodes: [] },
    ...over,
  };
}

function page(nodes: unknown[], hasNextPage = false, endCursor = "c") {
  return {
    data: { viewer: { login: "me" }, search: { pageInfo: { hasNextPage, endCursor }, nodes } },
  };
}

const vars = (args: string[]) =>
  Object.fromEntries(
    args
      .map((a, i) => (args[i - 1] === "-f" ? a : null))
      .filter((a): a is string => a !== null)
      .map((a) => [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]),
  );

describe("trackerSearch", () => {
  it("scopes to the owner or the listed repositories", () => {
    expect(trackerSearch({ owner: "acme", repositories: null })).toBe(
      "user:acme is:issue is:open assignee:@me",
    );
    expect(trackerSearch({ owner: "acme", repositories: ["acme/a", "acme/b"] })).toBe(
      "repo:acme/a repo:acme/b is:issue is:open assignee:@me",
    );
  });
});

describe("trackerSync", () => {
  const req = { owner: "acme", repositories: null, board: null };

  it("maps issues, preferring linked branches, then open closing PR heads in the same repo", async () => {
    const gh: Gh = vi.fn(async () =>
      page([
        issue(1, {
          linkedBranches: {
            nodes: [
              { ref: { name: "1-linked", repository: { nameWithOwner: REPO } } },
              { ref: { name: "elsewhere", repository: { nameWithOwner: "fork/app" } } },
            ],
          },
          closedByPullRequestsReferences: {
            nodes: [
              {
                number: 9,
                state: "MERGED",
                url: `https://github.com/${REPO}/pull/9`,
                headRefName: "old",
                headRepository: { nameWithOwner: REPO },
              },
              {
                number: 10,
                state: "OPEN",
                url: `https://github.com/${REPO}/pull/10`,
                headRefName: "feat/x",
                headRepository: { nameWithOwner: REPO },
              },
              {
                number: 11,
                state: "OPEN",
                url: `https://github.com/${REPO}/pull/11`,
                headRefName: "fork-branch",
                headRepository: { nameWithOwner: "fork/app" },
              },
            ],
          },
        }),
        { notAnIssue: true },
        issue(2, {
          closedByPullRequestsReferences: {
            nodes: [
              {
                number: 12,
                state: "MERGED",
                url: `https://github.com/${REPO}/pull/12`,
                headRefName: "done",
                headRepository: { nameWithOwner: REPO },
              },
            ],
          },
        }),
      ]),
    );
    const r = await trackerSync(gh, req);
    expect(r.login).toBe("me");
    expect(r.truncated).toBe(false);
    expect(r.items).toHaveLength(2);
    expect(r.items[0]).toMatchObject({
      itemId: "I_1",
      repository: REPO,
      number: 1,
      branches: ["1-linked", "feat/x"],
      pullRequest: { number: 10, state: "OPEN", headRefName: "feat/x" },
      board: null,
      assignees: ["me"],
    });
    expect(r.items[1]).toMatchObject({
      branches: [],
      pullRequest: { number: 12, state: "MERGED" },
    });
    const args = (gh as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string[];
    expect(args.slice(0, 4)).toEqual(["api", "--hostname", "github.com", "graphql"]);
    expect(vars(args).q).toBe("user:acme is:issue is:open assignee:@me");
    expect(vars(args).query).not.toContain("projectItems");
  });

  it("follows pages and stops after four", async () => {
    let n = 0;
    const gh: Gh = vi.fn(async () => page([issue(++n)], true, `c${n}`));
    const r = await trackerSync(gh, req);
    expect(gh).toHaveBeenCalledTimes(4);
    expect(r.items).toHaveLength(4);
    expect(r.truncated).toBe(true);
    const calls = (gh as ReturnType<typeof vi.fn>).mock.calls.map((c) => vars(c[0] as string[]));
    expect(calls[0]!.cursor).toBeUndefined();
    expect(calls[1]!.cursor).toBe("c1");
  });

  it("throws on GraphQL errors", async () => {
    const gh: Gh = async () => ({ errors: [{ message: "INSUFFICIENT_SCOPES" }] });
    await expect(trackerSync(gh, req)).rejects.toThrow("INSUFFICIENT_SCOPES");
  });

  it("reads the board column of the configured project", async () => {
    const projectItems = {
      nodes: [
        {
          id: "PVTI_other",
          project: { id: "P_other", number: 2, owner: { login: "acme" }, field: { id: "F2" } },
          fieldValueByName: { name: "Done", optionId: "o9" },
        },
        {
          id: "PVTI_1",
          project: {
            id: "P_1",
            number: 5,
            owner: { login: "ACME" },
            field: {
              id: "F1",
              options: [
                { id: "o1", name: "Todo" },
                { id: "o2", name: "In progress" },
              ],
            },
          },
          fieldValueByName: { name: "Todo", optionId: "o1" },
        },
      ],
    };
    const gh: Gh = vi.fn(async () =>
      page([
        issue(1, { projectItems }),
        issue(2, {
          projectItems: { nodes: [{ ...projectItems.nodes[1], fieldValueByName: null }] },
        }),
      ]),
    );
    const r = await trackerSync(gh, {
      ...req,
      board: { projectNumber: 5, statusField: "Status" },
    });
    expect(r.items[0]!.board).toEqual({
      projectId: "P_1",
      projectItemId: "PVTI_1",
      fieldId: "F1",
      status: "Todo",
      statusOptionId: "o1",
      options: [
        { id: "o1", name: "Todo" },
        { id: "o2", name: "In progress" },
      ],
    });
    expect(r.items[1]!.board).toMatchObject({ status: null, statusOptionId: null });
    const args = (gh as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string[];
    expect(vars(args).statusField).toBe("Status");
    expect(vars(args).query).toContain("projectItems");
  });
});

describe("trackerSetStatus", () => {
  const req = {
    projectId: "P",
    projectItemId: "I",
    fieldId: "F",
    statusField: "Status",
    optionId: "o2",
    expectedOptionId: "o1",
    login: "me",
    allowShared: false,
  };
  const item = (assignees: string[], optionId: string | null) => ({
    data: {
      node: {
        content: { assignees: { nodes: assignees.map((login) => ({ login })) } },
        fieldValueByName: optionId ? { optionId } : null,
      },
    },
  });

  it.each([
    ["not_assigned", ["someone"], "o1", req],
    ["shared", ["me", "someone"], "o1", req],
    ["stale", ["me"], "o3", req],
  ] as const)("skips %s cards without the mutation", async (reason, assignees, optionId, r) => {
    const gh: Gh = vi.fn(async () => item([...assignees], optionId));
    expect(await trackerSetStatus(gh, r)).toEqual({ status: "skipped", reason });
    expect(gh).toHaveBeenCalledTimes(1);
  });

  it("moves an assigned card that is where it was last seen", async () => {
    const gh: Gh = vi.fn(async (args: string[]) =>
      vars(args).query!.startsWith("mutation") ? { data: {} } : item(["Me", "other"], "o1"),
    );
    expect(await trackerSetStatus(gh, { ...req, allowShared: true })).toEqual({ status: "moved" });
    const mutation = vars((gh as ReturnType<typeof vi.fn>).mock.calls[1]![0] as string[]);
    expect(mutation).toMatchObject({ project: "P", item: "I", field: "F", option: "o2" });
  });
});
