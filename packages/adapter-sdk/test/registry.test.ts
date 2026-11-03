import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AdapterRegistry,
  type AdapterSession,
  type Claim,
  defineAdapter,
  discoverPiPackages,
  InteractionResponseError,
  type PiUiRequest,
  parseGitSource,
  piPackageDirCandidates,
} from "../src/index.js";
import { claimingServer, inline, sink, tmp, writeAdapterDir } from "./helpers.js";

const gate: PiUiRequest = {
  id: "ui-1",
  method: "select",
  title: "Allow this call?\nAction: run bash\nTarget: rm -rf build",
  options: ["Allow once", "Block", "Block with a message"],
};

function textClaim(label: string, req: PiUiRequest): Claim {
  return {
    title: label,
    presentation: { t: "text", text: label },
    toPiResponse: (r) =>
      r.kind === "cancel"
        ? { cancelled: true }
        : { value: (req as { options: string[] }).options[0]! },
  };
}

function open(registry: AdapterRegistry, sessionId = "ses_1") {
  const s = sink();
  return { session: registry.openSession({ sessionId, emit: s.emit }), effects: s.effects };
}

describe("onToolUpdate", () => {
  it("delivers partial results to adapters that have the hook", async () => {
    const seen: unknown[] = [];
    const registry = new AdapterRegistry();
    registry.setAdapters([
      inline("upd", { onToolUpdate: (e) => void seen.push(e) }),
      inline("plain", {}),
    ]);
    const { session } = open(registry);
    const e = {
      toolCallId: "c1",
      name: "t",
      args: { a: 1 },
      partialResult: { content: [] },
      details: { plan: "x" },
    };
    await session.onToolUpdate(e);
    expect(seen).toEqual([e]);
  });
});

describe("precedence", () => {
  it("orders project > owner > plugin > bundled and lets the highest tier claim", async () => {
    const root = tmp();
    const project = join(root, "repo");
    writeAdapterDir(
      join(project, ".switchyard", "adapters", "p"),
      "proj",
      claimingServer("project"),
    );
    const owner = join(root, "owner");
    writeAdapterDir(join(owner, "o"), "own", claimingServer("owner"));
    const pkg = join(root, "pkg");
    writeAdapterDir(join(pkg, "adapter"), "plug", claimingServer("plugin"));
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "@test/plug", version: "1.0.0", switchyard: { adapter: "adapter" } }),
    );
    const bundled = inline("bund", { claimInteraction: (req) => textClaim("bundled", req) });

    const registry = new AdapterRegistry();
    await registry.load({
      projectRoot: project,
      ownerDir: owner,
      pluginPackageDirs: [pkg],
      bundled: [bundled],
    });
    expect(registry.adapters().map((a) => [a.manifest.id, a.tier])).toEqual([
      ["proj", "project"],
      ["own", "owner"],
      ["plug", "plugin"],
      ["bund", "bundled"],
    ]);
    expect(registry.diagnostics()).toEqual([]);

    const { session } = open(registry);
    const out = await session.onUiRequest(gate);
    expect(out).toMatchObject({ kind: "claim", adapterId: "proj", claim: { title: "project" } });

    // Without the project tier, the owner adapter wins; without any, bundled.
    await registry.load({
      projectRoot: null,
      ownerDir: owner,
      pluginPackageDirs: [pkg],
      bundled: [bundled],
    });
    expect(await open(registry).session.onUiRequest(gate)).toMatchObject({ adapterId: "own" });
    await registry.load({ projectRoot: null, ownerDir: join(root, "none"), bundled: [bundled] });
    expect(await open(registry).session.onUiRequest(gate)).toMatchObject({ adapterId: "bund" });
  });

  it("a higher tier with the same id overrides the bundled adapter", async () => {
    const owner = tmp();
    writeAdapterDir(join(owner, "tg"), "tool-gate", claimingServer("owner tool-gate"));
    const registry = new AdapterRegistry();
    await registry.load({
      projectRoot: null,
      ownerDir: owner,
      bundled: [inline("tool-gate", { claimInteraction: (req) => textClaim("bundled", req) })],
    });
    expect(registry.adapters()).toHaveLength(1);
    expect(registry.info().map((i) => [i.id, i.tier, i.status])).toEqual([
      ["tool-gate", "owner", "active"],
      ["tool-gate", "bundled", "disabled"],
    ]);
    expect(await open(registry).session.onUiRequest(gate)).toMatchObject({
      claim: { title: "owner tool-gate" },
    });
  });

  it("falls back to the generic claim when nobody claims", async () => {
    const registry = new AdapterRegistry();
    registry.setAdapters([inline("quiet", { claimInteraction: () => undefined })]);
    const out = await open(registry).session.onUiRequest(gate);
    expect(out).toMatchObject({
      kind: "claim",
      adapterId: null,
      claim: { title: "Allow this call?" },
    });
  });

  it("reports adapters that fail to load and a target version outside the range", async () => {
    const owner = tmp();
    writeAdapterDir(join(owner, "broken"), "broken", "export default 42;\n");
    mkdirSync(join(owner, "bad-manifest"));
    writeFileSync(join(owner, "bad-manifest", "switchyard-adapter.json"), '{"id": 1}');
    const registry = new AdapterRegistry();
    await registry.load({
      projectRoot: null,
      ownerDir: owner,
      bundled: [inline("old", {})],
      installedPackages: [{ name: "@test/old", version: "2.1.0" }],
    });
    const info = registry.info();
    expect(info.find((i) => i.id === "broken")).toMatchObject({ status: "error" });
    expect(info.find((i) => i.id === "old")).toMatchObject({
      status: "active",
      detail: expect.stringContaining("outside"),
    });
    const messages = registry
      .diagnostics()
      .map((d) => d.message)
      .join("\n");
    expect(messages).toMatch(/must default-export/);
    expect(messages).toMatch(/invalid adapter manifest/);
  });
});

