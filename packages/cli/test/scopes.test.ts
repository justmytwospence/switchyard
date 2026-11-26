// @module-tag slow
import { describe, expect, it } from "vitest";
import {
  scopesCreate,
  scopesEdit,
  scopesList,
  scopesSync,
  sourceText,
} from "../src/commands/scopes.js";
import { main } from "../src/main.js";
import { stubFetch, testCtx } from "./helpers.js";

const conn = { coordinator: "http://coord", credential: "cred" };
const T = "2026-11-02T10:00:00.000Z";
const HOST = {
  id: "hst_1",
  name: "Mac",
  platform: "darwin",
  agentVersion: "0.15.0",
  piVersion: "1.5.0",
  piCompatible: true,
  capabilities: null,
  connectivity: "connected",
  lastSeenAt: T,
  revokedAt: null,
  createdAt: T,
};
const SOURCE = {
  kind: "github",
  hostId: "hst_1",
  owner: "VO-Health",
  repositories: null,
  board: { projectNumber: 3, statusField: "Status", onStart: "Doing", onReview: null },
  writeBack: true,
  moveShared: true,
  enabled: true,
  login: "me",
  lastSyncedAt: T,
  lastError: null,
};
const base = {
  mode: "all",
  projectIds: null,
  hostIds: null,
  sessionIds: [],
  createdAt: T,
  updatedAt: T,
};
/** A GitHub scope. */
const VO = { ...base, id: "trk_1", name: "vo", projectIds: [], source: SOURCE };
/** A scope of sessions you pin. */
const DAILY = { ...base, id: "viw_1", name: "daily", mode: "pinned", source: null };

function setup(scopes: unknown[] = [VO, DAILY]) {
  return stubFetch({
    "GET /api/hosts": () => [HOST],
    "GET /api/projects": () => [],
    "GET /api/clients": () => [],
    "GET /api/scopes": () => scopes,
    "POST /api/scopes": (c) => {
      const body = c.body as { name: string; source?: object };
      return {
        status: 201,
        body: { ...DAILY, ...body, id: body.source ? "trk_1" : "viw_1" },
      };
    },
    "PATCH /api/scopes/trk_1": (c) => ({ ...VO, ...(c.body as object) }),
    "PATCH /api/scopes/viw_1": (c) => ({ ...DAILY, ...(c.body as object) }),
    "DELETE /api/scopes/viw_1": () => ({ ok: true, id: "viw_1" }),
    "POST /api/scopes/trk_1/sync": () => VO,
    "GET /api/issues": () => [
      { id: "trk_1:I_1", scopeId: "trk_1" },
      { id: "trk_2:I_2", scopeId: "trk_2" },
    ],
  });
}
const posted = (calls: { method: string; body: unknown }[]) =>
  calls.filter((c) => c.method === "POST").at(-1)!.body;
const patched = (calls: { method: string; body: unknown }[]) =>
  calls.filter((c) => c.method === "PATCH").at(-1)!.body;

describe("scopes create", () => {
  it("posts the name and mode", async () => {
    const { fetch, calls } = setup();
    const ctx = testCtx(fetch);
    await scopesCreate(ctx, "work", { ...conn, mode: "pinned" });
    expect(posted(calls)).toEqual({ name: "work", mode: "pinned" });
    expect(ctx.lines).toEqual(["Created scope work (viw_1)"]);
  });

  it("create with --owner posts a source", async () => {
    const { fetch, calls } = setup();
    const ctx = testCtx(fetch);
    await scopesCreate(ctx, "vo", {
      ...conn,
      githubHost: "mac",
      owner: "VO-Health",
      board: "3",
      onStart: "Doing",
      writeBack: true,
      moveShared: false,
    });
    expect(posted(calls)).toEqual({
      name: "vo",
      source: {
        hostId: "hst_1",
        owner: "VO-Health",
        board: { projectNumber: 3, onStart: "Doing" },
        writeBack: true,
        moveShared: false,
      },
    });
    expect(ctx.lines).toEqual(["Created scope vo (trk_1)"]);
  });

  it("GitHub options need --owner and --github-host, and board options need --board", async () => {
    const { fetch } = setup();
    const ctx = testCtx(fetch);
    await expect(scopesCreate(ctx, "x", { ...conn, githubHost: "Mac" })).rejects.toThrow(
      "GitHub options need --owner",
    );
    await expect(scopesCreate(ctx, "x", { ...conn, board: "3" })).rejects.toThrow(
      "GitHub options need --owner",
    );
    await expect(scopesCreate(ctx, "x", { ...conn, owner: "acme" })).rejects.toThrow(
      "--github-host is required with --owner",
    );
    await expect(
      scopesCreate(ctx, "x", { ...conn, githubHost: "Mac", owner: "acme", onStart: "Doing" }),
    ).rejects.toThrow("need --board");
    await expect(
      scopesCreate(ctx, "x", { ...conn, githubHost: "Mac", owner: "acme", project: ["Alpha"] }),
    ).rejects.toThrow("--project cannot be combined with --owner");
  });

  it("follows a board with backlog columns and a priority field", async () => {
    const { fetch, calls } = setup();
    const ctx = testCtx(fetch);
    const gh = { ...conn, githubHost: "Mac", owner: "me" };
    await scopesCreate(ctx, "me", { ...gh, board: "4", follow: "board", backlog: ["Backlog"] });
    expect(posted(calls)).toMatchObject({
      source: { follow: "board", board: { projectNumber: 4, backlog: ["Backlog"] } },
    });
    await expect(scopesCreate(ctx, "x", { ...gh, follow: "board" })).rejects.toThrow(
      "--follow board needs --board",
    );
    await expect(scopesCreate(ctx, "x", { ...gh, board: "4", follow: "nope" })).rejects.toThrow(
      "--follow must be assigned or board",
    );
    await scopesCreate(ctx, "p", { ...gh, board: "4", priorityField: "Priority" });
    expect(posted(calls)).toMatchObject({
      source: { board: { projectNumber: 4, priorityField: "Priority" } },
    });
    await scopesCreate(ctx, "fg", { ...gh, also: ["vcomedia/uplft"] });
    expect(posted(calls)).toMatchObject({ source: { extraRepositories: ["vcomedia/uplft"] } });
  });
});

