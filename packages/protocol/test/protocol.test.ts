import { describe, expect, it } from "vitest";
import {
  branchSlug,
  CoordinatorToHost,
  HostCommand,
  isFieldVisible,
  newId,
  Profile,
  SwitchyardError,
  type UINode,
  validateUINode,
} from "../src/index.js";

describe("ids", () => {
  it("prefixes and sorts", () => {
    const a = newId("ses");
    const b = newId("ses");
    expect(a.startsWith("ses_")).toBe(true);
    expect(a < b).toBe(true);
  });
  it("slugs branches", () => {
    expect(branchSlug("feat/x/y")).toBe("feat-x-y");
  });
});

describe("ui", () => {
  it("round-trips a form", () => {
    const node: UINode = {
      t: "section",
      title: "Q",
      children: [
        {
          t: "form",
          formId: "f",
          submitLabel: "Submit",
          fields: [
            { kind: "select", name: "a", label: "A", options: [{ value: "x", label: "X" }] },
            {
              kind: "multiselect",
              name: "b",
              label: "B",
              options: [{ value: "y", label: "Y" }],
              showIf: { field: "a", values: ["x"] },
            },
          ],
        },
      ],
    };
    expect(validateUINode(node)).toEqual(node);
  });
  it("rejects deep trees", () => {
    let node: UINode = { t: "text", text: "leaf" };
    for (let i = 0; i < 13; i++) node = { t: "section", children: [node] };
    expect(() => validateUINode(node)).toThrow(SwitchyardError);
  });
  it("rejects huge trees", () => {
    const items: UINode[] = Array.from({ length: 2001 }, () => ({ t: "text", text: "x" }));
    expect(() => validateUINode({ t: "list", items })).toThrow(/2000/);
  });
  it("evaluates showIf", () => {
    const f = {
      kind: "text" as const,
      name: "c",
      label: "C",
      showIf: { field: "a", values: ["x"] },
    };
    expect(isFieldVisible(f, { a: "x" })).toBe(true);
    expect(isFieldVisible(f, { a: "z" })).toBe(false);
    expect(isFieldVisible(f, { a: ["z", "x"] })).toBe(true);
    expect(isFieldVisible(f, {})).toBe(false);
  });
});

describe("wire", () => {
  it("parses commands", () => {
    const cmd = HostCommand.parse({
      type: "session.prompt",
      sessionId: "ses_1",
      text: "hi",
      mode: "steer",
      origin: "human",
      controlRevision: 1,
    });
    expect(cmd.type).toBe("session.prompt");
    const frame = CoordinatorToHost.parse({ type: "command", commandId: "cmd_1", command: cmd });
    expect(frame.type).toBe("command");
  });
  it("rejects managed profile flags", () => {
    const base = {
      id: "prf_1",
      name: "p",
      provider: null,
      model: null,
      thinking: null,
      projectTrust: "ask",
    };
    expect(Profile.safeParse({ ...base, extraArgs: ["--verbose"] }).success).toBe(true);
    expect(Profile.safeParse({ ...base, extraArgs: ["--session=x"] }).success).toBe(false);
    expect(Profile.safeParse({ ...base, extraArgs: ["--mode"] }).success).toBe(false);
  });
});
