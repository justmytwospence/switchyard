// @module-tag slow
import { existsSync } from "node:fs";
import { join } from "node:path";
import { terminalSupport } from "@switchyard/pi-runtime";
import type { Interaction } from "@switchyard/protocol";
import { type MockScript, when } from "@switchyard/test-fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type CompatHarness,
  type CompatSession,
  compatSkipReason,
  legacyBoundAdapter,
  pluginInfo,
  recordResult,
  startCompatHarness,
  toolItem,
  waitFor,
} from "./helpers.js";

const skip = compatSkipReason();

const script: MockScript = [
  {
    // The gate can append its settings reminder after the human message.
    when: (r) =>
      r.lastRole === "user" &&
      !r.messages.some((m) => m.role === "tool") &&
      r.messages.some((m) => m.role === "user" && JSON.stringify(m.content).includes("say hello")),
    reply: { toolCalls: [{ name: "bash", arguments: { command: "echo hello" } }] },
  },
  { when: when.toolResult("bash"), reply: (r) => ({ text: `bash said: ${r.lastText}` }) },
];

/**
 * pi-tool-gate has no manual approval mode: `/approvals` offers only Auto and Yolo, and in Auto
 * the gate judges each call itself (offline, with no judge reachable, it auto-approves). The
 * offline way to make it ask the user is a permission rule of kind `ask`, added for this session
 * with `/gate rules add ask Bash(echo:*) --scope session`; a matching call is held and the user is
 * asked, without consulting the judge.
 */
