// @module-tag slow
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ADAPTER_CONTRACT_FEATURE, type Interaction, type Panel } from "@switchyard/protocol";
import { when } from "@switchyard/test-fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type HostHarness, startHarness, tempDir, waitFor } from "./helpers.js";
import { callTool, interactions, isSettled, items, sid, startSession } from "./sessions-helpers.js";

/** A contract v2 adapter: a tool view, a question claim and a tracker, each behind its feature. */
const SERVER = `
const has = (ctx, f) => ctx.features?.includes(f) === true;
export default {
  toolView(tool) {
    if (tool.name !== "fixture_select") return undefined;
    return { verb: "Picked a fruit", activeVerb: "Picking a fruit", meta: ["fixture"], hide: false };
  },
  claimInteraction(req) {
    if (req.method !== "select") return undefined;
    return {
      title: "Fruit?",
      kind: "question",
      presentation: { t: "text", text: "pick" },
      toPiResponse() { return { value: req.options[0] }; },
    };
  },
  onToolStart(e, ctx) {
    if (e.name !== "fixture_select") return;
    ctx.setContribution("fruit", has(ctx, "adapter.trackers.v1")
      ? { placement: "composer.tracker", title: "Fruit", mobileFallback: "picking",
          node: { t: "checklist", items: [{ text: "pick", state: "doing" }] },
          tracker: { count: "0/1", status: "running", step: "pick" } }
      : { placement: "composer.pill", title: "Fruit", mobileFallback: "picking",
          node: { t: "text", text: "Fruit 0/1" } });
  },
};
`;

function writeAdapter(root: string): void {
  const dir = join(root, ".switchyard", "adapters", "fruit2");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "switchyard-adapter.json"),
    JSON.stringify({
      id: "fruit2",
      version: "1.0.0",
      target: { extension: "fixture", versionRange: "*", testedVersions: [] },
      protocolVersion: 1,
      server: "server.mjs",
      webRenderer: null,
      capabilities: ["interactions", "panels"],
    }),
  );
  writeFileSync(join(dir, "server.mjs"), SERVER);
}

const script = [
  { when: when.userSays("pick"), reply: callTool("fixture_select") },
  { when: when.userSays("status"), reply: callTool("fixture_status") },
  { when: when.userSays("work slowly"), reply: callTool("fixture_slow") },
  {
    when: when.userSays("fail a command"),
    reply: { toolCalls: [{ name: "bash", arguments: { command: "exit 3" } }] },
  },
  {
    when: when.toolResult(),
    reply: (r: { lastText: string }) => ({ text: `done: ${r.lastText}` }),
  },
];

const panelsOf = (h: HostHarness, id: string) =>
  h.coord.eventsOf("panel.updated", id).map((e) => e.data as Panel);

async function askFruit(h: HostHarness, cwd: string) {
  const id = sid();
  await startSession(h, id, cwd, { initialPrompt: "please pick a fruit" });
  await waitFor(() => interactions(h, id).some((i) => i.state === "pending"), 30000, "question");
  const pending = interactions(h, id).find((i) => i.state === "pending") as Interaction;
  const tool = items(h, id).find((x) => x.kind === "tool" && x.data.name === "fixture_select");
  return { id, pending, tool };
}

