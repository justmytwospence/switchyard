import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type AdapterEffect, AdapterRegistry, loadAdapterFromDir } from "@switchyard/adapter-sdk";
import { describe, expect, it } from "vitest";
import { EXAMPLE_ADAPTER_NAMES, exampleAdapterDir, exampleAdapters } from "../src/index.js";

function harness(initialState?: Record<string, Record<string, unknown>>) {
  const effects: AdapterEffect[] = [];
  const registry = new AdapterRegistry();
  registry.setAdapters(exampleAdapters());
  const session = registry.openSession({
    sessionId: "ses_hello",
    initialState,
    emit: (e) => effects.push(e),
  });
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
  it("restores persistent presentation without replay and records safe actions only in state", async () => {
    const { session, panels } = harness({
      hello: { shown: "Saved greeting 1/2", last: "Saved action" },
    });
    await session.restore();
    expect(panels().find((panel) => panel.slot === "hello")?.node).toMatchObject({
      t: "progress",
      value: 0.5,
    });
    expect(panels().find((panel) => panel.contribution?.id === "footer")?.node).toEqual({
      t: "text",
      text: "Saved action",
    });
    const count = panels().length;
    await session.restore();
    expect(panels()).toHaveLength(count);
    expect(await session.onAction("hello", "save", { note: "Local note" })).toEqual({ ok: true });
    expect(
      panels()
        .filter((panel) => panel.contribution?.id === "footer")
        .at(-1)?.node,
    ).toEqual({
      t: "text",
      text: 'save: {"note":"Local note"}',
    });
  });

  it("claims the hello question, accepts a portable form, and falls back safely on an invalid mapping", async () => {
    const { session } = harness();
    const claimed = await session.onUiRequest({ id: "q", method: "input", title: "Hello name" });
    expect(claimed.kind).toBe("claim");
    if (claimed.kind !== "claim") throw new Error("Expected a claim");
    expect(claimed.adapterId).toBe("hello");
    expect(await session.respond(claimed, { kind: "form", values: { name: "Pi" } })).toMatchObject({
      kind: "respond",
      response: { value: "Pi" },
    });
    const fallback = await session.respond(claimed, { kind: "confirm", confirmed: true });
    expect(fallback.kind).toBe("reclaim");
    expect(session.statuses()[0]?.status).toBe("disabled");
  });
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
    const p = panels().filter((e) => e.slot === "hello");
    expect(p.map((e) => e.node)).toEqual([
      { t: "progress", label: "greeting 2/4", value: 0.5, status: "running" },
      { t: "progress", label: "waving 100%", value: 1, status: "ok" },
      { t: "text", text: "resting" },
      null,
    ]);
    expect(
      panels()
        .filter((e) => e.contribution && e.node !== null)
        .map((e) => e.contribution?.placement),
    ).toEqual(
      expect.arrayContaining([
        "sidebar.header",
        "sidebar.footer",
        "session.panel",
        "composer.pill",
        "palette.item",
        "slash.command",
      ]),
    );
    expect(panels().filter((e) => e.contribution && e.node === null)).toHaveLength(6);
    expect(p[0]).toMatchObject({
      adapterId: "hello",
      slot: "hello",
      title: "Hello",
      mobileFallback: "greeting 2/4",
    });
  });
});
