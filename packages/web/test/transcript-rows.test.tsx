import type { ToolItemData, TranscriptItem } from "@switchyard/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { TimelineEntry } from "../src/features/code/model";
import { summarizeWork } from "../src/features/code/model";
import { TimelineRow, ToolRow, WorkRow } from "../src/features/code/TranscriptItems";

const at = "2026-01-01T00:00:00Z";
const tool = (patch: Partial<ToolItemData>): ToolItemData => ({
  toolCallId: "call",
  name: "bash",
  status: "ok",
  args: { command: "pnpm test" },
  summary: "bash pnpm test",
  output: "all green",
  startedAt: at,
  durationMs: 2500,
  card: null,
  adapterId: null,
  ...patch,
});
const entry = (item: TranscriptItem): TimelineEntry => ({
  type: "item",
  key: item.id,
  item,
  stream: null,
});
const rest = {
  sessionId: "s",
  interactionReadOnly: null,
  highlightInteractionId: null,
};

describe("transcript rows", () => {
  it("shows a finished command as one closed line", () => {
    const html = renderToStaticMarkup(<ToolRow data={tool({})} stream={null} sessionId="s" />);
    expect(html).toContain('data-testid="tool-row"');
    expect(html).toContain('data-kind="command"');
    expect(html).toContain(">Ran<");
    expect(html).toContain("pnpm test");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(">3s<");
    expect(html).not.toContain("Arguments");
    expect(html).not.toContain("all green");
    expect(html).not.toContain("failed");
  });
  it("marks a failed call in words", () => {
    const html = renderToStaticMarkup(
      <ToolRow data={tool({ status: "error" })} stream={null} sessionId="s" />,
    );
    expect(html).toContain(">failed<");
    expect(html).toContain('aria-label="Tool bash: Failed"');
  });
  it("keeps the name of a tool it has no verb for and shows edit counts", () => {
    const other = renderToStaticMarkup(
      <ToolRow
        data={tool({ name: "todo", args: { action: "list" } })}
        stream={null}
        sessionId="s"
      />,
    );
    expect(other).toContain(">todo<");
    expect(other).toContain(">list<");
    const edit = renderToStaticMarkup(
      <ToolRow
        data={tool({
          name: "edit",
          args: { path: "a.ts", edits: [{ oldText: "a", newText: "b" }] },
        })}
        stream={null}
        sessionId="s"
      />,
    );
    expect(edit).toContain(">Edited<");
    expect(edit).toContain("+1");
    expect(edit).toContain("−1");
  });
  it("draws your message as a labelled card without a heading", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TimelineRow
          entry={entry({
            id: "u",
            sessionId: "s",
            order: 1,
            at,
            kind: "user",
            data: { text: "Fix the login retry" },
          })}
          {...rest}
        />
      </MemoryRouter>,
    );
    expect(html).toContain("Fix the login retry");
    expect(html).toContain('aria-label="You, ');
    expect(html).not.toContain(">You<");
    expect(html).not.toContain("Show full message");
    const long = renderToStaticMarkup(
      <MemoryRouter>
        <TimelineRow
          entry={entry({
            id: "u",
            sessionId: "s",
            order: 1,
            at,
            kind: "user",
            data: { text: "line\n".repeat(20) },
          })}
          {...rest}
        />
      </MemoryRouter>,
    );
    expect(long).toContain("Show full message");
  });
  it("names Pi only for screen readers", () => {
    const html = renderToStaticMarkup(
      <TimelineRow
        entry={entry({
          id: "a",
          sessionId: "s",
          order: 1,
          at,
          kind: "assistant",
          data: { text: "Done." },
        })}
        {...rest}
      />,
    );
    expect(html).toContain('<span class="sr-only select-none">Pi: </span>');
    expect(html).toContain("Done.");
  });
  it("folds a turn's work into a sentence", () => {
    const entries = [
      entry({ id: "t1", sessionId: "s", order: 1, at, kind: "tool", data: tool({}) }),
      entry({
        id: "t2",
        sessionId: "s",
        order: 2,
        at,
        kind: "tool",
        data: tool({ toolCallId: "c2", name: "read", args: { path: "a.ts" }, status: "error" }),
      }),
    ];
    const html = renderToStaticMarkup(
      <WorkRow
        entries={entries}
        summary={summarizeWork(entries, null)}
        live={false}
        startAt={null}
        {...rest}
      />,
    );
    expect(html).toContain('data-testid="work-row"');
    expect(html).toContain("Worked for 5s · ran 1 command · read 1 file · 1 failed");
    const live = renderToStaticMarkup(
      <WorkRow
        entries={entries}
        summary={summarizeWork(entries, null)}
        live
        startAt={null}
        {...rest}
      />,
    );
    expect(live).toContain("Working… · ran 1 command");
  });
});