describe("scopes edit", () => {
  it("edits a scope's own fields", async () => {
    const { fetch, calls } = setup();
    const ctx = testCtx(fetch);
    await scopesEdit(ctx, "daily", { ...conn, name: "Daily", mode: "all", anyProject: true });
    expect(patched(calls)).toEqual({ name: "Daily", mode: "all", projectIds: null });
    expect(ctx.lines).toEqual(["Updated scope Daily"]);
    await expect(scopesEdit(ctx, "nope", conn)).rejects.toThrow(
      'Unknown scope "nope". Scopes: vo, daily',
    );
  });

  it("edits a GitHub source", async () => {
    const { fetch, calls } = setup();
    const ctx = testCtx(fetch);
    await scopesEdit(ctx, "VO", { ...conn, onReview: "Review", allRepos: true, disable: true });
    expect(patched(calls)).toEqual({
      source: {
        repositories: null,
        board: { projectNumber: 3, statusField: "Status", onStart: "Doing", onReview: "Review" },
        enabled: false,
      },
    });
    await scopesEdit(ctx, "vo", { ...conn, noBoard: true, writeBack: false });
    expect(patched(calls)).toEqual({
      source: { board: null, follow: "assigned", writeBack: false },
    });
    await scopesEdit(ctx, "vo", { ...conn, noBacklog: true });
    expect(patched(calls)).toEqual({
      source: {
        board: {
          projectNumber: 3,
          statusField: "Status",
          onStart: "Doing",
          onReview: null,
          backlog: [],
        },
      },
    });
    await scopesEdit(ctx, "vo", { ...conn, noPriorityField: true });
    expect(patched(calls)).toMatchObject({ source: { board: { priorityField: null } } });
    await scopesEdit(ctx, "vo", { ...conn, noAlso: true });
    expect(patched(calls)).toEqual({ source: { extraRepositories: [] } });
    await expect(scopesEdit(ctx, "vo", { ...conn, noBoard: true, board: "2" })).rejects.toThrow(
      "--no-board",
    );
    await expect(
      scopesEdit(ctx, "vo", { ...conn, noBacklog: true, backlog: ["a"] }),
    ).rejects.toThrow("--no-backlog cannot be combined with --backlog");
    await expect(scopesEdit(ctx, "vo", { ...conn, noAlso: true, also: ["a/b"] })).rejects.toThrow(
      "--no-also cannot be combined with --also",
    );
  });

  it("edit --no-github sends source null", async () => {
    const { fetch, calls } = setup();
    const ctx = testCtx(fetch);
    await scopesEdit(ctx, "vo", { ...conn, noGithub: true });
    expect(patched(calls)).toEqual({ source: null });
    await expect(scopesEdit(ctx, "vo", { ...conn, noGithub: true, owner: "acme" })).rejects.toThrow(
      "--no-github cannot be combined with GitHub options",
    );
  });

  it("adds a source to a scope without one only with --owner and --github-host", async () => {
    const { fetch, calls } = setup();
    const ctx = testCtx(fetch);
    await expect(scopesEdit(ctx, "daily", { ...conn, board: "3" })).rejects.toThrow(
      "GitHub options need --owner",
    );
    await scopesEdit(ctx, "daily", { ...conn, githubHost: "Mac", owner: "acme" });
    expect(patched(calls)).toEqual({ source: { hostId: "hst_1", owner: "acme" } });
  });
});

