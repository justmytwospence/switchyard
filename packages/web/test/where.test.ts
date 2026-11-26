import { describe, expect, it } from "vitest";
import {
  parseWhere,
  sessionIsWhere,
  terminalLabel,
  type Where,
  whereKey,
  whereLabel,
  whereOptions,
} from "../src/features/views/where";

describe("where", () => {
  it("labels terminals and hosts", () => {
    expect(terminalLabel("herdr:default@mac-pro")).toBe("herdr default on mac-pro");
    expect(terminalLabel("odd")).toBe("odd");
    expect(whereLabel({ kind: "host", id: "h1" }, { h1: { name: "NUC" } })).toBe("NUC");
    expect(whereLabel({ kind: "host", id: "h9" }, {})).toBe("Unknown host");
  });

  it("matches by terminal or host", () => {
    const s = { hostId: "h1", external: { client: "herdr:a@m" } };
    expect(sessionIsWhere(null, s)).toBe(true);
    expect(sessionIsWhere({ kind: "terminal", id: "herdr:a@m" }, s)).toBe(true);
    expect(sessionIsWhere({ kind: "terminal", id: "herdr:b@m" }, s)).toBe(false);
    expect(sessionIsWhere({ kind: "host", id: "h1" }, s)).toBe(true);
    expect(sessionIsWhere({ kind: "host", id: "h2" }, s)).toBe(false);
    expect(
      sessionIsWhere({ kind: "terminal", id: "herdr:a@m" }, { hostId: "h1", external: null }),
    ).toBe(false);
  });

  it("round-trips keys", () => {
    const t: Where = { kind: "terminal", id: "herdr:default@mac-pro" };
    const h: Where = { kind: "host", id: "hst_1" };
    expect(parseWhere(whereKey(t))).toEqual(t);
    expect(parseWhere(whereKey(h))).toEqual(h);
    expect(parseWhere("")).toBeNull();
    expect(parseWhere("x:1")).toBeNull();
  });

  it("offers terminals in use, hosts only when several, and the selection", () => {
    const sessions = [
      { archivedAt: null, external: { client: "herdr:b@m" } },
      { archivedAt: null, external: { client: "herdr:a@m" } },
      { archivedAt: "x", external: { client: "herdr:z@m" } },
      { archivedAt: null, external: null },
    ];
    const one = { h1: { name: "NUC" } };
    const two = { h1: { name: "NUC" }, h2: { name: "Mac" } };
    const ids = (w: Where[]) => w.map((x) => x.id);
    const a = whereOptions(sessions, one, null);
    expect(ids(a.terminals)).toEqual(["herdr:a@m", "herdr:b@m"]);
    expect(a.hosts).toEqual([]);
    expect(ids(whereOptions(sessions, two, null).hosts)).toEqual(["h2", "h1"]);
    expect(
      ids(whereOptions(sessions, one, { kind: "terminal", id: "herdr:gone@m" }).terminals),
    ).toContain("herdr:gone@m");
    expect(ids(whereOptions(sessions, one, { kind: "host", id: "h1" }).hosts)).toEqual(["h1"]);
  });
});
