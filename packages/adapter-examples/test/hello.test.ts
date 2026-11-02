import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type AdapterEffect, AdapterRegistry, loadAdapterFromDir } from "@switchyard/adapter-sdk";
import { describe, expect, it } from "vitest";
import { EXAMPLE_ADAPTER_NAMES, exampleAdapterDir, exampleAdapters } from "../src/index.js";

function harness() {
  const effects: AdapterEffect[] = [];
  const registry = new AdapterRegistry();
  registry.setAdapters(exampleAdapters());
  const session = registry.openSession({ sessionId: "ses_hello", emit: (e) => effects.push(e) });
  const panels = () =>
    effects.filter((e): e is Extract<AdapterEffect, { type: "panel" }> => e.type === "panel");
  return { session, panels };
}

describe("example adapters", () => {
  it("ship valid manifests", () => {
    const list = exampleAdapters();
    expect(list.map((a) => a.manifest.id)).toEqual([...EXAMPLE_ADAPTER_NAMES]);
    expect(list[0]!.manifest.target.extension).toBe("pi-hello");
    for (const name of EXAMPLE_ADAPTER_NAMES) {
      expect(existsSync(`${exampleAdapterDir(name)}/switchyard-adapter.json`)).toBe(true);
    }
  });

  it("the emitted hello folder loads like any adapter directory", async () => {
    // Under vitest the folder is the TypeScript source; dist holds the manifest plus server.js.
    const dist = fileURLToPath(new URL("../dist/hello", import.meta.url));
    if (!existsSync(dist)) return;
    const { adapter } = await loadAdapterFromDir(dist, "owner");
    expect(adapter.manifest.id).toBe("hello");
    expect(typeof adapter.server.toolCard).toBe("function");
    expect(typeof adapter.server.onStatus).toBe("function");
  });
});

describe("hello", () => {
  it("renders the hello tool as a section with a table of its arguments", async () => {
    const { session } = harness();
    const running = await session.toolCard({
      toolCallId: "c1",
      name: "hello",
      args: { name: "Pi", times: 2 },
    });
    expect(running).toEqual({
      adapterId: "hello",
      node: {
        t: "section",
        title: "Hello",
        children: [
          {
            t: "table",
            columns: ["Argument", "Value"],
            rows: [
              ["name", "Pi"],
              ["times", "2"],
            ],
          },
        ],
      },
    });
    const done = await session.toolCard({
      toolCallId: "c1",
      name: "hello",
      args: {},
      result: { content: [{ type: "text", text: "hello, Pi" }] },
      isError: false,
    });
    expect(done?.node).toMatchObject({
      children: [
        { t: "text", text: "No arguments", tone: "muted" },
        { t: "text", text: "hello, Pi", tone: "default" },
      ],
    });
    expect(await session.toolCard({ toolCallId: "c2", name: "bash", args: {} })).toBeUndefined();
  });

  it("maps the hello status to the hello panel as progress or text, and clears it", async () => {
    const { session, panels } = harness();
    expect(await session.onStatus("hello", "greeting 2/4")).toBe(true);
    expect(await session.onStatus("hello", "waving 100%")).toBe(true);
    expect(await session.onStatus("hello", "resting")).toBe(true);
    expect(await session.onStatus("other", "ignored")).toBe(false);
    await session.onStatus("hello", undefined);
    const p = panels();
    expect(p.map((e) => e.node)).toEqual([
      { t: "progress", label: "greeting 2/4", value: 0.5, status: "running" },
      { t: "progress", label: "waving 100%", value: 1, status: "ok" },
      { t: "text", text: "resting" },
      null,
    ]);
    expect(p[0]).toMatchObject({
      adapterId: "hello",
      slot: "hello",
      title: "Hello",
      mobileFallback: "greeting 2/4",
    });
  });
});
