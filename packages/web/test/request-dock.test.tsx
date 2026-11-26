import type { Interaction, UINode } from "@switchyard/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InteractionCard } from "../src/components/intent/InteractionCard";
import { TimelineRow } from "../src/features/code/TranscriptItems";
import { interaction } from "./fixtures";

const options = ["Apple", "Pear"].map((v) => ({ value: v, label: v }));
const select = (name: string, label: string) => ({ kind: "select" as const, name, label, options });
const form = (fields: ReturnType<typeof select>[]): UINode => ({
  t: "form",
  formId: "f",
  fields,
  submitLabel: "Send answer",
  cancelLabel: "Cancel",
});
const PLAN_TEXT = `# Ship it\n\n${"Plan body sentence. ".repeat(40)}`;
const plan: UINode = {
  t: "section",
  children: [
    { t: "markdown", text: PLAN_TEXT },
    {
      t: "actions",
      actions: [
        { id: "yes", label: "Approve the plan" },
        { id: "no", label: "Keep planning" },
      ],
    },
  ],
};
const row = (i: Interaction) =>
  renderToStaticMarkup(
    <TimelineRow
      entry={{ type: "interaction", key: `interaction:${i.id}`, interaction: i }}
      sessionId="ses_1"
      interactionReadOnly={null}
      highlightInteractionId={null}
    />,
  );

describe("request dock", () => {
  it("shows a one-question form under one title, with its submit button", () => {
    const html = renderToStaticMarkup(
      <InteractionCard
        mode="dock"
        interaction={interaction("int_1", {
          title: "Pick a fruit",
          presentation: form([select("q", "Pick a fruit")]),
        })}
      />,
    );
    expect(html).toContain("<h3");
    expect(html).toContain('<legend class="sr-only">Pick a fruit</legend>');
    expect(html).not.toContain("Needs input");
    expect(html).toContain("Send answer");
    expect(html).not.toContain("Next");
  });

  it("steps through a form with several questions", () => {
    const html = renderToStaticMarkup(
      <InteractionCard
        mode="dock"
        interaction={interaction("int_1", {
          title: "Two things",
          presentation: form([select("a", "First question"), select("b", "Second question")]),
        })}
      />,
    );
    expect(html).toContain('aria-label="Questions"');
    expect(html).toContain("Question 2 of 2: Second question");
    expect(html).toContain(">Next<");
    expect(html).not.toContain("Send answer");
    expect(html.split("<fieldset").length - 1).toBe(1);
  });

  it("keeps the whole form outside the dock", () => {
    const html = renderToStaticMarkup(
      <InteractionCard
        interaction={interaction("int_1", {
          title: "Two things",
          presentation: form([select("a", "First question"), select("b", "Second question")]),
        })}
      />,
    );
    expect(html.split("<fieldset").length - 1).toBe(2);
    expect(html).toContain("Needs input");
    expect(html).not.toContain('aria-label="Questions"');
  });

  it("splits a plan into its text and its answers", () => {
    const asked = interaction("int_1", { title: "Approve this plan?", presentation: plan });
    const reader = renderToStaticMarkup(<InteractionCard mode="reader" interaction={asked} />);
    expect(reader).toContain('data-testid="document-interaction"');
    expect(reader).toContain("Plan body sentence.");
    expect(reader).not.toContain("Approve the plan");
    expect(reader).not.toContain("Keep planning");

    const dock = renderToStaticMarkup(
      <InteractionCard mode="dock" interaction={asked} planAnchorId="interaction-int_1" />,
    );
    expect(dock).toContain('data-testid="answer-bar"');
    expect(dock).toContain("Approve the plan");
    expect(dock).toContain("Keep planning");
    expect(dock).toContain("Plan start");
    expect(dock).not.toContain("Plan body sentence.");
    expect(dock).not.toContain('data-testid="document-interaction"');
  });

  it("says why a plan cannot be answered instead of offering its answers", () => {
    const dock = renderToStaticMarkup(
      <InteractionCard
        mode="dock"
        readOnlyReason="Host mac is offline."
        interaction={interaction("int_1", { title: "Approve this plan?", presentation: plan })}
      />,
    );
    expect(dock).toContain("Host mac is offline.");
    expect(dock).not.toContain("Approve the plan");
  });
});

describe("questions in the transcript", () => {
  it("leaves a pending question to the dock", () => {
    expect(row(interaction("int_1", { presentation: form([select("q", "Pick one")]) }))).toBe("");
  });

  it("keeps a pending plan's text", () => {
    const html = row(interaction("int_1", { presentation: plan }));
    expect(html).toContain('data-testid="interaction-card"');
    expect(html).toContain("Plan body sentence.");
    expect(html).not.toContain("Approve the plan");
  });

  it("shows an answered question as one line", () => {
    const html = row(
      interaction("int_1", {
        title: "Pick a fruit",
        state: "resolved",
        resolution: { by: "dev_1", summary: "Apple", at: "2026-11-01T10:00:00.000Z" },
      }),
    );
    expect(html).toContain('data-testid="interaction-outcome"');
    expect(html).toContain("Pick a fruit");
    expect(html).toContain("Apple");
    expect(html).toContain("Answered by a device");
    expect(html).not.toContain("<h3");
  });

  it("names how an unanswered question closed", () => {
    expect(row(interaction("int_1", { state: "expired" }))).toContain("expired");
    expect(row(interaction("int_1", { state: "canceled" }))).toContain("canceled");
  });
});
