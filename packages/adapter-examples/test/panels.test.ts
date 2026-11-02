import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadAdapterFromDir } from "@switchyard/adapter-sdk";
import { describe, expect, it } from "vitest";
import {
  BG_RENDERER_PATH,
  BUNDLED_ADAPTER_NAMES,
  bundledAdapterDir,
  bundledAdapters,
} from "../src/index.js";
import { harness } from "./fixtures.js";

const panels = (effects: ReturnType<typeof harness>["effects"]) =>
  effects.filter((e) => e.type === "panel");

describe("bundled adapters", () => {
  it("ship valid manifests in a stable order", () => {
    const list = bundledAdapters();
    expect(list.map((a) => a.manifest.id)).toEqual([...BUNDLED_ADAPTER_NAMES]);
    expect(list.every((a) => a.tier === "bundled")).toBe(true);
    expect(list.find((a) => a.manifest.id === "ask-user-question")!.manifest.target).toEqual({
      extension: "@justmytwospence/pi-ask-user-question",
      versionRange: ">=0.1.0 <0.2.0",
      testedVersions: ["0.1.2"],
    });
  });

  it("each folder holds a loadable manifest", async () => {
    for (const name of BUNDLED_ADAPTER_NAMES) {
      expect(existsSync(`${bundledAdapterDir(name)}/switchyard-adapter.json`)).toBe(true);
    }
    // Under vitest the folders are the TypeScript sources; the emitted dist folders hold a
    // manifest plus server.js and load like any adapter directory.
    const dist = fileURLToPath(new URL("../dist/todo", import.meta.url));
    if (existsSync(dist)) {
      const { adapter } = await loadAdapterFromDir(dist, "plugin");
      expect(adapter.manifest.id).toBe("todo");
      expect(typeof adapter.server.onToolEnd).toBe("function");
    }
  });

  it("bg ships its web renderer", () => {
    expect(existsSync(BG_RENDERER_PATH)).toBe(true);
    const html = readFileSync(BG_RENDERER_PATH, "utf8");
    expect(html).toContain('"render"');
    expect(html).toContain('type: "resize"');
    expect(html).toContain("Content-Security-Policy");
    expect(bundledAdapters().find((a) => a.manifest.id === "bg")!.webRendererPath).toBe(
      BG_RENDERER_PATH,
    );
  });
});

describe("plan-mode", () => {
  it("plan message -> plan panel; status keys -> plan-status table", async () => {
    const { session, effects } = harness();
    await session.onCustomMessage({ customType: "plan-mode-plan", content: "# Plan\n1. Do it" });
    await session.onCustomMessage({ customType: "other", content: "ignored" });
    expect(await session.onStatus("workflow-mode", "planning")).toBe(true);
    await session.onStatus("plan", "3 steps");
    await session.onStatus("workflow-mode", undefined);
    expect(await session.onStatus("unrelated", "x")).toBe(false);
    const p = panels(effects);
    expect(p[0]).toMatchObject({
      adapterId: "plan-mode",
      slot: "plan",
      node: { t: "markdown", text: "# Plan\n1. Do it" },
    });
    expect(p.at(-1)).toMatchObject({
      slot: "plan-status",
      node: { t: "table", rows: [["plan", "3 steps"]] },
    });
  });
});

describe("subagents", () => {
  it("links runs from entries and tool results, keeping the latest per id", async () => {
    const { session, effects } = harness();
    const run = {
      id: "run-1",
      agent: "worker",
      task: "Fix the tests",
      status: "running",
      sessionFile: "/s/a.jsonl",
    };
    await session.onEntry({ type: "custom", customType: "subagents:run", data: run });
    await session.onEntry({ type: "custom", customType: "subagents:run", data: run });
    await session.onToolEnd({
      toolCallId: "c1",
      name: "subagent",
      args: {},
      result: {},
      isError: false,
      details: {
        mode: "single",
        runs: [
          { ...run, status: "done" },
          { id: "run-2", agent: "explorer", task: "Look", label: "Scout", status: "failed" },
        ],
      },
    });
    const links = effects
      .filter((e) => e.type === "subagent")
      .map((e) => (e.type === "subagent" ? e.link : null));
    expect(links).toEqual([
      {
        runId: "run-1",
        label: "worker: Fix the tests",
        status: "running",
        sessionFile: "/s/a.jsonl",
      },
      { runId: "run-1", label: "worker: Fix the tests", status: "done", sessionFile: "/s/a.jsonl" },
      { runId: "run-2", label: "Scout", status: "failed", sessionFile: null },
    ]);
  });
});

describe("todo", () => {
  it("todo tool details.tasks -> todo panel list", async () => {
    const { session, effects } = harness();
    await session.onToolEnd({
      toolCallId: "c1",
      name: "todo",
      args: {},
      result: {
        details: {
          tasks: [
            { id: 1, subject: "Write tests", status: "in_progress" },
            { id: 2, subject: "Ship", status: "pending" },
            { id: 3, subject: "Plan", status: "completed" },
          ],
        },
      },
      isError: false,
    });
    expect(panels(effects)[0]).toMatchObject({
      slot: "todo",
      title: "Todo",
      node: {
        t: "list",
        items: [
          { t: "text", text: "[~] Write tests" },
          { t: "text", text: "[ ] Ship" },
          { t: "text", text: "[x] Plan", tone: "muted" },
        ],
      },
    });
  });
});

describe("bg", () => {
  it("bg status -> progress or text panel with renderer state; clearing removes it", async () => {
    const { session, effects } = harness();
    expect(await session.onStatus("bg", "2/4 jobs running")).toBe(true);
    await session.onStatus("bg", "1 job running");
    await session.onWidget("bg", ["build  running", "test   queued"]);
    await session.onStatus("bg", undefined);
    await session.onWidget("bg", undefined);
    const p = panels(effects);
    expect(p[0]).toMatchObject({
      slot: "bg",
      webRenderer: true,
      node: { t: "progress", label: "2/4 jobs running", value: 0.5 },
    });
    expect(p[1]).toMatchObject({ node: { t: "text", text: "1 job running" } });
    expect(p[2]).toMatchObject({
      node: { t: "section" },
      state: { status: "1 job running", lines: ["build  running", "test   queued"] },
    });
    expect(p.at(-1)).toMatchObject({ node: null });
  });
});
