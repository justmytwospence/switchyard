import { writeFileSync } from "node:fs";
import { type MockScript, when } from "@switchyard/test-fixtures";
import { describe, expect, it } from "vitest";
import {
  compatSkipReason,
  legacyBoundAdapter,
  pluginInfo,
  recordResult,
  startCompatHarness,
  toolItem,
  waitFor,
} from "./helpers.js";

const skip = compatSkipReason();
const plan = "# Compat plan\n\nKeep workflow authority in the Pi plugin.\n";
const script: MockScript = [
  {
    when: when.userSays("enter planning"),
    reply: { toolCalls: [{ name: "enter_plan_mode", arguments: {} }] },
  },
  { when: when.toolResult("enter_plan_mode"), reply: { text: "Planning is active." } },
  {
    when: when.userSays("review planning"),
    reply: { toolCalls: [{ name: "exit_plan_mode", arguments: {} }] },
  },
  { when: when.toolResult("exit_plan_mode"), reply: { text: "Review finished." } },
];

describe.skipIf(skip !== null)(`plan mode compat${skip ? ` (${skip})` : ""}`, () => {
  for (const terminalSessions of [false, true]) {
    it(`shows the real plan approval and cancellation never implements (${terminalSessions ? "terminal" : "rpc"})`, async () => {
      const h = await startCompatHarness({ plugins: ["pi-plan-mode"], script, terminalSessions });
      try {
        const s = await h.startSession();
        const before = s.settledCount();
        await s.prompt("enter planning");
        await s.waitSettled(before);
        expect(s.toolEnds("enter_plan_mode").at(-1)?.isError).toBe(false);
        const entry = s.piEvents.find(
          (e) => e.type === "entry_appended" && e.entry?.data?.planFile,
        );
        expect(entry?.entry.data.planFile).toEqual(expect.any(String));
        writeFileSync(entry.entry.data.planFile, plan);
        const next = s.settledCount();
        await s.prompt("review planning");
        if (await legacyBoundAdapter(h, s, "pi-plan-mode", "plan-mode")) {
          await waitFor(
            () => s.latestInteractions().some((i) => i.state === "pending"),
            30000,
            "generic plan approval",
          );
          const approval = s.latestInteractions().find((i) => i.state === "pending")!;
          expect(approval.adapterId).toBeNull();
          expect(await s.answer(approval, { kind: "cancel" })).toMatchObject({
            status: "answered",
          });
          await s.waitSettled(next);
          expect(s.toolEnds("exit_plan_mode").at(-1)?.result?.details?.outcome).not.toBe(
            "approved",
          );
          expect(s.latestInteractions().every((i) => i.state !== "pending")).toBe(true);
          expect(s.toolEnds("bash")).toEqual([]);
          return;
        }
        await waitFor(
          () =>
            s
              .latestInteractions()
              .some(
                (i) =>
                  i.state === "pending" &&
                  i.adapterId === "plan-mode" &&
                  JSON.stringify(i.presentation).includes(JSON.stringify(plan.trim())),
              ),
          30000,
          "adapter-owned plan approval (including a late RPC tool update)",
        );
        const approval = s.latestInteractions().find((i) => i.state === "pending")!;
        recordResult(`plan-mode-${terminalSessions ? "terminal" : "rpc"}`, {
          plugin: pluginInfo(["pi-plan-mode"]),
          approval,
          ui: s.uiRequests,
          piEvents: s.piEvents,
          adapters: h.agent.supervisor.sessionAdapters(s.id),
        });
        expect(
          approval,
          JSON.stringify({ ui: s.uiRequests, adapters: h.agent.supervisor.sessionAdapters(s.id) }),
        ).toMatchObject({ adapterId: "plan-mode" });
        expect(JSON.stringify(approval.presentation)).toContain(JSON.stringify(plan.trim()));
        expect(h.adapter("plan-mode")).toMatchObject({ tier: "plugin" });
        // Both legacy panels and portable contributions use the same host panel projection.
        expect(
          s
            .panels()
            .some(
              (p) =>
                p.adapterId === "plan-mode" &&
                JSON.stringify(p.node).includes("Keep workflow authority"),
            ),
        ).toBe(true);
        expect(await s.answer(approval, { kind: "cancel" })).toMatchObject({ status: "answered" });
        await s.waitSettled(next);
        const end = s.toolEnds("exit_plan_mode").at(-1);
        expect(end?.isError).toBe(false);
        expect(end?.result?.details?.outcome).not.toBe("approved");
        expect(s.latestInteractions().every((i) => i.state !== "pending")).toBe(true);
        expect(toolItem(s, "exit_plan_mode")?.data.status).toBe("ok");
        expect(s.toolEnds("bash")).toEqual([]);
      } finally {
        await h.dispose();
      }
    }, 90000);
  }
});
