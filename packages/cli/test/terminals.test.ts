import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { herdrPair } from "../src/commands/herdr.js";
import { resolveTerminalRef, terminalsBind, terminalsList } from "../src/commands/terminals.js";
import { stubFetch, testCtx } from "./helpers.js";

const conn = { coordinator: "http://coord", credential: "cred" };
const T = "2026-11-02T10:00:00.000Z";
const VIEW = {
  id: "viw_1",
  name: "work",
  mode: "all",
  projectIds: null,
  hostIds: null,
  sessionIds: [],
  clients: [],
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
    viewId: null,
    bindingSetAt: T,
    shows: [],
    lastSeenAt: T,
    createdAt: T,
    ...over,
  };
};

describe("resolveTerminalRef", () => {
  const known = [term("herdr:vo@mac"), term("herdr:vo@nuc"), term("tmux:work@nuc")] as never[];
  it("takes ids, kind:name on this machine, and unique names", () => {
    expect(resolveTerminalRef("herdr:x@y", known, "mac")).toBe("herdr:x@y");
    expect(resolveTerminalRef("tmux:new", known, "mac")).toBe("tmux:new@mac");
    expect(resolveTerminalRef("vo", known, "mac")).toBe("herdr:vo@mac");
    expect(resolveTerminalRef("work", known, "mac")).toBe("tmux:work@nuc");
    expect(() => resolveTerminalRef("vo", known, "other")).toThrow(/several/);
    expect(() => resolveTerminalRef("nope", known, "mac")).toThrow(/Unknown terminal/);
  });
});

describe("terminals bind and list", () => {
  it("records a view by id and prints what it mirrors", async () => {
    const { fetch, calls } = stubFetch({
      "GET /api/views": () => [VIEW],
      "GET /api/terminals": () => [term("herdr:default@mac")],
      "PUT /api/terminals/herdr%3Adefault%40mac/binding": (c) =>
        term("herdr:default@mac", c.body as object),
    });
    const ctx = testCtx(fetch);
    await terminalsBind(ctx, "herdr:default@mac", { ...conn, view: "work" });
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({
      mirror: "view",
      viewId: "viw_1",
    });
    expect(ctx.lines).toEqual(["herdr:default@mac mirrors view work"]);
  });

  it("needs exactly one of --view, --all and --none", async () => {
    const { fetch } = stubFetch({});
    await expect(
      terminalsBind(testCtx(fetch), "herdr:a@b", { ...conn, all: true, none: true }),
    ).rejects.toThrow(/Choose one/);
  });

  it("lists terminals with their binding and daemon", async () => {
    const seen = new Date().toISOString();
    const { fetch } = stubFetch({
      "GET /api/views": () => [VIEW],
      "GET /api/terminals": () => [
        term("herdr:default@mac", { mirror: "all", shows: ["ses_1", "ses_2"], lastSeenAt: seen }),
        term("tmux:work@nuc", { mirror: "view", viewId: "viw_1" }),
        term("herdr:new@mac", { bindingSetAt: null }),
      ],
    });
    const ctx = testCtx(fetch);
    await terminalsList(ctx, conn);
    expect(ctx.lines[1]).toMatch(/^herdr:default@mac +everything +2 +seen /);
    expect(ctx.lines[2]).toMatch(/^tmux:work@nuc +view work +0 +not running$/);
    expect(ctx.lines[3]).toMatch(/nothing \(not recorded\)/);
  });
});

describe("pair", () => {
  it("writes how to run switchyard, and records the view with the coordinator", async () => {
    const id = `herdr:vo@${hostname()}`;
    const { fetch, calls } = stubFetch({
      "GET /api/views": () => [VIEW],
      [`PUT /api/terminals/${encodeURIComponent(id)}/binding`]: (c) => term(id, c.body as object),
    });
    const ctx = testCtx(fetch, { XDG_CONFIG_HOME: "" });
    ctx.env.XDG_CONFIG_HOME = join(ctx.dir, "config");
    await herdrPair(ctx, { ...conn, session: "vo", view: "work", cli: "node x.js" });
    const file = readFileSync(join(ctx.dir, "config", "switchyard-herdr", "vo.env"), "utf8");
    expect(file).toBe('SWITCHYARD_CLI="node x.js"\n');
    expect(calls.at(-2)!.body).toEqual({ mirror: "view", viewId: "viw_1" });
    expect(ctx.lines).toContain(`${id} mirrors view work`);
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
