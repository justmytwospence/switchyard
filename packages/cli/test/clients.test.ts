import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clientsBind, clientsList, resolveClientRef } from "../src/commands/clients.js";
import { herdrPair } from "../src/commands/herdr.js";
import { main } from "../src/main.js";
import { stubFetch, testCtx } from "./helpers.js";

const conn = { coordinator: "http://coord", credential: "cred" };
const T = "2026-11-02T10:00:00.000Z";
const SCOPE = {
  id: "viw_1",
  name: "work",
  mode: "all",
  projectIds: null,
  hostIds: null,
  sessionIds: [],
  source: null,
  createdAt: T,
  updatedAt: T,
};
const term = (id: string, over: Record<string, unknown> = {}) => {
  const [, kind, name, machine] = /^(\w+):(.+)@(.+)$/.exec(id)!;
  return {
    id,
    kind,
    name,
    machine,
    deviceId: "dev_1",
    hostId: null,
    mirror: "none",
    scopeId: null,
    bindingSetAt: T,
    shows: [],
    lastSeenAt: T,
    createdAt: T,
    ...over,
  };
};

describe("resolveClientRef", () => {
  const known = [term("herdr:vo@mac"), term("herdr:vo@nuc"), term("tmux:work@nuc")] as never[];
  it("takes ids, kind:name on this machine, and unique names", () => {
    expect(resolveClientRef("herdr:x@y", known, "mac")).toBe("herdr:x@y");
    expect(resolveClientRef("tmux:new", known, "mac")).toBe("tmux:new@mac");
    expect(resolveClientRef("vo", known, "mac")).toBe("herdr:vo@mac");
    expect(resolveClientRef("work", known, "mac")).toBe("tmux:work@nuc");
    expect(() => resolveClientRef("vo", known, "other")).toThrow(/several/);
    expect(() => resolveClientRef("nope", known, "mac")).toThrow(/Unknown client/);
  });
  it("resolves a kind other than herdr and tmux", () => {
    expect(resolveClientRef("zellij:main", known, "mac")).toBe("zellij:main@mac");
    expect(resolveClientRef("zellij:main@nuc", known, "mac")).toBe("zellij:main@nuc");
  });
});

describe("clients bind and list", () => {
  it("records a scope by id and prints what it mirrors", async () => {
    const { fetch, calls } = stubFetch({
      "GET /api/scopes": () => [SCOPE],
      "GET /api/clients": () => [term("herdr:default@mac")],
      "PUT /api/clients/herdr%3Adefault%40mac/binding": (c) =>
        term("herdr:default@mac", c.body as object),
    });
    const ctx = testCtx(fetch);
    await clientsBind(ctx, "herdr:default@mac", { ...conn, scope: "work" });
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({
      mirror: "scope",
      scopeId: "viw_1",
    });
    expect(ctx.lines).toEqual(["herdr:default@mac mirrors scope work"]);
  });

  it("--view still selects a scope", async () => {
    const { fetch, calls } = stubFetch({
      "GET /api/scopes": () => [SCOPE],
      "GET /api/clients": () => [term("herdr:default@mac")],
      "PUT /api/clients/herdr%3Adefault%40mac/binding": (c) =>
        term("herdr:default@mac", c.body as object),
    });
    const ctx = testCtx(fetch);
    const code = await main(
      [
        "node",
        "switchyard",
        "terminals",
        "bind",
        "herdr:default@mac",
        "--view",
        "work",
        "--coordinator",
        "http://c",
        "--credential",
        "t",
      ],
      ctx,
    );
    expect(code).toBe(0);
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({
      mirror: "scope",
      scopeId: "viw_1",
    });
    expect(ctx.errors).toEqual([
      '"switchyard terminals" is now "switchyard clients"; the old name will be removed',
    ]);
    expect(ctx.lines).toEqual(["herdr:default@mac mirrors scope work"]);
  });

  it("needs exactly one of --scope, --all and --none", async () => {
    const { fetch } = stubFetch({});
    await expect(
      clientsBind(testCtx(fetch), "herdr:a@b", { ...conn, all: true, none: true }),
    ).rejects.toThrow(/Choose one/);
  });

  it("lists clients with their binding and daemon", async () => {
    const seen = new Date().toISOString();
    const { fetch } = stubFetch({
      "GET /api/scopes": () => [SCOPE],
      "GET /api/clients": () => [
        term("herdr:default@mac", { mirror: "all", shows: ["ses_1", "ses_2"], lastSeenAt: seen }),
        term("tmux:work@nuc", { mirror: "scope", scopeId: "viw_1" }),
        term("herdr:new@mac", { bindingSetAt: null }),
      ],
    });
    const ctx = testCtx(fetch);
    await clientsList(ctx, conn);
    expect(ctx.lines[1]).toMatch(/^herdr:default@mac +everything +2 +seen /);
    expect(ctx.lines[2]).toMatch(/^tmux:work@nuc +scope work +0 +not running$/);
    expect(ctx.lines[3]).toMatch(/nothing \(not recorded\)/);
  });
});

describe("pair", () => {
  it("writes how to run switchyard, and records the scope with the coordinator", async () => {
    const id = `herdr:vo@${hostname()}`;
    const { fetch, calls } = stubFetch({
      "GET /api/scopes": () => [SCOPE],
      [`PUT /api/clients/${encodeURIComponent(id)}/binding`]: (c) => term(id, c.body as object),
    });
    const ctx = testCtx(fetch, { XDG_CONFIG_HOME: "" });
    ctx.env.XDG_CONFIG_HOME = join(ctx.dir, "config");
    await herdrPair(ctx, { ...conn, session: "vo", scope: "work", cli: "node x.js" });
    const file = readFileSync(join(ctx.dir, "config", "switchyard-herdr", "vo.env"), "utf8");
    expect(file).toBe('SWITCHYARD_CLI="node x.js"\n');
    expect(calls.at(-2)!.body).toEqual({ mirror: "scope", scopeId: "viw_1" });
    expect(ctx.lines).toContain(`${id} mirrors scope work`);
  });

  it("without a binding only says how to choose one", async () => {
    const { fetch, calls } = stubFetch({});
    const ctx = testCtx(fetch);
    ctx.env.XDG_CONFIG_HOME = join(ctx.dir, "config");
    await herdrPair(ctx, { session: "x" });
    expect(calls).toEqual([]);
    expect(ctx.lines.join("\n")).toMatch(/mirrors nothing until you choose/);
  });
});
