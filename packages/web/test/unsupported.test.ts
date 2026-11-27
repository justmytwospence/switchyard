import { describe, expect, it } from "vitest";
import {
  isUnsupported,
  messageMode,
  UNSUPPORTED_FALLBACK_COPY,
  unsupportedView,
} from "../src/components/intent/unsupported";
import { interaction } from "./fixtures";

const RPC_COPY =
  "An extension opened a terminal-only dialog. In RPC mode Pi gave it no answer, so the extension continued without one.";
const LEGACY_TERMINAL_COPY =
  "An extension is showing its own interface in this session's terminal. Open the terminal (switchyard tui) to answer it.";
const TERMINAL_COPY = "This dialog can only be answered in the terminal where Pi is running.";

const hostPresentation = {
  t: "section" as const,
  title: "Terminal-only interface requested",
  children: [
    { t: "text" as const, text: RPC_COPY },
    {
      t: "actions" as const,
      actions: [
        { id: "abort", label: "Stop the run", tone: "danger" as const },
        { id: "message", label: "Send a message to Pi", tone: "primary" as const },
      ],
    },
  ],
};

function unsupported(patch = {}) {
  return interaction("int_u", {
    source: { kind: "unsupported_custom", title: null },
    title: "Terminal-only interface requested",
    presentation: hostPresentation,
    state: "unsupported",
    ...patch,
  });
}

describe("unsupported interactions", () => {
  it("offers the host's alternatives until one is chosen", () => {
    const i = unsupported();
    expect(isUnsupported(i)).toBe(true);
    expect(unsupportedView(i)).toEqual({
      answerable: true,
      copy: RPC_COPY,
      actions: [
        { id: "abort", label: "Stop the run", tone: "danger" },
        { id: "message", label: "Send a message to Pi", tone: "primary" },
      ],
    });
    const chosen = unsupported({
      resolution: { by: "dev_a", summary: "Stop the run", at: "2026-11-01T10:00:00.000Z" },
    });
    expect(unsupportedView(chosen).answerable).toBe(false);
  });

  it("normalizes legacy terminal descriptions even after a terminal answer", () => {
    const i = unsupported({
      presentation: { t: "section", children: [{ t: "text", text: LEGACY_TERMINAL_COPY }] },
      resolution: {
        by: "terminal",
        summary: "Answered in the terminal",
        at: "2026-11-01T10:00:00.000Z",
      },
    });
    expect(unsupportedView(i)).toMatchObject({ copy: TERMINAL_COPY, answerable: false });
  });

  it("uses new terminal descriptions and a neutral fallback for missing text", () => {
    const terminal = unsupported({ presentation: { t: "text", text: TERMINAL_COPY } });
    expect(unsupportedView(terminal).copy).toBe(TERMINAL_COPY);
    const blank = unsupported({
      presentation: {
        t: "section",
        children: [
          { t: "text", text: "  " },
          { t: "section", children: [{ t: "actions", actions: [] }] },
        ],
      },
    });
    expect(unsupportedView(blank).copy).toBe(UNSUPPORTED_FALLBACK_COPY);
  });

  it("falls back to stop/message when the presentation has no actions", () => {
    const i = unsupported({ presentation: { t: "text", text: "unsupported" } });
    expect(unsupportedView(i).actions.map((a) => a.id)).toEqual(["abort", "message"]);
  });

  it("queues the message as a follow-up while Pi is working", () => {
    expect(messageMode("running")).toBe("followUp");
    expect(messageMode("waiting_input")).toBe("followUp");
    expect(messageMode("idle")).toBe("prompt");
    expect(messageMode(undefined)).toBe("prompt");
  });
});
