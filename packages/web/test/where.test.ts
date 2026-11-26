import { describe, expect, it } from "vitest";
import {
  clientLabel,
  clientName,
  effectiveWhere,
  liveHostIds,
  runsIn,
  sameWhere,
  sessionIsWhere,
  sessionWhereToken,
  whereLabel,
} from "../src/features/scopes/where";

describe("where", () => {
  it("labels clients through the host's Switchyard name, and hosts", () => {
    expect(clientName("herdr:default@mac-pro")).toBe("herdr default");
    expect(clientLabel("herdr:default@mac-pro")).toBe("herdr default on mac-pro");
    expect(clientLabel("herdr:default@mac-pro", "Mac")).toBe("herdr default on Mac");
    expect(clientLabel("odd")).toBe("odd");
    const hosts = { h1: { name: "NUC" }, h2: { name: "Mac" } };
    expect(whereLabel({ kind: "host", id: "h1" }, hosts)).toBe("NUC");
    expect(whereLabel({ kind: "host", id: "h9" }, {})).toBe("Unknown host");
    expect(whereLabel({ kind: "client", id: "herdr:a@mac-pro", hostId: "h2" }, hosts)).toBe(
      "herdr a on Mac",
    );
    expect(whereLabel({ kind: "client", id: "herdr:a@mac-pro" }, hosts)).toBe("herdr a on mac-pro");
  });

  it("matches by client or host", () => {
    const s = { hostId: "h1", external: { client: "herdr:a@m" } };
    expect(sessionIsWhere(null, s)).toBe(true);
    expect(sessionIsWhere({ kind: "client", id: "herdr:a@m" }, s)).toBe(true);
    expect(sessionIsWhere({ kind: "client", id: "herdr:b@m" }, s)).toBe(false);
    expect(sessionIsWhere({ kind: "host", id: "h1" }, s)).toBe(true);
    expect(sessionIsWhere({ kind: "host", id: "h2" }, s)).toBe(false);
    expect(
      sessionIsWhere({ kind: "client", id: "herdr:a@m" }, { hostId: "h1", external: null }),
    ).toBe(false);
  });

  it("never filters by a revoked host", () => {
    const hosts = { h1: { name: "NUC", revokedAt: null }, h2: { name: "Old", revokedAt: "x" } };
    expect(liveHostIds(hosts)).toEqual(["h1"]);
    expect(effectiveWhere({ kind: "host", id: "h2" }, hosts)).toBeNull();
    expect(effectiveWhere({ kind: "client", id: "t", hostId: "h2" }, hosts)).toBeNull();
    expect(effectiveWhere({ kind: "host", id: "h1" }, hosts)).toEqual({ kind: "host", id: "h1" });
    expect(effectiveWhere(null, hosts)).toBeNull();
  });

  it("a stored terminal Where reads as a client", () => {
    const hosts = { h1: { name: "NUC", revokedAt: null } };
    const stored = { kind: "terminal", id: "herdr:a@m", hostId: "h1" } as never;
    expect(effectiveWhere(stored, hosts)).toEqual({
      kind: "client",
      id: "herdr:a@m",
      hostId: "h1",
    });
  });

  it("compares places by kind and id", () => {
    expect(sameWhere({ kind: "host", id: "a" }, { kind: "host", id: "a" })).toBe(true);
    expect(sameWhere({ kind: "client", id: "a", hostId: "h" }, { kind: "client", id: "a" })).toBe(
      true,
    );
    expect(sameWhere({ kind: "host", id: "a" }, { kind: "client", id: "a" })).toBe(false);
    expect(sameWhere(null, { kind: "host", id: "a" })).toBe(false);
  });

  it("gives a row the terminal of a hand-started Pi, else the host when there are several", () => {
    const ext = { hostId: "h1", external: { client: "herdr:default@mac-pro" } };
    expect(sessionWhereToken(ext, "Mac", false)).toEqual({
      kind: "terminal",
      label: "herdr default on Mac",
    });
    const gone = { hostId: "h1", external: { client: null } };
    expect(sessionWhereToken(gone, "Mac", false)).toEqual({ kind: "terminal", label: "Terminal" });
    expect(sessionWhereToken(gone, "Mac", true)).toEqual({
      kind: "terminal",
      label: "Terminal on Mac",
    });
    const held = { hostId: "h1", external: null };
    expect(sessionWhereToken(held, "Mac", false)).toBeNull();
    expect(sessionWhereToken(held, "Mac", true)).toEqual({ kind: "host", label: "Mac" });
  });

  it("says in Details where a hand-started Pi runs, with the same label", () => {
    expect(runsIn({ hostId: "h1", external: { client: "herdr:default@mac-pro" } }, "Mac")).toBe(
      "herdr default on Mac (your terminal)",
    );
    expect(runsIn({ hostId: "h1", external: { client: null } }, "Mac")).toBe(
      "Your terminal on Mac",
    );
    expect(runsIn({ hostId: "h1", external: null }, "Mac")).toBeNull();
  });
});