describe.skipIf(skip !== null)(`tool-gate compat${skip ? ` (${skip})` : ""}`, () => {
  let h: CompatHarness;
  const results: Record<string, any> = {};
  beforeAll(async () => {
    // The harness gives Pi an empty HOME: the plugin reads user-level config from ~/.config/agents/tool-gate.json.
    h = await startCompatHarness({ plugins: ["pi-tool-gate"], script });
  });
  afterAll(async () => {
    recordResult("tool-gate", { plugin: pluginInfo(["pi-tool-gate"]), ...results });
    await h?.dispose();
  });

  it("renders the approval card for an ask-rule bash call and Block blocks it", async () => {
    const s = await h.startSession();

    // /approvals: a plain select answered through the generic renderer (kept on Auto).
    const approvals = s.prompt("/approvals");
    await waitFor(
      () => s.latestInteractions().some((i) => i.state === "pending"),
      15000,
      "approvals select",
    );
    const modeSelect = s.latestInteractions().find((i) => i.state === "pending")!;
    results.approvalsRequest = s.uiRequests.find((r) => r.method === "select") as any;
    expect(modeSelect).toMatchObject({
      adapterId: null,
      title: expect.stringMatching(/^Approvals(?: · Permission prompts: on)?$/),
      source: { kind: "extension_ui", method: "select" },
    });
    const presentation = modeSelect.presentation as any;
    const form =
      presentation.t === "form"
        ? presentation
        : presentation.children.find((n: any) => n.t === "form");
    expect(form).toMatchObject({ t: "form", formId: "generic" });
    const modes = form.fields[0].options.map((o: any) => o.value);
    results.approvalModes = modes;
    expect(modes).toContain("Auto");
    // Answered through the routed `session.answer` command while the `/approvals` prompt is still
    // running: Pi answers a /command prompt only after its handler, which waits on this select, so
    // the answer must not queue behind the prompt (control lane in CommandRouter).
    expect(await s.answer(modeSelect, { kind: "form", values: { value: "Auto" } })).toMatchObject({
      status: "answered",
    });
    expect(await approvals).toMatchObject({ disposition: expect.any(String) });
    expect(s.uiResponses.find((r) => r.id === results.approvalsRequest?.id)?.body).toEqual({
      value: "Auto",
    });

    // An ask rule for this session makes the gate ask the user (no judge, no network).
    const n0 = s.uiRequests.length;
    await s.prompt("/gate rules add ask Bash(echo:*) --scope session");
    await waitFor(
      () => s.uiRequests.slice(n0).some((r) => r.method === "notify"),
      10000,
      "rule notice",
    );
    expect(s.uiRequests.slice(n0).find((r) => r.method === "notify")?.message).toContain(
      "Added to ask: Bash(echo:*)",
    );

    const before = s.settledCount();
    await s.prompt("please say hello");
    let card: Interaction | undefined;
    try {
      await waitFor(
        () => {
          card = s.latestInteractions().find((i) => i.state === "pending");
          return card !== undefined;
        },
        30000,
        "approval card",
      );
    } finally {
      results.rawUiRequests = structuredClone(s.uiRequests);
      results.toolEnds = s.toolEnds("bash");
      results.modelRequests = h.mock.requests;
      results.adapters = h.agent.supervisor.sessionAdapters(s.id);
    }
    const raw = s.uiRequests.find((r) => r.method === "select" && r.title.startsWith("Allow"));
    results.approvalRequest = raw;
    if (await legacyBoundAdapter(h, s, "pi-tool-gate", "tool-gate")) {
      expect(card).toMatchObject({ adapterId: null });
      expect(raw.options).toContain("Block");
      expect(await s.answer(card!, { kind: "form", values: { value: "Block" } })).toMatchObject({
        status: "answered",
      });
      await s.waitSettled(before);
      expect(s.uiResponses.find((r) => r.id === raw.id)?.body).toEqual({ value: "Block" });
      expect(s.toolEnds("bash").at(-1)?.isError).toBe(true);
      expect(toolItem(s, "bash")?.data.status).toBe("error");
      return;
    }
    expect(card).toMatchObject({
      adapterId: "tool-gate",
      title: "Allow this call? bash",
      presentation: { t: "section", title: "Allow this call?" },
    });
    // Claimed by the adapter pi-tool-gate ships, loaded through the plugin tier.
    expect(h.adapter("tool-gate")).toMatchObject({ tier: "plugin" });
    const children = (card!.presentation as any).children as any[];
    const table = children.find((c) => c.t === "table");
    const rows = Object.fromEntries(table.rows as [string, string][]);
    expect(rows).toMatchObject({ Action: "bash", Target: "echo hello" });
    expect(rows.Held).toContain("Bash(echo:*)");
    const actions = children.find((c) => c.t === "actions").actions as any[];
    expect(actions.map((a) => a.label)).toEqual(raw.options);
    const block = actions.find((a) => a.label === "Block");
    expect(block).toMatchObject({ tone: "danger" });

    expect(await s.answer(card!, { kind: "action", actionId: block.id })).toMatchObject({
      status: "answered",
    });
    await s.waitSettled(before);
    expect(s.uiResponses.find((r) => r.id === raw.id)?.body).toEqual({ value: "Block" });
    const end = s.toolEnds("bash").at(-1);
    results.blockedToolEnd = end;
    expect(end?.isError).toBe(true);
    expect(JSON.stringify(end?.result)).toContain("declined");
    expect(toolItem(s, "bash")?.data.status).toBe("error");
    // The ask rule decided it: no System 1 judge was consulted.
    expect(raw.title).toContain("matches the ask rule");
    expect(
      s.piEvents.some(
        (e) => e.type === "entry_appended" && e.entry?.customType === "system1:decision",
      ),
    ).toBe(false);
  });
});

