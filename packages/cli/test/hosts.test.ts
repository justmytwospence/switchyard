import { ApiClient } from "@switchyard/terminal";
import { describe, expect, it } from "vitest";
import {
  hostsFolders,
  hostsList,
  hostsLocation,
  hostsScan,
  resolveHost,
} from "../src/commands/hosts.js";
import { main } from "../src/main.js";
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
const NUC = host("hst_1", "NUC", { checkoutRoot: "/srv" });
const MAC = host("hst_2", "MacBook-Pro", { checkoutRoot: null });

describe("hosts commands", () => {
  it("wires location flags through the CLI", async () => {
    const { fetch, calls } = stubFetch({
      "GET /api/hosts": () => [NUC],
      "PATCH /api/hosts/hst_1": (c) => ({ ...NUC, ...(c.body as object) }),
    });
    const ctx = testCtx(fetch);
    expect(
      await main(
        [
          "node",
          "switchyard",
          "hosts",
          "location",
          "NUC",
          "--set",
          "~/Projects",
          "--coordinator",
          "http://coord",
          "--credential",
          "cred",
        ],
        ctx,
      ),
    ).toBe(0);
    expect(calls.at(-1)?.body).toEqual({ checkoutRoot: "~/Projects" });
  });
  it("resolves ids and unique names and ignores revoked hosts", async () => {
    const { fetch } = stubFetch({
      "GET /api/hosts": () => [
        NUC,
        MAC,
        host("3", "Twin"),
        host("4", "twin"),
        host("5", "Gone", { revokedAt: T }),
      ],
    });
    const api = new ApiClient({ coordinatorUrl: "http://coord", credential: "c", fetch });
    expect((await resolveHost(api, "hst_2")).name).toBe("MacBook-Pro");
    expect((await resolveHost(api, "nuc")).id).toBe("hst_1");
    await expect(resolveHost(api, "TWIN")).rejects.toThrow(/Several hosts/);
    await expect(resolveHost(api, "Gone")).rejects.toThrow(/Unknown host/);
  });
  it("lists locations and reads one as text or JSON", async () => {
    const { fetch } = stubFetch({ "GET /api/hosts": () => [NUC, MAC] });
    const ctx = testCtx(fetch);
    await hostsList(ctx, conn);
    expect(ctx.lines[0]).toMatch(/CHECKOUT LOCATION/);
    expect(ctx.lines[1]).toMatch(/\/srv$/);
    expect(ctx.lines[2]).toMatch(/-$/);
    await hostsLocation(ctx, "NUC", conn);
    expect(ctx.lines.at(-1)).toBe("Checkout location on NUC: /srv");
    await hostsLocation(ctx, "MacBook-Pro", { ...conn, json: true });
    expect(JSON.parse(ctx.lines.at(-1)!).checkoutRoot).toBeNull();
  });
  it("sets and clears the root without scanning", async () => {
    const { fetch, calls } = stubFetch({
      "GET /api/hosts": () => [NUC],
      "PATCH /api/hosts/hst_1": (c) => ({ ...NUC, ...(c.body as object) }),
    });
    const ctx = testCtx(fetch);
    await hostsLocation(ctx, "NUC", { ...conn, set: "~/Projects" });
    await hostsLocation(ctx, "NUC", { ...conn, clear: true, json: true });
    expect(calls.filter((c) => c.method === "PATCH").map((c) => c.body)).toEqual([
      { checkoutRoot: "~/Projects" },
      { checkoutRoot: null },
    ]);
    expect(JSON.parse(ctx.lines.at(-1)!).checkoutRoot).toBeNull();
    expect(calls.every((c) => c.method !== "POST")).toBe(true);
    await expect(hostsLocation(ctx, "NUC", { ...conn, set: "/a", clear: true })).rejects.toThrow(
      /not both/,
    );
  });
  it("guides legacy reads and rejects all legacy mutations without requests", async () => {
    const { fetch, calls } = stubFetch({ "GET /api/hosts": () => [NUC] });
    const ctx = testCtx(fetch);
    await hostsFolders(ctx, "NUC", { ...conn, json: true });
    expect(JSON.parse(ctx.lines[0]!).checkoutRoot).toBe("/srv");
    expect(ctx.errors.join(" ")).toMatch(/hosts location/);
    for (const flags of [{ set: ["/a"] }, { add: ["/a"] }, { remove: ["/a"] }, { clear: true }]) {
      await expect(hostsFolders(ctx, "NUC", { ...conn, ...flags })).rejects.toThrow(
        /hosts location/,
      );
    }
    await expect(hostsScan(ctx, "NUC", conn)).rejects.toThrow(/Git provider/);
    expect(calls).toHaveLength(1);
  });
});
