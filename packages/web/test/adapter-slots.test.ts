import type { Panel } from "@switchyard/protocol";
import { describe, expect, it } from "vitest";
import {
  adapterCommandError,
  adapterCommandFingerprint,
  adapterCommandName,
  adapterTabId,
} from "../src/features/code/adapterIdentity";
import { contributionsForSession } from "../src/sync/store";

const panel = (sessionId: string, adapterId: string, id: string, order = 0): Panel => ({
  sessionId,
  adapterId,
  slot: `@slot/${id}`,
  title: id,
  node: { t: "text", text: id },
  mobileFallback: id,
  webRenderer: false,
  updatedAt: "2026-01-01T00:00:00Z",
  contribution: { id, placement: "palette.item", actionId: "run", order },
});

describe("session-scoped adapter contributions", () => {
  it("sorts by order, adapter and ID without collapsing identical IDs or leaking sessions", () => {
    const items = [
      panel("one", "b", "same"),
      panel("one", "a", "z"),
      panel("one", "a", "same"),
      panel("one", "a", "first", -2),
      panel("two", "a", "same"),
    ];
    const state = Object.fromEntries(items.map((p, i) => [i, p]));
    expect(
      contributionsForSession(state, "one").map((p) => `${p.adapterId}:${p.contribution?.id}`),
    ).toEqual(["a:first", "a:same", "a:z", "b:same"]);
    expect(contributionsForSession(state, "two")).toHaveLength(1);
    expect(contributionsForSession(state, null)).toEqual([]);
    expect(adapterTabId(items[0]!)).not.toBe(adapterTabId(items[2]!)); // adapter identities stay distinct
  });

  it("keeps command identities and invalidates changed descriptors", () => {
    const p = {
      ...panel("one", "my-adapter", "form"),
      contribution: {
        id: "form",
        placement: "slash.command" as const,
        actionId: "save",
        name: "note",
      },
    };
    expect(adapterCommandName(p)).toBe("adapter:my-adapter:note");
    expect(adapterCommandFingerprint(p)).not.toBe(
      adapterCommandFingerprint({ ...p, node: { t: "text", text: "changed" } }),
    );
    expect(
      adapterCommandError("/adapter:my-adapter:note", "adapter:my-adapter:note", 0),
    ).toBeNull();
    expect(
      adapterCommandError("/adapter:my-adapter:note extra", "adapter:my-adapter:note", 0),
    ).toContain("uses a form");
    expect(adapterCommandError("/adapter:my-adapter:note", "adapter:my-adapter:note", 1)).toContain(
      "Remove attachments",
    );
  });
});
