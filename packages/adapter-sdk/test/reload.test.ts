import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type AdapterContext, AdapterRegistry, loadAdapterFromDir } from "../src/index.js";
import { inline, sink, tmp, writeAdapterDir } from "./helpers.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const tool = { toolCallId: "c", name: "x", args: {} };

describe("content-addressed adapter entries", () => {
  it("reuses identical module bytes, loads edited bytes, and keeps normal relative imports", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "helper.mjs"), 'export const label = "relative";');
    const source = (version: string) => `import {label} from './helper.mjs';
      export default { toolCard() { return {t:'text', text:label + '-${version}'}; } };`;
    writeAdapterDir(dir, "hash", source("one"));
    const a = (await loadAdapterFromDir(dir, "owner")).adapter;
    const b = (await loadAdapterFromDir(dir, "owner")).adapter;
    expect(a.server).toBe(b.server);
    writeFileSync(join(dir, "server.mjs"), source("two"));
    const c = (await loadAdapterFromDir(dir, "owner")).adapter;
    expect(c.server).not.toBe(a.server);
    const registry = new AdapterRegistry();
    registry.setAdapters([a]);
    const old = registry.openSession({ sessionId: "old", emit() {} });
    registry.setAdapters([c]);
    const fresh = registry.openSession({ sessionId: "fresh", emit() {} });
    expect(await old.toolCard(tool)).toMatchObject({ node: { text: "relative-one" } });
    expect(await fresh.toolCard(tool)).toMatchObject({ node: { text: "relative-two" } });
  });

  it("creates a fresh async factory instance per session even with the same imported entry", async () => {
    const dir = tmp();
    writeAdapterDir(
      dir,
      "factory",
      `export default async () => {
      let count = 0;
      return { toolCard() { return { t: 'text', text: String(++count) }; } };
    };`,
    );
    const adapter = (await loadAdapterFromDir(dir, "owner")).adapter;
    const registry = new AdapterRegistry();
    registry.setAdapters([adapter]);
    const a = registry.openSession({ sessionId: "a", emit() {} });
    const b = registry.openSession({ sessionId: "b", emit() {} });
    expect(await a.toolCard(tool)).toMatchObject({ node: { text: "1" } });
    expect(await a.toolCard(tool)).toMatchObject({ node: { text: "2" } });
    expect(await b.toolCard(tool)).toMatchObject({ node: { text: "1" } });
  });
});