describe("failure isolation", () => {
  const throwing = defineAdapter({
    claimInteraction() {
      throw new Error("boom");
    },
    onStatus() {
      return true;
    },
  });

  it("an adapter that throws is disabled for the session, emits a diagnostic, and never auto-answers", async () => {
    const registry = new AdapterRegistry();
    registry.setAdapters([inline("bad", throwing, "project")]);
    const { session, effects } = open(registry);
    const out = await session.onUiRequest(gate);
    // Generic fallback: a claim that waits for a human. No response was produced.
    expect(out.kind).toBe("claim");
    expect(out).toMatchObject({ adapterId: null, claim: { title: "Allow this call?" } });
    expect(effects).toContainEqual(
      expect.objectContaining({
        type: "diagnostic",
        level: "error",
        adapterId: "bad",
        sessionId: "ses_1",
      }),
    );
    expect(session.statuses()).toEqual([
      expect.objectContaining({
        adapterId: "bad",
        status: "disabled",
        detail: expect.stringMatching(/boom/),
      }),
    ]);
    // Disabled for the rest of the session: other hooks are skipped too.
    expect(await session.onStatus("k", "v")).toBe(false);
    // Another session is unaffected.
    const other = open(registry, "ses_2").session;
    expect(other.statuses()[0]!.status).toBe("active");
  });

  it("a hook that exceeds the timeout disables the adapter", async () => {
    const registry = new AdapterRegistry({ hookTimeoutMs: 50 });
    registry.setAdapters([inline("slow", { claimInteraction: () => new Promise(() => {}) })]);
    const { session, effects } = open(registry);
    const out = await session.onUiRequest(gate);
    expect(out).toMatchObject({ kind: "claim", adapterId: null });
    expect(effects.find((e) => e.type === "diagnostic")).toMatchObject({
      message: expect.stringMatching(/timed out/),
    });
  });

  it("an invalid claim presentation disables the adapter", async () => {
    const registry = new AdapterRegistry();
    registry.setAdapters([
      inline("weird", {
        claimInteraction: () => ({
          title: "x",
          presentation: { t: "blink" } as never,
          toPiResponse: () => ({ value: "x" }),
        }),
      }),
    ]);
    const { session } = open(registry);
    expect(await session.onUiRequest(gate)).toMatchObject({ adapterId: null });
    expect(session.statuses()[0]!.status).toBe("disabled");
  });

  it("a throwing toPiResponse re-presents the generic claim instead of answering", async () => {
    const registry = new AdapterRegistry();
    registry.setAdapters([
      inline("mapper", {
        claimInteraction: () => ({
          title: "t",
          presentation: { t: "text", text: "t" },
          toPiResponse() {
            throw new Error("mapping bug");
          },
        }),
      }),
    ]);
    const { session, effects } = open(registry);
    const claimed = await session.onUiRequest(gate);
    if (claimed.kind !== "claim") throw new Error("expected claim");
    const out = await session.respond(claimed, { kind: "action", actionId: "x" });
    expect(out).toMatchObject({
      kind: "reclaim",
      adapterId: null,
      claim: { title: "Allow this call?" },
    });
    expect(effects.some((e) => e.type === "diagnostic" && e.level === "error")).toBe(true);
  });

  it("invalid user answers surface as InteractionResponseError and keep the adapter", async () => {
    const registry = new AdapterRegistry();
    registry.setAdapters([
      inline("strict", {
        claimInteraction: () => ({
          title: "t",
          presentation: { t: "text", text: "t" },
          toPiResponse() {
            throw new InteractionResponseError("pick one");
          },
        }),
      }),
    ]);
    const { session } = open(registry);
    const claimed = await session.onUiRequest(gate);
    if (claimed.kind !== "claim") throw new Error("expected claim");
    await expect(session.respond(claimed, { kind: "cancel" })).rejects.toThrow(/pick one/);
    expect(session.statuses()[0]!.status).toBe("active");
  });

  it("a response that does not fit the dialog is never sent", async () => {
    const registry = new AdapterRegistry();
    registry.setAdapters([
      inline("liar", {
        claimInteraction: () => ({
          title: "t",
          presentation: { t: "text", text: "t" },
          toPiResponse: () => ({ value: "Allow forever" }),
        }),
      }),
    ]);
    const { session } = open(registry);
    const claimed = await session.onUiRequest(gate);
    if (claimed.kind !== "claim") throw new Error("expected claim");
    expect(await session.respond(claimed, { kind: "action", actionId: "x" })).toMatchObject({
      kind: "reclaim",
    });
  });
});