const terminalSkip = skip ?? (!terminalSupport().ok ? "terminal support unavailable" : null);
describe.skipIf(terminalSkip !== null)(
  `tool-gate terminal compat${terminalSkip ? ` (${terminalSkip})` : ""}`,
  () => {
    let h: CompatHarness;
    beforeAll(async () => {
      h = await startCompatHarness({ plugins: ["pi-tool-gate"], script, terminalSessions: true });
    });
    afterAll(async () => {
      await h?.dispose();
    });

    async function approval(s: CompatSession) {
      const n0 = s.uiRequests.length;
      await s.prompt("/gate rules add ask Bash(echo:*) --scope session");
      await waitFor(
        () =>
          s.uiRequests
            .slice(n0)
            .some((r) => r.method === "notify" && r.message.includes("Added to ask: Bash(echo:*)")),
        10000,
        "rule notice",
      );
      const before = s.settledCount();
      await s.prompt("please say hello");
      const mirror = existsSync(join(h.suiteDir, "packages/pi-tool-gate/src/switchyard-remote.ts"));
      await waitFor(
        () =>
          s
            .latestInteractions()
            .some((i) => (mirror ? i.state === "pending" : i.source.kind === "unsupported_custom")),
        30000,
        "terminal approval",
      );
      if (!mirror) {
        expect(s.latestInteractions().some((i) => i.source.kind === "unsupported_custom")).toBe(
          true,
        );
        expect(s.latestInteractions().filter((i) => i.state === "pending")).toEqual([]);
        return null;
      }
      const pending = s.latestInteractions().filter((i) => i.state === "pending");
      expect(pending).toHaveLength(1);
      expect(s.latestInteractions().filter((i) => i.source.kind === "unsupported_custom")).toEqual(
        [],
      );
      const card = pending[0]!;
      const legacy = await legacyBoundAdapter(h, s, "pi-tool-gate", "tool-gate");
      if (legacy) {
        expect(card).toMatchObject({
          adapterId: null,
          source: { kind: "extension_ui", method: "select" },
        });
      } else {
        expect(card).toMatchObject({ adapterId: "tool-gate", kind: "approval" });
        const facts = (card.presentation as any).children.find((c: any) => c.t === "facts");
        expect(facts.items).toContainEqual(
          expect.objectContaining({ label: "Directory", value: h.pi.cwd }),
        );
      }
      const response = (label: string) => {
        if (legacy) return { kind: "form" as const, values: { value: label } };
        const actions = (card.presentation as any).children.find(
          (c: any) => c.t === "actions",
        ).actions;
        const action = actions.find((a: any) => a.label === label);
        expect(action).toBeDefined();
        return { kind: "action" as const, actionId: action.id as string };
      };
      return { card, before, response };
    }

    it("blocks a held terminal call from the web", async () => {
      const s = await h.startSession();
      const a = await approval(s);
      if (!a) return;
      expect(await s.answer(a.card, a.response("Block"))).toMatchObject({ status: "answered" });
      await s.waitSettled(a.before);
      expect(s.toolEnds("bash")).toHaveLength(1);
      expect(s.toolEnds("bash")[0].isError).toBe(true);
    }, 90000);

    it("lets native Escape win in an enrolled terminal", async () => {
      const s = await h.startEnrolledSession();
      const a = await approval(s);
      if (!a) return;
      await waitFor(
        () => s.terminal.output().includes("Allow once"),
        15000,
        "native approval screen",
      );
      s.terminal.write("\x1b");
      await waitFor(
        () =>
          s.latestInteractions().some((i) => i.id === a.card.id && i.resolution?.by === "terminal"),
        15000,
        "terminal resolution",
      );
      expect(await s.answer(a.card, a.response("Allow once"))).toMatchObject({
        status: "already_answered",
      });
      await s.waitSettled(a.before);
      expect(s.toolEnds("bash")).toHaveLength(1);
      expect(s.toolEnds("bash")[0].isError).toBe(true);
      expect(JSON.stringify(s.toolEnds("bash")[0].result)).not.toContain("hello\n");
    }, 90000);

    it("lets the web allow an enrolled call without native input", async () => {
      const s = await h.startEnrolledSession();
      const a = await approval(s);
      if (!a) return;
      await waitFor(
        () => s.terminal.output().includes("Allow once"),
        15000,
        "native approval screen",
      );
      expect(await s.answer(a.card, a.response("Allow once"))).toMatchObject({
        status: "answered",
      });
      await s.waitSettled(a.before);
      expect(s.toolEnds("bash")).toHaveLength(1);
      expect(s.toolEnds("bash")[0].isError).toBe(false);
      expect(JSON.stringify(s.toolEnds("bash")[0].result)).toContain("hello");
      expect(await s.answer(a.card, a.response("Allow once"))).toMatchObject({
        status: "already_answered",
      });
    }, 90000);
  },
);