describe("scopes list and sync", () => {
  it("lists each scope with its source, and the clients mirroring it", async () => {
    const seen = new Date().toISOString();
    const { fetch } = stubFetch({
      "GET /api/scopes": () => [VO, DAILY],
      "GET /api/projects": () => [],
      "GET /api/clients": () => [
        {
          id: "herdr:default@mac",
          kind: "herdr",
          name: "default",
          machine: "mac",
          deviceId: "dev_1",
          hostId: null,
          mirror: "scope",
          scopeId: "viw_1",
          lastSeenAt: seen,
          createdAt: seen,
        },
      ],
    });
    const ctx = testCtx(fetch);
    await scopesList(ctx, conn);
    expect(ctx.lines[0]).toMatch(
      /^NAME\s+SOURCE\s+MODE\s+PROJECTS\s+PINNED\s+MIRRORED IN\s+LAST SYNC\s+ERROR$/,
    );
    expect(ctx.lines[1]).toMatch(/^vo\s+GitHub VO-Health board #3\s+all\s+-\s+0\s+-\s+2026-11-02/);
    expect(ctx.lines[2]).toMatch(/^daily\s+-\s+pinned\s+any\s+0\s+herdr default \(mac\)\s+-\s+-$/);
  });

  it("describes a source", () => {
    expect(sourceText(null)).toBe("-");
    expect(sourceText({ ...SOURCE, board: null } as never)).toBe("GitHub VO-Health");
    expect(sourceText({ ...SOURCE, follow: "board", enabled: false } as never)).toBe(
      "GitHub VO-Health board #3 (whole board) (paused)",
    );
  });

  it("syncs and counts the scope's issues", async () => {
    const { fetch } = setup();
    const ctx = testCtx(fetch);
    await scopesSync(ctx, "vo", conn);
    expect(ctx.lines.at(-1)).toBe("Synced vo: 1 issue");
  });
});

describe("the old command names", () => {
  const run = (ctx: ReturnType<typeof testCtx>, ...args: string[]) =>
    main(["node", "switchyard", ...args, "--coordinator", "http://c", "--credential", "t"], ctx);

  it("the trackers alias passes --host as the GitHub host and turns delete into removing the source", async () => {
    const { fetch, calls } = setup();
    const ctx = testCtx(fetch);
    expect(
      await run(ctx, "trackers", "create", "vo", "--host", "Mac", "--owner", "VO-Health"),
    ).toBe(0);
    expect(posted(calls)).toEqual({
      name: "vo",
      source: { hostId: "hst_1", owner: "VO-Health" },
    });
    expect(ctx.errors).toEqual([
      '"switchyard trackers" is now "switchyard scopes"; the old name will be removed',
    ]);
    expect(await run(ctx, "trackers", "edit", "vo", "--host", "Mac", "--no-write-back")).toBe(0);
    expect(patched(calls)).toEqual({ source: { hostId: "hst_1", writeBack: false } });
    expect(await run(ctx, "trackers", "delete", "vo")).toBe(0);
    expect(patched(calls)).toEqual({ source: null });
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(ctx.lines.at(-1)).toBe(
      'Removed the GitHub source of scope vo; "switchyard scopes delete" deletes the scope',
    );
    await run(ctx, "trackers", "list");
    expect(ctx.lines.filter((l) => /^(vo|daily)\s/.test(l))).toHaveLength(1);
  });

  it("the views alias works on scopes, with --host as a host limit", async () => {
    const { fetch, calls } = setup();
    const ctx = testCtx(fetch);
    expect(await run(ctx, "views", "create", "work", "--host", "Mac")).toBe(0);
    expect(posted(calls)).toEqual({ name: "work", hostIds: ["hst_1"] });
    expect(ctx.errors).toEqual([
      '"switchyard views" is now "switchyard scopes"; the old name will be removed',
    ]);
    expect(await run(ctx, "views", "delete", "daily")).toBe(0);
    expect(calls.at(-1)).toMatchObject({ method: "DELETE", path: "/api/scopes/viw_1" });
  });

  it("scopes create takes --github-host, and --host stays a host limit", async () => {
    const { fetch, calls } = setup();
    const ctx = testCtx(fetch);
    expect(
      await run(ctx, "scopes", "create", "vo", "--github-host", "Mac", "--owner", "VO-Health"),
    ).toBe(0);
    expect(posted(calls)).toEqual({
      name: "vo",
      source: { hostId: "hst_1", owner: "VO-Health" },
    });
    expect(await run(ctx, "scopes", "create", "plain")).toBe(0);
    expect(posted(calls)).toEqual({ name: "plain" });
    expect(await run(ctx, "scopes", "edit", "vo", "--no-github")).toBe(0);
    expect(patched(calls)).toEqual({ source: null });
    expect(ctx.errors).toEqual([]);
  });
});
