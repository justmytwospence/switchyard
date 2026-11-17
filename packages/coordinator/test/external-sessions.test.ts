import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostSession, until } from "./helpers.js";
import { type Harness, ROOT, setupHarness } from "./task-helpers.js";

let h: Harness;
beforeEach(async () => {
  h = await setupHarness();
  // Discover the main checkout as a workspace.
  expect((await h.t.admin("POST", `/api/projects/${h.project.id}/refresh`)).status).toBe(200);
});
afterEach(async () => {
  await h.t.cleanup();
});

describe("sessions a host announces from your terminal", () => {
  it("map to the workspace containing their cwd and are pinned to their client's view", async () => {
    const client = "herdr:daily@mac";
    const view = await h.t.admin("POST", "/api/views", {
      name: "daily",
      mode: "pinned",
      clientId: client,
    });
    expect(view.status).toBe(201);
    const other = await h.t.admin("POST", "/api/views", { name: "other", mode: "pinned" });
    await h.host.event(
      "session.updated",
      hostSession("ses_ext", {
        cwd: `${ROOT}/packages/app`,
        workspaceId: null,
        projectId: null,
        external: { client },
        terminal: false,
      }),
    );
    await until(() => h.t.c.store.sessions.get("ses_ext") !== undefined);
    const s = h.t.c.store.sessions.require("ses_ext");
    const ws = h.t.c.store.workspaceByPath(h.creds.hostId, ROOT)!;
    expect(s).toMatchObject({ workspaceId: ws.id, projectId: h.project.id, external: { client } });
    await until(() => h.t.c.store.views.require(view.body.id).sessionIds.includes("ses_ext"));
    expect(h.t.c.store.views.require(other.body.id).sessionIds).toEqual([]);
  });

  it("leave a cwd outside every workspace without a project", async () => {
    await h.host.event(
      "session.updated",
      hostSession("ses_loose", { cwd: "/elsewhere", workspaceId: null, projectId: null }),
    );
    await until(() => h.t.c.store.sessions.get("ses_loose") !== undefined);
    expect(h.t.c.store.sessions.require("ses_loose")).toMatchObject({
      workspaceId: null,
      projectId: null,
    });
  });
});
