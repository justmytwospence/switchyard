import { describe, expect, it } from "vitest";
import {
  applyToolView,
  builtinToolView,
  describeTool,
  downgradeUINode,
  type Interaction,
  mergeToolViewData,
  type Panel,
  piEditDiffToPatch,
  projectHostEvent,
  projectItem,
  projectPanel,
  type TranscriptItem,
  trackerText,
  type UINode,
  V1_UI_READER,
  validateContribution,
  validateToolView,
  validateUINode,
} from "../src/index.js";

const v2: UINode = {
  t: "section",
  title: "Work",
  collapsible: true,
  open: false,
  children: [
    {
      t: "checklist",
      items: [
        { text: "one", state: "done" },
        { text: "two", state: "doing", note: "now" },
      ],
    },
    { t: "facts", items: [{ label: "Tool", value: "bash", mono: true }] },
    {
      t: "rows",
      rows: [
        {
          title: "job 1",
          status: "running",
          tone: "warning",
          meta: "12s",
          ref: { kind: "session", sessionId: "s" },
        },
      ],
    },
    { t: "badge", text: "ask", tone: "warning" },
    { t: "ref", ref: { kind: "url", url: "https://example.com/a" }, label: "Docs" },
  ],
};

describe("ui.nodes.v2", () => {
  it("validates the new nodes and a section that starts closed", () => {
    expect(validateUINode(v2)).toEqual(v2);
  });
  it("accepts only http(s) URLs", () => {
    const ref = (url: string) => ({ t: "ref", ref: { kind: "url", url }, label: "x" });
    expect(() => validateUINode(ref("javascript:alert(1)"))).toThrow();
    expect(() => validateUINode(ref("https://a b"))).toThrow();
    expect(validateUINode(ref("http://localhost:3000/x"))).toBeTruthy();
  });
  it("downgrades to nodes every earlier reader draws", () => {
    const d = downgradeUINode(v2);
    expect(validateUINode(d)).toEqual(d);
    expect(d).toEqual({
      t: "section",
      title: "Work",
      collapsible: true,
      children: [
        {
          t: "list",
          items: [
            { t: "text", text: "[x] one" },
            { t: "text", text: "[~] two (now)" },
          ],
        },
        { t: "table", columns: ["Field", "Value"], rows: [["Tool", "bash"]] },
        { t: "list", items: [{ t: "text", text: "job 1 · running · 12s", tone: "warning" }] },
        { t: "text", text: "ask", tone: "warning" },
        { t: "text", text: "Docs: https://example.com/a" },
      ],
    });
  });
  it("returns the same object when nothing is new", () => {
    const old: UINode = {
      t: "section",
      children: [
        { t: "text", text: "a" },
        { t: "list", items: [] },
      ],
    };
    expect(downgradeUINode(old)).toBe(old);
  });
});

describe("adapter.trackers.v1", () => {
  const base = { title: "Todo", mobileFallback: "2 of 5", node: { t: "checklist", items: [] } };
  it("accepts a tracker with its summary and a badge with short text", () => {
    const t = validateContribution("todo", {
      ...base,
      placement: "composer.tracker",
      tracker: { count: "2/5", status: "running", step: "Write tests" },
    });
    expect(t.descriptor).toMatchObject({
      placement: "composer.tracker",
      tracker: { count: "2/5" },
    });
    expect(
      validateContribution("b", {
        placement: "session.badge",
        title: "Mode",
        mobileFallback: "plan",
        node: { t: "badge", text: "plan", tone: "warning" },
      }).node,
    ).toEqual({ t: "badge", text: "plan", tone: "warning" });
  });
  it("rejects a summary elsewhere, a long badge and an interactive badge", () => {
    expect(() =>
      validateContribution("x", {
        ...base,
        placement: "composer.pill",
        node: { t: "text", text: "a" },
        tracker: {},
      }),
    ).toThrow();
    const badge = (text: string, extra = {}) => ({
      placement: "session.badge",
      title: "Mode",
      mobileFallback: "m",
      node: { t: "text", text },
      ...extra,
    });
    expect(() => validateContribution("x", badge("x".repeat(25)))).toThrow(/24/);
    expect(() => validateContribution("x", badge("ok", { actionId: "go" }))).toThrow();
    expect(() =>
      validateContribution("x", { ...badge("ok"), node: { t: "markdown", text: "a" } }),
    ).toThrow();
  });
  it("says a tracker in one line", () => {
    expect(trackerText("Todo", { count: "2/5", step: "Write tests" })).toBe(
      "Todo 2/5 · Write tests",
    );
    expect(trackerText("Todo", undefined)).toBe("Todo");
  });
});