describe("presentation-only restore", () => {
  it("restores once from state without replay and refuses attention/subagent/answer effects", async () => {
    const effects = sink();
    const hooks: string[] = [];
    const registry = new AdapterRegistry();
    registry.setAdapters([
      inline("a", {
        onRestore(ctx) {
          hooks.push("restore");
          const n = ctx.state.get<number>("count")!;
          ctx.state.set("count", n + 1);
          ctx.setPanel("restored", { t: "text", text: String(n) });
          ctx.setContribution("pill", {
            placement: "sidebar.header",
            title: "Pill",
            mobileFallback: "safe",
            node: { t: "text", text: "safe" },
          });
          ctx.attention("needs_input", "should never send");
          ctx.linkSubagent({ runId: "r", label: "r", status: "running", sessionFile: null });
          ctx.queueAnswers({}, [{ confirmed: true }]);
        },
        onEntry() {
          hooks.push("entry");
        },
        onToolStart() {
          hooks.push("tool");
        },
        onCustomMessage() {
          hooks.push("message");
        },
        onAction(_id, _payload, ctx) {
          ctx.setPanel("after", { t: "text", text: String(ctx.state.get("count")) });
        },
      }),
    ]);
    const initialState = { a: { count: 2 } };
    const session = registry.openSession({ sessionId: "s", emit: effects.emit, initialState });
    await Promise.all([session.restore(), session.restore()]);
    expect(hooks).toEqual(["restore"]);
    expect(initialState).toEqual({ a: { count: 2 } });
    expect(effects.effects.filter((e) => e.type === "diagnostic")).toHaveLength(3);
    expect(effects.effects.filter((e) => ["attention", "subagent"].includes(e.type))).toEqual([]);
    expect(session.queuedAnswers()).toEqual({});
    expect(session.activeToolCalls()).toEqual([]);
    expect(effects.effects.filter((e) => e.type === "state")).toEqual([
      { type: "state", adapterId: "a", key: "count", value: 3 },
    ]);
    expect(await session.onAction("a", "read", null)).toEqual({ ok: true });
    expect(effects.effects.at(-1)).toMatchObject({
      type: "panel",
      slot: "after",
      node: { text: "3" },
    });
  });

  it("buffers until each hook succeeds, discards failed state/UI, and isolates failure", async () => {
    const effects = sink();
    const gate = deferred();
    const started = deferred();
    const registry = new AdapterRegistry();
    registry.setAdapters([
      inline("bad", {
        onRestore(ctx) {
          ctx.state.set("x", 1);
          ctx.setPanel("p", { t: "text", text: "bad" });
          throw new Error("restore failed");
        },
      }),
      inline("good", {
        async onRestore(ctx) {
          ctx.setPanel("p", { t: "text", text: "good" });
          started.resolve();
          await gate.promise;
        },
      }),
    ]);
    const session = registry.openSession({ sessionId: "s", emit: effects.emit });
    const restore = session.restore();
    await started.promise;
    expect(effects.effects.every((e) => e.type === "diagnostic")).toBe(true);
    gate.resolve();
    await restore;
    expect(effects.effects.filter((e) => e.type !== "diagnostic")).toEqual([
      expect.objectContaining({
        type: "panel",
        adapterId: "good",
        node: { text: "good", t: "text" },
      }),
    ]);
    expect(session.statuses().map((s) => s.status)).toEqual(["disabled", "active"]);
  });

  it("fences timed-out restores and retired contexts, including local store mutation and returned cards", async () => {
    const effects = sink();
    const gate = deferred();
    let captured!: AdapterContext;
    const registry = new AdapterRegistry({ hookTimeoutMs: 10 });
    registry.setAdapters([
      inline("late", {
        async onRestore(ctx) {
          captured = ctx;
          await gate.promise;
          ctx.state.set("object", { changed: true });
          ctx.setPanel("p", { t: "text", text: "late" });
        },
      }),
    ]);
    const session = registry.openSession({
      sessionId: "s",
      emit: effects.emit,
      initialState: { late: { object: { changed: false } } },
    });
    await session.restore();
    const before = effects.effects.length;
    gate.resolve();
    await Promise.resolve();
    captured.state.delete("object");
    captured.state.get<{ changed: boolean }>("object")!.changed = true;
    expect(captured.state.get("object")).toEqual({ changed: false });
    expect(effects.effects).toHaveLength(before);

    const retireGate = deferred();
    const started = deferred();
    let retired!: AdapterContext;
    registry.setAdapters([
      inline("retired", {
        async toolCard(_tool, ctx) {
          retired = ctx;
          started.resolve();
          await retireGate.promise;
          ctx.state.set("x", 2);
          ctx.setContribution("c", {
            placement: "sidebar.header",
            title: "Late",
            mobileFallback: "late",
            node: { t: "text", text: "late" },
          });
          return { t: "text", text: "late" };
        },
      }),
    ]);
    const old = registry.openSession({
      sessionId: "s2",
      emit: effects.emit,
      initialState: { retired: { x: 1 } },
    });
    const card = old.toolCard(tool);
    await started.promise;
    old.close();
    retireGate.resolve();
    expect(await card).toBeUndefined();
    expect(retired.state.get("x")).toBe(1);
    expect(effects.effects).toHaveLength(before);
  });

  it("revokes a successful restore context after return and discards a retired candidate buffer", async () => {
    const effects = sink();
    let captured!: AdapterContext;
    const registry = new AdapterRegistry();
    registry.setAdapters([
      inline("a", {
        onRestore(ctx) {
          captured = ctx;
          ctx.state.set("x", 1);
        },
      }),
    ]);
    const a = registry.openSession({ sessionId: "a", emit: effects.emit });
    await a.restore();
    captured.state.set("x", 2);
    expect(captured.state.get("x")).toBe(1);
    const gate = deferred();
    const started = deferred();
    registry.setAdapters([
      inline("b", {
        async onRestore(ctx) {
          ctx.state.set("x", 1);
          ctx.setPanel("p", { t: "text", text: "candidate" });
          started.resolve();
          await gate.promise;
        },
      }),
    ]);
    const b = registry.openSession({ sessionId: "b", emit: effects.emit });
    const restoring = b.restore();
    await started.promise;
    b.close();
    gate.resolve();
    await restoring;
    expect(effects.effects).toEqual([{ type: "state", adapterId: "a", key: "x", value: 1 }]);
  });

  it("rejects restore on used contexts and retains active-tool/queue inspection", async () => {
    const registry = new AdapterRegistry();
    registry.setAdapters([
      inline("a", {
        onToolStart(_event, ctx) {
          ctx.queueAnswers({}, [{ confirmed: true }]);
        },
      }),
    ]);
    const session = registry.openSession({ sessionId: "s", emit() {} });
    await session.onToolStart(tool);
    expect(session.activeToolCalls()).toEqual(["c"]);
    expect(session.queuedAnswers()).toEqual({ c: 1 });
    await expect(session.restore()).rejects.toThrow("new adapter session");
    await session.onToolEnd({ ...tool, result: {}, isError: false });
    expect(session.activeToolCalls()).toEqual([]);
    expect(session.queuedAnswers()).toEqual({});
  });
});
