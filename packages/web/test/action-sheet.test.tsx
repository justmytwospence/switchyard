// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Menu } from "../src/components/ui/Menu";

const bp = vi.hoisted(() => ({ value: "mobile" }));
vi.mock("../src/app/useBreakpoint", () => ({
  useBreakpoint: () => bp.value,
  useCoarsePointer: () => false,
}));

const trigger = (p: Record<string, unknown>) => (
  <button type="button" {...p}>
    open
  </button>
);

beforeEach(() => {
  bp.value = "mobile";
});

afterEach(cleanup);

describe("Menu on a phone", () => {
  it("opens as a sheet and selects once", () => {
    const onSelect = vi.fn();
    render(
      <Menu
        label="Actions"
        trigger={trigger as never}
        items={[
          { id: "a", label: "Rename", onSelect },
          { id: "b", label: "Pinned", kind: "checkbox", checked: true, onSelect: () => undefined },
        ]}
      />,
    );
    fireEvent.click(screen.getByText("open"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("menu", { name: "Actions" })).toBeTruthy();
    expect(
      screen.getByRole("menuitemcheckbox", { name: "Pinned" }).getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("stays a dropdown on desktop", () => {
    bp.value = "desktop";
    render(
      <Menu
        label="Actions"
        trigger={trigger as never}
        items={[{ id: "a", label: "Rename", onSelect: () => undefined }]}
      />,
    );
    fireEvent.click(screen.getByText("open"));
    expect(screen.getByRole("menu", { name: "Actions" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
