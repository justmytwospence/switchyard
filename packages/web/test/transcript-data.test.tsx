// @vitest-environment happy-dom
import type { ToolItemData } from "@switchyard/protocol";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TimelineRow, ToolRow } from "../src/features/code/TranscriptItems";

const mode = vi.hoisted(() => ({ mobile: false }));
vi.mock("../src/app/useBreakpoint", () => ({
  useBreakpoint: () => (mode.mobile ? "mobile" : "desktop"),
  useCoarsePointer: () => false,
}));
afterEach(() => {
  cleanup();
  mode.mobile = false;
});
const tool = (patch: Partial<ToolItemData> = {}): ToolItemData => ({
  toolCallId: "call",
  name: "custom",
  status: "ok",
  args: { nested: { name: "Alice" } },
  summary: "",
  output: '{"result":{"count":2}}',
  startedAt: "2026-01-01T00:00:00Z",
  durationMs: 1,
  card: null,
  adapterId: null,
  ...patch,
});
const open = (data: ToolItemData) => {
  const result = render(<ToolRow data={data} stream={null} sessionId="s" />);
  fireEvent.click(screen.getByRole("button", { name: /custom|Read/i }));
  return result;
};
describe("tool transcript data", () => {
  it.each([false, true])("shows structured arguments and output on mobile=%s", (mobile) => {
    mode.mobile = mobile;
    const { container } = open(tool());
    expect(screen.getByText("nested")).toBeTruthy();
    expect(screen.getByText("Alice")).toBeTruthy();
    expect(screen.getByText("count")).toBeTruthy();
    expect(container.querySelector("pre")).toBeNull();
  });
  it("gives successful adapter details precedence over arguments and output", () => {
    open(tool({ view: { detail: { t: "text", text: "Adapter detail" } } }));
    expect(screen.getByText("Adapter detail")).toBeTruthy();
    expect(screen.queryByText("nested")).toBeNull();
    expect(screen.queryByText("count")).toBeNull();
  });
  it("hides an argument delta until parsed arguments arrive", () => {
    render(
      <ToolRow
        data={tool({ args: {}, status: "running", output: "" })}
        stream={{
          sessionId: "s",
          itemId: "i",
          order: null,
          text: "",
          thinking: "",
          toolArgs: '{"secret":',
          toolOutput: "",
        }}
        sessionId="s"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /custom/i }));
    expect(screen.getByText("Receiving arguments…")).toBeTruthy();
    expect(document.body.textContent).not.toContain("secret");
  });
  it("keeps failed adapter output and suppresses generic arguments", () => {
    open(tool({ status: "error", view: { detail: { t: "text", text: "Adapter detail" } } }));
    expect(screen.getByText("Adapter detail")).toBeTruthy();
    expect(screen.getByText("count")).toBeTruthy();
    expect(screen.queryByText("nested")).toBeNull();
  });
  it("keeps JSON file source literal", () => {
    const { container } = open(tool({ name: "read", args: { path: "file.json" } }));
    expect(container.querySelector("pre")?.textContent).toContain('{"result":{"count":2}}');
  });
  it("hides both orphan stream buffers", () => {
    render(
      <TimelineRow
        entry={{
          type: "stream",
          key: "s",
          stream: {
            sessionId: "s",
            itemId: "i",
            order: null,
            text: "",
            thinking: "",
            toolArgs: '{"secret":',
            toolOutput: "secret output",
          },
        }}
        sessionId="s"
        interactionReadOnly={null}
        highlightInteractionId={null}
      />,
    );
    expect(screen.getByText("Receiving arguments…")).toBeTruthy();
    expect(document.body.textContent).not.toContain("secret");
  });
});
