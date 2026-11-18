import { ApiClient } from "@switchyard/terminal";
import { describe, expect, it } from "vitest";
import { startPresence } from "../src/mirror/presence.js";
import { stubFetch } from "./helpers.js";

const surface = {
  id: "herdr:default@mac",
  kind: "herdr" as const,
  name: "default",
  machine: "mac",
  hostId: "hst_1",
};
const tick = () => new Promise((r) => setTimeout(r, 10));

describe("surface presence", () => {
  it("reports to /api/surfaces and withdraws", async () => {
    const { fetch, calls } = stubFetch({
      "PUT /api/surfaces/herdr%3Adefault%40mac": () => ({}),
      "DELETE /api/surfaces/herdr%3Adefault%40mac": () => ({ ok: true }),
    });
    const api = new ApiClient({ coordinatorUrl: "http://coord", credential: "c", fetch });
    const p = startPresence(api, surface, "viw_1", () => {});
    await tick();
    expect(calls[0]).toMatchObject({
      method: "PUT",
      body: { kind: "herdr", name: "default", machine: "mac", viewId: "viw_1", hostId: "hst_1" },
    });
    await p.stop();
    expect(calls.at(-1)!.method).toBe("DELETE");
  });

  it("falls back to the legacy endpoint on an older coordinator", async () => {
    const { fetch, calls } = stubFetch({
      "POST /api/views/viw_1/clients": () => ({}),
      "DELETE /api/views/viw_1/clients/herdr%3Adefault%40mac": () => ({}),
    });
    const api = new ApiClient({ coordinatorUrl: "http://coord", credential: "c", fetch });
    const p = startPresence(api, surface, "viw_1", () => {});
    await tick();
    expect(calls.map((c) => c.method)).toEqual(["PUT", "POST"]);
    expect(calls[1]!.body).toEqual({
      id: surface.id,
      kind: "herdr",
      name: "default",
      machine: "mac",
    });
    await p.stop();
    expect(calls.at(-1)).toMatchObject({
      method: "DELETE",
      path: "/api/views/viw_1/clients/herdr%3Adefault%40mac",
    });
  });
});
