import type { UINode } from "@switchyard/protocol";
import { describe, expect, it } from "vitest";
import {
  isDocumentPresentation,
  stripLeadingTitle,
} from "../src/components/intent/InteractionCard";

const actions: UINode = { t: "actions", actions: [{ id: "a", label: "Yes" }] };
const plan = (text: string): UINode => ({
  t: "section",
  children: [{ t: "markdown", text }, actions],
});

describe("document presentation", () => {
  it("is true for a long plan with options", () => {
    expect(isDocumentPresentation(plan("x".repeat(500)))).toBe(true);
    expect(isDocumentPresentation(plan("a\n".repeat(13)))).toBe(true);
  });
  it("is false for short text, no actions, or forms", () => {
    expect(isDocumentPresentation(plan("short"))).toBe(false);
    expect(
      isDocumentPresentation({
        t: "section",
        children: [{ t: "markdown", text: "x".repeat(500) }],
      }),
    ).toBe(false);
    expect(isDocumentPresentation({ t: "form", formId: "f", fields: [], submitLabel: "Go" })).toBe(
      false,
    );
  });
  it("drops a leading heading that repeats the title", () => {
    expect(stripLeadingTitle("# Implement this plan\n\nBody", "Implement this plan?")).toBe("Body");
    expect(stripLeadingTitle("# Other\n\nBody", "Implement this plan?")).toBe("# Other\n\nBody");
  });
});
