import { describe, expect, it } from "vitest";
import { entriesToMessages } from "../src/importable.js";
import { ManagedSession } from "../src/session-runtime.js";
import { messagesToItems } from "../src/transcript.js";
import { mockProfile } from "./helpers.js";

const make = () =>
  new ManagedSession({
    sessionId: "ses_custom",
    cwd: "/tmp",
    title: "Custom",
    profile: mockProfile,
  });
const deliver = (ms: ManagedSession, message: unknown) =>
  (ms as unknown as { onMessageEnd: (m: unknown) => void }).onMessageEnd(message);

describe("custom messages", () => {
  it("emits exactly one fallback notice and a typed event for a visible message", () => {
    const ms = make();
    const items: any[] = [];
    const events: any[] = [];
    ms.on("item", (item) => items.push(item));
    ms.on("custom_message", (event) => events.push(event));
    const message = {
      role: "custom",
      customType: "build",
      content: [{ type: "text", text: "Done" }],
      details: { secret: "not persisted" },
    };
    deliver(ms, message);
    expect(items).toHaveLength(1);
    expect(items[0].data).toEqual({ level: "info", text: "Done", customType: "build" });
    expect(events).toEqual([
      {
        itemId: items[0].id,
        message: {
          customType: "build",
          content: message.content,
          display: undefined,
          details: message.details,
        },
      },
    ]);
    expect(JSON.stringify(items[0])).not.toContain("secret");
    deliver(ms, { ...message, display: false });
    expect(items).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it("falls back on empty content and leaves invalid custom types text-only", () => {
    const ms = make();
    const items: any[] = [];
    const events: any[] = [];
    ms.on("item", (item) => items.push(item));
    ms.on("custom_message", (event) => events.push(event));
    deliver(ms, { role: "custom", customType: "quiet", content: [] });
    deliver(ms, { role: "custom", customType: "", content: "Legacy" });
    expect(items.map((item) => item.data)).toEqual([
      { level: "info", text: "Custom message: quiet", customType: "quiet" },
      { level: "info", text: "Legacy" },
    ]);
    expect(events).toHaveLength(1);
  });

  it("imports historical entries as portable text without invoking hooks", () => {
    const messages = entriesToMessages([
      { type: "custom_message", customType: "quiet", content: [], display: true },
      { type: "custom_message", customType: "hidden", content: "No", display: false },
    ]);
    const items = messagesToItems(messages, {
      sessionId: "ses_custom",
      startOrder: 0,
      fallbackAt: new Date().toISOString(),
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "notice",
      data: { customType: "quiet", text: "Custom message: quiet" },
    });
    expect((items[0] as any).data.card).toBeUndefined();
  });
});
