import type {
  Interaction,
  Panel,
  ToolItemData,
  TranscriptItem,
  UINode,
} from "@switchyard/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { IntentContext } from "../src/components/intent/context";
import { UINodeRenderer } from "../src/components/intent/UINodeRenderer";
import {
  questionToolCalls,
  summarizeWork,
  type TimelineEntry,
  transcriptEntries,
} from "../src/features/code/model";
import { ToolRow } from "../src/features/code/TranscriptItems";
import { toolViewOf } from "../src/features/code/toolView";
import { sessionBadges } from "../src/sync/store";

const at = "2026-01-01T00:00:00Z";
const tool = (patch: Partial<ToolItemData>): ToolItemData => ({
  toolCallId: "call",
  name: "todo",
  status: "ok",
  args: { action: "set" },
  summary: "todo set",
  output: "raw output",
  startedAt: at,
  durationMs: 10,
  card: null,
  adapterId: null,
  ...patch,
});
const entry = (id: string, data: ToolItemData): TimelineEntry => ({
  type: "item",
  key: id,
  stream: null,
  item: { id, sessionId: "s", order: 1, at, kind: "tool", data } as TranscriptItem,
});
const render = (node: UINode) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <UINodeRenderer node={node} />
    </MemoryRouter>,
  );

describe("ui.nodes.v2 in the web renderer", () => {
  it("draws a checklist with a state for each step", () => {
    const html = render({
      t: "checklist",
      items: [
        { text: "Read", state: "done" },
        { text: "Write", state: "doing", note: "half way" },
        { text: "Ship", state: "todo" },
        { text: "Old", state: "skipped" },
      ],
    });
    for (const s of ["done", "doing", "todo", "skipped"])
      expect(html).toContain(`data-state="${s}"`);
    expect(html).toContain("In progress: ");
    expect(html).toContain("half way");
  });
  it("draws facts, rows with a link, a badge and a URL", () => {
    expect(render({ t: "facts", items: [{ label: "Tool", value: "bash", mono: true }] })).toContain(
      "<dt",
    );
    const rows = render({
      t: "rows",
      rows: [
        {
          title: "worker",
          status: "running",
          meta: "12s",
          ref: { kind: "session", sessionId: "ses_2" },
        },
      ],
    });
    expect(rows).toContain("worker");
    expect(rows).toContain("12s");
    expect(render({ t: "badge", text: "plan", tone: "warning" })).toContain("border-warning");
    const link = render({
      t: "ref",
      ref: { kind: "url", url: "https://example.com/x" },
      label: "Docs",
    });
    expect(link).toContain('href="https://example.com/x"');
    expect(link).toContain('rel="noreferrer noopener"');
  });
  it("starts a section closed when it says so", () => {
    const section = (open?: boolean) =>
      render({
        t: "section",
        title: "More",
        collapsible: true,
        open,
        children: [{ t: "text", text: "x" }],
      });
    expect(section(false)).not.toContain("open=");
    expect(section()).toContain("open=");
  });
});

describe("tool.views.v1 in the transcript", () => {
  it("uses the host or adapter view for the row and shows its node when opened", () => {
    const data = tool({
      view: {
        verb: "Updated todo",
        meta: ["2/5"],
        detail: { t: "checklist", items: [{ text: "a", state: "done" }] },
      },
      card: { t: "text", text: "card" },
    });
    expect(toolViewOf(data, null)).toMatchObject({
      verb: "Updated todo",
      meta: ["2/5"],
      hide: false,
    });
    // A card opens the row, so the detail is in the static markup.
    const html = renderToStaticMarkup(<ToolRow data={data} stream={null} sessionId="s" />);
    expect(html).toContain(">Updated todo<");
    expect(html).toContain(">2/5<");
    expect(html).toContain('data-state="done"');
    expect(html).not.toContain("raw output");
    expect(html).not.toContain("<dl");
  });
  it("counts a tool by the kind its view gives", () => {
    const s = summarizeWork([entry("a", tool({ view: { kind: "command" } }))], null);
    expect(s).toMatchObject({ commands: 1, other: 0 });
  });
  it("drops a hidden row and the row of a call a question stands for", () => {
    const entries = [
      entry("shown", tool({ toolCallId: "c1" })),
      entry("hidden", tool({ toolCallId: "c2", view: { hide: true } })),
      entry("asked", tool({ toolCallId: "c3", name: "ask_user_question" })),
      entry("approved", tool({ toolCallId: "c4", name: "bash" })),
    ];
    const interactions = [
      { sessionId: "s", kind: "question", toolCallId: "c3" },
      { sessionId: "s", kind: "approval", toolCallId: "c4" },
      { sessionId: "other", kind: "question", toolCallId: "c1" },
      { sessionId: "s", toolCallId: "c1" },
    ] as Pick<Interaction, "sessionId" | "kind" | "toolCallId">[];
    const asked = questionToolCalls(interactions, "s");
    expect([...asked]).toEqual(["c3"]);
    expect(transcriptEntries(entries, [], () => false, asked).map((e) => e.key)).toEqual([
      "shown",
      "approved",
    ]);
  });
});

describe("session badges", () => {
  it("collects each session's badges in order", () => {
    const panel = (id: string, sessionId: string, over: Partial<Panel>): [string, Panel] => [
      id,
      {
        sessionId,
        adapterId: "gate",
        slot: `@slot/${id}`,
        title: id,
        node: { t: "badge", text: id, tone: "warning" },
        webRenderer: false,
        mobileFallback: id,
        updatedAt: at,
        contribution: { id, placement: "session.badge" },
        ...over,
      },
    ];
    const badges = sessionBadges(
      Object.fromEntries([
        panel("plan", "s1", {}),
        panel("ask", "s1", { contribution: { id: "ask", placement: "session.badge", order: -1 } }),
        panel("gone", "s1", { node: null }),
        panel("pill", "s1", { contribution: { id: "pill", placement: "composer.pill" } }),
        panel("x", "s2", { node: { t: "text", text: "x" } }),
      ]),
    );
    expect(badges.s1?.map((b) => b.text)).toEqual(["ask", "plan"]);
    expect(badges.s2).toEqual([expect.objectContaining({ text: "x", tone: undefined })]);
  });
});

describe("number keys in the dock", () => {
  const form: UINode = {
    t: "form",
    formId: "f",
    submitLabel: "Send",
    fields: [
      {
        kind: "select",
        name: "a",
        label: "Pick",
        options: [
          { value: "x", label: "X" },
          { value: "y", label: "Y" },
        ],
      },
    ],
  };
  const dock = (keys: boolean) =>
    renderToStaticMarkup(
      <IntentContext.Provider value={{ onRespond: () => {}, dock: { title: "Pick", keys } }}>
        <UINodeRenderer node={form} />
      </IntentContext.Provider>,
    );
  it("numbers a question's options and never an approval's", () => {
    expect(dock(true).match(/<kbd/g)).toHaveLength(2);
    expect(dock(false)).not.toContain("<kbd");
  });
});
