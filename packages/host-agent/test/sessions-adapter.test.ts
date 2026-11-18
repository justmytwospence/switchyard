// @module-tag slow
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type HostHarness, startHarness, tempDir, waitFor } from "./helpers.js";
import {
  interactions,
  isSettled,
  items,
  script,
  sid,
  startSession,
  writeProjectAdapter,
} from "./sessions-helpers.js";

describe("adapter integration", () => {
  let h: HostHarness;
  let work: { path: string; cleanup(): void };
  beforeAll(async () => {
    h = await startHarness({ script });
    work = tempDir("switchyard-adapter-ws-");
    writeProjectAdapter(work.path);
  });
  afterAll(async () => {
    await h?.dispose();
    work?.cleanup();
  });

  it("an adapter that presents a status or widget hides the generic one", async () => {
    const id = sid();
    await startSession(h, id, work.path, { initialPrompt: "set status please" });
    await h.coord.waitEvent(isSettled(id), 30000, "settled");
    await waitFor(
      () => items(h, id).some((i) => i.kind === "notice" && i.data.text === "fixture notified"),
      10000,
      "notice",
    );
    const slots = h.coord.eventsOf("panel.updated", id).map((e) => (e.data as any).slot);
    expect(slots).not.toContain("status");
    expect(slots).not.toContain("widget:fixture");
    expect(h.agent.supervisor.panels(id).filter((p) => p.adapterId === "generic")).toEqual([]);
    await h.coord.ok({ type: "session.stop", sessionId: id });
  });

  it("loads project adapters and applies queued answers, tool cards, panels and state", async () => {
    const id = sid();
    await startSession(h, id, work.path, { initialPrompt: "please pick a fruit" });
    const settled = await h.coord.waitEvent(isSettled(id), 30000, "settled");
    expect((settled.data as any).lastAssistantText).toBe("tool said: selected Apple");

    const adapters = h.coord.eventsOf("adapters.updated").at(-1)!.data as any;
    expect(adapters.adapters).toContainEqual(
      expect.objectContaining({ id: "fruit", tier: "project", status: "active" }),
    );

    const [i] = interactions(h, id);
    expect(i).toMatchObject({
      state: "resolved",
      adapterId: "fruit",
      resolution: { by: "host", summary: "Answered from your earlier form" },
    });
    await waitFor(
      () =>
        items(h, id).some(
          (x) => x.kind === "tool" && (x.data as any).card?.text === "fruit chosen",
        ),
      10000,
      "final tool card",
    );
    const tool = items(h, id)
      .filter((x) => x.kind === "tool")
      .at(-1)!;
    expect(tool.data).toMatchObject({
      adapterId: "fruit",
      card: { t: "text", text: "fruit chosen" },
    });

    await waitFor(() => h.coord.eventsOf("panel.updated", id).length > 0, 10000, "panel");
    expect(h.coord.eventsOf("panel.updated", id).at(-1)!.data).toMatchObject({
      sessionId: id,
      adapterId: "fruit",
      slot: "fruit",
      title: "Fruit",
      node: { t: "markdown", text: "Fruit: Apple" },
    });
    const row = h.agent.db.get<{ json: string }>(
      "SELECT json FROM adapter_state WHERE session_id = ? AND adapter_id = 'fruit' AND key = 'lastFruit'",
      [id],
    );
    expect(JSON.parse(row!.json)).toBe("Apple");
    expect(h.agent.supervisor.panels(id)).toHaveLength(1);
    await h.coord.ok({ type: "session.stop", sessionId: id });
  });
});