describe("tool.views.v1", () => {
  it("validates an adapter's view and refuses forms and unknown fields", () => {
    expect(validateToolView({ verb: "Asked", target: "Which?", hide: true })).toEqual({
      verb: "Asked",
      target: "Which?",
      hide: true,
    });
    expect(() => validateToolView({ verb: "" })).toThrow();
    expect(() => validateToolView({ color: "red" })).toThrow();
    expect(() =>
      validateToolView({
        detail: { t: "confirm", message: "m", confirmLabel: "y", cancelLabel: "n" },
      }),
    ).toThrow();
  });
  it("applies a view over the derived row, field by field", () => {
    const derived = describeTool({ name: "todo", args: { action: "list" } }, null);
    expect(derived).toMatchObject({ verb: null, target: "list", node: null, hide: false });
    const view = applyToolView(derived, {
      verb: "Listed todos",
      meta: ["3 items"],
      detail: { t: "text", text: "d" },
    });
    expect(view).toMatchObject({
      kind: "other",
      verb: "Listed todos",
      activeVerb: "Listed todos",
      target: "list",
      meta: ["3 items"],
      node: { t: "text", text: "d" },
    });
    expect(applyToolView(derived, undefined)).toBe(derived);
    expect(mergeToolViewData({ meta: ["a"], verb: "A" }, { verb: "B" })).toEqual({
      meta: ["a"],
      verb: "B",
    });
  });
  it("turns Pi's edit diff into a patch with real line numbers", () => {
    const pi = [
      " 10 ctx",
      "-11 old",
      "+11 new",
      "+12 more",
      " 12 after",
      "    ...",
      " 40 far",
      "-41 gone",
    ].join("\n");
    const r = piEditDiffToPatch("src/a.ts", pi)!;
    expect(r).toMatchObject({ added: 2, removed: 2 });
    expect(r.patch).toBe(
      [
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -10,3 +10,4 @@",
        " ctx",
        "-old",
        "+new",
        "+more",
        " after",
        "@@ -40,2 +41,1 @@",
        " far",
        "-gone",
        "",
      ].join("\n"),
    );
    expect(piEditDiffToPatch("a", "nothing here")).toBeNull();
  });
  it("gives the host's view of a finished edit and a failed command", () => {
    const edit = builtinToolView(
      { name: "edit", args: { path: "/w/src/a.ts" }, result: {}, details: { diff: "-1 a\n+1 b" } },
      "/w",
    );
    expect(edit).toMatchObject({ stat: { added: 1, removed: 1 }, detail: { t: "diff" } });
    expect(edit!.detail).toMatchObject({ patch: expect.stringContaining("+++ b/src/a.ts") });
    expect(
      builtinToolView(
        { name: "bash", args: { command: "x" }, result: { structuredContent: { exit_code: 3 } } },
        null,
      ),
    ).toEqual({ meta: ["exit 3"] });
    expect(
      builtinToolView(
        {
          name: "bash",
          args: { command: "a\nb" },
          result: { content: [{ type: "text", text: "boom\n\nCommand exited with code 2" }] },
        },
        null,
      ),
    ).toEqual({ meta: ["+1 line", "exit 2"] });
    expect(
      builtinToolView(
        { name: "bash", args: {}, result: { structuredContent: { exit_code: 0 } } },
        null,
      ),
    ).toBeUndefined();
    expect(builtinToolView({ name: "edit", args: { path: "a" } }, null)).toBeUndefined();
  });
});

describe("projection for a reader from before contract v2", () => {
  const panel = (over: Partial<Panel>): Panel => ({
    sessionId: "s",
    adapterId: "todo",
    slot: "@slot/todo",
    title: "Todo",
    node: { t: "checklist", items: [{ text: "a", state: "done" }] },
    webRenderer: false,
    mobileFallback: "[x] a",
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  });
  it("turns a tracker into a pill that says the same thing", () => {
    const p = projectPanel(
      panel({
        contribution: {
          id: "todo",
          placement: "composer.tracker",
          actionId: "x",
          tracker: { count: "1/1", step: "a" },
        },
      }),
      V1_UI_READER,
    );
    expect(p.contribution).toEqual({ id: "todo", placement: "composer.pill" });
    expect(p.node).toEqual({ t: "text", text: "Todo 1/1 · a" });
  });
  it("removes a badge and downgrades a legacy panel's nodes", () => {
    const badge = projectPanel(
      panel({
        node: { t: "badge", text: "plan" },
        contribution: { id: "b", placement: "session.badge" },
      }),
      V1_UI_READER,
    );
    expect(badge).toMatchObject({ node: null });
    expect(badge.contribution).toBeUndefined();
    expect(projectPanel(panel({ slot: "legacy" }), V1_UI_READER).node).toEqual({
      t: "list",
      items: [{ t: "text", text: "[x] a" }],
    });
  });
  it("drops a tool's view, downgrades its card and strips an interaction's kind", () => {
    const item = {
      id: "i",
      sessionId: "s",
      order: 1,
      at: "2026-01-01T00:00:00Z",
      kind: "tool",
      data: {
        toolCallId: "c",
        name: "todo",
        status: "ok",
        args: {},
        summary: "todo",
        output: "",
        startedAt: "2026-01-01T00:00:00Z",
        durationMs: 1,
        card: { t: "badge", text: "b" },
        adapterId: "todo",
        view: { verb: "Updated", hide: true },
      },
    } as TranscriptItem;
    const out = projectItem(item, V1_UI_READER);
    expect(out.kind === "tool" && out.data.view).toBeUndefined();
    expect(out.kind === "tool" && out.data.card).toEqual({ t: "text", text: "b" });
    expect(projectItem(item, { ...V1_UI_READER, views: true, nodes: true })).toBe(item);

    const interaction = {
      id: "int",
      sessionId: "s",
      revision: 1,
      source: { kind: "extension_ui", method: "select", piRequestIds: ["r"] },
      adapterId: "a",
      kind: "question",
      toolCallId: "c",
      title: "Q",
      presentation: { t: "badge", text: "q" },
      state: "pending",
      resolution: null,
      createdAt: "2026-01-01T00:00:00Z",
    } as Interaction;
    const ev = projectHostEvent({ type: "interaction.updated", sessionId: "s", data: interaction });
    expect(ev.data).not.toHaveProperty("kind");
    expect(ev.data).not.toHaveProperty("toolCallId");
    expect((ev.data as Interaction).presentation).toEqual({ t: "text", text: "q" });
  });
});
