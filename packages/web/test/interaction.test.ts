import type { UINode } from "@switchyard/protocol";
import { describe, expect, it } from "vitest";
import {
  documentSections,
  isDocumentPresentation,
  leadingHeading,
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
  it("takes the leading heading as the title", () => {
    expect(leadingHeading("# Add tests\n\nBody")).toEqual({ title: "Add tests", rest: "Body" });
    expect(leadingHeading("No heading")).toEqual({ title: null, rest: "No heading" });
  });
  it("lists h2 sections and ignores fenced code", () => {
    const md = "## One\ntext\n```\n## not a heading\n```\n## Two words\n";
    expect(documentSections(md)).toEqual([
      { text: "One", id: "plan-one" },
      { text: "Two words", id: "plan-two-words" },
    ]);
  });
});
