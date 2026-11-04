import type { UINode } from "@switchyard/protocol";
import { describe, expect, it } from "vitest";
import { splitPresentation } from "../src/components/intent/InteractionCard";

const actions: UINode = { t: "actions", actions: [{ id: "a", label: "Yes" }] };

describe("splitPresentation", () => {
  it("splits content from a trailing row of actions", () => {
    const node: UINode = {
      t: "section",
      children: [{ t: "markdown", text: "# Plan" }, actions],
    };
    const split = splitPresentation(node);
    expect(split?.actions).toEqual(actions);
    expect(split?.body).toMatchObject({
      t: "section",
      children: [{ t: "markdown", text: "# Plan" }],
    });
  });
  it("leaves other shapes alone", () => {
    expect(splitPresentation(actions)).toBeNull();
    expect(splitPresentation({ t: "section", children: [actions] })).toBeNull();
    expect(
      splitPresentation({
        t: "section",
        children: [
          { t: "markdown", text: "x" },
          { t: "text", text: "y" },
        ],
      }),
    ).toBeNull();
  });
});
