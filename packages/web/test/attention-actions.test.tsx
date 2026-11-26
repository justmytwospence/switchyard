// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Menu } from "../src/components/ui/Menu";
import { ATTENTION_ACTION_HELP } from "../src/features/attention/logic";
import type { SyncStore } from "../src/sync/store";
import { attention, session } from "./fixtures";

const mock = vi.hoisted(() => ({ state: {} as SyncStore }));

vi.mock("../src/sync/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/sync/store")>()),
  useSyncStore: (selector: (state: SyncStore) => unknown) => selector(mock.state),
}));

beforeEach(() => {
  mock.state = {
    projects: {},
    tasks: {},
    sessions: { ses_1: session("ses_1") },
    hosts: {},
    interactions: {},
    attention: {},
  } as unknown as SyncStore;
});

/** The description a button with `label` is given (its tooltip and aria-describedby target). */
function describedAs(html: string, label: string) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const button = [...doc.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
  if (!button) return null;
  const id = button.getAttribute("aria-describedby");
  return {
    title: button.getAttribute("title"),
    description: id ? doc.getElementById(id)?.textContent : null,
  };
}

describe("attention action help", () => {
  it("says what Dismiss and Clear do and leave behind", () => {
    expect(ATTENTION_ACTION_HELP).toEqual({
      dismiss:
        "Marks it as seen and moves it to Dismissed; it stays open, and a question keeps flagging its session.",
      clear: "Resolves it now: the session loses this flag and the item moves to History.",
      clearNeedsInput:
        "Removes this session's Needs input flag and moves it to History; a question Pi is still waiting on stays.",
    });
  });

  it("gives Dismiss and Clear on the Attention page a tooltip and an accessible description", async () => {
    const { AttentionRow } = await import("../src/features/attention/index");
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AttentionRow item={attention("a", { reason: "ready_for_review" })} />
      </MemoryRouter>,
    );
    expect(describedAs(html, "Dismiss")).toEqual({
      title: ATTENTION_ACTION_HELP.dismiss,
      description: ATTENTION_ACTION_HELP.dismiss,
    });
    expect(describedAs(html, "Clear")).toEqual({
      title: ATTENTION_ACTION_HELP.clear,
      description: ATTENTION_ACTION_HELP.clear,
    });
  });

  it("describes Clear Needs input in the session menu", async () => {
    const { sessionMenuItems } = await import("../src/features/code/ConversationHeader");
    const ctx = { session: { id: "ses_1", readOnly: false, archivedAt: null } } as never;
    const actions = { dismissAttention: () => {} } as never;
    const item = sessionMenuItems(ctx, actions, []).find((i) => i.id === "dismiss-attention");
    expect(item).toMatchObject({
      label: "Clear Needs input",
      description: ATTENTION_ACTION_HELP.clearNeedsInput,
    });
  });

  it("renders a menu item's description as its tooltip and accessible description", () => {
    render(
      <Menu
        label="Session actions"
        trigger={(p) => (
          <button type="button" {...p}>
            Open
          </button>
        )}
        items={[
          {
            id: "dismiss-attention",
            label: "Clear Needs input",
            description: ATTENTION_ACTION_HELP.clearNeedsInput,
            onSelect: () => {},
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByText("Open"));
    const item = screen.getByRole("menuitem", { name: "Clear Needs input" });
    expect(item.getAttribute("title")).toBe(ATTENTION_ACTION_HELP.clearNeedsInput);
    expect(document.getElementById(item.getAttribute("aria-describedby")!)?.textContent).toBe(
      ATTENTION_ACTION_HELP.clearNeedsInput,
    );
  });
});
