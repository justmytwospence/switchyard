import type { HostCommand } from "@switchyard/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commandsOf, type Harness, ROOT, setupHarness } from "./task-helpers.js";

const LOG = {
  base: "main",
  scope: "recent",
  commits: [
    {
      sha: "a".repeat(40),
      subject: "feat: one",
      author: "Me",
      authoredAt: "2026-11-17T10:00:00Z",
      pushed: false,
    },
  ],
  truncated: false,
  uncommitted: 0,
};
const DIFF = { base: "main", files: [], patch: "" };

let h: Harness;
let wsId: string;
beforeEach(async () => {
  h = await setupHarness();
  h.override = (cmd: HostCommand) =>
    cmd.type === "workspace.log" ? LOG : cmd.type === "workspace.diff" ? DIFF : undefined;
  expect((await h.t.admin("POST", `/api/projects/${h.project.id}/refresh`)).status).toBe(200);
  wsId = h.t.c.store.workspaceByPath(h.creds.hostId, ROOT)!.id;
});
afterEach(async () => {
  await h.t.cleanup();
});

describe("workspace commits", () => {
  it("lists commits through the host", async () => {
    const r = await h.t.admin("GET", `/api/workspaces/${wsId}/commits`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual(LOG);
    expect(commandsOf(h.host, "workspace.log").at(-1)).toMatchObject({ path: ROOT, limit: 50 });
    expect((await h.t.admin("GET", `/api/workspaces/${wsId}/commits?limit=5`)).status).toBe(200);
    expect(commandsOf(h.host, "workspace.log").at(-1)).toMatchObject({ limit: 5 });
    expect((await h.t.admin("GET", `/api/workspaces/${wsId}/commits?limit=500`)).status).toBe(400);
  });

  it("narrows the diff with rev", async () => {
    expect((await h.t.admin("GET", `/api/workspaces/${wsId}/diff?rev=uncommitted`)).status).toBe(
      200,
    );
    expect(commandsOf(h.host, "workspace.diff").at(-1)).toMatchObject({ rev: "uncommitted" });
    expect((await h.t.admin("GET", `/api/workspaces/${wsId}/diff`)).status).toBe(200);
    expect(commandsOf(h.host, "workspace.diff").at(-1)).not.toHaveProperty("rev");
    expect((await h.t.admin("GET", `/api/workspaces/${wsId}/diff?rev=nope`)).status).toBe(400);
  });

  it("refuses commits on a host without the feature, but still diffs", async () => {
    await h.host.close();
    await h.host.open({ features: ["agentRequests.v1", "policies.v1", "trackers.v1"] });
    const log = await h.t.admin("GET", `/api/workspaces/${wsId}/commits`);
    expect(log.body.error?.code ?? log.body.code).toBe("unsupported_capability");
    const narrowed = await h.t.admin("GET", `/api/workspaces/${wsId}/diff?rev=uncommitted`);
    expect(narrowed.body.error?.code ?? narrowed.body.code).toBe("unsupported_capability");
    expect((await h.t.admin("GET", `/api/workspaces/${wsId}/diff`)).status).toBe(200);
  });
});
