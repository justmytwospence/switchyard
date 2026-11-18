import { describe, expect, it } from "vitest";
import { clientRef, viewsCreate, viewsEdit, viewsList } from "../src/commands/views.js";
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

describe("views --client", () => {
  it("adds this machine to a client id without one", () => {
    expect(clientRef("herdr:default", "mac")).toBe("herdr:default@mac");
    expect(clientRef("herdr:vo@nuc", "mac")).toBe("herdr:vo@nuc");
    expect(() => clientRef("default", "mac")).toThrow("--client must look like");
  });

  it("creates and edits a view's client", async () => {
    const { fetch, calls } = stubFetch({
      "GET /api/views": () => [VIEW],
      "POST /api/views": (c) => ({ status: 201, body: { ...VIEW, ...(c.body as object) } }),
      "PATCH /api/views/viw_1": (c) => ({ ...VIEW, ...(c.body as object) }),
    });
    const ctx = testCtx(fetch);
    await viewsCreate(ctx, "daily", { ...conn, mode: "pinned", client: "herdr:default@mac" });
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({
      name: "daily",
      mode: "pinned",
      clientId: "herdr:default@mac",
    });
    await viewsEdit(ctx, "daily", { ...conn, noClient: true });
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ clientId: null });
  });
});

describe("views list", () => {
  it("shows the surfaces a view is open in", async () => {
    const seen = new Date().toISOString();
    const { fetch } = stubFetch({
      "GET /api/views": () => [{ ...VIEW, clientId: "herdr:default@mac" }],
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
    expect(ctx.lines[0]).toContain("SOURCE");
    expect(ctx.lines[1]).toContain("herdr default (mac)");
  });
});
