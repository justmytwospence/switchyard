// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLongPress } from "../src/lib/useLongPress";

function Target({ onLong, onClick }: { onLong: () => void; onClick: () => void }) {
  const p = useLongPress(onLong);
  return (
    <button type="button" {...p} onClick={onClick}>
      row
    </button>
  );
}

const touch = { pointerType: "touch", isPrimary: true, pointerId: 1 };

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useLongPress", () => {
  it("fires after the delay for touch and swallows the closing click", () => {
    const long = vi.fn();
    const click = vi.fn();
    render(<Target onLong={long} onClick={click} />);
    const el = screen.getByText("row");
    fireEvent.pointerDown(el, { ...touch, clientX: 5, clientY: 5 });
    act(() => void vi.advanceTimersByTime(460));
    expect(long).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(el, touch);
    fireEvent.click(el);
    expect(click).not.toHaveBeenCalled();
  });

  it("does nothing for a mouse", () => {
    const long = vi.fn();
    render(<Target onLong={long} onClick={() => undefined} />);
    fireEvent.pointerDown(screen.getByText("row"), {
      pointerType: "mouse",
      isPrimary: true,
      pointerId: 1,
    });
    act(() => void vi.advanceTimersByTime(600));
    expect(long).not.toHaveBeenCalled();
  });

  it("is cancelled by moving and lets a normal tap through", () => {
    const long = vi.fn();
    const click = vi.fn();
    render(<Target onLong={long} onClick={click} />);
    const el = screen.getByText("row");
    fireEvent.pointerDown(el, { ...touch, clientX: 5, clientY: 5 });
    fireEvent.pointerMove(el, { ...touch, clientX: 25, clientY: 5 });
    act(() => void vi.advanceTimersByTime(600));
    expect(long).not.toHaveBeenCalled();
    fireEvent.pointerUp(el, touch);
    fireEvent.click(el);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("opens once for a context menu after the timer fired", () => {
    const long = vi.fn();
    render(<Target onLong={long} onClick={() => undefined} />);
    const el = screen.getByText("row");
    fireEvent.contextMenu(el);
    expect(long).toHaveBeenCalledTimes(1);
    fireEvent.contextMenu(el);
    expect(long).toHaveBeenCalledTimes(1);
  });
});
