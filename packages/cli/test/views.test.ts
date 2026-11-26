import { describe, expect, it } from "vitest";
import { viewsCreate, viewsList } from "../src/commands/views.js";
import { stubFetch, testCtx } from "./helpers.js";

const conn = { coordinator: "http://coord", credential: "cred" };
const T = "2026-11-02T10:00:00.000Z";
const VIEW = {
  id: "viw_1",
  name: "daily",
  mode: "pinned",
  projectIds: null,
  hostIds: null,
  sessionIds: [],
  clients: [],
  createdAt: T,
  updatedAt: T,
};

describe("views create", () => {
  it("posts the name and mode", async () => {
    const { fetch, calls } = stubFetch({
      "POST /api/views": (c) => ({ status: 201, body: { ...VIEW, ...(c.body as object) } }),
    });
    const ctx = testCtx(fetch);
    await viewsCreate(ctx, "work", { ...conn, mode: "pinned" });
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({
      name: "work",
      mode: "pinned",
    });
  });
});

describe("views list", () => {
  it("shows the surfaces a view is open in", async () => {
    const seen = new Date().toISOString();
    const { fetch } = stubFetch({
      "GET /api/views": () => [VIEW],
      "GET /api/projects": () => [],
      "GET /api/hosts": () => [],
      "GET /api/surfaces": () => [
        {
          id: "herdr:default@mac",
          kind: "herdr",
          name: "default",
          machine: "mac",
          deviceId: "dev_1",
          hostId: null,
          viewId: "viw_1",
          lastSeenAt: seen,
          createdAt: seen,
        },
      ],
    });
    const ctx = testCtx(fetch);
    await viewsList(ctx, conn);
    expect(ctx.lines[0]).not.toContain("SOURCE");
    expect(ctx.lines[1]).toContain("herdr default (mac)");
  });
});
