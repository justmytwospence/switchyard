import { describe, expect, it } from "vitest";
import { adapterFits, CONTRACT_MATCHES, claimFits, contextFits } from "../src/contract-check.js";
import {
  ADAPTER_FEATURES,
  type AdapterEffect,
  AdapterRegistry,
  type Claim,
  type ServerAdapter,
} from "../src/index.js";
import { inline } from "./helpers.js";

function open(server: ServerAdapter) {
  const effects: AdapterEffect[] = [];
  const registry = new AdapterRegistry();
  registry.setAdapters([inline("v2", server)]);
  const session = registry.openSession({ sessionId: "ses_1", emit: (e) => effects.push(e) });
  return { session, effects };
}
const select = { id: "r1", method: "select", title: "Pick", options: ["a", "b"] } as const;

describe("adapter contract v2", () => {
  it("keeps the copyable contract types equal to the SDK's", () => {
    expect(Object.values(CONTRACT_MATCHES).every((v) => v === true)).toBe(true);
    expect([adapterFits, contextFits, claimFits].every((f) => typeof f === "function")).toBe(true);
  });

  it("tells every hook which features the host has", async () => {
    let seen: readonly string[] | undefined;
    const { session } = open({
      onToolStart(_e, ctx) {
        seen = ctx.features;
      },
    });
    await session.onToolStart({ toolCallId: "c1", name: "x", args: {} });
    expect(seen).toEqual([...ADAPTER_FEATURES]);
  });

  it("returns the first valid tool view and disables an adapter that returns an invalid one", async () => {
    const { session } = open({
      toolView(tool) {
        return tool.name === "todo"
          ? { verb: "Updated todo", meta: ["2/5"], hide: false }
          : undefined;
      },
    });
    expect(await session.toolView({ toolCallId: "c", name: "todo", args: {} })).toEqual({
      adapterId: "v2",
      view: { verb: "Updated todo", meta: ["2/5"], hide: false },
    });
    expect(await session.toolView({ toolCallId: "c", name: "other", args: {} })).toBeUndefined();

    const bad = open({ toolView: () => ({ verb: "x".repeat(41) }) });
    expect(await bad.session.toolView({ toolCallId: "c", name: "todo", args: {} })).toBeUndefined();
    expect(bad.session.statuses()[0]).toMatchObject({ status: "disabled" });
    expect(bad.effects.some((e) => e.type === "diagnostic" && e.level === "error")).toBe(true);
  });

  it("carries a claim's kind and names the dialog's tool call only when it is certain", async () => {
    const { session } = open({
      claimInteraction: () => ({
        title: "Pick",
        kind: "question",
        presentation: { t: "text", text: "p" },
        toPiResponse: () => ({ value: "a" }),
      }),
    });
    const none = await session.onUiRequest(select);
    expect(none.kind === "claim" && none.claim.kind).toBe("question");
    expect(none.kind === "claim" && none.toolCallId).toBeUndefined();

    await session.onToolStart({ toolCallId: "c1", name: "ask", args: {} });
    const one = await session.onUiRequest(select);
    expect(one.kind === "claim" && one.toolCallId).toBe("c1");

    await session.onToolStart({ toolCallId: "c2", name: "bash", args: {} });
    const two = await session.onUiRequest(select);
    expect(two.kind === "claim" && two.toolCallId).toBeUndefined();
  });

  it("uses the claim's owner when it names a running call, and refuses an unknown kind", async () => {
    const { session } = open({
      claimInteraction: () => ({
        title: "Allow?",
        kind: "approval",
        ownerToolCallId: "c2",
        presentation: { t: "text", text: "p" },
        toPiResponse: () => ({ value: "a" }),
      }),
    });
    await session.onToolStart({ toolCallId: "c1", name: "a", args: {} });
    await session.onToolStart({ toolCallId: "c2", name: "b", args: {} });
    const r = await session.onUiRequest(select);
    expect(r).toMatchObject({ kind: "claim", toolCallId: "c2", claim: { kind: "approval" } });

    const bad = open({
      claimInteraction: () =>
        ({
          title: "x",
          kind: "survey",
          presentation: { t: "text", text: "p" },
          toPiResponse: () => ({ value: "a" }),
        }) as unknown as Claim,
    });
    const generic = await bad.session.onUiRequest(select);
    expect(generic).toMatchObject({ kind: "claim", adapterId: null });
    expect(bad.session.statuses()[0]).toMatchObject({ status: "disabled" });
  });

  it("accepts trackers, badges and the new nodes in contributions and cards", async () => {
    const { session, effects } = open({
      onToolStart(_e, ctx) {
        ctx.setContribution("t", {
          placement: "composer.tracker",
          title: "Todo",
          mobileFallback: "1/2",
          node: { t: "checklist", items: [{ text: "a", state: "done" }] },
          tracker: { count: "1/2", status: "running" },
        });
        ctx.setContribution("b", {
          placement: "session.badge",
          title: "Mode",
          mobileFallback: "plan",
          node: { t: "badge", text: "plan" },
        });
      },
      toolCard: () => ({ t: "facts", items: [{ label: "k", value: "v" }] }),
    });
    await session.onToolStart({ toolCallId: "c1", name: "x", args: {} });
    const panels = effects.filter((e) => e.type === "panel");
    expect(panels.map((p) => p.type === "panel" && p.contribution?.placement)).toEqual([
      "composer.tracker",
      "session.badge",
    ]);
    expect(await session.toolCard({ toolCallId: "c1", name: "x", args: {} })).toMatchObject({
      node: { t: "facts" },
    });
  });
});
