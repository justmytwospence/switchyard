import { ApiClient } from "@switchyard/terminal";
import { describe, expect, it } from "vitest";
import {
  hostsFolders,
  hostsList,
  hostsScan,
  resolveHost,
  scanLine,
} from "../src/commands/hosts.js";
import { stubFetch, testCtx } from "./helpers.js";

const conn = { coordinator: "http://coord", credential: "cred" };
const T = "2026-11-02T10:00:00.000Z";

function host(id: string, name: string, over: Record<string, unknown> = {}) {
  return {
    id,
    name,
    platform: "linux",
    agentVersion: "0.4.0",
    piVersion: "1.4.0",
    piCompatible: true,
    capabilities: null,
    connectivity: "connected",
    lastSeenAt: T,
    revokedAt: null,
    createdAt: T,
    ...over,
  };
}

const NUC = host("hst_1", "NUC", { projectFolders: ["/srv"] });
const MAC = host("hst_2", "MacBook-Pro");

describe("resolveHost", () => {
  it("matches ids and unique names, and explains failures", async () => {
    const { fetch } = stubFetch({
      "GET /api/hosts": () => [
        NUC,
        MAC,
        host("hst_3", "Twin"),
        host("hst_4", "twin"),
        host("hst_5", "Gone", { revokedAt: T }),
      ],
    });
    const api = new ApiClient({ coordinatorUrl: "http://coord", credential: "c", fetch });
    expect((await resolveHost(api, "hst_2")).name).toBe("MacBook-Pro");
    expect((await resolveHost(api, "nuc")).id).toBe("hst_1");
    await expect(resolveHost(api, "TWIN")).rejects.toThrow(/Several hosts/);
    await expect(resolveHost(api, "Gone")).rejects.toThrow(/Unknown host "Gone"/);
  });
});

describe("hosts commands", () => {
  it("lists hosts with their folders", async () => {
    const { fetch } = stubFetch({ "GET /api/hosts": () => [NUC, MAC] });
    const ctx = testCtx(fetch);
    await hostsList(ctx, conn);
    expect(ctx.lines[0]).toMatch(/^ID\s+NAME\s+STATUS\s+AGENT\s+PROJECT FOLDERS$/);
    expect(ctx.lines[1]).toMatch(/hst_1\s+NUC\s+connected\s+0\.4\.0\s+\/srv$/);
    expect(ctx.lines[2]).toMatch(/MacBook-Pro.*-$/);
  });

  it("adds a folder with PATCH", async () => {
    const { fetch, calls } = stubFetch({
      "GET /api/hosts": () => [NUC],
      "PATCH /api/hosts/hst_1": (c) => ({ ...NUC, ...(c.body as object) }),
    });
    const ctx = testCtx(fetch);
    await hostsFolders(ctx, "NUC", { ...conn, add: ["~/Projects", "/srv"] });
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({
      projectFolders: ["/srv", "~/Projects"],
    });
    expect(ctx.lines[0]).toBe("Project folders on NUC: /srv, ~/Projects");
    expect(ctx.lines[1]).toMatch(/Scanning in the background/);
  });

  it("refuses conflicting flags and unknown folders", async () => {
    const { fetch } = stubFetch({ "GET /api/hosts": () => [NUC] });
    const ctx = testCtx(fetch);
    await expect(hostsFolders(ctx, "NUC", { ...conn, set: ["/a"], add: ["/b"] })).rejects.toThrow(
      /on its own/,
    );
    await expect(hostsFolders(ctx, "NUC", { ...conn, remove: ["/nope"] })).rejects.toThrow(
      /not a project folder of NUC/,
    );
  });

  it("shows folders and the last scan", async () => {
    const scan = {
      state: "done",
      startedAt: T,
      finishedAt: T,
      repositories: 3,
      projectsCreated: 1,
      checkoutsAdded: 2,
      errors: ["/x: missing"],
    };
    const { fetch } = stubFetch({ "GET /api/hosts": () => [{ ...NUC, projectScan: scan }] });
    const ctx = testCtx(fetch);
    await hostsFolders(ctx, "NUC", conn);
    expect(ctx.lines[0]).toBe("/srv");
    expect(ctx.lines[1]).toMatch(
      /^Last scanned .*: 3 repositories, 2 new checkouts, 1 new projects\.$/,
    );
    expect(ctx.lines[2]).toBe("! /x: missing");
    expect(scanLine(null)).toEqual(["Not scanned yet."]);
    expect(scanLine({ ...scan, state: "failed" } as never)[0]).toMatch(/failed .*: \/x: missing/);
  });

  it("scans and prints what was added", async () => {
    const { fetch } = stubFetch({
      "GET /api/hosts": () => [NUC],
      "POST /api/hosts/hst_1/scan-projects": () => ({
        state: "done",
        startedAt: T,
        finishedAt: T,
        repositories: 2,
        projectsCreated: 1,
        checkoutsAdded: 2,
        errors: ["/y: nope"],
        added: [
          { projectId: "p1", name: "app", path: "/srv/app", newProject: true },
          { projectId: "p2", name: "lib", path: "/srv/lib", newProject: false },
        ],
      }),
    });
    const ctx = testCtx(fetch);
    await hostsScan(ctx, "NUC", conn);
    expect(ctx.lines).toEqual([
      "Scanned NUC: 2 repositories, 2 new checkouts, 1 new projects",
      "+ app  /srv/app (new project)",
      "+ lib  /srv/lib",
      "! /y: nope",
    ]);
  });
});
