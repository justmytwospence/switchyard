// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SwipeRow } from "../src/components/ui/SwipeRow";

function setup(opts: { removes?: boolean; onAction?: () => unknown } = {}) {
  const onAction = vi.fn(opts.onAction ?? (() => undefined));
  const lead = vi.fn();
  render(
    <SwipeRow
      trailing={[
        {
          id: "archive",
          label: "Archive",
          icon: null,
          tone: "red",
          removes: opts.removes,
          onAction,
        },
        { id: "more", label: "More", icon: null, tone: "gray", onAction: () => undefined },
      ]}
      leading={[{ id: "clear", label: "Clear", icon: null, tone: "orange", onAction: lead }]}
    >
      <button type="button">content</button>
    </SwipeRow>,
  );
  const fg = screen.getByText("content").parentElement as HTMLElement;
  Object.defineProperty(fg, "offsetWidth", { value: 300 });
  return { fg, onAction, lead };
}

const ev = (type: "touch" | "mouse", x: number, y = 0) => ({
  pointerType: type,
  isPrimary: true,
  pointerId: 1,
  clientX: x,
  clientY: y,
});

function drag(el: HTMLElement, type: "touch" | "mouse", from: number, to: number, dy = 0) {
  fireEvent.pointerDown(el, ev(type, from));
  fireEvent.pointerMove(el, ev(type, (from + to) / 2, dy / 2));
  fireEvent.pointerMove(el, ev(type, to, dy));
  fireEvent.pointerUp(el, ev(type, to, dy));
}

afterEach(cleanup);

describe("SwipeRow", () => {
  it("leaves both trailing buttons open after a short swipe", () => {
    const { fg, onAction } = setup();
    drag(fg, "touch", 250, 140);
    expect(onAction).not.toHaveBeenCalled();
    expect(screen.getByText("Archive")).toBeTruthy();
    expect(screen.getByText("More")).toBeTruthy();
    fireEvent.click(screen.getByText("Archive"));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("runs the trailing action on a long swipe left", () => {
    const { fg, onAction } = setup();
    drag(fg, "touch", 250, 40);
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("runs the leading action on a long swipe right", () => {
    const { fg, lead } = setup();
    drag(fg, "touch", 20, 220);
    expect(lead).toHaveBeenCalledTimes(1);
  });

  it("ignores vertical drags and the mouse", () => {
    const { fg, onAction, lead } = setup();
    drag(fg, "touch", 100, 105, 200);
    drag(fg, "mouse", 250, 40);
    expect(onAction).not.toHaveBeenCalled();
    expect(lead).not.toHaveBeenCalled();
  });

  it("puts the row back when a removing action fails", async () => {
    const { fg } = setup({ removes: true, onAction: () => Promise.reject(new Error("no")) });
    await act(async () => {
      drag(fg, "touch", 250, 40);
    });
    expect(fg.style.transform).toBe("");
    expect(screen.queryByText("Archive")).toBeNull();
  });

  it("swallows the click after a drag", () => {
    const { fg } = setup();
    const click = vi.fn();
    screen.getByText("content").addEventListener("click", click);
    drag(fg, "touch", 100, 50);
    fireEvent.click(screen.getByText("content"));
    expect(click).not.toHaveBeenCalled();
  });
});
