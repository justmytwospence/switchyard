import { describe, expect, it } from "vitest";
import { toolPayloadParts } from "../src/features/code/toolPayload";

describe("tool payload presentation", () => {
  it("preserves ordinary logs", () => {
    for (const text of [
      "[INFO] hello",
      "[1] exit",
      "{not json}",
      "ordinary text",
      "{starting server\noutput\n… (truncated, 40000 characters)",
    ])
      expect(toolPayloadParts(text, false)).toEqual([{ kind: "text", text }]);
  });
  it("parses containers, fences, quoted brackets and successive documents with a note", () => {
    expect(toolPayloadParts('{"a":"}\\"["}\n[true]\nResult note', false)).toEqual([
      { kind: "data", value: { a: '}"[' } },
      { kind: "data", value: [true] },
      { kind: "text", text: "\nResult note" },
    ]);
    expect(toolPayloadParts('```JSON\n{"x": 1}\n```', false)).toEqual([
      { kind: "data", value: { x: 1 } },
    ]);
    expect(toolPayloadParts('{"x":1} trailing', false)).toEqual([
      { kind: "text", text: '{"x":1} trailing' },
    ]);
  });
  it("hides incomplete, malformed and bounded structured data", () => {
    expect(toolPayloadParts('{"secret":', true)).toEqual([{ kind: "pending" }]);
    expect(toolPayloadParts('{"secret":', false)).toEqual([{ kind: "unreadable" }]);
    expect(toolPayloadParts("```json\nnot valid\n```", false)).toEqual([{ kind: "unreadable" }]);
    expect(toolPayloadParts("[1, 2 … (truncated, 500 characters)", false)).toEqual([
      { kind: "unreadable" },
    ]);
    expect(toolPayloadParts(`{"x":"${"a".repeat(70000)}`, false)).toEqual([{ kind: "omitted" }]);
    expect(toolPayloadParts(Array(21).fill("{}").join("\n"), false).at(-1)).toEqual({
      kind: "omitted",
    });
  });
});
