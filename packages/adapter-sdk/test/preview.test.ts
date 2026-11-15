import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ADAPTER_PREVIEW_MAX_BYTES,
  AdapterPreviewFixtureSchema,
  AdapterPreviewSchema,
  parseAdapterPreviewFixtureJson,
  parseAdapterPreviewJson,
} from "@switchyard/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { runAdapterPreview } from "../src/preview.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function adapter(server: string) {
  const dir = await mkdtemp(join(tmpdir(), "switchyard-preview-"));
  dirs.push(dir);
  await writeFile(
    join(dir, "switchyard-adapter.json"),
    JSON.stringify({
      id: "preview-test",
      version: "1.0.0",
      protocolVersion: 1,
      target: { extension: "fixture-extension", versionRange: "*", testedVersions: [] },
      server: "server.mjs",
      webRenderer: null,
      capabilities: ["panels", "interactions"],
    }),
  );
  await writeFile(join(dir, "server.mjs"), server);
  return dir;
}
const fixture = (steps: unknown[]) => ({ version: 1, name: "Preview test", steps });

describe("preview protocol bounds", () => {
  it("rejects malformed, oversized and over-complex fixtures before adapter imports", async () => {
    expect(() =>
      AdapterPreviewFixtureSchema.parse(fixture([{ kind: "execute", data: {} }])),
    ).toThrow();
    expect(() =>
      AdapterPreviewFixtureSchema.parse(
        fixture(Array.from({ length: 201 }, () => ({ kind: "restore" }))),
      ),
    ).toThrow();
    expect(() => parseAdapterPreviewFixtureJson(" ".repeat(ADAPTER_PREVIEW_MAX_BYTES + 1))).toThrow(
      /1 MiB/,
    );
    expect(() =>
      parseAdapterPreviewFixtureJson(
        JSON.stringify({ ...fixture([]), name: "é".repeat(ADAPTER_PREVIEW_MAX_BYTES / 2) }),
      ),
    ).toThrow(/1 MiB/);
    expect(() =>
      AdapterPreviewFixtureSchema.parse({
        ...fixture([]),
        initialState: { a: { token: () => "not JSON" } },
      }),
    ).toThrow();
    await expect(
      runAdapterPreview({ adapter: "/nonexistent", fixture: fixture([{ kind: "unknown" }]) }),
    ).rejects.toThrow(/kind/);
  });

  it("rejects raw HTML nodes, deep trees, invalid contributions and real session identities", () => {
    const base = {
      version: 1,
      name: "test",
      adapter: { id: "test", version: "1" },
      steps: [],
      panels: [],
      interactions: [],
      cards: [],
      diagnostics: [],
    };
    expect(() =>
      parseAdapterPreviewJson(
        JSON.stringify({ ...base, cards: [{ t: "html", html: "<script>alert(1)</script>" }] }),
      ),
    ).toThrow();
    let node: unknown = { t: "text", text: "leaf" };
    for (let i = 0; i < 13; i++) node = { t: "section", children: [node] };
    expect(() => AdapterPreviewSchema.parse({ ...base, cards: [node] })).toThrow(/deeper/);
    const panel = {
      sessionId: "ses_adapter_preview",
      adapterId: "test",
      slot: "@slot/pill",
      title: "Pill",
      node: { t: "actions", actions: [] },
      webRenderer: false,
      mobileFallback: "Fallback",
      contribution: { id: "pill", placement: "composer.pill" },
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(() => AdapterPreviewSchema.parse({ ...base, panels: [panel] })).toThrow(/Composer pill/);
    expect(() =>
      AdapterPreviewSchema.parse({
        ...base,
        panels: [{ ...panel, contribution: undefined, sessionId: "ses_live" }],
      }),
    ).toThrow();
    expect(() => parseAdapterPreviewJson(" ".repeat(ADAPTER_PREVIEW_MAX_BYTES + 1))).toThrow(
      /1 MiB/,
    );
  });
});

describe("runAdapterPreview", () => {
  it("uses real session dispatch, restore state, tool hooks, claims, actions and portable effects", async () => {
    const dir = await adapter(`export default {
      onRestore(ctx) { ctx.setPanel('persistent', {t:'text',text:ctx.state.get('saved')}); },
      onToolStart(e, ctx) { ctx.state.set('tool', e.toolCallId); },
      onToolUpdate(e, ctx) { ctx.setPanel('progress', {t:'progress',label:e.name,value:0.5}); },
      onToolEnd(e, ctx) { ctx.setPanel('progress', null); },
      toolCard(e) { return {t:'text',text:'tool '+e.name}; },
      onStatus(key, text, ctx) { ctx.setPanel(key, text ? {t:'text',text} : null); return true; },
      onWidget(key, lines, ctx) { ctx.log('info', lines.join(' ')); },
      onCustomMessage(m, ctx) { ctx.log('info', 'custom hook'); },
      customMessageCard(m) { return {t:'text',text:m.content}; },
      claimInteraction(req) { return {title:req.title,presentation:{t:'confirm',message:req.title,confirmLabel:'Yes',cancelLabel:'No'},toPiResponse:r=>({confirmed:r.confirmed})}; },
      onAction(id, payload, ctx) { ctx.setContribution('action', {placement:'session.panel',title:'Local action',node:{t:'text',text:payload.note},mobileFallback:'local'}); },
    }`);
    const result = await runAdapterPreview({
      adapter: dir,
      fixture: {
        ...fixture([
          { kind: "restore" },
          { kind: "toolStart", data: { toolCallId: "call", name: "demo", args: {} } },
          {
            kind: "toolUpdate",
            data: { toolCallId: "call", name: "demo", args: {}, partialResult: {} },
          },
          { kind: "status", data: { key: "status", text: "ready" } },
          { kind: "widget", data: { key: "widget", lines: ["notes"] } },
          {
            kind: "dialog",
            data: { id: "question", method: "confirm", title: "Proceed?", message: "Preview only" },
          },
          {
            kind: "answer",
            data: { requestId: "question", response: { kind: "confirm", confirmed: true } },
          },
          { kind: "action", data: { actionId: "note", payload: { note: "simulated" } } },
          { kind: "customMessage", data: { customType: "demo", content: "custom card" } },
          {
            kind: "toolEnd",
            data: { toolCallId: "call", name: "demo", args: {}, result: {}, isError: false },
          },
        ]),
        initialState: { "preview-test": { saved: "restored panel" } },
      },
    });
    expect(result.steps.every((step) => step.ok)).toBe(true);
    expect(result.panels.find((panel) => panel.slot === "persistent")?.node).toEqual({
      t: "text",
      text: "restored panel",
    });
    expect(result.panels.some((panel) => panel.slot === "progress")).toBe(false);
    expect(result.panels.find((panel) => panel.slot === "@slot/action")?.node).toEqual({
      t: "text",
      text: "simulated",
    });
    expect(result.interactions[0]?.state).toBe("resolved");
    expect(result.cards).toContainEqual({ t: "text", text: "custom card" });
    expect(result.diagnostics.some((d) => d.message === "custom hook")).toBe(true);
    expect(JSON.stringify(result)).not.toContain('"tool":"call"');
    expect(AdapterPreviewSchema.parse(result)).toEqual(result);
  });

  it("reports hook and node failures as failed steps, keeps generic dialogs pending and never fabricates an answer", async () => {
    const dir = await adapter(`export default {
      claimInteraction(req) { return {title:req.title,presentation:{t:'text',text:'question'},toPiResponse(){throw new Error('mapper broke')}}; },
      onAction(){ throw new Error('action should not run after disable'); }
    }`);
    const result = await runAdapterPreview({
      adapter: dir,
      fixture: fixture([
        { kind: "dialog", data: { id: "q", method: "input", title: "Original evidence" } },
        {
          kind: "answer",
          data: { requestId: "q", response: { kind: "confirm", confirmed: true } },
        },
        { kind: "action", data: { actionId: "attempt", payload: {} } },
      ]),
    });
    expect(result.steps.map((step) => step.ok)).toEqual([true, false, false]);
    expect(result.steps[1]?.error).toContain("mapper broke");
    expect(result.interactions[0]?.state).toBe("pending");
    expect(result.interactions[0]?.presentation.t).toBe("form");
    const broken = await adapter("export default {toolCard(){return {t:'html',html:'unsafe'}}}");
    const badNode = await runAdapterPreview({
      adapter: broken,
      fixture: fixture([{ kind: "toolStart", data: { toolCallId: "c", name: "test", args: {} } }]),
    });
    expect(badNode.steps[0]?.ok).toBe(false);
    expect(badNode.cards).toEqual([]);
    expect(badNode.diagnostics.some((d) => d.level === "error")).toBe(true);
  });

  it("fails unexpected inputs and invalid restore sequencing without silently skipping steps", async () => {
    const dir = await adapter("export default {}");
    const result = await runAdapterPreview({
      adapter: dir,
      fixture: fixture([
        { kind: "answer", data: { requestId: "missing", response: { kind: "cancel" } } },
        { kind: "restore" },
      ]),
    });
    expect(result.steps.every((step) => !step.ok)).toBe(true);
    expect(result.steps[0]?.error).toContain("No pending dialog");
    expect(result.steps[1]?.error).toContain("first step");
  });
});
