import type { Interaction } from "@switchyard/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Integration, steps, uiResponses } from "./harness.js";

/** Spec §19: interaction-answer races. */
describe("interaction answer race", { timeout: 120_000 }, () => {
  let env: Integration;
  beforeAll(async () => {
    env = await Integration.create();
  });
  afterAll(async () => {
    await env?.dispose();
  });

  it("two concurrent answers: one 200, one 409 already_answered; Pi gets one response", async () => {
    const { terminal, desktop } = env.devices!;
    const s = await env.createSession(terminal, "", "Race");
    const pid = await env.livePi(s.id);
    await env.ok("POST", `/api/sessions/${s.id}/prompt`, {
      as: terminal,
      body: { text: `Pick something ${steps("select", "done")}` },
    });
    const pending = await env.pendingInteraction(s.id);
    expect(pending.title).toBe("Pick a fruit");
    expect(pending.adapterId).toBeNull();
    const before = uiResponses.filter((r) => r.pid === pid).length;
    expect(before).toBe(0);

    const answer = (as: typeof terminal, value: string) =>
      env.api("POST", `/api/interactions/${pending.id}/answer`, {
        as,
        body: { revision: pending.revision, response: { kind: "form", values: { value } } },
      });
    const [a, b] = await Promise.all([answer(terminal, "Apple"), answer(desktop, "Banana")]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const winner = a.status === 200 ? a : b;
    const loser = a.status === 200 ? b : a;
    const winnerDevice = a.status === 200 ? terminal : desktop;
    const winnerValue = a.status === 200 ? "Apple" : "Banana";
    expect(winner.body.status).toBe("answered");
    expect(winner.body.interaction.state).toBe("resolved");
    expect(winner.body.interaction.resolution.by).toBe(winnerDevice.id);
    expect(loser.body.error.code).toBe("already_answered");
    const accepted = loser.body.error.details.interaction as Interaction;
    expect(accepted.id).toBe(pending.id);
    expect(accepted.state).toBe("resolved");
    expect(accepted.resolution).toEqual(winner.body.interaction.resolution);

    // The tool saw the winning value; the run finished.
    await env.waitSession(
      s.id,
      (x) => x.runtime === "idle" && /SWITCHYARD: DONE/.test(x.lastAssistantText ?? ""),
      "settled",
    );
    const items = (await env.ok("GET", `/api/sessions/${s.id}/transcript`)).items as any[];
    const tool = items.find((i) => i.kind === "tool" && i.data.name === "fixture_select");
    expect(JSON.stringify(tool.data)).toContain(`selected ${winnerValue}`);

    // Exactly one extension_ui_response reached Pi.
    const sent = uiResponses.filter((r) => r.pid === pid);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toEqual({ value: winnerValue });

    // A third, late answer is also refused with the accepted resolution.
    const late = await answer(terminal, "Apple");
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("already_answered");
    expect(late.body.error.details.interaction.resolution).toEqual(
      winner.body.interaction.resolution,
    );
    expect(uiResponses.filter((r) => r.pid === pid)).toHaveLength(1);
  });
});