describe("adapter contract v2 with a coordinator that negotiated it", () => {
  let h: HostHarness;
  let work: { path: string; cleanup(): void };
  beforeAll(async () => {
    h = await startHarness({ script, welcomeFeatures: [ADAPTER_CONTRACT_FEATURE] });
    work = tempDir("switchyard-v2-ws-");
    writeAdapter(work.path);
  });
  afterAll(async () => {
    await h?.dispose();
    work?.cleanup();
  });

  it("advertises the contract and the queue command", () => {
    expect(h.coord.hellos.at(-1)!.features).toEqual(
      expect.arrayContaining([ADAPTER_CONTRACT_FEATURE, "queueClear.v1"]),
    );
    expect(h.coord.hellos.at(-1)!.capabilities?.queueEdit).toBe(true);
  });

  it("carries the adapter's tool view, the dialog's kind and tool call, and a tracker", async () => {
    const { id, pending, tool } = await askFruit(h, work.path);
    expect(pending).toMatchObject({ adapterId: "fruit2", kind: "question" });
    expect(tool?.kind === "tool" && pending.toolCallId).toBe(
      tool?.kind === "tool" ? tool.data.toolCallId : null,
    );
    await waitFor(
      () =>
        items(h, id).some(
          (x) => x.kind === "tool" && x.data.view?.verb === "Picked a fruit" && !x.data.card,
        ),
      10000,
      "tool view",
    );
    const tracker = panelsOf(h, id).find((p) => p.contribution?.placement === "composer.tracker");
    expect(tracker).toMatchObject({
      adapterId: "fruit2",
      node: { t: "checklist" },
      contribution: { tracker: { count: "0/1", status: "running", step: "pick" } },
    });
    await h.coord.ok({
      type: "session.answer",
      sessionId: id,
      interactionId: pending.id,
      revision: pending.revision,
      response: { kind: "action", actionId: "x" },
      deviceId: "dev_a",
    });
    await h.coord.waitEvent(isSettled(id), 30000, "settled");
    await h.coord.ok({ type: "session.stop", sessionId: id });
  });

  it("shows unclaimed statuses as one Status tracker, not a panel", async () => {
    const id = sid();
    await startSession(h, id, work.path, { initialPrompt: "set status please" });
    await h.coord.waitEvent(isSettled(id), 30000, "settled");
    await waitFor(
      () => panelsOf(h, id).some((p) => p.slot === "@slot/status" && p.node !== null),
      10000,
      "status tracker",
    );
    const status = panelsOf(h, id)
      .filter((p) => p.slot === "@slot/status" && p.node)
      .at(-1)!;
    expect(status).toMatchObject({
      adapterId: "generic",
      title: "Status",
      node: { t: "facts" },
      contribution: { id: "status", placement: "composer.tracker" },
    });
    expect(panelsOf(h, id).some((p) => p.slot === "status" && p.node !== null)).toBe(false);
    await h.coord.ok({ type: "session.stop", sessionId: id });
  });

  it("adds a failed command's exit code to its view", async () => {
    const id = sid();
    await startSession(h, id, work.path, { initialPrompt: "fail a command" });
    await h.coord.waitEvent(isSettled(id), 30000, "settled");
    await waitFor(
      () => items(h, id).some((x) => x.kind === "tool" && x.data.view?.meta?.includes("exit 3")),
      10000,
      "exit code",
    );
    await h.coord.ok({ type: "session.stop", sessionId: id });
  });

  it("clears the queue without stopping the run and returns what waited", async () => {
    const id = sid();
    await startSession(h, id, work.path, { initialPrompt: "work slowly" });
    await waitFor(
      () => items(h, id).some((x) => x.kind === "tool" && x.data.status === "running"),
      30000,
      "running tool",
    );
    await h.coord.ok({
      type: "session.prompt",
      sessionId: id,
      text: "after that, say hi",
      images: [],
      mode: "followUp",
      origin: "human",
      controlRevision: 1,
    });
    const r = await h.coord.ok<{ cleared: { steering: string[]; followUp: string[] } }>({
      type: "session.clearQueue",
      sessionId: id,
    });
    expect(r.cleared.followUp).toEqual(["after that, say hi"]);
    expect(h.agent.supervisor.record(id)?.runtime).toBe("running");
    await h.coord.ok({ type: "session.stop", sessionId: id });
  });
});

describe("the same adapter with a coordinator from before contract v2", () => {
  let h: HostHarness;
  let work: { path: string; cleanup(): void };
  beforeAll(async () => {
    h = await startHarness({ script });
    work = tempDir("switchyard-v1-ws-");
    writeAdapter(work.path);
  });
  afterAll(async () => {
    await h?.dispose();
    work?.cleanup();
  });

  it("sends every event in its earlier shape", async () => {
    const { id, pending } = await askFruit(h, work.path);
    expect(pending.adapterId).toBe("fruit2");
    expect(pending).not.toHaveProperty("kind");
    expect(pending).not.toHaveProperty("toolCallId");
    await waitFor(() => panelsOf(h, id).some((p) => p.adapterId === "fruit2"), 10000, "pill");
    // The host still runs contract v2 (the adapter saw its features); only the wire is older.
    expect(panelsOf(h, id).find((p) => p.adapterId === "fruit2")).toMatchObject({
      contribution: { placement: "composer.pill" },
      node: { t: "text", text: "Fruit 0/1 · pick" },
    });
    expect(items(h, id).every((x) => x.kind !== "tool" || x.data.view === undefined)).toBe(true);
    await h.coord.ok({ type: "session.stop", sessionId: id });
  });
});
