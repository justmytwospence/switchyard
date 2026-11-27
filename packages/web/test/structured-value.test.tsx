import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StructuredValue } from "../src/components/ui/StructuredValue";

const render = (value: unknown) => renderToStaticMarkup(<StructuredValue value={value} />);
describe("StructuredValue", () => {
  it("renders escaped nested data and empty values", () => {
    const html = render({ "<key>": ["<script>", true, false, null, 0, "", {}, []] });
    for (const expected of [
      "&lt;key&gt;",
      "&lt;script&gt;",
      "Yes",
      "No",
      "None",
      "0",
      "Empty text",
      "No fields",
      "No items",
      "<ol",
    ])
      expect(html).toContain(expected);
    expect(html).not.toContain("<script>");
  });
  it("does not invoke getters and bounds cycles, strings, depth and count", () => {
    const obj: Record<string, unknown> = { cycle: null };
    obj.cycle = obj;
    Object.defineProperty(obj, "unsafe", {
      enumerable: true,
      get() {
        throw new Error("getter invoked");
      },
    });
    expect(render(obj)).toContain("More data omitted");
    expect(render(obj)).toContain("Not available");
    expect(render("x".repeat(4001))).toContain("…");
    expect(render(Array(250).fill(1))).toContain("More data omitted");
    let deep: unknown = "end";
    for (let i = 0; i < 10; i++) deep = [deep];
    expect(render(deep)).toContain("More data omitted");
    expect(render(new Date())).toContain("Not available");
  });
});