describe("queued answers", () => {
  const follow: PiUiRequest = { id: "ui-2", method: "input", title: "Why?" };
  const sequenced = defineAdapter({
    claimInteraction: (req) =>
      req.method === "select"
        ? {
            title: "form",
            presentation: { t: "text", text: "form" },
            ownerToolCallId: "call-1",
            toPiResponse: () => ({
              sequence: [
                { value: "Block with a message" },
                { match: { method: "input" }, response: { value: "too risky" } },
              ],
            }),
          }
        : undefined,
  });

  async function setup() {
    const registry = new AdapterRegistry();
    registry.setAdapters([inline("seq", sequenced)]);
    const { session, effects } = open(registry);
    await session.onToolStart({ toolCallId: "call-1", name: "t", args: {} });
    const claimed = await session.onUiRequest(gate);
    if (claimed.kind !== "claim") throw new Error("expected claim");
    const out = await session.respond(claimed, { kind: "action", actionId: "x" });
    return { session, effects, out };
  }

  it("answers the current dialog and queues the rest for the same tool call", async () => {
    const { session, out } = await setup();
    expect(out).toEqual({
      kind: "respond",
      response: { value: "Block with a message" },
      queued: 1,
    });
    expect(session.queuedAnswers()).toEqual({ "call-1": 1 });
    expect(await session.onUiRequest(follow)).toMatchObject({
      kind: "queued",
      response: { value: "too risky" },
      toolCallId: "call-1",
    });
    expect(session.queuedAnswers()).toEqual({});
    // Queue consumed: the next dialog is claimed normally (generic here).
    expect(await session.onUiRequest({ ...follow, id: "ui-3" })).toMatchObject({
      kind: "claim",
      adapterId: null,
    });
  });

  it("expires when the owning tool call ends", async () => {
    const { session } = await setup();
    await session.onToolEnd({
      toolCallId: "call-1",
      name: "t",
      args: {},
      result: {},
      isError: false,
    });
    expect(session.queuedAnswers()).toEqual({});
    expect(await session.onUiRequest(follow)).toMatchObject({ kind: "claim", adapterId: null });
  });

  it("does not use a queued answer for a dialog it does not match", async () => {
    const { session } = await setup();
    const confirm: PiUiRequest = { id: "c", method: "confirm", title: "Sure?", message: "?" };
    expect(await session.onUiRequest(confirm)).toMatchObject({ kind: "claim" });
    expect(session.queuedAnswers()).toEqual({ "call-1": 1 });
  });

  it("drops queued answers that no longer fit the real dialog", async () => {
    const registry = new AdapterRegistry();
    registry.setAdapters([
      inline("q", {
        onToolStart: (_e, ctx) => ctx.queueAnswers({ method: "select" }, [{ value: "Nope" }]),
      }),
    ]);
    const { session, effects } = open(registry);
    await session.onToolStart({ toolCallId: "call-9", name: "t", args: {} });
    expect(session.queuedAnswers()).toEqual({ "call-9": 1 });
    expect(await session.onUiRequest(gate)).toMatchObject({ kind: "claim", adapterId: null });
    expect(session.queuedAnswers()).toEqual({});
    expect(effects.some((e) => e.type === "diagnostic" && e.level === "warning")).toBe(true);
  });

  it("drops a sequence when no tool call is running", async () => {
    const registry = new AdapterRegistry();
    registry.setAdapters([inline("seq", { claimInteraction: sequenced.claimInteraction! })]);
    const { session } = open(registry);
    const claimed = await session.onUiRequest(gate);
    if (claimed.kind !== "claim") throw new Error("expected claim");
    expect(await session.respond(claimed, { kind: "action", actionId: "x" })).toMatchObject({
      queued: 0,
    });
    expect(await session.onUiRequest(follow)).toMatchObject({ kind: "claim" });
  });
});

