import type { InteractionResponse, UINode } from "@switchyard/protocol";
import { describe, expect, it } from "vitest";
import {
  controlLines,
  type InteractionStep,
  type InteractionUi,
  initialInteractionUi,
  interactionKey,
  isTyping,
} from "../src/interaction.js";
import type { KeyPress } from "../src/keys.js";
import { interaction } from "./fixtures.js";

const ENTER: KeyPress = { return: true };
const DOWN: KeyPress = { downArrow: true };
const UP: KeyPress = { upArrow: true };

/** Feed keys; return the final UI and the submitted response, if any. */
function press(
  ui: InteractionUi,
  keys: (KeyPress | string)[],
): { ui: InteractionUi; response: InteractionResponse | null } {
  let cur = ui;
  let response: InteractionResponse | null = null;
  for (const k of keys) {
    const step: InteractionStep =
      typeof k === "string" ? interactionKey(cur, k, {}) : interactionKey(cur, "", k);
    if (step.kind === "update") cur = step.ui;
    if (step.kind === "submit") {
      cur = step.ui;
      response = step.response;
    }
  }
  return { ui: cur, response };
}

const fruit = {
  kind: "select" as const,
  name: "q1",
  label: "Fruit",
  options: [
    { value: "Apple", label: "Apple" },
    { value: "Pear", label: "Pear" },
  ],
  allowOther: { label: "Other" },
};
const letters = {
  kind: "multiselect" as const,
  name: "q2",
  label: "Letters",
  options: ["A", "B", "C"].map((v) => ({ value: v, label: v })),
};

function formNode(fields: unknown[], cancelLabel?: string): UINode {
  return {
    t: "section",
    title: "Questions",
    children: [
      { t: "markdown", text: "Please answer" },
      { t: "form", formId: "f", fields, submitLabel: "Submit", cancelLabel } as UINode,
    ],
  };
}

describe("interaction keyboard model", () => {
  it("answers a select with arrows and Enter, and a multiselect with Space then Enter", () => {
    const ui = initialInteractionUi(interaction(formNode([fruit, letters])));
    expect(ui.body).toEqual(["Questions", "  Please answer"]);
    const { response } = press(ui, [ENTER, " ", DOWN, DOWN, " ", ENTER]);
    expect(response).toEqual({ kind: "form", values: { q1: "Apple", q2: ["A", "C"] } });
  });

  it("never accepts comma-separated typing for a multiselect", () => {
    const ui = initialInteractionUi(interaction(formNode([letters])));
    const { ui: after, response } = press(ui, ["1", ",", "3", ENTER]);
    expect(response).toEqual({ kind: "form", values: { q2: [] } });
    expect(after.values.q2?.selected).toEqual([]);
  });

  it("supports Other text on a select", () => {
    const ui = initialInteractionUi(interaction(formNode([fruit])));
    let r = press(ui, [UP]);
    expect(isTyping(r.ui)).toBe(true);
    r = press(r.ui, ["K", "i", "w", "i", { backspace: true }, "i", ENTER]);
    expect(r.response).toEqual({ kind: "form", values: { q1: { other: "Kiwi" } } });
  });

  it("requires a value for an empty Other", () => {
    const ui = initialInteractionUi(interaction(formNode([fruit])));
    const r = press(ui, [UP, ENTER, ENTER]);
    expect(r.response).toBeNull();
    expect(r.ui.error).toMatch(/Other/);
  });

  it("enforces multiselect min and max", () => {
    const ui = initialInteractionUi(interaction(formNode([{ ...letters, min: 1, max: 2 }])));
    let r = press(ui, [ENTER]);
    expect(r.response).toBeNull();
    expect(r.ui.error).toBe("Choose at least 1");
    r = press(r.ui, [" ", DOWN, " ", DOWN, " "]);
    expect(r.ui.values.q2?.selected).toEqual(["A", "B"]);
    expect(r.ui.error).toBe("Choose at most 2");
  });

  it("hides showIf fields and omits them from the values", () => {
    const follow = {
      kind: "text" as const,
      name: "why",
      label: "Why pear?",
      showIf: { field: "q1", values: ["Pear"] },
    };
    const ui = initialInteractionUi(interaction(formNode([fruit, follow])));
    const apple = press(ui, [ENTER]);
    expect(apple.response).toEqual({ kind: "form", values: { q1: "Apple" } });
    const pear = press(ui, [DOWN, ENTER, "j", "u", "i", "c", "y", ENTER]);
    expect(pear.response).toEqual({ kind: "form", values: { q1: "Pear", why: "juicy" } });
  });

  it("inserts newlines with Alt+Enter only in multi-line text fields", () => {
    const ui = initialInteractionUi(
      interaction(
        formNode([{ kind: "text", name: "msg", label: "Message", multiline: true, prefill: "a" }]),
      ),
    );
    const r = press(ui, [{ return: true, meta: true }, "b", ENTER]);
    expect(r.response).toEqual({ kind: "form", values: { msg: "a\nb" } });
  });

  it("offers Cancel on the button row when the form has a cancel label", () => {
    const ui = initialInteractionUi(interaction(formNode([letters], "Skip")));
    const r = press(ui, [{ tab: true }, { rightArrow: true }, ENTER]);
    expect(r.response).toEqual({ kind: "cancel" });
  });

  it("answers confirm dialogs", () => {
    const node: UINode = {
      t: "confirm",
      message: "Delete?",
      confirmLabel: "Yes",
      cancelLabel: "No",
    };
    const ui = initialInteractionUi(interaction(node));
    expect(press(ui, [ENTER]).response).toEqual({ kind: "confirm", confirmed: true });
    expect(press(ui, [{ rightArrow: true }, ENTER]).response).toEqual({
      kind: "confirm",
      confirmed: false,
    });
    expect(press(ui, ["n"]).response).toEqual({ kind: "confirm", confirmed: false });
  });

  it("runs actions", () => {
    const node: UINode = {
      t: "section",
      title: "Allow this call?",
      children: [
        { t: "table", columns: ["Field", "Value"], rows: [["Action", "bash"]] },
        {
          t: "actions",
          actions: [
            { id: "allow", label: "Allow once", tone: "primary" },
            { id: "block", label: "Block", tone: "danger" },
          ],
        },
      ],
    };
    const ui = initialInteractionUi(interaction(node));
    expect(ui.body.join("\n")).toContain("Action");
    expect(press(ui, [DOWN, ENTER]).response).toEqual({ kind: "action", actionId: "block" });
    expect(controlLines(ui).map((l) => l.text)).toContain("> Allow once");
  });
});
