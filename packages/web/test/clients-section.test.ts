import type { Client } from "@switchyard/protocol";
import { describe, expect, it } from "vitest";
import {
  bindingFromValue,
  bindingValue,
  clientFacts,
} from "../src/features/settings/ClientsSection";

describe("Clients settings", () => {
  it("round-trips a binding through the select value", () => {
    expect(bindingValue({ mirror: "none", scopeId: null })).toBe("none");
    expect(bindingValue({ mirror: "all", scopeId: null })).toBe("all");
    expect(bindingValue({ mirror: "scope", scopeId: "viw_1" })).toBe("scope:viw_1");
    expect(bindingFromValue("scope:viw_1")).toEqual({ mirror: "scope", scopeId: "viw_1" });
    expect(bindingFromValue("all")).toEqual({ mirror: "all" });
    expect(bindingFromValue("none")).toEqual({ mirror: "none" });
  });

  describe("clientFacts", () => {
    const now = Date.parse("2026-11-26T12:00:00Z");
    const client = (over: Partial<Client> = {}): Client => ({
      id: "herdr:default@mac",
      kind: "herdr",
      name: "default",
      machine: "mac",
      deviceId: "dev_1",
      hostId: null,
      mirror: "none",
      scopeId: null,
      shows: [],
      lastSeenAt: "2026-11-26T11:59:00Z",
      createdAt: "2026-11-01T00:00:00Z",
      ...over,
    });
    const device = { name: "mac CLI", revokedAt: null };

    it("says where, which device, and what it shows while it runs", () => {
      expect(clientFacts(client({ shows: ["a", "b"] }), { device, hostName: "Mac" }, now)).toEqual([
        "on Mac",
        "signed in with mac CLI",
        "2 sessions mirrored",
      ]);
      expect(clientFacts(client({ shows: ["a"] }), { device }, now)).toEqual([
        "on mac",
        "signed in with mac CLI",
        "1 session mirrored",
      ]);
    });

    it("names a revoked device and leaves out one it does not know", () => {
      expect(
        clientFacts(client(), { device: { name: "x", revokedAt: "2026-11-20T00:00:00Z" } }, now),
      ).toContain("its device was revoked");
      expect(clientFacts(client(), {}, now)).toEqual(["on mac"]);
    });

    it("says when a client that is not running was last seen", () => {
      expect(
        clientFacts(client({ lastSeenAt: new Date(0).toISOString() }), { device }, now),
      ).toEqual(["on mac", "signed in with mac CLI", "never seen"]);
      const old = clientFacts(client({ lastSeenAt: "2026-11-26T10:00:00Z" }), { device }, now);
      expect(old[2]).toMatch(/^last seen /);
    });
  });
});
