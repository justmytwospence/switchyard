import { describe, expect, it } from "vitest";
import {
  ClientToServer,
  ContributionDescriptor,
  contributionKey,
  contributionSlot,
  Panel,
  TranscriptItem,
  validateContribution,
  validateContributionCard,
} from "../src/index.js";

const base = {
  placement: "sidebar.header",
  title: "Build",
  node: { t: "text", text: "Ready" },
  mobileFallback: "Ready",
};

describe("adapter contributions", () => {
  it("validates each placement and keeps identity distinct from placement", () => {
    for (const placement of [
      "sidebar.header",
      "sidebar.footer",
      "session.panel",
      "composer.pill",
      "palette.item",
      "slash.command",
    ] as const) {
      const input = {
        ...base,
        placement,
        ...(placement === "palette.item" ? { actionId: "run", keywords: ["build"] } : {}),
        ...(placement === "slash.command"
          ? {
              name: "build",
              actionId: "run",
              node: { t: "form", formId: "build", fields: [], submitLabel: "Run" },
            }
          : {}),
      };
      expect(validateContribution("build", input).descriptor.placement).toBe(placement);
    }
    expect(contributionSlot("build")).toBe("@slot/build");
    expect(contributionKey("a,b", "c")).not.toBe(contributionKey("a", "bc"));
  });

  it("refuses invalid content, unexpected fields and JSON bombs", () => {
    expect(() => validateContribution("bad/name", base)).toThrow();
    expect(() => validateContribution("build", { ...base, extra: true })).toThrow();
    expect(() =>
      validateContribution("build", {
        ...base,
        node: { t: "form", formId: "x", fields: [], submitLabel: "Go" },
      }),
    ).toThrow();
    expect(() =>
      validateContribution("build", {
        ...base,
        placement: "composer.pill",
        node: { t: "section", children: [] },
      }),
    ).toThrow();
    expect(() =>
      validateContribution("build", {
        ...base,
        placement: "slash.command",
        name: "run",
        actionId: "run",
      }),
    ).toThrow();
    expect(() => validateContribution("build", { ...base, state: { x: 1 } })).toThrow();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => validateContribution("build", { ...base, state: cycle })).toThrow();
    expect(() =>
      validateContribution("build", { ...base, mobileFallback: "a".repeat(300_000) }),
    ).toThrow();
    expect(() =>
      validateContributionCard({
        t: "confirm",
        message: "?",
        confirmLabel: "Yes",
        cancelLabel: "No",
      }),
    ).toThrow();
  });

  it("retains old panel and notice shapes; new descriptors require valid metadata", () => {
    const panel = {
      sessionId: "ses_1",
      adapterId: "a",
      slot: "normal",
      title: "Legacy",
      node: null,
      webRenderer: false,
      mobileFallback: null,
      updatedAt: new Date().toISOString(),
    };
    expect(Panel.parse(panel).contribution).toBeUndefined();
    const notice = {
      id: "itm_1",
      sessionId: "ses_1",
      order: 1,
      at: new Date().toISOString(),
      kind: "notice",
      data: { level: "info", text: "Legacy" },
    };
    expect(TranscriptItem.parse(notice).data).toEqual(notice.data);
    expect(
      TranscriptItem.safeParse({
        ...notice,
        data: { ...notice.data, card: { t: "text", text: "Card" } },
      }).success,
    ).toBe(false);
    expect(ContributionDescriptor.safeParse({ id: "b", placement: "palette.item" }).success).toBe(
      false,
    );
  });

  it("accepts additive client capabilities without requiring them", () => {
    expect(ClientToServer.parse({ type: "hello", cursor: null })).toMatchObject({ type: "hello" });
    expect(
      ClientToServer.parse({
        type: "hello",
        cursor: 2,
        capabilities: ["unknown"],
        projectionId: "v1:",
      }).capabilities,
    ).toEqual(["unknown"]);
  });
});
