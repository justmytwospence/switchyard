import type { Interaction } from "@switchyard/protocol";
import { type MockScript, when } from "@switchyard/test-fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type CompatHarness,
  compatSkipReason,
  pluginInfo,
  recordResult,
  startCompatHarness,
  toolItem,
  waitFor,
} from "./helpers.js";

const skip = compatSkipReason();

const script: MockScript = [
  {
    when: when.userSays("say hello"),
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
      title: "Approvals",
      source: { kind: "extension_ui", method: "select" },
      presentation: { t: "form", formId: "generic" },
    });
    const modes = (modeSelect.presentation as any).fields[0].options.map((o: any) => o.value);
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
    await waitFor(
      () => {
        card = s.latestInteractions().find((i) => i.state === "pending");
        return card !== undefined;
      },
      30000,
      "approval card",
    );
    const raw = s.uiRequests.find((r) => r.method === "select" && r.title.startsWith("Allow"));
    results.approvalRequest = raw;
    expect(card).toMatchObject({
      adapterId: "tool-gate",
      title: "Allow this call? bash",
      presentation: { t: "section", title: "Allow this call?" },
    });
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