describe("context effects", () => {
  it("validates panels, persists state and seeds it from initialState", async () => {
    const registry = new AdapterRegistry();
    let seen: unknown;
    registry.setAdapters([
      inline("p", {
        onStatus(key, text, ctx) {
          seen = ctx.state.get("count");
          ctx.state.set("count", 2);
          ctx.setPanel("s", { t: "text", text: `${key}=${text}` }, { title: "S" });
          ctx.attention("needs_input", "look");
          ctx.linkSubagent({ runId: "r", label: "L", status: "running", sessionFile: null });
          return true;
        },
        onWidget(_k, _l, ctx) {
          ctx.setPanel("bad", { t: "nope" } as never);
        },
      }),
    ]);
    const s = sink();
    const session: AdapterSession = registry.openSession({
      sessionId: "ses_x",
      emit: s.emit,
      initialState: { p: { count: 1 } },
    });
    expect(await session.onStatus("k", "v")).toBe(true);
    expect(seen).toBe(1);
    expect(s.effects.map((e) => e.type)).toEqual(["state", "panel", "attention", "subagent"]);
    expect(s.effects[1]).toMatchObject({
      slot: "s",
      title: "S",
      webRenderer: false,
      node: { text: "k=v" },
    });
    await session.onWidget("w", ["x"]);
    expect(session.statuses()[0]!.status).toBe("disabled");
  });

  it("routes actions to the named adapter only", async () => {
    const calls: string[] = [];
    const registry = new AdapterRegistry();
    registry.setAdapters([
      inline("a", { onAction: (id) => void calls.push(`a:${id}`) }),
      inline("b", { onAction: (id) => void calls.push(`b:${id}`) }),
    ]);
    const { session } = open(registry);
    expect(await session.onAction("b", "go", null)).toEqual({ ok: true });
    expect(await session.onAction("zzz", "go", null)).toMatchObject({ ok: false });
    expect(calls).toEqual(["b:go"]);
  });
});

describe("plugin discovery", () => {
  it("parses git sources like Pi", () => {
    expect(parseGitSource("git:github.com/acme/pi-x@v1")).toEqual({
      host: "github.com",
      path: "acme/pi-x",
    });
    expect(parseGitSource("https://github.com/acme/pi-x.git")).toEqual({
      host: "github.com",
      path: "acme/pi-x",
    });
    expect(parseGitSource("git:git@github.com:acme/pi-x#main")).toEqual({
      host: "github.com",
      path: "acme/pi-x",
    });
    expect(parseGitSource("./local")).toBeNull();
  });

  it("resolves npm, git and local sources under the agent dir", () => {
    const agent = "/agent";
    expect(piPackageDirCandidates("npm:@acme/pi-x@1.2.3", agent)).toEqual([
      "/agent/npm/node_modules/@acme/pi-x",
    ]);
    expect(piPackageDirCandidates("git:github.com/acme/pi-x", agent)).toEqual([
      "/agent/git/github.com/acme/pi-x",
    ]);
    expect(piPackageDirCandidates("../plugins/pi-y", agent)).toEqual(["/plugins/pi-y"]);
    expect(piPackageDirCandidates("~/p", agent, { home: "/home/u" })).toEqual(["/home/u/p"]);
  });

  it("finds packages with switchyard.adapter and reports unresolvable ones", async () => {
    const agent = tmp();
    const local = join(agent, "..", `${agent.split("/").pop()}-local`);
    mkdirSync(local, { recursive: true });
    writeFileSync(
      join(local, "package.json"),
      JSON.stringify({ name: "pi-local", version: "0.1.0", switchyard: { adapter: "adapter" } }),
    );
    const git = join(agent, "git", "github.com", "acme", "pi-git");
    mkdirSync(git, { recursive: true });
    writeFileSync(join(git, "package.json"), JSON.stringify({ name: "pi-git", version: "0.2.0" }));
    writeFileSync(
      join(agent, "settings.json"),
      JSON.stringify({
        packages: [
          `../${local.split("/").pop()}`,
          { source: "git:github.com/acme/pi-git@v2" },
          "npm:missing-pkg",
        ],
      }),
    );
    const d = await discoverPiPackages({ env: { PI_CODING_AGENT_DIR: agent } });
    expect(d.agentDir).toBe(agent);
    expect(d.packages.map((p) => [p.name, p.version, p.adapters])).toEqual([
      ["pi-local", "0.1.0", ["adapter"]],
      ["pi-git", "0.2.0", []],
    ]);
    expect(d.pluginPackageDirs).toEqual([join(agent, "..", local.split("/").pop()!)]);
    expect(d.diagnostics).toHaveLength(1);
    expect(d.diagnostics[0]!.message).toMatch(/npm:missing-pkg could not be resolved/);
  });
});
